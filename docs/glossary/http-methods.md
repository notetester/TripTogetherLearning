# HTTP 메서드·상태코드

> HTTP 메서드는 "무엇을 할지"(동사)를, 상태코드는 "결과가 무엇인지"(3자리 숫자)를 표준화한 규약이다. TripTogether 신고 모듈은 401/403/404/409를 의미별로 분리해 반환한다.

## 1. 한 줄 정의

HTTP 요청은 **메서드**(GET/POST/PUT/DELETE 등 동작 의도)와 **경로**로 서버에 무엇을 할지 알리고, 서버는 **상태코드**(1xx~5xx)로 처리 결과의 종류를 응답 첫 줄에 담아 돌려준다.

- **메서드** = 요청의 의도. 같은 URL `/report/42`라도 `GET`은 조회, `POST`(여기서는 `/report/42/delete`)는 변경.
- **상태코드** = 결과의 분류. `2xx` 성공, `4xx` 요청자 잘못, `5xx` 서버 잘못.

## 2. 왜 이렇게 설계했나

상태코드를 `200` 한 가지로 뭉뚱그리고 본문 메시지로만 성공/실패를 구분하면, 프런트엔드(JSP의 `fetch`/`ajax`)가 **본문을 파싱하기 전까지 분기할 수 없다.** 반면 상태코드를 의미별로 나누면:

- 프런트는 `response.status`만 보고 토스트 메시지·리다이렉트·재시도를 결정할 수 있다.
- 비로그인(`401`)이면 로그인 모달, 권한 없음(`403`)이면 "권한이 없습니다", 중복(`409`)이면 "이미 신고하셨습니다"처럼 **분기가 코드로 자명**해진다.
- 모니터링·로그에서 4xx(사용자 실수)와 5xx(서버 버그)를 자동 구분해 장애 알림 노이즈를 줄인다.

:::tip 멱등성(idempotency)
`GET`/`PUT`/`DELETE`는 같은 요청을 여러 번 보내도 서버 상태가 한 번 보낸 것과 같아야 한다(멱등). `POST`는 멱등이 아니다 — 두 번 보내면 두 번 생성될 수 있다. 그래서 신고 접수처럼 "한 번만 허용"해야 하는 동작은 서버에서 **중복 검사(409)** 로 멱등성을 보강한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

TripTogether는 Spring MVC(`@Controller`)에서 메서드별 애너테이션과 `ResponseEntity.status(...)`로 상태코드를 직접 제어한다. 가장 명확한 예가 신고 모듈이다.

| 구성요소 | 실제 식별자 |
| --- | --- |
| 컨트롤러 | `org.triptogether.report.controller.ReportController` (`@RequestMapping("/report")`) |
| 서비스 | `ReportService` / `ReportServiceImpl` |
| 매퍼·VO | `ReportMapper`, `ReportDto`, `ReportSearchDto` |
| 응답 타입 | `ResponseEntity<Map<String,Object>>` + `@ResponseBody` |
| 메시지 | `MessageUtil`(i18n 키 `report.api.error.*`) |

신고 대상은 `targetType`(`post`/`comment`/`review`/`user`)과 `targetId`로 표현되고, 상태머신은 `IN_REVIEW → RESOLVED / DISMISSED`를 따른다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 메서드 ↔ 의도 매핑

| 메서드 | 의도 | 멱등 | TripTogether 예 |
| --- | --- | --- | --- |
| `GET` | 조회(부수효과 없음) | O | `GET /report/list`, `GET /report/{reportId}` |
| `POST` | 생성·상태변경 | X | `POST /report/{targetType}/{targetId}` (신고 접수) |
| `PUT` | 전체 교체(업서트) | O | (REST 스타일 자원 교체) |
| `DELETE` | 삭제 | O | 의도상 삭제 — 본 프로젝트는 `POST /report/{id}/delete`로 처리 |

::: details JSP 폼은 GET/POST만 보낸다 — PUT/DELETE는 왜 POST로?
브라우저의 HTML `form`은 `GET`/`POST`만 네이티브로 보낼 수 있다. 그래서 JSP 기반인 TripTogether는 삭제·수정도 `POST /report/{id}/delete`, `POST /report/{id}/edit`처럼 **POST 하위 경로**로 표현한다. 의미는 DELETE/PUT이지만 전송 메서드는 POST다. 순수 REST API라면 `DELETE /report/{id}`로 표현했을 것이다.
:::

### 상태코드 분류

| 범위 | 뜻 | 예 |
| --- | --- | --- |
| `2xx` 성공 | 요청 정상 처리 | `200 OK` |
| `3xx` 리다이렉트 | 다른 위치로 | 비로그인 시 `redirect:/auth/login` |
| `4xx` 요청자 오류 | 보낸 쪽 문제 | `400/401/403/404/409` |
| `5xx` 서버 오류 | 서버 측 문제 | `500` |

### 신고 모듈의 4xx 의미 분리 (핵심)

`POST /report/{reportId}/edit`(신고 내용 수정) 한 엔드포인트가 4가지 4xx를 단계별로 반환한다 — 추상화한 코드:

```java
// 1) 인증: 세션에 loginUser 없으면
if (session.getAttribute("loginUser") == null)
    return ResponseEntity.status(401).body(result);   // 누구인지 모름

ReportDto report = reportService.getReport(reportId);

// 2) 존재: 신고 자체가 없으면
if (report == null)
    return ResponseEntity.status(404).body(result);    // 자원 없음

// 3) 인가: 로그인했지만 내 신고가 아니면
if (!loginUserIdx.equals(report.getUserIdx()))
    return ResponseEntity.status(403).body(result);    // 권한 없음

// 4) 상태/유효성: IN_REVIEW 단계가 아니면
if (!"IN_REVIEW".equals(report.getStatus()))
    return ResponseEntity.status(400).body(result);    // 요청은 정상이나 규칙 위반
```

신고 **접수**(`POST /report/{targetType}/{targetId}`)에서는 중복이 추가된다 — 같은 대상을 이미 신고했으면 서비스가 `false`를 반환하고:

```java
if (!submitted)
    return ResponseEntity.status(409).body(result);    // 충돌: 이미 신고함
```

### 4xx 의미 한눈에

| 코드 | 의미 | 신고 모듈에서 트리거되는 상황 |
| --- | --- | --- |
| `400 Bad Request` | 요청 자체가 규칙 위반 | 잘못된 `targetType`(`invalidTarget`), 자기 자신 신고(`selfReport`), `IN_REVIEW` 아님(`cannotEdit`), 잘못된 상태값 |
| `401 Unauthorized` | **인증** 안 됨(누군지 모름) | 세션에 `loginUser` 없음 |
| `403 Forbidden` | 인증됐으나 **인가** 없음 | 남의 신고 수정·삭제·취소, 관리자 전용 상태변경을 일반 유저가 시도 |
| `404 Not Found` | 자원이 없음 | `reportId`에 해당하는 신고 미존재 |
| `409 Conflict` | 현재 상태와 충돌 | 동일 대상 중복 신고(`alreadyReported`) |

:::warning 401 vs 403을 헷갈리지 말 것
`401`은 "**너 누구냐**(로그인 안 됨)", `403`은 "너는 알겠는데 **그건 네 권한 밖**"이다. 신고 모듈에서 비로그인은 항상 `401`, 로그인했지만 소유자/관리자가 아니면 `403`으로 명확히 갈라진다. 순서도 중요하다 — 보통 인증(401) → 존재(404) → 인가(403) → 유효성(400) 순으로 검사한다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: 신고 모듈의 401/403/404/409/400/500 의미 분리, `GET` 조회 + `POST` 변경, 중복 방지(409), 본인 `IN_REVIEW` 한정 수정/취소, 관리자 전용 상태변경(403 차단)은 `ReportController`에 실제 구현되어 있다.
- **됨**: 전역 예외는 `GlobalExceptionHandler`가 처리, 메시지는 i18n 키(`report.api.error.*`)로 4개국어 대응.
- **부분/관례**: JSP 환경 특성상 삭제·수정도 `POST` 하위 경로로 표현(순수 `DELETE`/`PUT` 메서드 미사용). REST 스타일 자원 메서드를 전 도메인에 일관 적용하지는 않는다.
- **계획**: OpenAPI/Swagger 문서가 없어 상태코드 규약이 코드·주석에만 존재한다(자동 명세화는 향후 과제).

## 6. 면접 답변 3단계

1. **한 줄**: "HTTP 메서드는 동작 의도, 상태코드는 결과 분류입니다. 저희 신고 기능은 4xx를 401/403/404/409로 의미별로 나눠서 프런트가 상태코드만 보고 분기하도록 했습니다."
2. **설계 의도**: "본문 메시지로만 성공/실패를 구분하면 클라이언트가 본문을 파싱해야 분기됩니다. 상태코드를 표준대로 쓰면 비로그인은 401, 권한 없음은 403, 중복은 409로 자명해져서 UX 분기와 모니터링이 단순해집니다."
3. **근거 코드**: "`ReportController`의 수정 엔드포인트가 좋은 예입니다. 인증(401) → 존재(404) → 소유권(403) → 상태 규칙(400) 순으로 검사하고, 접수에서는 중복 시 409를 반환합니다. `ResponseEntity.status(...)`로 직접 제어합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 401과 403의 차이는?
401은 **인증 실패**(누구인지 모름 — 로그인 필요), 403은 **인가 실패**(누군지는 알지만 권한 없음)입니다. 신고 모듈에서 비로그인은 401, 로그인했지만 남의 신고를 수정하려 하면 403입니다.
:::

:::details Q2. 중복 신고를 막을 때 왜 409이고 400이 아닌가?
400은 요청의 형식·값 자체가 잘못된 경우(예: 잘못된 `targetType`)입니다. 409 Conflict는 요청은 정상이지만 **현재 서버 상태와 충돌**할 때입니다. 이미 신고한 대상을 다시 신고하는 건 요청은 멀쩡하나 상태 충돌이므로 409가 의미상 정확합니다.
:::

:::details Q3. JSP 폼에서 DELETE를 못 보내는데 어떻게 삭제하나?
HTML form은 GET/POST만 네이티브로 지원합니다. 그래서 삭제는 `POST /report/{id}/delete`처럼 POST 하위 경로로 표현합니다. 의미는 DELETE지만 전송 메서드는 POST입니다. REST API였다면 `DELETE /report/{id}`로 했을 것입니다.
:::

:::details Q4. GET으로 신고를 접수하면 안 되나?
안 됩니다. GET은 **부수효과 없는 조회**여야 합니다(멱등·캐시 가능). 신고 접수는 서버 상태를 바꾸므로 POST가 맞습니다. GET으로 처리하면 브라우저 프리페치·크롤러·캐시가 의도치 않게 신고를 발생시킬 수 있습니다.
:::

:::details Q5. 404와 403 검사 순서가 바뀌면 무슨 문제가 생기나?
민감한 자원에서는 "존재 여부 자체"가 정보 노출이 될 수 있어 의도적으로 404를 먼저 줘 존재를 숨기기도 합니다. 신고 모듈은 일반 자원이라 존재(404) → 소유권(403) 순으로 검사해, 없는 신고를 수정하려 하면 404가 먼저 나갑니다. 보안 민감 자원이라면 일부러 403 대신 404로 통일하는 전략도 있습니다.
:::

## 8. 직접 말해보기

- "GET과 POST의 차이를 멱등성·부수효과 관점에서 설명해보라."
- "신고 수정 한 엔드포인트가 401·404·403·400을 어떤 순서로, 왜 그 순서로 검사하는지 말해보라."
- "중복 신고에 409를 쓴 이유를, 400/409의 의미 차이로 정당화해보라."
- "JSP 환경에서 DELETE/PUT을 POST로 표현한 이유와 트레이드오프를 설명해보라."

---

관련: [REST](/glossary/rest) · [API](/glossary/api) · [JSON](/glossary/json) · [신고 상태머신](/community/report-system) · [예외 처리](/backend/exception-handling)
허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="비로그인 사용자가 신고를 접수하려 할 때 ReportController가 반환하는 상태코드는?"
  :choices="['200 OK', '401 Unauthorized', '403 Forbidden', '409 Conflict']"
  :answer="1"
  explanation="세션에 loginUser가 없으면 인증되지 않은 상태이므로 401을 반환한다. 403은 로그인은 됐지만 권한이 없을 때다."
/>

<QuizBox
  question="이미 신고한 대상을 같은 사용자가 다시 신고할 때 의미상 가장 정확한 상태코드는?"
  :choices="['400 Bad Request', '404 Not Found', '409 Conflict', '500 Internal Server Error']"
  :answer="2"
  explanation="요청 형식은 정상이지만 현재 서버 상태(이미 신고됨)와 충돌하므로 409 Conflict가 맞다. 400은 요청 값 자체가 잘못된 경우다."
/>

<QuizBox
  question="신고 수정 엔드포인트가 검사하는 순서로 가장 적절한 것은?"
  :choices="['유효성(400) → 인증(401) → 존재(404)', '인증(401) → 존재(404) → 인가(403) → 유효성(400)', '인가(403) → 인증(401) → 존재(404)', '존재(404) → 유효성(400) → 인증(401)']"
  :answer="1"
  explanation="누군지(401) 먼저 확인하고, 자원이 있는지(404), 내 것인지(403), 마지막으로 수정 가능한 상태인지(400)를 검사한다."
/>
