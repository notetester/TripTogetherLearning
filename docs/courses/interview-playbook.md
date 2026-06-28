---
title: "코스·AI일정 면접 플레이북"
owner: D
domain: "여행 코스·AI 일정"
tags: ["면접"]
---

# 코스·AI일정 면접 플레이북

> 여행 코스·AI 일정 도메인을 1분/3분으로 압축해 말하고, "왜 Structured Outputs인가 / 왜 plan_source로 출처를 나눴나 / 왜 트랜잭션 롤백인가"를 근거와 함께 방어하고, 꼬리질문 10여 개를 미리 막는 한 장.

## 1. 한 줄 정의

이 페이지는 **여행 코스·AI 일정 도메인을 면접에서 말로 풀어내기 위한 대본**이다. 새 기능 설명이 아니라, [개요](/courses/)부터 [공개 코스 피드](/courses/public-feed)까지 흩어진 내용을 면접 길이(1분/3분)와 질문 유형별로 재배열했다. 도메인 전체 지도는 [전체 개요](/domains)와 [전체 흐름](/flow/), 담당 태그별 보기는 [담당별 보기](/by-area/)에서 본다.

## 2. 왜 이렇게 설계했나 (말하기 전에 잡아둘 큰 그림)

면접에서 이 도메인은 "AI로 일정 만들어요"로 끝내면 진다. 채점자는 **AI를 어떻게 신뢰 가능한 데이터로 바꿨는지**를 듣고 싶어 한다. 코스 도메인은 세 가지 설계 결정으로 요약되고, 플레이북 전체가 이 셋을 변주한다.

| 결정 | 무엇을 골랐나 | 한 줄 이유 |
| --- | --- | --- |
| AI 출력 형식 | 자유 텍스트가 아니라 **OpenAI Structured Outputs(json_schema, strict=true)** | LLM 응답을 파싱 가능한 DTO로 강제해 후처리 분기를 없앤다 |
| 일정 출처 | 한 테이블에 **plan_source(MANUAL/AI) 컬럼**으로 통합 | 직접 작성과 AI 생성을 같은 TRAVEL_PLAN으로 다루되 이력은 구분 |
| 저장 일관성 | AI 호출+여러 INSERT를 **하나의 @Transactional**로 | 일부만 저장된 반쪽 일정을 만들지 않는다 |

여기에 부가 결정 두 개가 붙는다. AI가 만든 자유 장소명은 실제 마스터 데이터(SPOT_TRAVEL)와 매칭하지 않으므로 **spot_id를 비워(null) 저장**하고, 비공개/공개 일정은 상세 조회에서 **소유권 + is_public 가드**로 노출을 통제한다.

## 3. 1분 / 3분 대본

### 1분 버전 (엘리베이터)

> "TripTogether의 코스 도메인은 **직접 작성 일정과 AI 생성 일정을 같은 테이블로 통합**한 구조입니다. 사용자가 여행지와 기간을 넣으면 OpenAI GPT-4o-mini를 호출하는데, 자유 텍스트가 아니라 **Structured Outputs**로 JSON Schema를 strict 모드로 강제합니다. 그래서 응답이 항상 title/summary/days 형태로 와서 별도 파싱 분기가 필요 없습니다. 받은 일정은 TRAVEL_PLAN 한 건과 날짜별 PLAN_SPOT 여러 건으로 저장하는데, **AI 호출과 모든 INSERT를 하나의 트랜잭션**으로 묶어 중간에 실패하면 통째로 롤백합니다. 일정 출처는 plan_source 컬럼에 MANUAL/AI로 남겨 구분합니다."

### 3분 버전 (구조 + 근거)

1분 버전을 말한 뒤, 아래 네 갈래로 살을 붙인다.

1. **한 번의 AI 생성 흐름** — `POST /courses/ai/generate`가 들어오면 컨트롤러는 세션의 loginUser를 확인하고, `AiPlanServiceImpl.generateAndSavePlan`이 요청 검증 → GPT 호출 → DB 저장을 순서대로 한다. 이 메서드 전체에 `@Transactional`이 걸려 있다.
2. **출력을 신뢰 가능하게** — GPT 호출은 `AiPlanGPTServiceImpl`이 담당한다. developer 프롬프트로 역할을, response_format으로 JSON Schema를 strict=true로 지정해 모델이 스키마를 벗어난 텍스트를 못 내게 한다. 받은 JSON은 곧장 `AiPlanResponseDTO`(title/summary/days)로 역직렬화한다.
3. **저장 모델** — days 배열을 풀어 날짜별 spot을 PLAN_SPOT에 넣는다. AI 장소명은 마스터와 매칭하지 않으므로 spot_id는 null, place_name과 visit_order만 채운다. 일정 헤더는 TRAVEL_PLAN에 plan_source=AI, is_public=0으로 들어간다.
4. **소유권과 공개** — 상세 조회(`/courses/detail`)는 본인 일정이거나 is_public=1일 때만 보여준다. 둘 다 아니면 목록으로 돌려보낸다. 수정·삭제는 본인 일정만 가능하다.

## 4. 동작 원리 (말로 쓰기 좋은 표·흐름)

### AI 일정 생성 한 호흡

```text
POST /courses/ai/generate
  → 세션 loginUser 확인 (없으면 로그인 폼)
  → @Transactional 시작
      → validateRequest (여행지·기간 필수, 종료일이 시작일보다 앞이면 거부)
      → AiPlanGPTService.generatePlan  (OpenAI 호출 + JSON Schema strict)
      → AiPlanResponseDTO 역직렬화 (title / summary / days)
      → TRAVEL_PLAN insert (plan_source=AI, is_public=0)
      → days 순회 → PLAN_SPOT insert (spot_id=null, place_name, visit_order)
  → 커밋 → redirect /courses/my
  (어느 단계든 예외 → 전체 롤백, redirect /courses/ai/form)
```

### 응답 DTO 계층

| DTO | 담는 것 |
| --- | --- |
| `AiPlanResponseDTO` | title, summary, days 배열 |
| `AiDayDTO` | dayNo, date, theme, spots 배열 |
| `AiSpotDTO` | name, description, visitOrder |

스키마의 required와 additionalProperties=false 덕에 위 필드는 항상 채워져 온다고 가정하고 코드를 쓸 수 있다.

### 핵심 테이블 두 개

| 테이블 | 키 컬럼 | 면접 포인트 |
| --- | --- | --- |
| `TRAVEL_PLAN` | plan_id, user_idx, plan_source, is_public, share_token, is_deleted | 출처·공개·소프트삭제가 한 행에 |
| `plan_spot` | plan_id, spot_id(nullable), place_name, visit_date, visit_order | 순서 유니크 제약 + ON DELETE CASCADE |

`plan_spot`에는 (plan_id, visit_date, visit_order) 유니크 키가 있어 같은 날 같은 순번이 두 개 생기지 않는다. plan_id는 TRAVEL_PLAN을 외래키로 참조하고 CASCADE라 일정이 사라지면 스팟도 함께 정리된다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 정직하게 구분
면접에서 가장 점수가 갈리는 지점이다. 구현된 것과 미완을 섞어 말하면 신뢰를 잃는다.
:::

- **구현됨** — 직접 일정 CRUD, AI 일정 생성·저장, Structured Outputs strict 스키마, @Transactional 롤백, plan_source 구분, 소유권/공개 가드, 순서 유니크 제약, 소프트삭제(is_deleted).
- **부분/주의** — AI가 만든 장소는 SPOT_TRAVEL 마스터와 연결되지 않는다(spot_id=null). 즉 AI 일정의 장소는 좌표·리뷰 같은 탐색 도메인 데이터와 자동으로 이어지지 않는다. 이는 의도된 단순화이자 향후 보강 지점이다.
- **계획/미완** — AI 응답 품질의 정량 평가 체계는 아직 없다(프롬프트·스키마로 형식만 보장). share_token 기반 외부 공유 링크는 컬럼·유니크 제약은 있으나 본격적인 공개 공유 UX는 확장 영역이다.

:::warning 보안 한 줄
OpenAI 키 같은 비밀값은 `@Value("${...}")`로 주입해 `API_KEY` 환경값에서 읽는 게 원칙이다. 소스에 키를 하드코딩하면 공개 저장소에 노출되므로, 발표 시에도 키 자체는 절대 화면에 띄우지 않는다.
:::

## 6. 면접 답변 3단계 (결론 → 근거 → 한계)

어떤 질문이 와도 이 틀로 답한다.

1. **결론 먼저** — "직접 작성과 AI 생성을 한 테이블로 통합하고, AI 출력은 strict 스키마로 강제했습니다."
2. **근거(코드/제약)** — "json_schema strict=true라 응답 형식이 보장되고, 생성-저장을 @Transactional로 묶어 반쪽 일정이 없습니다. plan_spot의 (plan_id, visit_date, visit_order) 유니크로 순서 중복도 DB가 막습니다."
3. **한계 인정** — "다만 AI 장소는 마스터 데이터와 매칭하지 않아 spot_id가 비고, 응답 품질 정량 평가는 향후 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details 왜 자유 텍스트 대신 Structured Outputs인가?
자유 텍스트는 모델이 인사말·마크다운·코드블록을 섞어 내보낼 수 있어 파싱이 깨지기 쉽다. response_format에 JSON Schema를 strict=true로 주면 모델이 스키마를 벗어난 출력을 못 하므로, 받은 문자열을 곧바로 AiPlanResponseDTO로 역직렬화할 수 있다. 후처리 분기와 방어 코드가 줄어드는 것이 핵심 이득이다.
:::

:::details 왜 plan_source 컬럼을 따로 두었나? 테이블을 분리하지 않은 이유는?
직접 작성 일정과 AI 일정은 저장 구조(TRAVEL_PLAN + PLAN_SPOT)가 동일하다. 테이블을 둘로 쪼개면 조회·목록·상세를 모두 두 벌로 만들어야 한다. 그래서 한 테이블에 plan_source(MANUAL/AI) 한 컬럼으로 출처만 태깅했다. 통계나 UI 배지처럼 출처가 필요한 곳만 이 값을 읽으면 된다.
:::

:::details @Transactional이 없으면 무슨 일이 생기나?
AI 호출 뒤 TRAVEL_PLAN은 저장됐는데 PLAN_SPOT 일부 INSERT에서 예외가 나면, 스팟 없는 빈 일정이 DB에 남는다. 트랜잭션으로 묶으면 어느 단계든 실패 시 전체가 롤백돼 그런 반쪽 데이터가 생기지 않는다. 생성-저장을 원자적 단위로 본 것이다.
:::

:::details AI 장소의 spot_id를 왜 null로 두나? 문제는 없나?
AI는 마스터에 없는 장소명도 자유롭게 만든다. 존재하지 않는 spot_id를 억지로 채우면 외래키 제약에 걸리거나 잘못된 장소와 연결된다. 그래서 place_name만 저장하고 spot_id는 비운다. 대가로 AI 일정의 장소는 탐색 도메인의 좌표·리뷰와 자동 연결되지 않는데, 이는 인지하고 있는 트레이드오프다.
:::

:::details 비공개 일정이 URL로 새지 않게 어떻게 막나?
상세 조회에서 일정을 불러온 뒤 isOwner(작성자=로그인 사용자)와 isPublic(is_public=1)을 계산한다. 둘 다 거짓이면 메시지와 함께 목록으로 리다이렉트한다. plan_id를 추측해 남의 비공개 일정에 접근해도 본문이 노출되지 않는다. 수정·삭제는 본인 일정만 통과한다.
:::

:::details 같은 날 같은 순서의 스팟이 중복 저장되면?
plan_spot에 (plan_id, visit_date, visit_order) 유니크 키가 있어 DB 차원에서 중복이 막힌다. 애플리케이션 검증을 빠뜨려도 마지막 방어선이 DB라는 점을 강조하면 좋다.
:::

:::details GPT-4o-mini를 고른 이유는?
일정 생성은 짧은 구조화 JSON을 빠르게 받는 작업이라 비용·지연이 중요하다. 경량 모델로 충분한 품질을 내면서 응답을 스키마로 강제하므로, 큰 모델 없이도 형식 안정성을 확보했다. 모델은 설정값으로 주입해 교체 가능하게 두었다.
:::

## 8. 직접 말해보기

녹음하고 30초 안에 끊기. 막히면 위 표로 돌아간다.

1. (30초) "이 도메인의 핵심 설계 결정 세 가지"를 plan_source·Structured Outputs·트랜잭션으로 한 호흡에 말한다.
2. (45초) "AI 일정이 생성돼서 저장되기까지" 흐름을 검증→호출→역직렬화→두 테이블 저장→커밋/롤백 순으로 말한다.
3. (30초) "구현된 것과 미완"을 spot_id null과 응답 품질 평가 부재로 정직하게 구분해 말한다.

더 깊게는 [AI 일정 생성(GPT)](/courses/ai-plan-gpt), [구조화 출력(JSON Schema)](/courses/structured-outputs), [plan_source(MANUAL/AI)](/courses/plan-source), [공개 코스 피드](/courses/public-feed)로 이어 읽는다.

## 퀴즈

<QuizBox question="AI 일정 생성에서 OpenAI Structured Outputs(json_schema strict)를 쓴 1차 목적은?" :choices="['응답 속도를 높이려고', 'LLM 출력을 정해진 JSON 형식으로 강제해 파싱을 안정화하려고', '번역을 자동화하려고', '비밀번호를 해싱하려고']" :answer="1" explanation="strict 스키마는 모델이 형식을 벗어나지 못하게 해 받은 문자열을 곧바로 AiPlanResponseDTO로 역직렬화할 수 있게 한다." />

<QuizBox question="generateAndSavePlan 전체를 하나의 트랜잭션으로 묶은 이유로 가장 적절한 것은?" :choices="['AI 호출 비용을 줄이려고', 'TRAVEL_PLAN만 저장되고 PLAN_SPOT은 누락된 반쪽 일정을 막으려고', '공개 일정만 저장하려고', '세션을 유지하려고']" :answer="1" explanation="생성-저장을 원자적 단위로 묶어, 중간 실패 시 전체 롤백으로 일관성을 보장한다." />

<QuizBox question="AI가 만든 자유 장소를 PLAN_SPOT에 저장할 때 spot_id를 비우는(null) 이유는?" :choices="['용량을 아끼려고', 'AI 장소명이 SPOT_TRAVEL 마스터와 매칭되지 않기 때문', '관리자만 보게 하려고', '순서를 무시하려고']" :answer="1" explanation="존재하지 않는 spot_id를 억지로 채우면 외래키 제약 위반이나 잘못된 연결이 생기므로 place_name만 저장한다." />
