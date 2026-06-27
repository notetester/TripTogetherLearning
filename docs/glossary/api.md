# API

> API는 "프로그램이 다른 프로그램에게 기능을 요청하는 약속된 창구"다. TripTogether는 JSP 서버 렌더링을 기본으로 하되, 동적 상호작용 구간만 골라 REST(JSON) 엔드포인트를 혼합한다.

이 페이지는 특정 담당자의 영역이 아니라, 네 명이 나눠 만든 14~15개 모듈 전체에 공통으로 적용되는 **API 설계 방식**을 다룬다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

API(Application Programming Interface)는 **"무엇을 보내면 무엇을 돌려준다"는 호출 규약**이다. 호출하는 쪽은 상대 내부 구현을 몰라도, 약속된 주소(URL)·메서드·입력·출력 형식만 지키면 기능을 빌려 쓸 수 있다.

TripTogether에서 API는 두 방향으로 존재한다.

- **내부로 노출하는 API**: 브라우저(JSP의 자바스크립트)가 서버를 호출하는 엔드포인트. `@Controller`/`@RestController` + `@RequestMapping`으로 정의.
- **외부에서 빌려 쓰는 API**: 서버가 OpenAI·Gemini·Claude·Perspective·Cloudinary·Toss·Google Translation 등을 OkHttp로 호출하는 쪽. 이때 TripTogether는 **API 소비자**다.

## 2. 왜 이렇게 설계했나

전부 REST로 가지 않고 **JSP 우선 + 부분 REST**라는 혼합 모델을 택한 데에는 이유가 있다.

- **화면 단위 이동은 서버 렌더링이 단순하다.** 목록·상세·폼처럼 "한 페이지 통째로 갈아끼우는" 동작은 JSP가 HTML을 완성해 내려주는 편이 상태 관리·SEO·초기 렌더 측면에서 비용이 낮다. SPA 프레임워크와 빌드 파이프라인을 들일 필요가 없다.
- **부분 갱신만 JSON으로 뺀다.** 신고 접수, 좋아요 토글, 챗봇 대화, 알림 스트림처럼 "페이지를 떠나지 않고 일부만 바꾸는" 동작은 전체 새로고침이 어색하다. 이 구간만 JSON을 주고받는 비동기 호출로 분리한다.
- **외부 AI/결제 연동은 표준 HTTP가 강제된다.** OpenAI·Gemini 등은 JSON over HTTPS만 받는다. 그래서 서버는 내부적으로는 JSP를 쓰면서도, 외부와는 철저히 REST 소비자로 동작한다.

:::tip 핵심 관점
"이 프로젝트는 REST API 프로젝트인가요?"라는 질문에는 **"화면은 JSP 서버 렌더링이 기본이고, 상호작용이 필요한 구간만 REST(JSON)로 혼합했습니다"**가 정확한 답이다. 둘 중 하나로 단순화하면 사실과 어긋난다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·구조)

API 정의는 컨트롤러 계층에 집중된다. 4계층(`controller → service → mapper → vo`)에서 가장 바깥이다.

| 패턴 | 어노테이션 | 반환 | 대표 예 |
| --- | --- | --- | --- |
| 순수 화면(JSP) | `@Controller` + 뷰 이름 반환 | `"report/list"` 같은 JSP 경로 | `ReportController.list()` |
| 순수 REST | `@RestController` | 객체 → JSON 직렬화 | `ChatbotController`, `RecommendController`, `NotificationController` |
| 혼합(한 컨트롤러 안) | `@Controller` + 메서드별 `@ResponseBody` | 일부는 JSP, 일부는 JSON | `ReportController.reportTarget()` |
| 실시간 스트림 | `@RestController` + `SseEmitter` | `text/event-stream` | `NotificationSseController` |

실제 코드의 대조를 보면 차이가 분명하다.

```java
// (1) 순수 REST — 메서드 반환값이 그대로 JSON 본문이 된다
@RestController
@RequestMapping("/chatbot")
public class ChatbotController {
    @PostMapping("/ask")
    public ChatbotResponseVO ask(@RequestBody ChatbotRequestVO req, ...) { ... }
}

// (2) 혼합 — 같은 @Controller 안에서 화면과 JSON이 공존
@Controller
@RequestMapping("/report")
public class ReportController {
    @GetMapping("/list")
    public String list(...) { return "report/list"; }   // JSP 뷰

    @PostMapping("/{targetType}/{targetId}")
    @ResponseBody                                        // JSON 본문
    public ResponseEntity<Map<String,Object>> reportTarget(...) { ... }
}
```

요청·응답 데이터는 `vo`(또는 `dto`)로 모양이 정해진다. 예를 들어 챗봇 응답은 `ChatbotResponseVO`, AI 일정 구조화 응답은 `AiPlanResponseDTO`(내부 `AiDayDTO`/`AiSpotDTO`)다. `@RequestBody`로 JSON을 객체로 역직렬화하고, 반환 객체를 다시 JSON으로 직렬화하는 일은 Spring MVC가 담당한다.

## 4. 동작 원리 (흐름·표·작은 코드)

브라우저가 부분 갱신 API를 호출하는 전형적 흐름이다.

```text
[JSP의 fetch/AJAX]
   POST /report/post/42   (FormData: reason, description)
        │
        ▼
[인터셉터 체인]  locale → ipBlock → activityLog → login → admin ...
        │ (세션 loginUser 확인, 차단 IP 거름)
        ▼
[ReportController.reportTarget]  @ResponseBody
        │  비로그인이면 401, 잘못된 타입 400, 중복 409
        ▼
[ReportService → ReportMapper → DB]
        │
        ▼
{ "success": true, "message": "신고가 접수되었습니다" }   ← JSON 응답
```

API의 **계약(contract)** 은 URL·메서드뿐 아니라 **상태 코드**까지 포함한다. ReportController는 의미별로 코드를 분리한다.

| 상황 | HTTP 상태 | 의미 |
| --- | --- | --- |
| 비로그인 | 401 | 인증 안 됨 |
| 권한 없음 / 타인 자원 | 403 | 인증은 됐으나 금지 |
| 대상 신고 없음 | 404 | 자원 없음 |
| 중복 신고 | 409 | 상태 충돌 |
| 잘못된 입력 | 400 | 요청 형식 오류 |

응답 본문 형식도 약속이다. JSON 엔드포인트 다수가 `{ success, message }` 형태를 공유하고, 실패는 `success:false`로 일관된다. 도메인 예외가 던져지면 `@RestControllerAdvice`로 선언된 `GlobalExceptionHandler`가 가로채 동일한 형식으로 바꾼다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Map<String,Object>> handleBusiness(BusinessException e) {
        // → { "success": false, "message": ... } + e.getHttpStatus()
    }
}
```

:::warning 외부 API 호출은 반대 방향
위 흐름은 "브라우저 → TripTogether". 반대로 "TripTogether → OpenAI/Gemini/Toss" 호출에서는 우리가 클라이언트다. 이때 인증은 세션이 아니라 **API 키**(코드에 노출 금지, 런타임 설정/환경변수로 주입)이고, OkHttp로 JSON을 POST한다. 응답 지연·실패에 대비한 폴백 전략은 [폴백 전략](/ai/fallback-strategy)에서 다룬다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| JSP 화면 컨트롤러 (목록/상세/폼) | 구현됨 — 전 도메인 |
| 부분 갱신용 JSON 엔드포인트(신고·좋아요·챗봇·알림 등) | 구현됨 |
| `@RestController` 전용 모듈(챗봇, 추천, 알림 SSE 등) | 구현됨 |
| 외부 AI API 소비(OpenAI/Gemini/Claude/Perspective) | 구현됨 |
| 결제(Toss)·이미지(Cloudinary)·번역 외부 API | 구현됨 |
| 항공권 외부 API | **Mock** — `FlightOfferProvider` 인터페이스만 두고 실 항공 API 미연동 |
| OpenAPI/Swagger 문서 | **부재** — API 명세는 코드·주석으로만 관리 |
| 전역 표준 에러 응답 적용 범위 | **부분 적용** — `GlobalExceptionHandler`는 현재 JSON(@ResponseBody) 경로 위주, 점진 확대 |
| 모바일/REST-first 재설계 | **계획** — 현재는 데스크톱 JSP 레이아웃 중심 |

## 6. 면접 답변 3단계

1. **한 줄**: "API는 프로그램 간 호출 규약입니다. TripTogether는 JSP 서버 렌더링을 기본으로 하고, 상호작용이 필요한 구간만 REST(JSON)로 혼합했습니다."
2. **근거**: "목록·상세·폼은 `@Controller`가 JSP 뷰를 반환하고, 신고·챗봇·알림처럼 페이지를 떠나지 않는 동작은 `@RestController`나 `@ResponseBody`로 JSON을 주고받습니다. 응답은 `{success, message}` 형태로 통일하고, 401/403/404/409를 의미별로 분리했습니다."
3. **확장**: "외부에서는 우리가 API 소비자입니다. OpenAI·Gemini·Toss 등을 OkHttp로 호출하고, 키는 코드에 두지 않고 런타임 설정으로 주입합니다. Swagger가 없는 점, 항공권이 Mock인 점은 인지된 한계이자 향후 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 처음부터 전부 REST로 만들지 않았나요?
화면 단위 이동이 많은 서비스라, 페이지를 통째로 내려주는 JSP 서버 렌더링이 상태 관리·초기 렌더 비용에서 유리했습니다. 별도 SPA 빌드 파이프라인 없이도 동작하고, 비동기 상호작용이 필요한 구간만 골라 JSON으로 분리했습니다. 트레이드오프는 모바일·외부 클라이언트 친화성이 낮다는 점이고, 그래서 REST-first 재설계를 향후 과제로 둡니다.
:::

:::details Q2. 한 컨트롤러 안에서 JSP와 JSON을 어떻게 섞나요?
클래스에는 `@Controller`를 붙이고, JSON으로 응답할 메서드에만 `@ResponseBody`를 답니다. 예: `ReportController`는 `/list`·`/{reportId}`는 뷰 이름(`"report/list"`)을 반환해 JSP로 렌더링하고, `/{targetType}/{targetId}` 같은 신고 접수는 `@ResponseBody` + `ResponseEntity`로 JSON과 상태 코드를 직접 돌려줍니다. `@RestController`는 사실상 `@Controller` + 클래스 전체 `@ResponseBody`입니다.
:::

:::details Q3. 응답 형식과 상태 코드를 어떻게 일관되게 유지하나요?
JSON 엔드포인트는 `{success, message}` 형태를 공유하고, 실패 시 `success:false`로 통일합니다. 상태 코드는 비로그인 401, 권한 없음 403, 자원 없음 404, 중복/충돌 409, 입력 오류 400으로 분리합니다. 도메인 예외는 `@RestControllerAdvice`인 `GlobalExceptionHandler`가 잡아 같은 형식으로 변환합니다. 다만 이 전역 처리는 현재 JSON 경로 위주로 적용 중이라 범위를 넓히는 중입니다.
:::

:::details Q4. 외부 AI API를 호출할 때 키 관리와 장애 대응은요?
키는 소스에 하드코딩하지 않고 런타임 설정(DB 우선, 환경변수)으로 주입합니다. 호출은 OkHttp로 JSON over HTTPS입니다. 외부 의존이 실패할 수 있으므로, 예컨대 추천은 'DB 캐시 → Gemini 호출 → 트렌딩'의 3단 폴백으로 빈 화면을 막습니다. 결제·이미지 등도 실패를 사용자 흐름에 그대로 노출하지 않도록 처리합니다.
:::

:::details Q5. API 문서는 어떻게 관리하나요? Swagger가 없는데 불편하지 않나요?
현재 명세는 컨트롤러 코드와 주석(메서드 상단 URL·권한·상태 코드 설명)으로 관리합니다. 4인 협업에서 도메인을 수직 분담했기 때문에 모듈 경계가 분명해 큰 마찰은 없었지만, 외부 공개나 프런트 분리를 가정하면 OpenAPI/Swagger 도입이 필요합니다. 이건 명확히 인지한 미흡점입니다.
:::

## 8. 직접 말해보기

다음 세 가지를 막힘 없이 말할 수 있으면 이 페이지를 이해한 것이다.

- TripTogether가 "REST 프로젝트"가 아니라 "JSP 우선 + 부분 REST"인 이유를, 화면 이동과 부분 갱신의 차이로 설명하기.
- `@Controller` / `@RestController` / `@ResponseBody` 세 가지의 관계를 한 문장으로 정리하기.
- 신고 API에서 401·403·404·409가 각각 언제 나오는지 예를 들어 말하기.

연관 학습: [REST](/glossary/rest) · [HTTP 메서드·상태코드](/glossary/http-methods) · [JSON](/glossary/json) · [DTO / VO](/glossary/dto-vo) · [4계층 구조](/glossary/layered-architecture) · [HTTP 클라이언트(OkHttp)](/backend/okhttp)

## 퀴즈

<QuizBox
  question="TripTogether의 API 설계를 가장 정확히 설명한 것은?"
  :choices="['모든 화면과 동작이 REST(JSON) API로만 동작하는 SPA다', 'JSP 서버 렌더링이 기본이고, 상호작용이 필요한 구간만 REST(JSON)를 혼합한다', '서버는 HTML만 내려주고 JSON 응답은 전혀 없다', '외부 AI를 쓰지 않고 모든 응답을 DB에서만 만든다']"
  :answer="1"
  explanation="목록·상세·폼은 JSP로 렌더링하고, 신고·챗봇·알림 같은 부분 갱신 구간만 JSON을 주고받는 혼합 모델이다."
/>

<QuizBox
  question="@Controller 클래스의 특정 메서드만 JSON으로 응답하게 하려면 무엇을 붙이는가?"
  :choices="['@RestController', '@ResponseBody', '@RequestBody', '@ModelAttribute']"
  :answer="1"
  explanation="메서드에 @ResponseBody를 붙이면 반환값이 뷰 이름이 아니라 JSON 본문으로 직렬화된다. @RestController는 클래스 전체에 이 효과를 준 단축형이다."
/>

<QuizBox
  question="ReportController에서 '이미 신고한 대상을 또 신고'했을 때 반환하는 HTTP 상태 코드는?"
  :choices="['400 Bad Request', '401 Unauthorized', '403 Forbidden', '409 Conflict']"
  :answer="3"
  explanation="중복 신고는 자원 상태와의 충돌이므로 409 Conflict로 분리한다. 비로그인은 401, 권한 없음은 403, 대상 없음은 404다."
/>
