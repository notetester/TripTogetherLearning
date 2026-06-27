# JSON

> JSON은 TripTogether에서 객체와 텍스트 사이를 오가는 공용 데이터 포맷이다. 핵심은 두 갈래 — 자바 객체를 외부 API 본문으로 보내는 **직렬화/역직렬화**와, AI 모델이 **구조화 JSON**으로 답하게 강제하는 두 가지 전략(OpenAI Structured Outputs vs Gemini 프롬프트 강제)이다.

## 1. 한 줄 정의

JSON(JavaScript Object Notation)은 `{ "key": value }` 형태의 텍스트 데이터 교환 포맷이고, **직렬화(serialize)** 는 자바 객체를 이 텍스트로, **역직렬화(deserialize)** 는 텍스트를 다시 객체로 바꾸는 과정이다. TripTogether에서 JSON은 두 곳에서 주역이다 — 외부 AI API와의 HTTP 통신, 그리고 AI 응답을 사람 손이 아니라 코드가 파싱할 수 있는 형태로 받아내는 일.

## 2. 왜 이렇게 설계했나

TripTogether는 OpenAI(GPT-4o-mini), Google Gemini 2.5 Flash, Anthropic Claude Haiku를 동시에 쓴다. 이 모델들의 공통 인터페이스가 **JSON over HTTP**다. 모델이 자연어 문장 하나를 토해내면 화면에 그대로 못 박는 것 말고는 할 수 있는 게 없다. 반면 모델이 `{ "title": ..., "days": [...] }` 같은 **구조화된 JSON**을 주면, 그걸 DB 테이블(`TRAVEL_PLAN`/`PLAN_SPOT`)에 매핑하거나, 링크 버튼·빠른답변 칩 같은 UI 컴포넌트로 렌더링할 수 있다.

문제는 LLM이 "JSON으로 답해"라고만 하면 종종 앞에 인사말을 붙이거나 마크다운 코드블록으로 감싸 깨진 JSON을 준다는 점이다. TripTogether는 이 위험을 **모델별로 다른 강도**로 막는다.

- **OpenAI(AI 일정 생성)**: Structured Outputs + `strict: true` JSON Schema. 모델 디코딩 단계에서 스키마를 강제하므로 깨질 여지 자체가 거의 없다.
- **Gemini(사이트 네비 챗봇)**: `responseMimeType: application/json`으로 "JSON만 내라"는 출력 형식만 지정하고, 스키마 검증은 **수신 측 코드에서 방어적으로** 한다.

이 차이가 이 페이지의 핵심이다. 같은 "구조화 JSON 받기"라도 제공자 능력에 따라 책임이 모델 쪽에 있느냐, 우리 파싱 코드 쪽에 있느냐가 갈린다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

TripTogether는 JSON 라이브러리를 **두 개** 쓴다. 이건 의도된 통일이 아니라 모듈별 작성자 선택의 결과이며, 면접에서 정직하게 말할 포인트다.

| 라이브러리 | 쓰이는 곳 | 대표 호출 |
| --- | --- | --- |
| **Jackson** (`ObjectMapper`) | AI 일정 생성, 공통 설정 | `objectMapper.readTree(...)`, `readValue(content, AiPlanResponseDTO.class)` |
| **Gson** (`Gson`, `JsonParser`) | assistant 멀티턴, common 챗봇 | `new Gson().toJson(body)`, `JsonParser.parseString(text).getAsJsonObject()` |

핵심 클래스/파일:

- `config/JacksonConfig` — 공통 `ObjectMapper` 빈. `JavaTimeModule` 등록 + `WRITE_DATES_AS_TIMESTAMPS` 비활성(날짜를 ISO 문자열로). Spring Boot 4 환경에서 자동 등록이 보장되지 않아 명시적으로 둔다.
- `ai/service/AiPlanGPTServiceImpl` — OpenAI 호출. `response_format`에 JSON Schema를 손으로 조립(`buildJsonSchemaResponseFormat`), 응답을 `AiPlanResponseDTO`로 역직렬화.
- `ai/dto/AiPlanResponseDTO` → `AiDayDTO` → `AiSpotDTO` — 3단 중첩 DTO. JSON Schema의 `title/summary/days[]/spots[]` 구조와 1:1 대응.
- `common/service/ChatbotService` — Gemini 호출. 응답 텍스트를 `JsonParser`로 다시 파싱해 `ChatbotResponseVO`로 빌드.
- `common/vo/ChatbotResponseVO` — `message`, `links[]`(중첩 `SiteLink`), `quickReplies[]`, `inappropriate` 필드를 가진 응답 VO.
- `assistant/service/AssistantServiceImpl` — 요청 본문은 `Gson().toJson(...)`으로 만들고, 응답은 `JsonParser`로 `choices[0].message.content`만 뽑는다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. AI 일정 생성 — 스키마로 강제하는 왕복 (OpenAI / Jackson)

```text
요청 DTO ─▶ JSON Schema(strict=true) 동봉 ─▶ OpenAI
                                              │
응답 본문 ─ readTree ─▶ choices[0].message.content (JSON 문자열)
                                              │
        readValue(content, AiPlanResponseDTO.class) ─▶ 자바 객체 트리
```

`response_format`은 `{ type: "json_schema", json_schema: { name, strict: true, schema } }` 모양이고, `schema`는 `Map`/`List`로 손수 조립한다. `additionalProperties: false` + `required` 배열을 모든 객체 레벨에 박아, 모델이 정의 안 된 키를 끼워넣거나 필드를 빠뜨리지 못하게 한다.

```java
// AiPlanGPTServiceImpl — 응답을 DTO로 한 번에 역직렬화
JsonNode root = objectMapper.readTree(responseBody);
String content = root.path("choices").get(0)
                     .path("message").path("content").asText();
return objectMapper.readValue(content, AiPlanResponseDTO.class); // JSON → 객체
```

여기서 `content`는 **JSON 문자열 안에 또 JSON 문자열**이 들어 있는 이중 구조다. 바깥은 OpenAI API 응답 봉투, 안쪽 `content`가 실제 일정 JSON. 그래서 `readTree`(트리 탐색)로 봉투를 까고, 안쪽만 `readValue`(객체 매핑)로 처리한다.

### 4-2. 사이트 네비 챗봇 — 형식만 강제하고 직접 파싱 (Gemini / Gson)

```java
// ChatbotService — 출력 형식만 JSON으로 지정
generationConfig.addProperty("responseMimeType", "application/json");
...
// 응답을 다시 파싱하며 모든 키를 방어적으로 확인
JsonObject json = JsonParser.parseString(text).getAsJsonObject();
vo.setInappropriate(json.has("inappropriate") && json.get("inappropriate").getAsBoolean());
if (json.has("links") && !json.get("links").isJsonNull()) { ... }
```

여기엔 strict 스키마가 없다. 대신 시스템 프롬프트가 정확한 JSON 모양(`message`/`links`/`quickReplies`/`inappropriate`)을 예시로 못 박고, **수신 코드가 `json.has(key)` + `isJsonNull()`로 필드 존재를 일일이 확인**한 뒤에만 읽는다. 모델이 키를 빠뜨려도 NPE 없이 빈 리스트로 흘러가게 만드는, 외부 응답을 신뢰하지 않는 방어적 파싱이다.

### 4-3. 두 전략 비교

| 항목 | AI 일정 (OpenAI) | 챗봇 (Gemini) |
| --- | --- | --- |
| 강제 수단 | Structured Outputs JSON Schema `strict=true` | `responseMimeType: application/json` + 프롬프트 |
| 검증 책임 | 모델(디코딩 단계) | 수신 코드(`has`/`isJsonNull`) |
| 라이브러리 | Jackson `readValue` → DTO | Gson `JsonParser` → VO 수동 빌드 |
| 결과 타입 | `AiPlanResponseDTO`(중첩 record/DTO) | `ChatbotResponseVO`(+`SiteLink`) |
| 깨진 JSON 위험 | 매우 낮음 | 상대적으로 높음 → 방어 코드로 흡수 |

### 4-4. 파싱된 JSON의 후처리 — 신뢰 경계

챗봇이 돌려준 `links[].url`은 그대로 버튼이 되므로, 파싱 직후 **URL 화이트리스트 검사 + 위험 스킴(`javascript:`/`data:`/`file:`) 및 경로순회 차단**을 거친다. JSON 역직렬화는 "구조를 복원"할 뿐 "내용이 안전함"을 보장하지 않는다는 원칙 — 외부에서 온 JSON 값은 항상 검증 후 사용한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- AI 일정 생성의 OpenAI Structured Outputs(`strict=true`) 왕복과 `AiPlanResponseDTO` 역직렬화 — 동작.
- Gemini 챗봇의 `responseMimeType: application/json` + 방어적 Gson 파싱 → `ChatbotResponseVO` — 동작.
- 공통 `JacksonConfig`(날짜 ISO 직렬화) — 동작.
- 파싱 후 URL 화이트리스트/위험 스킴 차단 — 동작.
:::

:::warning 한계 · 정직하게
- **JSON 라이브러리 이원화**: 같은 프로젝트에서 Jackson과 Gson이 혼재한다. 기능엔 문제없지만 일관성·유지보수 관점에선 정리 대상이다.
- Gemini 쪽은 **스키마 검증이 아니라 프롬프트 + 수신 코드 방어**에 의존한다. 모델이 형식을 어기면 fallback VO로 떨어지는 경로가 있다.
- AI 응답 JSON의 **내용 품질**(일정이 실제로 합리적인지)에 대한 정량 평가 체계는 없다(향후 과제).
:::

## 6. 면접 답변 3단계

1. **한 줄**: "JSON은 TripTogether가 LLM·외부 API와 데이터를 주고받는 공용 포맷이고, AI 응답을 코드가 다룰 수 있게 구조화해 받는 게 핵심이었습니다."
2. **설계 이유**: "자연어 한 덩어리는 화면에 박는 것 외엔 못 씁니다. 일정을 DB에 저장하거나 링크 버튼을 렌더링하려면 구조화 JSON이 필요했고, LLM이 형식을 어기는 걸 막는 게 관건이었습니다."
3. **구현 차이**: "OpenAI는 Structured Outputs의 `strict=true` JSON Schema로 모델 단계에서 형식을 강제했고, Gemini는 `responseMimeType: application/json`으로 형식만 지정한 뒤 수신 코드에서 `has`/`isJsonNull` 방어 파싱으로 안전망을 뒀습니다. 라이브러리는 전자가 Jackson, 후자가 Gson입니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. `readTree`와 `readValue`를 둘 다 쓴 이유는?
응답이 **이중 JSON**이기 때문입니다. 바깥은 OpenAI API 봉투(`choices[0].message.content`)이고, 그 `content` 값이 또 하나의 JSON 문자열입니다. 봉투는 구조가 가변적이라 `readTree`로 트리 탐색해 안쪽 문자열만 뽑고, 그 안쪽은 우리가 정의한 `AiPlanResponseDTO`와 1:1이라 `readValue`로 객체 매핑했습니다.
:::

:::details Q2. JSON Schema의 `additionalProperties: false`와 `required`를 모든 레벨에 넣은 이유는?
Structured Outputs의 `strict` 모드를 제대로 활용하려는 의도입니다. `additionalProperties: false`는 모델이 정의되지 않은 키를 추가하지 못하게 하고, `required`는 필드 누락을 막습니다. 둘을 day·spot 같은 중첩 객체까지 박아야 깨진 부분 없이 DTO로 안전하게 역직렬화됩니다.
:::

:::details Q3. Gemini는 왜 strict 스키마를 안 쓰고 방어적 파싱을 했나요?
사이트 네비 챗봇은 `message`/`links`/`quickReplies`/`inappropriate`처럼 상대적으로 단순한 구조라 `responseMimeType: application/json`으로 출력 형식만 지정했습니다. 대신 모델이 키를 빠뜨릴 가능성을 가정하고, 수신 코드에서 `json.has(key)`와 `isJsonNull()`로 존재를 확인한 뒤에만 읽어 NPE 없이 빈 값으로 흡수되게 했습니다. 외부 응답을 신뢰하지 않는 방어적 파싱입니다.
:::

:::details Q4. 파싱한 JSON 값을 바로 쓰지 않고 추가 검증한 부분이 있나요?
챗봇이 준 `links[].url`은 화면 버튼이 되므로, 역직렬화 직후 URL 화이트리스트와 위험 스킴(`javascript:`/`data:`/`file:`)·경로순회 차단을 거칩니다. JSON 역직렬화는 구조를 복원할 뿐 내용이 안전하다는 보장이 아니므로, 외부 출처 값은 항상 검증 후 사용한다는 원칙을 적용했습니다.
:::

:::details Q5. Jackson과 Gson이 섞여 있는 건 의도인가요?
의도된 표준화는 아니고 모듈별 작성 시점의 선택이 누적된 결과입니다. AI 일정·공통 설정은 Jackson(`ObjectMapper`), assistant·common 챗봇은 Gson(`JsonParser`)을 씁니다. 기능엔 문제가 없지만 일관성·의존성 관리 관점에선 하나로 수렴시키는 게 개선 방향이라고 보고 있습니다.
:::

## 8. 직접 말해보기

- TripTogether에서 JSON이 주역인 두 지점을 들고, 각각 어떤 라이브러리를 썼는지 30초로 설명해 보세요.
- "OpenAI는 모델이 형식을 보장하고, Gemini는 우리 코드가 보장한다"를 구체 메서드(`strict` 스키마 vs `has`/`isJsonNull`)와 함께 말해 보세요.
- 이중 JSON(봉투 안의 JSON)을 왜 `readTree` → `readValue` 2단계로 처리했는지 설명해 보세요.

더 넓은 맥락은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 이어집니다.

## 퀴즈

<QuizBox question="AI 일정 생성(OpenAI)에서 모델이 JSON 형식을 거의 깨지 않게 만든 핵심 수단은?" :choices="['응답을 정규식으로 후처리한다', 'Structured Outputs의 strict=true JSON Schema로 디코딩 단계에서 형식을 강제한다', '프롬프트에 JSON 예시만 넣는다', 'Gson으로 파싱하면 자동 보정된다']" :answer="1" explanation="AiPlanGPTServiceImpl은 response_format에 strict=true JSON Schema를 동봉해 모델 디코딩 단계에서 형식을 강제한다. additionalProperties:false와 required를 중첩 레벨까지 박아 누락·잉여 키를 막는다." />

<QuizBox question="Gemini 챗봇(ChatbotService)이 응답 JSON을 다루는 방식으로 옳은 것은?" :choices="['strict JSON Schema로 모델이 형식을 보장한다', 'responseMimeType: application/json으로 형식만 지정하고, 수신 코드가 has/isJsonNull로 방어적으로 파싱한다', 'Jackson readValue로 곧장 DTO에 매핑한다', '응답을 검증 없이 그대로 버튼 URL로 사용한다']" :answer="1" explanation="Gemini 쪽은 responseMimeType으로 출력 형식만 JSON으로 지정하고, 스키마 검증 대신 수신 코드에서 json.has(key)와 isJsonNull()로 필드 존재를 확인한 뒤 읽는다. links의 url은 추가로 화이트리스트·위험 스킴 차단을 거친다." />

<QuizBox question="AiPlanGPTServiceImpl이 OpenAI 응답을 readTree로 한 번, readValue로 또 한 번 처리하는 이유는?" :choices="['Jackson 버그 우회용이다', '응답이 API 봉투 JSON 안에 또 JSON 문자열(content)이 든 이중 구조라, 봉투는 트리 탐색으로 까고 안쪽만 DTO로 매핑하기 때문이다', '날짜 직렬화 때문이다', 'Gson과 호환을 맞추려고']" :answer="1" explanation="바깥 choices[0].message.content는 가변 봉투라 readTree로 안쪽 JSON 문자열을 뽑고, 그 문자열은 AiPlanResponseDTO와 1:1이라 readValue로 객체 매핑한다." />
