---
title: "구조화 JSON 응답"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["구조화출력"]
---

# 구조화 JSON 응답

> 챗봇은 자유 텍스트가 아니라 정해진 JSON 스키마로 답한다. 그래야 같은 응답을 말풍선·버튼·칩으로 동시에 렌더링하고, 링크를 검증·로깅할 수 있다.

## 1. 한 줄 정의

TripTogether 사이트 네비게이션 챗봇(Gemini 2.5 Flash 기반)이 모델에게 `responseMimeType=application/json` 으로 고정된 4개 필드 스키마(`message`, `links[]`, `quickReplies[]`, `inappropriate`)만 출력하도록 강제하고, 서버가 그 JSON을 파싱·검증해 UI가 바로 쓰는 객체로 변환하는 구조다.

## 2. 왜 이렇게 설계했나

챗봇 응답 하나가 화면에서 여러 UI 요소로 쪼개진다. 텍스트 말풍선, 클릭하면 페이지로 이동하는 링크 버튼, 후속 질문 칩, 그리고 부적절 여부 플래그. 이걸 모델이 자연어 한 덩어리로 뱉으면 프론트가 정규식으로 링크를 긁어내야 하고, 그 파싱은 모델 표현이 조금만 바뀌어도 깨진다.

- **렌더링 분리**: `message`는 말풍선, `links[]`는 버튼, `quickReplies[]`는 칩으로 1:1 매핑. 프론트가 추측할 필요가 없다.
- **링크 안전성**: 모델이 만든 URL을 그대로 믿지 않는다. 구조화돼 있으니 `url` 필드만 골라 화이트리스트·위험 스킴 검사에 통과시킬 수 있다.
- **저장·복원 일관성**: 같은 JSON 구조를 DB(`CHAT_MESSAGE.content`)에 저장하고, 대화 복원 시 프론트가 그대로 다시 파싱한다.
- **확장 여지**: `inappropriate` 같은 메타 플래그를 본문과 섞지 않고 별도 필드로 둬서, 부적절 판정·로깅을 깔끔하게 분기한다.

:::tip 비교 포인트
같은 프로젝트의 AI 일정 생성(`/assistant`)은 OpenAI GPT-4o-mini의 Structured Outputs(JSON Schema, strict=true)로 스키마를 강제한다. 챗봇은 Gemini의 `responseMimeType` + 프롬프트 내 스키마 명시 방식이다. 둘 다 목표는 같다 — 모델 출력을 코드가 신뢰할 수 있는 형태로 고정하는 것.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 요소 | 위치 |
|------|------|
| 메인 서비스 | `common/service/ChatbotService` (Gemini 호출·파싱·검증) |
| 응답 VO | `common/vo/ChatbotResponseVO` + 내부 `SiteLink` |
| 요청 VO | `common/vo/ChatbotRequestVO` |
| LLM 생략 경로 | `common/service/ChatbotFastPathService` (동일 VO로 즉답) |
| 진입 컨트롤러 | `common/controller/ChatbotController` (`POST /chatbot/ask`) |
| 저장 테이블 | `CHAT_MESSAGE`(content에 assistant JSON 저장), `CONVERSATION` |
| JSON 파서 | Gson(`JsonParser`, `JsonObject`, `JsonArray`) |

`ChatbotResponseVO`의 필드는 응답 스키마와 정확히 대응한다.

```java
String message;              // 말풍선 텍스트 (최대 3문장)
List<SiteLink> links;        // {label, url, icon}
List<String> quickReplies;   // 후속 질문 칩
boolean inappropriate;       // 부적절 플래그
// + conversationId, messageId (서버가 후처리에서 주입)
```

모델 호출은 Gemini `generateContent` 엔드포인트(`gemini-2.5-flash:generateContent`)에 `generationConfig.responseMimeType = application/json` 을 넣어 보낸다. API 키는 `gemini.api.key` 설정값으로, 코드·문서에는 자리표시자(API_KEY)로만 다룬다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 요청에 JSON 모드 강제

`callGemini`가 페이로드를 만들 때 출력 형식을 application/json으로 못 박는다.

```java
generationConfig.addProperty("responseMimeType", "application/json");
generationConfig.addProperty("maxOutputTokens", 1024);
generationConfig.addProperty("temperature", 0.7);
```

여기에 더해 시스템 프롬프트가 스키마를 한 번 더 명시한다. 핵심 규칙은 네 가지다.

- `message`: 최대 3문장, 줄바꿈은 백슬래시 n
- `links`: 직접 관련 있는 실제 경로만 0개에서 4개
- `quickReplies`: 자연스러운 후속 질문 0개에서 3개
- `inappropriate`: 욕설·무관 잡담·개인정보·스팸이면 true

### 4.2 응답 파싱 — 코드펜스 제거가 핵심

`responseMimeType`을 줘도 모델이 가끔 출력을 코드펜스로 감싸 돌려준다. 그대로 `JsonParser.parseString`에 넣으면 파싱이 깨지므로, 먼저 펜스를 벗긴다.

```java
text = text.replaceAll("(?s)```json\\s*", "")
           .replaceAll("```\\s*", "")
           .trim();
JsonObject json = JsonParser.parseString(text).getAsJsonObject();
```

그다음 필드를 하나씩 꺼내 VO로 옮긴다. `inappropriate`는 없으면 false로, `icon`은 없으면 화살표 기본값으로 보정한다.

### 4.3 링크 검증 — 모델 출력은 신뢰하지 않는다

`links[]`의 각 `url`은 그대로 쓰지 않고 `isAllowedInternalUrl`을 통과해야 살아남는다.

| 검사 | 차단 대상 |
|------|-----------|
| 위험 스킴 | javascript:, data:, file:, vbscript: |
| 외부/프로토콜 상대 | 슬래시로 시작 안 함, 슬래시 두 개로 시작 |
| 경로 순회 | 점 두 개 포함 |
| 화이트리스트 | 정규식 패턴 목록에 매칭 안 되면 drop |
| 로그인 가드 | 비로그인인데 mypage로 시작하면 제거 |

통과 못 한 링크는 경고 로그를 남기고 조용히 버린다. 그래서 모델이 환각으로 만든 경로나 위험 URL이 버튼으로 노출되지 않는다.

### 4.4 전체 흐름

```text
사용자 메시지
  → 차단·쿼터 체크 → 대화 조회/생성 → user 메시지 저장
  → fast-path 매칭? ─yes→ LLM 생략, 동일 VO 즉답
        │no
  → 사전 의도분류(부적절이면 안전응답)
  → Gemini 호출(responseMimeType=application/json)
  → 코드펜스 제거 → JSON 파싱 → 링크 화이트리스트 검증
  → assistant JSON을 CHAT_MESSAGE에 저장
  → conversationId/messageId 주입해 반환
```

### 4.5 같은 스키마를 코드로도 만든다

`ChatbotFastPathService`는 짧은 네비게이션 요청(15자 이하, 예: 커뮤니티, 로그인)을 LLM 없이 `ChatbotResponseVO`로 즉답한다. 모델을 거치지 않아도 출력 형태가 완전히 동일하므로, 프론트는 fast-path 응답인지 LLM 응답인지 구분할 필요가 없다. 저장 시에도 `toJsonForStorage`가 VO를 같은 4필드 JSON 문자열로 직렬화한다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: `responseMimeType` JSON 강제, 4필드 스키마, 코드펜스 제거 후 Gson 파싱, 링크 화이트리스트·위험 스킴·경로순회 차단, 비로그인 mypage 가드, 부적절 플래그 분기, fast-path 동일 VO 즉답, JSON으로 DB 저장·복원, 다국어 응답(사용자 언어 자동 감지).
- **부분/안전망**: 모델이 스키마를 어기거나(필드 누락) 안전 필터로 막히면 파싱이 실패할 수 있고, 이때는 정해진 fallback 응답(탐색·도우미·커뮤니티 링크가 붙은 고정 JSON)으로 떨어진다. 즉 스키마 강제는 100% 보장이 아니라 강제 + 검증 + fallback 3중 방어다.
- **계획/미구현**: 챗봇 응답 품질을 수치로 재는 정량 평가 체계는 아직 없다. JSON Schema를 코드로 선언해 컴파일타임에 검증하는 방식(예: 별도 스키마 객체)도 도입돼 있지 않다.

## 6. 면접 답변 3단계

1. **한 줄**: 챗봇 응답을 자유 텍스트가 아니라 message·links·quickReplies·inappropriate 4필드 JSON으로 고정해서, 한 번의 응답을 말풍선·버튼·칩으로 동시에 렌더링하고 링크를 안전하게 검증합니다.
2. **설계 이유**: 텍스트를 프론트가 파싱하면 모델 표현이 바뀔 때마다 깨지고 위험한 링크를 거르기 어렵습니다. 구조화하면 url 필드만 골라 화이트리스트·위험 스킴 검사를 돌릴 수 있고, 같은 구조를 DB에 저장해 대화도 그대로 복원합니다.
3. **구현 디테일**: Gemini 호출에 responseMimeType을 application/json으로 주고, 그래도 가끔 붙는 코드펜스를 정규식으로 제거한 뒤 Gson으로 파싱합니다. 모델 출력은 신뢰하지 않고 링크는 화이트리스트를 통과한 것만 남기며, 파싱이 실패하면 고정 fallback JSON으로 떨어집니다.

## 7. 꼬리질문 + 모범답안

:::details responseMimeType을 줬는데 왜 코드펜스 제거가 또 필요한가요?
JSON 모드를 줘도 모델이 마크다운 코드펜스로 출력을 감싸 돌려주는 경우가 실제로 있습니다. 그 상태로 파서에 넣으면 깨지므로, 파싱 직전에 펜스 표시를 정규식으로 벗기고 trim한 뒤 파싱합니다. 방어적 전처리로, 스키마 강제가 완벽하지 않다는 전제를 코드에 반영한 것입니다.
:::

:::details 모델이 만든 링크를 그대로 쓰지 않는 이유는?
모델 출력은 신뢰 경계 밖이기 때문입니다. 존재하지 않는 경로를 환각으로 만들거나 위험 스킴을 넣을 수 있어서, url 필드를 화이트리스트 정규식과 위험 스킴·경로순회·프로토콜 상대 검사에 통과시킨 것만 버튼으로 노출합니다. 통과 못 하면 경고 로그를 남기고 버립니다. 추가로 비로그인 사용자에게는 mypage 링크를 제거합니다.
:::

:::details JSON 파싱이 실패하면 사용자는 무엇을 보나요?
빈 화면이 아니라 정해진 fallback 응답을 봅니다. 탐색·AI 도우미·커뮤니티로 가는 링크가 붙은 고정 JSON으로, 메시지 문구는 다국어 메시지 소스에서 로드합니다. 부적절 판정·안전 필터 차단·쿼터 초과 같은 경우에도 각각 별도의 고정 응답이 준비돼 있어서, 어떤 경로로든 항상 유효한 4필드 응답을 반환합니다.
:::

:::details fast-path 응답과 LLM 응답을 프론트가 구분해야 하나요?
구분할 필요가 없습니다. fast-path도 LLM도 같은 ChatbotResponseVO를 반환하므로 출력 스키마가 동일합니다. 짧은 네비게이션 요청은 모델을 거치지 않고 코드로 즉답해 비용과 지연을 줄이지만, 응답 형태는 완전히 같아서 렌더링 로직이 하나로 통일됩니다.
:::

:::details 이 챗봇과 AI 일정 생성의 구조화 방식은 무엇이 다른가요?
목표는 같지만 수단이 다릅니다. 챗봇은 Gemini의 responseMimeType과 프롬프트 내 스키마 명시 + 서버 측 검증을 씁니다. AI 일정 생성은 OpenAI GPT-4o-mini의 Structured Outputs로 JSON Schema를 strict하게 강제합니다. 후자는 모델 차원에서 스키마를 더 강하게 보장하고, 전자는 검증·fallback으로 신뢰성을 메웁니다.
:::

## 8. 직접 말해보기

다음 세 가지를 입으로 설명해보세요.

- 챗봇 응답의 4개 필드를 나열하고, 각 필드가 화면의 어떤 UI 요소로 렌더링되는지 매핑하기.
- `responseMimeType`을 줬는데도 코드펜스 제거 단계가 필요한 이유와, 그게 어떤 설계 철학(모델 출력 불신)을 보여주는지.
- 모델이 만든 링크가 버튼으로 노출되기까지 통과해야 하는 검증 4단계를 순서대로.

## 퀴즈

<QuizBox question="TripTogether 챗봇의 구조화 JSON 응답 스키마에 포함되지 않는 필드는?" :choices="['message', 'links', 'quickReplies', 'temperature']" :answer="3" explanation="응답 스키마는 message, links, quickReplies, inappropriate 네 필드다. temperature는 모델 호출 시 generationConfig에 들어가는 생성 파라미터이지 응답 필드가 아니다." />

<QuizBox question="Gemini에 responseMimeType을 application/json으로 줬는데도 파싱 직전에 코드펜스 제거 정규식을 돌리는 이유로 가장 적절한 것은?" :choices="['모델이 출력을 코드펜스로 감싸 돌려주는 경우가 있어 그대로 파싱하면 깨지기 때문', 'Gson이 JSON을 못 읽기 때문', '응답을 DB에 저장하려면 코드펜스가 필요하기 때문', '다국어 번역을 위해 펜스를 제거해야 하기 때문']" :answer="0" explanation="JSON 모드를 줘도 모델이 마크다운 코드펜스로 출력을 감싸 보내는 경우가 있어, 파싱 전에 펜스를 제거하는 방어적 전처리가 필요하다." />

<QuizBox question="모델이 응답한 links 항목의 url을 버튼으로 노출하기 전에 적용하는 검증이 아닌 것은?" :choices="['위험 스킴 차단 예 javascript data file', '경로 순회 차단 점 두 개 포함 시 제거', '화이트리스트 정규식 매칭', '링크 라벨의 맞춤법 검사']" :answer="3" explanation="url은 위험 스킴, 경로순회, 프로토콜 상대, 화이트리스트, 비로그인 mypage 가드로 검증한다. 라벨 맞춤법 검사는 하지 않는다." />
