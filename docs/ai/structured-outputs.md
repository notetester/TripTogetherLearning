# 구조화 출력 (Structured Outputs)

> LLM 응답을 자유 텍스트가 아니라 기계가 바로 파싱하는 JSON으로 강제해, 파싱 실패 없이 DB에 바로 저장한다.

## 1. 한 줄 정의

구조화 출력은 LLM에게 정해진 JSON 스키마로만 답하게 만들어, 응답을 정규식이나 문자열 자르기 없이 `ObjectMapper.readValue` 한 번으로 도메인 객체에 매핑하는 기법이다. TripTogether는 두 곳에서 사용한다: courses 도메인의 AI 일정 생성(OpenAI GPT-4o-mini, JSON Schema strict 모드)과 common 도메인의 사이트 네비 챗봇(Google Gemini 2.5 Flash, JSON MIME 타입).

## 2. 왜 이렇게 설계했나

LLM에게 일정을 만들어 달라고 하면 보통 인사말, 마크다운 표, 코드블록(```), 줄글 설명이 섞여 나온다. 이걸 서버가 받아서 DB에 넣으려면 텍스트를 직접 파싱해야 하는데, 모델이 형식을 조금만 바꿔도 파싱이 깨진다. 핵심 동기는 세 가지다.

- **파싱 신뢰성**: 자유 텍스트를 정규식으로 긁으면 모델 출력이 흔들릴 때마다 깨진다. 스키마로 형식을 고정하면 파싱 코드가 안정된다.
- **필수 필드 보장**: `PLAN_SPOT` 테이블에 저장하려면 `visitOrder`(방문 순서)가 반드시 있어야 한다. 스키마의 `required`로 강제하면 누락 자체가 발생하지 않는다.
- **계약 명시**: 응답 구조가 코드(스키마 빌더)에 박혀 있어, 프롬프트만 읽지 않아도 응답 형태를 알 수 있다.

:::tip 자유 텍스트 파싱 vs 구조화 출력
"3일차 첫 번째로 성산일출봉을 방문하세요" 같은 문장에서 day, order, 장소명을 뽑아내는 건 취약하다. 스키마로 `{dayNo, date, theme, spots:[{name, description, visitOrder}]}`를 받으면 추출 과정 자체가 사라진다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

두 경로는 같은 목표(파싱 가능한 JSON)에 다른 강제 수단을 쓴다.

| 구분 | AI 일정 생성 | 사이트 네비 챗봇 |
| --- | --- | --- |
| 모델 | OpenAI GPT-4o-mini | Google Gemini 2.5 Flash |
| 핵심 클래스 | `AiPlanGPTServiceImpl` | `ChatbotService` |
| 강제 수단 | `response_format` = json_schema, strict=true | `generationConfig.responseMimeType` = application/json |
| 응답 DTO | `AiPlanResponseDTO` → `AiDayDTO` → `AiSpotDTO` | `ChatbotResponseVO` (+ `SiteLink`) |
| 파서 | Jackson `ObjectMapper` | Gson `JsonParser` |
| 저장 | `AiPlanServiceImpl` → `PLAN_SPOT` / `TRAVEL_PLAN` | `CHAT_MESSAGE`(role assistant content JSON) |

- **AI 일정 스키마**: `AiPlanGPTServiceImpl.buildJsonSchemaResponseFormat()`가 중첩 스키마를 Map으로 조립한다. 최상위 `required`는 title, summary, days. 각 day는 dayNo, date, theme, spots를 required로, 각 spot은 name, description, visitOrder를 required로 둔다. 모든 object에 `additionalProperties=false`를 걸어 스키마에 없는 키가 끼지 못하게 한다.
- **응답 매핑**: `AiPlanResponseDTO`(title, summary, `List AiDayDTO`)와 `AiDayDTO`(dayNo, date, theme, `List AiSpotDTO`), `AiSpotDTO`(name, description, visitOrder) 필드명이 스키마 키와 1:1이라, JSON 문자열을 그대로 `objectMapper.readValue(content, AiPlanResponseDTO.class)`로 역직렬화한다.
- **챗봇 스키마**: `ChatbotService.SYSTEM_PROMPT`에 message, links, quickReplies, inappropriate 형태를 예시로 박고, `generationConfig`에 responseMimeType을 application/json으로 지정해 Gemini가 JSON 본문만 내도록 유도한다.

## 4. 동작 원리 (흐름·표·작은 코드)

### AI 일정: 스키마 강제 → 무손실 파싱 → DB 저장

```text
사용자 요청(AiPlanRequestDTO: destination, startDate, endDate, style ...)
  └ AiPlanServiceImpl.generateAndSavePlan() @Transactional
       ├ validateRequest()  종료일이 시작일보다 빠르면 예외
       ├ AiPlanGPTServiceImpl.generatePlan()
       │    ├ body.response_format = json_schema(strict=true)
       │    ├ OpenAI /v1/chat/completions 호출
       │    └ readValue(content, AiPlanResponseDTO.class)  ← 자유텍스트 파싱 없음
       └ savePlanSpots(): days×spots 순회 → PLAN_SPOT insert (visit_order = visitOrder)
```

strict=true의 핵심은 모델이 스키마를 벗어난 출력을 만들 수 없다는 것이다. 그래서 응답 `content`는 항상 유효한 JSON이고, required로 지정한 `visitOrder`가 빠지지 않으므로 `PlanSpotVO.setVisit_order(spot.getVisitOrder())`가 항상 값을 받는다.

```java
// AiPlanGPTServiceImpl — 응답을 객체로 직접 역직렬화
String content = root.path("choices").get(0)
        .path("message").path("content").asText();
return objectMapper.readValue(content, AiPlanResponseDTO.class);
```

```java
// AiPlanServiceImpl — visitOrder가 보장되므로 순서 정보가 안전하게 저장됨
planSpotVO.setPlace_name(spot.getName());
planSpotVO.setVisit_order(spot.getVisitOrder());
planSpotVO.setSpot_id(null); // AI 자유 장소명이라 SPOT_TRAVEL과 매칭 안 함
```

저장 시점에 `spot_id`를 null로 둔다는 점이 설계 포인트다. AI가 만든 장소명은 실제 `SPOT_TRAVEL` 테이블의 정규화된 여행지와 매칭하지 않고, `place_name` 자유 텍스트로만 보관한다. 즉 구조화 출력으로 형식은 고정하되, 장소 식별은 의도적으로 느슨하게 둔다.

### 챗봇: JSON MIME 강제 + 방어적 후처리

Gemini는 strict 스키마 대신 responseMimeType으로 JSON을 유도하므로, 모델이 코드블록을 덧붙이는 등 형식이 흔들릴 여지가 남는다. 그래서 `parseGeminiResponse`는 방어적으로 처리한다.

```java
// ```json 펜스를 제거한 뒤 파싱 — MIME 강제만으로 100% 보장되지 않으므로 방어
text = text.replaceAll("(?s)```json\\s*", "").replaceAll("```\\s*", "").trim();
JsonObject json = JsonParser.parseString(text).getAsJsonObject();
```

파싱 후에도 끝나지 않는다. `links[].url`은 화이트리스트(`ALLOWED_URL_PATTERNS`)와 위험 스킴 차단(`DANGEROUS_SCHEME_PATTERN`: javascript:, data:, file:, vbscript:), 경로 순회(..) 차단을 통과한 것만 남긴다. 구조화 출력은 형식을 보장할 뿐, 내용 안전까지 보장하지는 않는다는 전제가 코드에 반영돼 있다.

| 단계 | AI 일정 (strict 스키마) | 챗봇 (MIME JSON) |
| --- | --- | --- |
| 형식 강제 강도 | 강함 (스키마 위반 불가) | 중간 (JSON 유도) |
| 파싱 전 정제 | 불필요 | 코드블록 펜스 제거 |
| 파싱 실패 시 | 예외 → 일정 생성 실패 | `fallbackResponse()`로 안전 응답 |
| 후처리 | DB 저장 | URL 화이트리스트 검증 |

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| GPT-4o-mini AI 일정 JSON Schema strict 생성 | 구현됨 |
| `AiPlanResponseDTO` 무손실 역직렬화 → `PLAN_SPOT` 저장 | 구현됨 |
| `@Transactional` 일정+장소 일괄 저장, 검증 실패 롤백 | 구현됨 |
| Gemini 챗봇 responseMimeType JSON + URL 화이트리스트 | 구현됨 |
| 챗봇 파싱 실패 시 fallback 안전 응답 | 구현됨 |
| AI 응답 품질 정량 평가 체계 | 계획 (미구현) |

:::warning 정직한 한계
구조화 출력은 응답의 형식 유효성만 보장한다. 모델이 만든 일정이 현실적인지, 장소가 실제 존재하는지 같은 내용 품질은 별도로 검증하지 않는다. AI 응답 품질의 정량 평가 체계는 아직 없고 향후 과제다.
:::

## 6. 면접 답변 3단계

1. **결론**: TripTogether는 LLM 응답을 자유 텍스트로 받지 않고 JSON 스키마로 강제해, 정규식 파싱 없이 객체로 바로 매핑합니다. AI 일정 생성은 OpenAI strict 스키마, 챗봇은 Gemini의 JSON MIME 타입을 씁니다.
2. **이유**: 일정을 DB의 PLAN_SPOT에 저장하려면 visitOrder 같은 필드가 반드시 있어야 하는데, 자유 텍스트 파싱은 모델 출력이 흔들리면 깨집니다. strict 스키마의 required로 누락을 원천 차단하고 additionalProperties false로 잡음을 막습니다.
3. **트레이드오프**: strict 스키마는 형식은 완벽히 보장하지만 응답 내용의 품질까지 보장하진 못합니다. 그래서 챗봇 쪽은 파싱 후 URL 화이트리스트로 한 번 더 거르고, 응답 품질의 정량 평가는 향후 과제로 남겨뒀습니다.

## 7. 꼬리질문 + 모범답안

:::details strict=true와 단순 JSON 모드의 차이는?
strict 모드는 모델이 제출한 스키마를 절대 벗어날 수 없게 디코딩을 제약합니다. required 필드 누락이나 정의되지 않은 키가 구조적으로 불가능해집니다. 반면 Gemini의 responseMimeType application/json은 JSON 본문을 내도록 유도하는 수준이라, 코드블록 펜스가 붙는 등 형식이 흔들릴 수 있어 파싱 전에 펜스를 제거하는 방어 코드가 필요합니다.
:::

:::details additionalProperties를 false로 두는 이유는?
스키마에 정의되지 않은 키를 모델이 추가로 끼워 넣지 못하게 막습니다. 응답에 예상 못 한 필드가 섞이면 역직렬화나 후속 로직에서 잡음이 되므로, 모든 object 레벨에서 false로 닫아 계약을 엄격하게 만듭니다.
:::

:::details 구조화 출력인데도 URL 검증을 또 하는 이유는?
구조화 출력은 형식만 보장하지 내용 안전은 보장하지 않기 때문입니다. 챗봇은 모델이 만든 링크를 그대로 신뢰하지 않고, 내부 경로 화이트리스트와 위험 스킴 차단, 경로 순회 차단을 통과한 url만 남깁니다. 형식 신뢰와 내용 신뢰를 분리하는 게 핵심입니다.
:::

:::details AI 장소를 SPOT_TRAVEL과 매칭하지 않고 place_name으로만 저장하는 이유는?
AI가 생성한 장소명은 자유 텍스트라 정규화된 여행지 테이블과 1:1로 매칭된다는 보장이 없습니다. 억지로 매칭하면 잘못된 spot_id를 붙일 위험이 있어, spot_id는 null로 두고 place_name만 보관해 데이터 무결성을 지킵니다. 구조화는 형식 차원이고, 엔티티 연결은 별개 판단입니다.
:::

:::details 파싱이 실패하면 어떻게 되나?
AI 일정 경로는 생성 메서드 전체가 @Transactional이라 예외가 나면 TRAVEL_PLAN과 PLAN_SPOT 저장이 함께 롤백됩니다. 챗봇 경로는 사용자 경험을 끊지 않으려고 예외를 잡아 fallbackResponse 같은 안전 응답을 돌려주고, 대화 흐름은 유지합니다. 두 경로의 실패 정책이 다릅니다.
:::

## 8. 직접 말해보기

- "이 프로젝트에서 LLM 응답을 어떻게 안정적으로 파싱하나요?"라는 질문에 strict 스키마와 MIME JSON 두 방식의 차이를 들어 1분 안에 답해 본다.
- visitOrder가 required로 보장되는 흐름을 `AiPlanResponseDTO`에서 `PLAN_SPOT`까지 한 줄로 이어 설명해 본다.
- 구조화 출력이 보장하는 것과 보장하지 못하는 것을 각각 한 문장으로 구분해 말해 본다.

## 퀴즈

<QuizBox question="AI 일정 생성에서 visitOrder 누락을 구조적으로 막아 주는 장치는 무엇인가?" :choices="['프롬프트에 순서를 강조하는 문구', 'JSON Schema의 required 필드와 strict 모드', '응답을 받은 뒤 정규식으로 순서 재계산', 'PLAN_SPOT 테이블의 NOT NULL 제약만으로 보장']" :answer="1" explanation="strict 모드에서 visitOrder를 required로 지정하면 모델이 그 필드를 빠뜨릴 수 없어 누락 자체가 발생하지 않는다. DB 제약은 마지막 방어선일 뿐 누락을 사전에 막지는 못한다." />

<QuizBox question="챗봇이 Gemini의 responseMimeType을 application/json으로 지정했는데도 파싱 전에 코드블록 펜스를 제거하는 이유로 가장 적절한 것은?" :choices="['Gson이 펜스를 지원하지 않아서', 'MIME 강제는 JSON을 유도할 뿐 형식 흔들림 여지가 남아서', 'strict 모드를 끄기 위해서', '응답 속도를 높이기 위해서']" :answer="1" explanation="responseMimeType은 strict 스키마와 달리 JSON 본문을 유도하는 수준이라 모델이 코드블록을 덧붙일 수 있다. 그래서 파싱 전에 펜스를 제거하는 방어 코드가 필요하다." />

<QuizBox question="구조화 출력으로 형식이 보장된 챗봇 응답인데도 links의 url을 화이트리스트로 다시 검증하는 이유는?" :choices="['구조화 출력은 형식만 보장하고 내용 안전은 보장하지 않기 때문', 'JSON 파싱이 느려서', '모델이 url 필드를 자주 누락하기 때문', '다국어 번역을 적용하기 위해']" :answer="0" explanation="형식 유효성과 내용 안전은 별개다. 모델이 만든 링크에 외부 URL이나 위험 스킴이 섞일 수 있으므로 내부 경로 화이트리스트와 위험 스킴 차단을 통과한 url만 남긴다." />
