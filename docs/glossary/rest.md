# REST

> 자원(resource)을 URL로 식별하고, 그 자원에 무엇을 할지는 HTTP 메서드(GET/POST/PATCH/DELETE)로 표현하는 API 설계 스타일. TripTogether는 신고·챗봇·어시스턴트 같은 비동기 기능을 REST 엔드포인트로, 화면은 JSP 서버 렌더링으로 **혼합** 운영한다.

이 페이지는 특정 도메인이 아니라 TripTogether 전체에 깔린 공통 통신 규약을 다룬다. 도메인 허브는 [도메인 전체 개요](/domains), 담당 태그로 보려면 [담당별 보기](/by-area/), 요청이 계층을 어떻게 통과하는지는 [전체 흐름](/flow/)을 참고한다.

## 1. 한 줄 정의

REST(Representational State Transfer)는 **"자원을 URL로 가리키고, 동작은 HTTP 메서드로 구분하며, 서버는 요청 사이에 클라이언트 상태를 기억하지 않는다(stateless)"** 는 세 가지 원칙을 따르는 웹 API 스타일이다. 같은 `/report/{id}` 경로라도 `GET`이면 조회, `DELETE`면 삭제로 의미가 갈린다.

## 2. 왜 이렇게 설계했나

TripTogether는 JSP 기반 서버 렌더링 플랫폼이지만, **페이지 전체를 다시 그리지 않고 일부만 갱신해야 하는 상호작용**이 많다. 신고 버튼, 챗봇 메시지 전송, 어시스턴트 대화, 알림 읽음 처리 등이 그렇다.

- **페이지 전환 없는 부분 갱신:** 신고 한 번에 화면을 새로 그리면 사용자 경험이 끊긴다. JS가 fetch로 JSON만 주고받으면 버튼 상태만 바꿀 수 있다.
- **동작의 의미를 URL이 아니라 메서드로:** "조회/생성/수정/삭제"를 경로에 박지 않고 HTTP 메서드로 표현하면 엔드포인트 수가 줄고 의도가 명확해진다.
- **stateless + 세션 인증의 절충:** 순수 REST는 무상태를 지향하지만, TripTogether는 로그인 상태를 **세션 쿠키**로 들고 다닌다. 즉 "요청 본문/경로에 비즈니스 상태를 담지 않는다"는 의미의 stateless는 지키되, 인증 컨텍스트는 세션에서 꺼낸다. 토큰리스 세션 인증은 [세션 / 쿠키](/glossary/session-cookie)에서 다룬다.

:::tip 왜 완전한 REST API 서버가 아닌가
TripTogether는 단일 페이지 앱(SPA)이 아니라 JSP 서버 렌더링이 기본이다. 그래서 "전부 REST"가 아니라, **화면 라우팅은 JSP, 비동기 동작만 REST**로 가져가는 실용적 혼합 구조다. 이 점을 면접에서 솔직히 말하면 설계 의도가 또렷해 보인다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

스택은 Spring Boot 4.0.6 / Java 21 / Spring MVC. 컨트롤러가 REST냐 화면이냐를 가르는 두 가지 패턴이 있다.

| 패턴 | 애너테이션 | 응답 | 실제 클래스 예 |
| --- | --- | --- | --- |
| 순수 REST 컨트롤러 | `@RestController` | 모든 메서드가 JSON | `ChatbotController` (`/chatbot/**`) |
| 화면 + JSON 혼합 | `@Controller` + 메서드별 `@ResponseBody` | 일부는 JSP 뷰 이름, 일부는 JSON | `ReportController`, `AssistantController` |

- **`@RestController`** = `@Controller` + 클래스 전체 `@ResponseBody`. 반환 객체를 Jackson이 자동으로 JSON 직렬화한다. `ChatbotController`가 대표 사례다.
- **`@Controller`** 단독이면 메서드가 반환한 문자열(`"report/list"`)을 **JSP 뷰 이름**으로 해석한다. 같은 컨트롤러 안에서 `@ResponseBody`를 붙인 메서드만 JSON으로 응답한다 — `ReportController`가 이 혼합형이다.
- 컨텍스트 경로는 `/TripTogether`이고, 별도 `/api` 프리픽스는 두지 않는다. REST 엔드포인트와 화면 라우팅이 같은 경로 공간(`/report`, `/chatbot`, `/assistant`)을 공유한다.
- 응답 본문은 대부분 손수 만든 `Map<String, Object>`(예: `success`, `message`, `conversations`)이거나 전용 VO(`ChatbotResponseVO`)다. 전역 표준 envelope 클래스는 두지 않았다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 `ReportController` — 혼합형의 교과서

같은 클래스 안에서 화면과 JSON이 메서드 단위로 갈린다.

```java
@Controller
@RequestMapping("/report")
public class ReportController {

    // 화면: JSP 뷰 이름을 반환 → /WEB-INF/views/report/list.jsp 렌더
    @GetMapping("/list")
    public String list(...) { return "report/list"; }

    // REST: @ResponseBody → JSON. 자원=대상, 동작=POST(생성)
    @PostMapping("/{targetType}/{targetId}")
    @ResponseBody
    public ResponseEntity<Map<String, Object>> reportTarget(...) { ... }
}
```

핵심은 **`@PathVariable`로 자원을 식별**하고(`targetType`=post/comment/review/user, `targetId`), **HTTP 상태 코드로 결과를 구분**한다는 점이다.

| 상황 | HTTP 상태 | 의미 |
| --- | --- | --- |
| 비로그인 신고 시도 | 401 | 인증 필요 |
| 잘못된 대상 타입 / 자기 자신 신고 | 400 | 잘못된 요청 |
| 본인 아님(타인 신고 수정) | 403 | 권한 없음 |
| 신고 대상 없음 | 404 | 자원 없음 |
| 이미 신고함(중복) | 409 | 충돌 |
| 정상 처리 | 200 | 성공 |

이렇게 401/403/404/409를 의미에 맞게 분리한 것이 "REST답다"의 핵심이다. 클라이언트 JS는 상태 코드만 보고 분기할 수 있다. 상태 코드 사전은 [HTTP 메서드·상태코드](/glossary/http-methods)에 정리돼 있다.

### 4.2 `ChatbotController` — 자원 전체를 메서드로 다루는 순수 REST

`@RestController`로 대화(conversation)라는 자원을 CRUD 전체로 노출한다.

| 메서드 + 경로 | 동작 | 자원 |
| --- | --- | --- |
| `POST /chatbot/ask` | 질문 전송 | 메시지 |
| `GET /chatbot/conversations` | 내 대화 목록 | 대화 컬렉션 |
| `GET /chatbot/conversations/{id}/messages` | 대화 내 메시지 | 단일 대화 |
| `PATCH /chatbot/conversations/{id}/title` | 제목 수정(부분 변경) | 단일 대화 |
| `PATCH /chatbot/conversations/order` | 정렬 순서 변경 | 대화 컬렉션 |
| `DELETE /chatbot/conversations/{id}` | 소프트 삭제 | 단일 대화 |

`PATCH`를 "전체 교체가 아닌 부분 수정"에 맞게 쓴 점, `DELETE`가 실제로는 `is_deleted` 플래그를 세우는 [소프트 삭제](/glossary/soft-delete)인 점이 실무적이다. 요청 본문은 `@RequestBody`로 JSON을 받고, 응답은 `Map` 또는 `ResponseEntity`로 상태 코드를 직접 제어한다.

### 4.3 stateless의 실제 모습

REST 요청에는 비즈니스 상태가 담기지 않는다. "누가 보냈는가"는 본문이 아니라 **세션에서** 꺼낸다.

```java
UsersVO loginUser = (UsersVO) session.getAttribute("loginUser");
Long userIdx = loginUser != null ? loginUser.getUserIdx() : null;
String anonSessionId = loginUser == null ? session.getId() : null;
// 비로그인 사용자도 세션 ID로 대화 소유권을 식별 → 위조 로그 방지
```

소유권 검증(`isOwner`)을 통과하지 못하면 403을 던진다. 즉 경로(`/conversations/{id}`)가 자원을 가리키더라도, **그 자원에 접근할 권한은 매 요청 세션 컨텍스트로 재확인**한다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 신고 REST(`/report/**`) — 401/403/404/409 분리, 상태머신 연동 | 구현됨 |
| 챗봇 REST(`/chatbot/**`) — GET/POST/PATCH/DELETE 전체 | 구현됨 |
| 어시스턴트(`/assistant/chat`, `/history/**`) — JSON 비동기 | 구현됨 |
| 알림 읽음/조회, 커뮤니티 좋아요·태그 등 부분 갱신 엔드포인트 | 구현됨 |
| 전역 응답 envelope 표준 클래스 | 없음 — 각 컨트롤러가 `Map` 직접 구성 |
| OpenAPI/Swagger 문서 | 없음 (향후 과제) |
| 순수 REST API 서버 / SPA 분리 | 계획 — 현재는 JSP 혼합 |

:::warning 정직하게 짚을 점
"REST API"라고 뭉뜽그리면 면접관이 파고든다. TripTogether는 **부분적으로 REST**다. HATEOAS·버전드 API·표준 envelope·Swagger는 없고, 화면 라우팅과 REST가 같은 컨트롤러/경로에 섞여 있다. 이걸 "JSP 서버 렌더링 + 비동기 동작만 REST로 뽑은 혼합 구조"라고 정확히 말하는 편이 점수가 높다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** "REST는 자원을 URL로, 동작을 HTTP 메서드로 구분하는 스타일이고, 저희는 화면은 JSP, 비동기 동작만 REST로 가져간 혼합 구조입니다."
2. **근거 한 스푼:** "예를 들어 신고는 `@Controller`에서 화면(`/report/list`)과 JSON 엔드포인트(`POST /report/{type}/{id}`)를 한 클래스에 두고, 결과를 401/403/404/409로 의미에 맞게 분리했습니다. 챗봇은 `@RestController`로 대화 자원을 GET/POST/PATCH/DELETE 전체로 다룹니다."
3. **한계 인정:** "다만 표준 응답 envelope이나 Swagger는 없고, 인증은 순수 무상태가 아니라 세션 기반이라 그 부분은 절충했습니다."

## 7. 꼬리질문 + 모범답안

:::details `@Controller`와 `@RestController` 차이는?
`@RestController` = `@Controller` + 클래스 전체에 `@ResponseBody`. 전자는 반환 문자열을 JSP 뷰 이름으로 해석하고, 후자는 반환 객체를 Jackson이 JSON으로 직렬화한다. TripTogether에서 `ChatbotController`는 `@RestController`, `ReportController`는 `@Controller`에 메서드별 `@ResponseBody`를 붙인 혼합형이다.
:::

:::details PUT이 아니라 PATCH를 쓴 이유는?
대화 제목/순서 변경은 자원 전체를 교체하는 게 아니라 일부 필드만 바꾸는 부분 수정이라 의미상 `PATCH`가 맞다. `PUT`은 멱등한 전체 교체에 가깝다. 실제 `PATCH /chatbot/conversations/{id}/title`이 그 예다.
:::

:::details REST는 stateless인데 세션을 쓰면 위반 아닌가?
엄밀한 REST는 무상태를 권장한다. 우리는 "요청 본문·경로에 비즈니스 상태를 담지 않는다"는 의미의 stateless는 지키되, 인증 컨텍스트만 세션 쿠키로 유지하는 절충을 택했다. 토큰 기반(JWT)으로 가면 더 무상태에 가깝지만, JSP 서버 렌더링 환경에선 세션이 단순하고 안전하다.
:::

:::details DELETE를 보냈는데 데이터가 안 지워지던데?
의도된 동작이다. `DELETE /chatbot/conversations/{id}`는 물리 삭제가 아니라 `is_deleted` 플래그를 세우는 [소프트 삭제](/glossary/soft-delete)다. 사용자에겐 숨기되 관리자 조회·감사 추적은 가능하게 하려는 정책(ADR-0008)이다.
:::

:::details 같은 경로에 화면과 JSON이 섞이면 헷갈리지 않나?
그래서 메서드 규칙을 둔다. 화면 진입은 보통 `GET`이고 뷰 이름을 반환, 상태를 바꾸는 비동기 동작은 `POST/PATCH/DELETE`에 `@ResponseBody`로 JSON을 반환한다. 향후 SPA로 분리하면 REST 엔드포인트만 떼어내기 쉽도록 동작 경로를 일관되게 유지하고 있다.
:::

## 8. 직접 말해보기

- TripTogether에서 "REST API 100%"가 아니라 "부분 REST"인 이유를, JSP 혼합 구조를 들어 30초 안에 설명해 보자.
- `ReportController`가 같은 `/report/{id}` 자원에 대해 어떤 메서드로 어떤 동작을 매핑하는지, 그리고 왜 401/403/404/409를 분리했는지 말해 보자.
- "DELETE를 호출했는데 행이 남아 있다"는 상황을 소프트 삭제로 설명하고, REST 의미론과 데이터 정책이 충돌하지 않는 이유를 풀어 보자.

## 퀴즈

<QuizBox
  question="TripTogether에서 ChatbotController가 모든 메서드를 JSON으로 응답할 수 있는 직접적인 이유는?"
  :choices="['클래스에 @RestController가 붙어 클래스 전체가 @ResponseBody이기 때문', 'JSP 뷰 리졸버를 제거했기 때문', '컨텍스트 경로가 /api라서', 'MyBatis가 JSON을 반환하기 때문']"
  :answer="0"
  explanation="@RestController = @Controller + @ResponseBody. 반환 객체를 Jackson이 JSON으로 직렬화한다. ReportController는 @Controller라서 메서드별로 @ResponseBody를 붙여야 JSON이 된다."
/>

<QuizBox
  question="신고 REST에서 '이미 신고한 대상을 또 신고'했을 때 반환하는 HTTP 상태 코드는?"
  :choices="['401 Unauthorized', '403 Forbidden', '404 Not Found', '409 Conflict']"
  :answer="3"
  explanation="중복 신고는 현재 자원 상태와 충돌하므로 409 Conflict로 응답한다. 비로그인은 401, 권한 없음은 403, 대상 없음은 404로 의미에 맞게 분리돼 있다."
/>

<QuizBox
  question="대화 제목만 바꾸는 PATCH /chatbot/conversations/{id}/title 에서 PUT 대신 PATCH가 적절한 이유를 한 문장으로 설명해 보라."
  explanation="PATCH는 자원의 일부 필드만 부분 수정하는 의미이고, PUT은 자원 전체를 교체(멱등)하는 의미다. 제목만 바꾸는 동작은 전체 교체가 아니라 부분 수정이므로 PATCH가 의미상 정확하다."
/>
