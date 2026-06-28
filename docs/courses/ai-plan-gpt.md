---
title: "AI 일정 생성 (GPT)"
owner: D
domain: "여행 코스·AI 일정"
tags: ["GPT", "AI일정"]
---

# AI 일정 생성 (GPT)

> 사용자가 여행 조건만 입력하면 GPT-4o-mini가 날짜별 여행 일정을 JSON으로 생성하고, 그 결과를 한 트랜잭션 안에서 여행 계획과 방문 장소로 저장한다.

## 1. 한 줄 정의

AI 일정 생성은 여행지·기간·동행·스타일·예산·추가요청을 입력받아 LLM을 호출하고, 응답으로 받은 날짜별 일정을 `TRAVEL_PLAN` 한 건과 여러 `PLAN_SPOT` 행으로 한 번에 저장한 뒤 내 코스 목록으로 보내는 기능이다.

## 2. 왜 이렇게 설계했나

여행 일정 짜기는 사용자에게 가장 진입장벽이 높은 작업이다. 빈 화면에서 장소를 직접 찾고 순서를 정하는 대신, 조건 몇 개만 받아 초안을 자동으로 만들어 주면 첫 계획 생성까지의 마찰이 크게 줄어든다.

설계 결정의 핵심은 다음과 같다.

- **자유 텍스트 입력을 구조화 데이터로 변환**: LLM 응답을 그대로 화면에 뿌리지 않고, 반드시 `TRAVEL_PLAN`과 `PLAN_SPOT` 스키마에 맞춰 저장한다. 그래야 직접 작성한 일정과 동일하게 조회·수정·공유 흐름을 재사용할 수 있다.
- **직접 작성과 같은 도메인 모델 공유**: AI가 만들든 사람이 만들든 결과물은 같은 테이블에 들어간다. 차이는 `plan_source` 컬럼 값(`AI` vs `MANUAL`)뿐이라 이후 기능이 분기를 최소화한다.
- **기본 비공개·트랜잭션 보호**: AI 초안은 다듬기 전이라 기본 비공개(`is_public = 0`)로 저장하고, 계획 저장과 장소 저장을 하나의 트랜잭션으로 묶어 중간 실패 시 부분 데이터가 남지 않게 한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 구현체 | 역할 |
| --- | --- | --- |
| 컨트롤러 | `AiPlanController` (`/courses/ai`) | 입력 폼 표시, 생성 요청 수신, 리다이렉트 |
| 오케스트레이션 | `AiPlanServiceImpl` | 입력 검증 + LLM 호출 + DB 저장 (`@Transactional`) |
| LLM 호출 | `AiPlanGPTServiceImpl` | OpenAI Chat Completions 호출, 구조화 출력 파싱 |
| 요청 DTO | `AiPlanRequestDTO` | 여행지·날짜·동행·스타일·예산·요청 텍스트 |
| 응답 DTO | `AiPlanResponseDTO` → `AiDayDTO` → `AiSpotDTO` | title/summary/days, 날짜별 theme·spots |
| 저장 서비스 | `TravelPlanService` | `insertTravelPlan`, `insertPlanSpot` |
| 저장 VO | `TravelPlanVO`, `PlanSpotVO` | DB 행 매핑 |
| 테이블 | `TRAVEL_PLAN`, `PLAN_SPOT` | 계획 1건 + 날짜별 장소 N건 |

모델은 `gpt-4o-mini`이며 OpenAI `/v1/chat/completions`를 호출한다. 응답 신뢰성은 Structured Outputs(JSON Schema, `strict = true`)로 강제한다. 스키마 세부는 [구조화 출력(JSON Schema)](/courses/structured-outputs) 문서에서 다룬다.

## 4. 동작 원리 (흐름·표·작은 코드)

전체 흐름은 컨트롤러 → 오케스트레이션 서비스 → LLM 서비스 → 저장 순이다.

```text
[planForm.jsp]
  POST /courses/ai/generate  (AiPlanRequestDTO)
        |
        v
AiPlanController.generatePlan()
  - 세션 loginUser 확인 (없으면 로그인 폼으로)
        |
        v
AiPlanServiceImpl.generateAndSavePlan()  @Transactional
  1) validateRequest()        입력 검증
  2) aiPlanGPTService.generatePlan()   GPT 호출 -> AiPlanResponseDTO
  3) TRAVEL_PLAN insert       plan_source=AI, is_public=0
  4) PLAN_SPOT insert (N건)   날짜별 spots, visit_order
        |
        v
redirect:/courses/my  (성공 플래시 메시지)
```

**입력 검증** (`validateRequest`)은 다음을 본다.

- 여행지(destination) 필수
- 시작일·종료일 필수
- 종료일이 시작일보다 앞서면 거부

검증 실패는 `IllegalArgumentException`으로 던지고, 컨트롤러가 이를 잡아 폼으로 되돌린다.

```java
// AiPlanController.generatePlan() 핵심
try {
    aiPlanService.generateAndSavePlan(requestDTO, loginUser.getUserIdx());
    return "redirect:/courses/my";          // 성공
} catch (IllegalArgumentException e) {
    return "redirect:/courses/ai/form";     // 검증 실패: 폼 복귀
} catch (Exception e) {
    return "redirect:/courses/ai/form";     // LLM/저장 실패: 폼 복귀
}
```

**저장 매핑**은 응답 DTO를 테이블 두 개로 펼친다.

| 응답 필드 | 저장 위치 | 비고 |
| --- | --- | --- |
| `title` | `TRAVEL_PLAN.title` | LLM이 생성한 제목 |
| 요청 `destination` | `TRAVEL_PLAN.destination` | 사용자 입력 그대로 |
| 요청 `startDate`/`endDate` | `TRAVEL_PLAN.start_date`/`end_date` | 검증된 날짜 |
| (고정) | `TRAVEL_PLAN.is_public = 0` | 기본 비공개 |
| (고정) | `TRAVEL_PLAN.plan_source = AI` | AI 출처 표시 |
| `days[].spots[].name` | `PLAN_SPOT.place_name` | AI 자유 장소명 |
| `days[].date` | `PLAN_SPOT.visit_date` | 날짜별 그룹 |
| `days[].spots[].visitOrder` | `PLAN_SPOT.visit_order` | 방문 순서 |

:::tip 왜 spot_id가 비어 있나
AI가 만든 장소명은 자유 텍스트라 실제 `SPOT_TRAVEL` 마스터 데이터와 1:1로 매칭하지 않는다. 그래서 `PLAN_SPOT.spot_id`는 `null`로 두고 `place_name`만 채운다. 즉 AI 일정의 장소는 "이름표"이지 탐색 도메인의 정식 스팟 참조가 아니다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 입력 폼 + 생성 POST 흐름 | 구현됨 |
| 입력 검증(여행지·날짜·날짜 역전) | 구현됨 |
| GPT-4o-mini 호출 + Structured Outputs 파싱 | 구현됨 |
| `TRAVEL_PLAN`/`PLAN_SPOT` 트랜잭션 저장 | 구현됨 |
| 기본 비공개·`plan_source=AI` | 구현됨 |
| 생성 결과 품질 정량 평가 | 없음 (향후 과제) |
| AI 장소의 실제 스팟 매칭 | 미구현 (place_name만 저장) |

:::warning 코드 정직성 메모
현재 `AiPlanGPTServiceImpl`은 설정 주입 키(`@Value` openai.api.key)가 아니라 클래스 안에 박힌 테스트 키를 사용하도록 되어 있다. 또한 실패 시 사용자 친화적 폴백 없이 예외를 그대로 던져 폼으로 되돌린다. 키 외부화와 재시도·폴백 전략은 운영 전 정리 대상이다. (학습 페이지에는 실제 키 값을 절대 싣지 않는다.)
:::

## 6. 면접 답변 3단계

1. **무엇**: "여행 조건을 입력받아 GPT-4o-mini로 날짜별 일정을 생성하고, 그 결과를 여행 계획 한 건과 방문 장소 여러 건으로 저장하는 기능을 만들었습니다."
2. **어떻게**: "LLM 응답은 JSON Schema strict 모드로 강제해 항상 같은 구조로 받고, 계획 저장과 장소 저장을 하나의 트랜잭션으로 묶어 부분 저장을 막았습니다. AI 초안이라 기본 비공개로 저장합니다."
3. **왜/효과**: "직접 작성과 같은 테이블·조회 흐름을 재사용하도록 설계해서, 출처는 plan_source 컬럼 하나로만 구분하고 이후 기능 분기를 최소화했습니다."

## 7. 꼬리질문 + 모범답안

:::details LLM이 깨진 JSON을 주면 어떻게 되나
Structured Outputs를 strict 모드로 켜서 모델이 스키마를 벗어난 출력을 하지 못하게 강제합니다. 그래도 파싱이 실패하면 `AiPlanGPTServiceImpl`이 예외를 던지고, 트랜잭션 전체가 롤백되며 사용자는 폼으로 돌아갑니다. 즉 깨진 결과가 DB에 부분 저장되는 일은 없습니다.
:::

:::details 왜 계획과 장소를 한 트랜잭션으로 묶었나
한 번의 AI 생성은 논리적으로 한 단위입니다. 계획만 저장되고 장소 저장 중 실패하면 빈 껍데기 계획이 남습니다. `generateAndSavePlan`에 `@Transactional`을 걸어 둬서 중간 실패 시 계획 insert까지 모두 롤백됩니다.
:::

:::details AI 일정을 왜 기본 비공개로 두나
AI 초안은 사용자가 검토·수정하기 전 상태입니다. 그대로 공개 피드에 노출되면 품질이 들쭉날쭉한 결과가 퍼질 수 있어, `is_public = 0`으로 저장하고 사용자가 의도적으로 공개 전환하도록 했습니다. 공개 전환 로직은 공개 코스 피드 쪽에서 다룹니다.
:::

:::details place_name만 저장하면 지도 표시나 추천은 어떻게 하나
현재 AI 장소는 자유 텍스트라 `spot_id`가 없어 탐색 도메인의 정식 스팟과 연결되지 않습니다. 그래서 지도 핀이나 스팟 기반 추천에는 직접 쓰이지 않습니다. 향후 장소명을 실제 `SPOT_TRAVEL`과 매칭해 `spot_id`를 채우면 두 도메인을 연결할 수 있고, 이는 현재 미구현 과제입니다.
:::

:::details 입력 검증을 컨트롤러가 아니라 서비스에 둔 이유
검증은 비즈니스 규칙(날짜 역전 금지 등)이라 트랜잭션 경계 안의 서비스에 둬서 호출 경로와 무관하게 같은 규칙이 적용되게 했습니다. 컨트롤러는 세션 로그인 확인과 리다이렉트만 담당하고, 검증 실패는 `IllegalArgumentException`으로 받아 메시지와 함께 폼으로 돌려보냅니다.
:::

## 8. 직접 말해보기

- AI 일정 생성 요청 한 번이 DB에 어떤 행들을 남기는지, `TRAVEL_PLAN`과 `PLAN_SPOT`를 들어 설명해 보라.
- LLM 응답을 신뢰할 수 있게 만든 두 가지 장치(구조화 출력, 트랜잭션)를 각각 어떤 실패를 막는지와 함께 말해 보라.
- AI 일정과 직접 작성 일정이 같은 모델을 공유하는데 무엇이 다른지, `plan_source`와 기본 공개 여부로 답해 보라.

## 퀴즈

<QuizBox question="AI 일정 생성에서 LLM 응답이 항상 같은 JSON 구조로 오도록 강제하는 장치는 무엇인가?" :choices="['Structured Outputs(JSON Schema strict)', '정규식 후처리', 'JSP 템플릿 검증', 'MyBatis resultMap']" :answer="0" explanation="AiPlanGPTServiceImpl은 OpenAI Structured Outputs를 strict 모드로 사용해 모델이 정의된 스키마만 따르도록 강제한다." />

<QuizBox question="generateAndSavePlan에 @Transactional을 건 주된 이유는?" :choices="['응답 속도를 높이려고', '계획과 장소 저장 중 실패하면 모두 롤백해 부분 저장을 막으려고', '캐시를 무효화하려고', '동시 접속자를 제한하려고']" :answer="1" explanation="계획 insert와 여러 장소 insert를 한 단위로 묶어, 중간 실패 시 빈 껍데기 계획이 남지 않도록 한다." />

<QuizBox question="AI가 생성한 일정이 저장될 때 TRAVEL_PLAN에 들어가는 기본값으로 옳은 것은?" :choices="['plan_source 값은 MANUAL, 공개 상태', 'plan_source 값은 AI, 기본 비공개', 'plan_source 비움, 기본 공개', 'is_public 값은 1, 출처 없음']" :answer="1" explanation="AI 초안은 plan_source 값을 AI로, is_public 값을 0(비공개)으로 저장해 검토 전 노출을 막는다." />
