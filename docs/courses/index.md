---
title: "여행 코스·AI 일정 개요"
owner: D
domain: "여행 코스·AI 일정"
tags: ["코스", "AI일정"]
---

# 여행 코스·AI 일정 개요

> 여행 일정을 직접 작성하거나 GPT-4o-mini 구조화 출력으로 자동 생성하고, 공개 피드로 공유하는 도메인.

## 1. 도메인 소개

TripTogether의 사용자 여정은 탐색 → 계획 → 예약 → 공유로 이어진다. 그중 **계획(planning)** 단계를 담당하는 모듈이 `courses`다. 핵심 단위는 한 건의 **여행 일정(Travel Plan)**이고, 그 안에 날짜별 방문 장소(Plan Spot)가 순서대로 들어간다.

일정을 만드는 경로는 두 가지다.

| 경로 | 진입점 | 핵심 클래스 | 저장 시 `plan_source` |
| --- | --- | --- | --- |
| 직접 작성 | `/courses/write` → `POST /courses/insert` | `TravelPlanController` | `MANUAL` |
| AI 자동 생성 | `/courses/ai/form` → `POST /courses/ai/generate` | `AiPlanController` → `AiPlanService` | `AI` |

두 경로 모두 같은 테이블(`TRAVEL_PLAN`, `PLAN_SPOT`)에 저장되므로, 목록/상세/공개 피드는 출처와 무관하게 동일하게 동작한다. 차이는 `plan_source` 컬럼 하나로만 구분한다.

## 2. 담당 범위

이 도메인은 다음 백엔드 패키지와 화면을 포함한다.

- `org.triptogether.courses.controller` — `TravelPlanController`(CRUD·목록·상세·공개), `AiPlanController`(AI 폼·생성)
- `org.triptogether.courses.service` — `TravelPlanService`(영속성·소유권), `AiPlanService`(요청 검증·AI 호출·저장 오케스트레이션)
- `org.triptogether.courses.vo` — `TravelPlanVO`, `PlanSpotVO`, `SpotTravelVO`
- `org.triptogether.ai`(코스에서 사용하는 부분) — `AiPlanGPTService`(OpenAI 호출), `AiPlanRequestDTO` / `AiPlanResponseDTO` / `AiDayDTO` / `AiSpotDTO`
- JSP 뷰 — `courses/main`, `courses/write`, `courses/my`, `courses/public`, `courses/detail`, `courses/edit`, `ai/planForm`

:::tip
AI 호출 자체(`AiPlanGPTService`)는 `org.triptogether.ai` 패키지에 있다. 코스 도메인은 이를 **조립해서 쓰는 소비자**이고, 모델 호출 책임은 AI 공통 영역에 둔다. 이 경계가 "일정 생성 흐름"과 "모델 통신"을 분리해 준다.
:::

## 3. 핵심 기술

세 가지 축으로 이해하면 면접에서 막힘없이 설명할 수 있다.

**(1) 직접 일정 작성 — 표준 4계층 CRUD**
세션의 `loginUser`에서 사용자를 식별하고, `plan_source`를 `MANUAL`로 고정해 저장한다. 목록은 본인 것만, 공개 피드는 `is_public = 1`만 노출한다. 상세·수정·삭제는 모두 `user_idx` 소유권 가드를 통과해야 한다.

**(2) AI 일정 생성 — GPT-4o-mini 오케스트레이션**
`AiPlanServiceImpl.generateAndSavePlan()`이 흐름의 중심이다. `@Transactional`로 묶여 있어 일정 헤더(`TRAVEL_PLAN`) 저장 후 장소(`PLAN_SPOT`) 저장 중 하나라도 실패하면 전부 롤백된다.

```text
요청 검증 → AiPlanGPTService.generatePlan() (OpenAI)
        → AiPlanResponseDTO(title, summary, days[])
        → TRAVEL_PLAN insert (plan_source = AI)
        → days/spots 순회하며 PLAN_SPOT insert
        → 전체 @Transactional
```

**(3) 구조화 출력(Structured Outputs) — JSON Schema strict 모드**
`AiPlanGPTServiceImpl`은 OpenAI Chat Completions에 `response_format = json_schema`(`strict: true`)를 보낸다. 모델 응답이 스키마를 100% 준수하도록 강제해, 파싱 단계의 방어 코드를 줄인다. 스키마는 `title`, `summary`, `days[]`(각 day는 `dayNo`, `date`, `theme`, `spots[]`)로 정의되고, Jackson `ObjectMapper`가 곧장 `AiPlanResponseDTO`로 역직렬화한다.

:::details 응답 DTO 계층 (실제 필드)
- `AiPlanResponseDTO` : `title`, `summary`, `days`
- `AiDayDTO` : `dayNo`, `date`, `theme`, `spots`
- `AiSpotDTO` : `name`, `description`, `visitOrder`

AI가 만든 장소명은 실제 `SPOT_TRAVEL` 레코드와 매칭하지 않으므로, `PLAN_SPOT`에는 `spot_id`를 비워 두고 `place_name`(자유 텍스트)만 저장한다. 직접 작성 일정이 실제 스팟을 참조할 수 있는 점과 대비되는 설계다.
:::

## 4. 권장 학습 순서

데이터 모델 → 직접 작성 → AI 생성 → 구조화 출력 순으로 보면 추상화가 점점 올라가 이해가 매끄럽다.

1. [직접 일정 작성](/courses/manual-plan) — `MANUAL` 경로와 표준 CRUD 흐름
2. [스팟 순서 관리](/courses/plan-spot-ordering) — `PLAN_SPOT`의 `visit_date` / `visit_order`
3. [AI 일정 생성(GPT)](/courses/ai-plan-gpt) — `AiPlanService` 오케스트레이션과 `@Transactional`
4. [구조화 출력(JSON Schema)](/courses/structured-outputs) — `strict: true` 스키마와 안전한 파싱
5. [plan_source(MANUAL/AI)](/courses/plan-source) — 두 출처를 한 테이블로 통합하는 설계
6. [공개 코스 피드](/courses/public-feed) — `is_public` 노출 정책
7. [CRUD·소유권](/courses/crud-ownership) — `user_idx` 소유권 가드와 권한 분리
8. [면접 플레이북](/courses/interview-playbook) — 도메인 통합 답변 정리

상위 맥락은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 확인한다.

## 5. 구현 상태 (됨 vs 계획)

| 항목 | 상태 |
| --- | --- |
| 직접 일정 CRUD·소유권·공개 피드 | 구현됨 |
| AI 일정 생성 + `@Transactional` 저장 | 구현됨 |
| Structured Outputs(`json_schema` strict) | 구현됨 |
| 다국어 일정 번역(`SpotTextTranslationService`) | 구현됨 |
| AI 장소의 실제 `SPOT_TRAVEL` 매칭 | 계획(현재 자유 텍스트만 저장) |
| AI 일정 품질 정량 평가 | 미구현(향후 과제) |

:::warning
실제 코드의 `AiPlanGPTServiceImpl`에는 키를 상수로 하드코딩하고 `@Value`로 주입한 키 대신 그 상수를 쓰는 흔적이 남아 있다. 이는 명백한 보안 안티패턴으로, 키는 반드시 환경변수/런타임 설정(`API_KEY` 형태)으로 주입하고 코드·저장소에 노출하지 않아야 한다. 면접에서는 "발견했고 환경변수 주입으로 교정 대상"이라고 정직하게 말하는 편이 낫다.
:::

## 6. 단골 면접 질문 5개

1. **직접 작성과 AI 생성 일정을 어떻게 한 테이블로 다루나요?**
   `plan_source` 컬럼(`MANUAL` / `AI`) 하나로 출처만 구분하고, 저장 구조(`TRAVEL_PLAN` + `PLAN_SPOT`)와 조회 로직은 공유한다. 덕분에 목록·상세·공개 피드 코드가 분기 없이 재사용된다.

2. **AI 일정 생성에서 트랜잭션 경계를 어디에 뒀나요?**
   `AiPlanServiceImpl.generateAndSavePlan()` 전체에 `@Transactional`을 걸었다. 헤더 저장 후 다수의 `PLAN_SPOT` insert 중 하나라도 실패하면 일정 자체가 롤백돼 반쪽짜리 일정이 남지 않는다.

3. **모델 응답 형식은 어떻게 보장하나요?**
   OpenAI Structured Outputs를 `strict: true` JSON Schema로 사용한다. 모델이 스키마를 벗어난 텍스트를 못 내도록 강제하므로, Jackson 역직렬화 실패 위험과 방어 파싱 코드가 크게 줄어든다.

4. **AI가 만든 장소를 실제 여행지 데이터와 연결하나요?**
   현재는 아니다. AI 장소명은 자유 텍스트라 `PLAN_SPOT.spot_id`를 비우고 `place_name`만 저장한다. 실제 `SPOT_TRAVEL` 매칭은 계획 단계의 과제다.

5. **다른 사람의 비공개 일정에 접근하면 어떻게 막나요?**
   상세 조회에서 `isOwner`(본인 `user_idx`)와 `isPublic`(`is_public = 1`)을 모두 검사한다. 둘 다 아니면 목록으로 리다이렉트한다. 수정·삭제는 본인만 가능하도록 별도 소유권 가드를 둔다.

## 퀴즈

<QuizBox question="직접 작성 일정과 AI 생성 일정을 한 테이블에서 구분하는 컬럼은 무엇인가요?" :choices="['is_public', 'plan_source', 'visit_order', 'share_token']" :answer="1" explanation="plan_source 컬럼에 MANUAL 또는 AI 값을 저장해 출처만 구분하고, 저장 구조와 조회 로직은 공유합니다." />

<QuizBox question="AI 일정 생성에서 헤더 저장과 장소 저장의 원자성을 보장하는 장치는 무엇인가요?" :choices="['세션 락', 'try-catch 무시', 'generateAndSavePlan에 건 Transactional', '비동기 큐']" :answer="2" explanation="AiPlanServiceImpl.generateAndSavePlan 전체가 Transactional이라 PLAN_SPOT insert 중 실패 시 일정 헤더까지 롤백됩니다." />

<QuizBox question="OpenAI 응답이 정해진 형식을 따르도록 강제하기 위해 사용한 방식은 무엇인가요?" :choices="['프롬프트로만 부탁', 'JSON Schema strict 모드의 Structured Outputs', '정규식 후처리', '응답을 사람이 검수']" :answer="1" explanation="response_format을 json_schema strict true로 지정해 모델이 스키마를 벗어나지 못하게 하고, 그대로 AiPlanResponseDTO로 역직렬화합니다." />
