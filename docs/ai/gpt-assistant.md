# GPT 어시스턴트·AI 일정

> 같은 GPT-4o-mini 모델을 두 가지 다른 방식으로 쓴다 — 어시스턴트는 자유 텍스트 멀티턴, AI 일정은 JSON Schema로 응답 형식을 강제하는 구조화 출력.

## 1. 한 줄 정의

TripTogether는 OpenAI GPT-4o-mini를 두 도메인에서 활용한다. `assistant` 모듈은 대화 맥락을 유지하는 다국어 멀티턴 여행 도우미(자유 텍스트)이고, `courses` 모듈의 AI 일정 생성은 Structured Outputs(JSON Schema, strict)로 응답을 고정 구조의 여행 일정 객체로 받아 DB에 저장한다.

## 2. 왜 이렇게 설계했나

두 기능은 "LLM에게 무엇을 기대하는가"가 다르다. 그래서 같은 모델을 쓰면서도 호출 방식이 갈린다.

| 관점 | 멀티턴 어시스턴트 | AI 일정 생성 |
| --- | --- | --- |
| 사용자 기대 | 대화처럼 묻고 답하기 | 화면·DB에 들어갈 정형 데이터 |
| 응답 형태 | 자유 텍스트(마크다운 허용) | 고정 스키마 JSON만 |
| 맥락 | 이전 대화 누적(멀티턴) | 단발성 요청(폼 1회) |
| 파싱 실패 위험 | 낮음(사람이 읽음) | 높음 → 스키마로 차단 |
| 저장 | 대화 로그(`CHAT_POST`) | 일정 엔티티(`TRAVEL_PLAN`) |

자유 텍스트를 그대로 받아 DB에 넣으려면 인사말·코드블록·마크다운을 일일이 정규식으로 걷어내야 하고, 필드 하나가 빠지면 파싱이 깨진다. AI 일정 쪽은 이 문제를 모델 단에서 막기 위해 Structured Outputs를 선택했다. 반대로 어시스턴트는 가독성과 자연스러움이 중요하므로 형식을 강제하지 않는다.

:::tip 핵심 대비
"형식이 깨져도 사람이 읽으면 그만"이면 자유 텍스트, "그대로 코드가 받아 DB에 넣어야" 하면 Structured Outputs. 모델 선택보다 응답 계약(contract) 설계가 먼저다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 멀티턴 어시스턴트 | AI 일정 생성 |
| --- | --- | --- |
| 서비스 | `AssistantServiceImpl` | `AiPlanServiceImpl` + `AiPlanGPTServiceImpl` |
| 컨트롤러 | `AssistantController` (`/assistant/**`) | `AiPlanController` (`/courses/ai/**`) |
| HTTP 클라이언트 | Spring `RestTemplate` | Spring `RestTemplate` |
| 요청 DTO | `Map` 페이로드(message, chatPostIdx) | `AiPlanRequestDTO` |
| 응답 매핑 | Gson으로 choices 파싱 | Jackson → `AiPlanResponseDTO` |
| 저장 테이블 | `CHAT_POST`, `CHAT_COMMENT` | `TRAVEL_PLAN`, `PLAN_SPOT` |
| 매퍼 | `AssistantMapper` | `TravelPlanMapper` |

공통 모델 설정은 `application.properties`의 `openai.model`(기본값 `gpt-4o-mini`)과 `openai.api.key`를 `@Value`로 주입한다. OpenAI Chat Completions 엔드포인트(`/v1/chat/completions`)를 두 기능 모두 호출한다.

:::warning 구현상의 키 관리 주의
현재 두 GPT 서비스는 키를 코드 상수에 직접 박아 호출하도록 임시 처리된 흔적이 있고, `@Value` 주입 경로는 주석으로 비활성화돼 있다. 운영 전 반드시 환경변수/런타임 설정(`APPLICATION_RUNTIME_SETTING`, `is_secret`)으로 외부화해야 한다. 이 문서를 포함해 공개물에는 실제 키 값(`API_KEY`)을 절대 노출하지 않는다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 멀티턴 어시스턴트

요청마다 `system` 프롬프트 1개 + 누적된 대화(`user`/`assistant` 역할) 메시지를 함께 보낸다. 응답을 받으면 히스토리에 붙이고, 길이가 `MAX_HISTORY`(20)를 넘으면 오래된 메시지부터 잘라낸다(슬라이딩 윈도우).

```text
[요청 messages]
 ├─ system : buildSystemPrompt(lang)   ← 매 호출 재생성
 ├─ user   : 이전 질문
 ├─ assistant : 이전 답변
 └─ user   : 이번 질문(temperature 0.7)
```

다국어는 응답을 기계번역하지 않고 `LANG_NAME_MAP`(ko/en/ja/zh)으로 시스템 프롬프트의 응답 언어 지시만 바꾼다. 언어 코드는 컨트롤러에서 `LocaleContextHolder`로 꺼낸다.

```java
// AssistantServiceImpl — 응답 언어를 프롬프트로 지정 (요지)
String langName = LANG_NAME_MAP.getOrDefault(lang, "Korean (한국어)");
// "항상 %s 로 답변하세요" 형태로 system 프롬프트에 주입
```

로그인 사용자는 대화가 DB에 저장된다. 한 대화 세션이 `CHAT_POST` 1건, 각 발화가 `CHAT_COMMENT` 1건이며 `comment_role`(USER/ASSISTANT)과 `comment_order`로 순서를 보존한다. `CHAT_COMMENT`는 (chat_post_idx, comment_order) 유니크 제약으로 순번 중복을 막는다. 비로그인 사용자는 세션(`chatHistory`)에만 임시 보관한다(DB 미저장). 저장 메서드는 `@Transactional`이라 사용자/어시스턴트 발화가 함께 커밋된다.

### 4-2. AI 일정 생성 (Structured Outputs)

폼 입력(`AiPlanRequestDTO`: destination, startDate, endDate, companion, style, budget, requestText)을 검증한 뒤 GPT에 `developer`+`user` 두 역할 메시지를 보내되, 핵심은 `response_format`에 JSON Schema를 넣고 `strict=true`로 둔 점이다.

```text
response_format = json_schema (strict: true)
 └─ title, summary, days[]
      └─ dayNo, date, theme, spots[]
            └─ name, description, visitOrder
```

`additionalProperties:false` + `required`로 모델이 스키마 밖 필드를 못 만들게 막는다. 응답 본문(`choices[0].message.content`)은 보장된 JSON이라 Jackson이 그대로 `AiPlanResponseDTO`(→ `AiDayDTO` → `AiSpotDTO`)로 역직렬화한다. 이후 `TRAVEL_PLAN`(plan_source = AI, is_public = 0 비공개 기본)과 날짜별 `PLAN_SPOT`(visit_order로 방문 순서)으로 저장한다.

| 흐름 단계 | 처리 |
| --- | --- |
| 1. 폼 제출 | `/courses/ai/generate`, 로그인 확인 |
| 2. 검증 | 여행지·날짜 필수, 종료일이 시작일보다 빠르면 예외 |
| 3. GPT 호출 | developer 프롬프트 + 스키마 강제 |
| 4. 파싱 | content JSON → `AiPlanResponseDTO` |
| 5. 저장 | `TRAVEL_PLAN` 1건 + `PLAN_SPOT` N건 |

AI가 생성한 장소명은 실제 `SPOT_TRAVEL` 테이블과 매칭하지 않으므로 `PLAN_SPOT.spot_id`는 null로 두고 `place_name`에 자유 텍스트를 넣는다. 전 과정이 `@Transactional`이라 일정 헤더만 저장되고 스팟이 실패하는 부분 저장은 일어나지 않는다(롤백).

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 멀티턴 대화·히스토리 슬라이딩 윈도우(20) | 구현됨 |
| 4개국어 프롬프트 언어 전환 | 구현됨 |
| 대화 DB 저장(`CHAT_POST`/`CHAT_COMMENT`) | 구현됨 |
| AI 일정 Structured Outputs(strict) | 구현됨 |
| 일정 → `TRAVEL_PLAN`/`PLAN_SPOT` 저장·트랜잭션 | 구현됨 |
| API 키 외부화(환경변수/런타임 설정) | 미흡(코드 하드코딩 흔적, 개선 필요) |
| 응답 품질 정량 평가 체계 | 부재(향후 과제) |
| 스트리밍 응답(토큰 단위) | 미구현 |
| 일정 스팟 ↔ 실제 SPOT_TRAVEL 매칭 | 계획(현재 spot_id null) |

## 6. 면접 답변 3단계

1. **한 문장**: 같은 GPT-4o-mini를 자유 텍스트 멀티턴(어시스턴트)과 JSON Schema 강제 구조화 출력(AI 일정)으로 나눠 썼습니다.
2. **이유 한 겹**: 사람이 읽는 답변과 코드가 DB에 넣어야 하는 데이터는 요구사항이 달라서, 후자는 Structured Outputs로 파싱 실패를 모델 단에서 차단했습니다.
3. **근거 한 겹**: 어시스턴트는 system 프롬프트로 응답 언어를 동적으로 지정하고 히스토리를 20개로 슬라이딩하며, 일정은 strict 스키마 응답을 Jackson으로 DTO에 매핑한 뒤 트랜잭션으로 `TRAVEL_PLAN`/`PLAN_SPOT`에 저장합니다.

## 7. 꼬리질문 + 모범답안

:::details 멀티턴 맥락은 어떻게 유지하나요? 토큰이 무한정 늘지 않나요?
요청마다 system 프롬프트 + 누적 대화를 함께 보내되, 메시지가 `MAX_HISTORY`(20)를 넘으면 가장 오래된 것부터 제거하는 슬라이딩 윈도우를 씁니다. 덕분에 맥락을 유지하면서도 컨텍스트 길이와 비용이 무한정 커지지 않습니다. 더 길게 가져가려면 요약 압축이나 임베딩 기반 회상을 붙이는 게 다음 단계입니다.
:::

:::details 다국어를 왜 번역 API 대신 프롬프트로 처리했나요?
GPT 응답을 사후 기계번역하면 어색하고 정보가 뭉개집니다. 대신 system 프롬프트에서 응답 언어만 지정하면(`LANG_NAME_MAP`으로 ko/en/ja/zh) 모델이 처음부터 해당 언어로 자연스럽게 답합니다. 번역 단계가 없으니 지연·비용·품질 모두 유리합니다.
:::

:::details Structured Outputs의 strict true가 구체적으로 무엇을 보장하나요?
모델이 우리가 준 JSON Schema를 반드시 따르도록 강제합니다. `additionalProperties false`로 스키마 밖 필드 생성을 막고 `required`로 누락을 막아, 응답이 항상 같은 구조라 Jackson 역직렬화가 깨지지 않습니다. 인사말·코드블록·마크다운이 섞여 파싱이 실패하는 사고를 모델 단에서 차단하는 게 핵심입니다.
:::

:::details AI가 만든 장소를 왜 실제 스팟 테이블과 연결하지 않았나요?
AI는 자유롭게 장소명을 생성하기 때문에 우리 `SPOT_TRAVEL` 마스터와 1:1로 맞지 않을 수 있습니다. 그래서 `PLAN_SPOT.spot_id`는 null로 두고 `place_name`에 텍스트로 저장합니다. 추후 이름·좌표 기반 매칭으로 실제 스팟과 연결해 상세·지도 연동을 확장할 계획입니다.
:::

:::details 일정 생성 중간에 실패하면 데이터가 깨지지 않나요?
생성·저장 메서드가 `@Transactional`이라, 일정 헤더(`TRAVEL_PLAN`)만 저장되고 스팟(`PLAN_SPOT`)이 실패하는 부분 저장은 롤백됩니다. 또 GPT 호출 전 여행지·날짜 필수와 종료일이 시작일보다 빠른지를 먼저 검증해 잘못된 입력으로 비싼 호출을 낭비하지 않습니다.
:::

## 8. 직접 말해보기

- 같은 모델을 어시스턴트와 AI 일정에서 다르게 호출하는 이유를 응답 계약 관점에서 한 문장으로 설명해 보세요.
- `MAX_HISTORY` 슬라이딩 윈도우가 없으면 어떤 문제가 생기는지 말해 보세요.
- strict JSON Schema가 막아 주는 구체적인 파싱 사고를 하나 들어 보세요.
- AI 일정 저장이 `@Transactional`이어야 하는 이유를 `TRAVEL_PLAN`/`PLAN_SPOT` 관계로 설명해 보세요.

## 퀴즈

<QuizBox question="멀티턴 어시스턴트가 대화 컨텍스트가 무한정 길어지지 않도록 쓰는 기법은?" :choices="['매 요청마다 새 세션 생성', 'MAX_HISTORY 20 기준 오래된 메시지부터 제거하는 슬라이딩 윈도우', '응답을 매번 요약해 1개로 압축', '히스토리를 아예 보내지 않음']" :answer="1" explanation="MAX_HISTORY 20을 넘으면 가장 오래된 메시지부터 제거해 맥락을 유지하면서 토큰과 비용 증가를 막는다." />

<QuizBox question="AI 일정 생성에서 응답을 고정 구조 JSON으로 강제하기 위해 사용하는 OpenAI 기능은?" :choices="['자유 텍스트 후 정규식 파싱', 'Structured Outputs JSON Schema strict true', 'temperature를 0으로 고정', '응답을 기계번역']" :answer="1" explanation="response_format에 JSON Schema를 넣고 strict true와 additionalProperties false로 스키마 밖 필드와 누락을 막아 파싱 실패를 차단한다." />

<QuizBox question="AI가 생성한 일정 장소가 PLAN_SPOT에 저장될 때 spot_id 값과 그 이유로 옳은 것은?" :choices="['실제 SPOT_TRAVEL과 자동 매칭되어 항상 채워진다', 'null로 두고 place_name에 자유 텍스트를 저장한다 - 마스터와 일치 보장이 없기 때문', '0으로 저장해 임시 스팟임을 표시한다', '저장하지 않고 항상 새 SPOT_TRAVEL을 만든다']" :answer="1" explanation="AI 자유 장소명은 SPOT_TRAVEL 마스터와 일치 보장이 없어 spot_id는 null, place_name에 텍스트로 저장한다. 추후 매칭은 계획 단계다." />
