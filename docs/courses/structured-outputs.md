---
title: "구조화 출력 (JSON Schema)"
owner: D
domain: "여행 코스·AI 일정"
tags: ["구조화출력", "JSON"]
---

# 구조화 출력 (JSON Schema)

> LLM의 자유 텍스트를 JSON Schema로 강제해, 파싱 실패 없이 곧바로 DTO로 역직렬화하고 DB에 저장하는 설계.

이 페이지는 TripTogether의 여행 코스·AI 일정 도메인에서 OpenAI의 Structured Outputs를 어떻게 쓰는지를 다룬다. 4명이 도메인을 나눠 만든 팀 프로젝트이며, 여기서 설명하는 부분은 그중 AI 일정 생성 흐름이다.

## 1. 한 줄 정의

구조화 출력은 LLM 응답을 미리 정의한 JSON Schema에 맞추도록 강제해, 모델이 항상 같은 구조의 JSON만 내놓게 만드는 기능이다. TripTogether는 사용자의 여행 조건을 받아 `title`, `summary`, `days[]` 형태의 일정 JSON을 받고, 이를 `AiPlanResponseDTO`로 역직렬화해 `TRAVEL_PLAN`과 `plan_spot` 테이블에 저장한다.

## 2. 왜 이렇게 설계했나

AI 일정은 결과를 화면에 보여주고 끝나는 게 아니라 **DB의 정규화된 두 테이블에 행으로 들어가야** 한다. 자유 텍스트 응답을 정규식이나 휴리스틱으로 파싱하면 모델이 말투를 바꾸거나 마크다운 코드블록을 덧붙이는 순간 깨진다.

- **파싱 신뢰성**: 스키마를 강제하면 항상 같은 키·타입이 보장되어, 후처리 파서 없이 `ObjectMapper.readValue(content, AiPlanResponseDTO.class)` 한 줄로 끝난다.
- **DB 매핑 일관성**: `visitOrder` 같은 필드는 `plan_spot.visit_order`(NOT NULL)와 직결된다. 모델이 이 값을 빠뜨리면 INSERT가 실패하므로, 스키마의 `required`로 누락을 원천 차단한다.
- **트랜잭션 안전성**: 응답이 항상 유효한 구조라는 전제가 있어야 한 번의 `@Transactional` 안에서 계획과 장소들을 통째로 저장하거나 통째로 롤백할 수 있다.

:::tip
구조화 출력의 핵심은 프롬프트로 부탁하는 게 아니라 API 차원에서 스키마를 강제한다는 점이다. 프롬프트의 형식 지시는 보조일 뿐, 진짜 보증은 `strict: true`가 한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 컨트롤러 | `AiPlanController` (`/courses/ai`) | 폼 표시, 세션 로그인 확인 후 생성 위임 |
| 서비스(흐름) | `AiPlanServiceImpl` | 입력 검증 → GPT 호출 → DB 저장, `@Transactional` |
| 서비스(LLM) | `AiPlanGPTServiceImpl` | OpenAI 호출·스키마 구성·역직렬화 |
| 요청 DTO | `AiPlanRequestDTO` | destination/startDate/endDate/companion/style/budget/requestText |
| 응답 DTO | `AiPlanResponseDTO` | title, summary, `List<AiDayDTO> days` |
| 응답 DTO(일자) | `AiDayDTO` | dayNo, date, theme, `List<AiSpotDTO> spots` |
| 응답 DTO(장소) | `AiSpotDTO` | name, description, visitOrder |
| 테이블 | `TRAVEL_PLAN` | 계획 헤더 (plan_source, is_public, share_token) |
| 테이블 | `plan_spot` | 일자별 장소 (place_name, visit_date, visit_order) |

모델은 OpenAI GPT-4o-mini이며, 응답 형식은 `response_format`에 `type = json_schema`, `strict = true`로 지정한다. 스키마는 `buildJsonSchemaResponseFormat()`에서 코드로 직접 조립한다.

## 4. 동작 원리 (흐름·표·작은 코드)

전체 흐름은 다음과 같다.

1. 사용자가 `/courses/ai/form`에서 여행 조건을 입력한다.
2. `AiPlanController.generatePlan`이 세션의 `loginUser`를 확인하고 `AiPlanService`로 넘긴다.
3. `AiPlanServiceImpl.validateRequest`가 여행지·날짜 필수값과 종료일이 시작일보다 빠른지를 검증한다.
4. `AiPlanGPTServiceImpl.generatePlan`이 developer/user 두 메시지와 JSON Schema를 담아 OpenAI에 POST한다.
5. 응답 JSON의 `choices[0].message.content`(스키마를 만족하는 JSON 문자열)를 꺼내 `AiPlanResponseDTO`로 역직렬화한다.
6. `savePlanSpots`가 days를 순회하며 각 spot을 `plan_spot` 행으로 저장한다.

스키마는 중첩 객체 배열 구조이며, 각 단계마다 `required`와 `additionalProperties = false`를 건다.

```java
// AiPlanGPTServiceImpl#buildJsonSchemaResponseFormat (요약)
schema.put("type", "object");
schema.put("additionalProperties", false);
schema.put("properties", Map.of(
    "title",   Map.of("type", "string"),
    "summary", Map.of("type", "string"),
    "days",    Map.of("type", "array", "items", dayItemSchema) // dayNo/date/theme/spots
));
schema.put("required", List.of("title", "summary", "days"));
// spot 항목: required = name, description, visitOrder
```

스키마 트리와 DTO·테이블의 대응은 다음과 같다.

| JSON Schema 경로 | 매핑 DTO 필드 | 저장 위치 |
| --- | --- | --- |
| title | `AiPlanResponseDTO.title` | `TRAVEL_PLAN.title` |
| summary | `AiPlanResponseDTO.summary` | (헤더 저장 시 미사용, 화면 요약용) |
| days[].dayNo / date / theme | `AiDayDTO` | date는 `plan_spot.visit_date`로 변환 |
| days[].spots[].name | `AiSpotDTO.name` | `plan_spot.place_name` |
| days[].spots[].visitOrder | `AiSpotDTO.visitOrder` | `plan_spot.visit_order` (NOT NULL) |

저장 단계의 핵심은 AI가 만든 자유 장소명은 실제 `SPOT_TRAVEL` 마스터와 매칭하지 않는다는 점이다. 그래서 `spot_id`는 비워 두고 `place_name`만 채운다. 계획 헤더는 `plan_source = AI`, `is_public = 0`(비공개)으로 생성된다.

```java
// AiPlanServiceImpl#savePlanSpots (요약)
planSpotVO.setSpot_id(null);            // AI 자유 장소명은 마스터와 미매칭
planSpotVO.setPlace_name(spot.getName());
planSpotVO.setVisit_date(visitDate);    // day.date 파싱
planSpotVO.setVisit_order(spot.getVisitOrder());
```

:::warning
`plan_spot`에는 (plan_id, visit_date, visit_order) 유니크 제약이 있다. 같은 날 같은 순번이 중복되면 INSERT가 실패하므로, `visitOrder`가 일자 안에서 유일하게 채워지는 것이 중요하다. 스키마가 `visitOrder`를 required로 강제하는 이유 중 하나다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: 폼 입력 → 검증 → GPT-4o-mini Structured Outputs 호출 → DTO 역직렬화 → `TRAVEL_PLAN` + `plan_spot` 저장의 전 과정이 동작한다. JSON Schema `strict = true`, 중첩 `required`/`additionalProperties = false`도 코드에 반영되어 있다.
- **트랜잭션**: 저장은 `@Transactional`로 묶여 일부 실패 시 롤백된다.
- **한계·계획**: AI 장소는 `SPOT_TRAVEL` 마스터와 자동 매칭되지 않아 `spot_id`가 비어 있다(좌표·지도 연동 대상에서 제외). 응답 품질의 정량 평가 체계는 아직 없다. 키 관리·예외 경로 등 일부는 운영 환경에서 외부 설정으로 분리해야 한다.

:::warning 보안 메모
이 흐름은 외부 LLM API 호출을 포함한다. API 키·DB 접속정보 같은 비밀값은 절대 소스에 하드코딩하지 말고 환경변수/외부 설정(`API_KEY`, `DB_HOST` 등 자리표시자)으로 주입해야 한다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "여행 조건을 받아 GPT-4o-mini의 Structured Outputs로 JSON Schema를 강제해, 파싱 실패 없이 일정 JSON을 DTO로 받아 DB에 저장합니다."
2. **설계 의도**: "응답이 화면 표시에서 끝나지 않고 정규화된 두 테이블에 행으로 들어가야 했습니다. 자유 텍스트 파싱은 깨지기 쉬워, API 차원에서 스키마를 강제하고 후처리 파서를 없앴습니다."
3. **구체화**: "스키마는 title/summary/days 3중 중첩이고, 각 단계에 required와 additionalProperties=false를 걸었습니다. 특히 visitOrder는 plan_spot의 NOT NULL 순번과 직결돼 required로 강제했고, 저장 전체를 @Transactional로 묶었습니다."

## 7. 꼬리질문 + 모범답안

:::details 프롬프트로 형식을 지시하면 되는데 왜 JSON Schema까지 쓰나요?
프롬프트 지시는 확률적이라 모델이 코드블록을 덧붙이거나 키를 바꾸면 파싱이 깨집니다. Structured Outputs는 strict 모드에서 API가 스키마 준수를 보장하므로, 휴리스틱 파서 없이 ObjectMapper 한 줄로 안전하게 역직렬화할 수 있습니다.
:::

:::details strict=true와 additionalProperties=false는 각각 무엇을 막나요?
strict는 스키마 외 형식 일탈을 막아 항상 같은 구조를 보장하고, additionalProperties=false는 정의하지 않은 키가 끼어드는 것을 막습니다. 둘이 함께 작동해야 DTO에 없는 필드로 인한 매핑 오류나 예기치 않은 데이터 유입을 차단할 수 있습니다.
:::

:::details visitOrder가 비면 어떤 문제가 생기나요?
plan_spot.visit_order는 NOT NULL이고 (plan_id, visit_date, visit_order)에 유니크 제약이 있습니다. 값이 비면 INSERT가 실패하고, 중복되면 같은 날 순번 충돌이 납니다. 그래서 스키마에서 required로 누락을 막고, 일자 안에서 순번이 유일하도록 합니다.
:::

:::details AI가 만든 장소를 왜 SPOT_TRAVEL과 매칭하지 않나요?
AI는 마스터에 없는 자유 장소명도 생성합니다. 억지로 매칭하면 잘못된 좌표나 엉뚱한 장소로 연결될 위험이 있어, 안전하게 spot_id를 비우고 place_name만 저장합니다. 정확 매칭과 좌표 연동은 후속 과제로 분리했습니다.
:::

:::details 저장 중 일부 장소만 들어가는 부분 실패는 어떻게 막나요?
generateAndSavePlan 전체가 @Transactional이라, 계획 헤더와 장소 INSERT 중 하나라도 실패하면 모두 롤백됩니다. 응답이 항상 유효한 구조라는 보장이 있어야 이 트랜잭션 전제가 성립하므로, 구조화 출력과 트랜잭션은 한 쌍으로 묶여 동작합니다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 1분 안에 답해 보세요.

- 자유 텍스트 응답 대신 JSON Schema를 강제했을 때 사라지는 코드와 늘어나는 안정성을 각각 한 문장으로 설명해 보세요.
- `title`, `summary`, `days[]`가 각각 어디에 저장되는지(또는 저장되지 않는지) 매핑을 말해 보세요.
- `spot_id`를 null로 두는 결정의 트레이드오프를 설명해 보세요.

## 퀴즈

<QuizBox question="TripTogether AI 일정에서 응답 JSON을 곧바로 DTO로 안전하게 역직렬화할 수 있게 보장하는 핵심 설정은 무엇인가" :choices="['response_format의 json_schema와 strict true', '프롬프트에 JSON으로 답하라고 적기', '응답을 정규식으로 후처리하기', '마크다운 코드블록 제거기']" :answer="0" explanation="API 차원에서 json_schema와 strict true로 스키마를 강제하므로 후처리 파서 없이 ObjectMapper로 바로 역직렬화할 수 있다." />

<QuizBox question="AI가 생성한 장소를 plan_spot에 저장할 때 spot_id를 비워 두는 이유로 가장 적절한 것은" :choices="['AI 자유 장소명을 SPOT_TRAVEL 마스터와 매칭하지 않기 때문', 'spot_id 컬럼이 존재하지 않아서', 'visit_order와 충돌하기 때문', '공개 여부가 비공개여서']" :answer="0" explanation="AI는 마스터에 없는 자유 장소명을 만들 수 있어 잘못된 매칭을 피하려고 spot_id를 null로 두고 place_name만 저장한다." />

<QuizBox question="AiSpotDTO에서 plan_spot의 NOT NULL 순번 컬럼과 직접 대응하여 스키마 required로 강제되는 필드는 무엇인가" :choices="['visitOrder', 'description', 'theme', 'summary']" :answer="0" explanation="visitOrder는 plan_spot.visit_order와 직결되며 NOT NULL 및 일자 내 순번 유니크 제약 때문에 누락을 막아야 한다." />
