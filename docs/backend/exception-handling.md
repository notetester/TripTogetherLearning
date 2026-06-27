# 예외 처리

> 도메인 예외를 던지면 `@RestControllerAdvice`가 표준 JSON으로 변환하고, 신고 모듈은 같은 실패라도 401·403·404·409로 의미를 분리한다.

이 프로젝트는 예외 처리에 **두 가지 패턴**이 공존한다. 하나는 도메인 예외(`BusinessException`)를 던지고 `GlobalExceptionHandler`가 한곳에서 응답으로 변환하는 **선언적 방식**, 다른 하나는 컨트롤러가 분기마다 직접 `ResponseEntity.status(...)`로 상태코드를 고르는 **명시적 방식**이다. 전자는 시범 적용 단계라 일부 메서드에만 적용돼 있고, 후자의 대표 사례가 신고 모듈이다. 두 방식이 왜 섞여 있는지, 각각이 무엇을 보장하는지가 이 페이지의 핵심이다.

관련 문서: [AOP 권한 체크](/backend/aop-authorization) · [@LoginUser 리졸버](/backend/login-user-resolver) · [신고 상태머신](/community/report-system) · [ADR 문서화](/infra/adr-madr)

## 1. 한 줄 정의

예외 처리란, 컨트롤러 본문에서 정상 흐름만 작성하도록 두고 실패는 예외로 던져 한곳(`@RestControllerAdvice`)에서 `{success, message}` JSON과 HTTP 상태코드로 변환하는 구조를 말한다. 신고 모듈처럼 같은 "실패"라도 원인에 따라 401/403/404/409를 정확히 구분해야 클라이언트가 올바르게 반응할 수 있다.

## 2. 왜 이렇게 설계했나

기존 컨트롤러는 메서드마다 권한 체크와 try-catch 보일러플레이트가 반복됐다. 권한 분기 한 덩어리, 비즈니스 호출 한 줄, `catch (Exception e)` 한 덩어리가 매 메서드에 복붙되니 다음 문제가 생겼다.

- **권한 체크 누락 위험** — 메서드마다 직접 작성하다 보면 빠뜨린다.
- **응답 포맷 불일치** — `success`/`message` 키를 손으로 채우니 메서드마다 미묘하게 다르다.
- **변경 전파 부담** — 응답 포맷을 바꾸려면 모든 사본을 동기화해야 한다.

[ADR-0011](/infra/adr-madr)은 이 보일러플레이트를 줄이기 위해 **도메인 예외 + 글로벌 핸들러** 조합을 선택했다(AOP 권한 체크와 한 세트). 컨트롤러는 "성공하면 이 응답" 한 줄만 남기고, 실패는 예외로 위임한다.

:::tip 왜 전면 적용이 아니라 시범 적용인가
`@RestControllerAdvice`는 자칫 JSP 뷰를 반환하는 일반 페이지 컨트롤러까지 영향을 줄 수 있다. 그래서 도메인 예외는 **AJAX(@ResponseBody) 메서드에서만** 발생시키도록 범위를 좁히고, 메서드 단위로 점진 마이그레이션한다. 회귀 위험을 최소화하려는 의도적 선택이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

예외 처리 인프라는 전부 `common/exception` 패키지에 있다.

| 클래스 | 역할 | HTTP |
| --- | --- | --- |
| `BusinessException` | 도메인 예외 베이스. `httpStatus` + `message` 보유, `RuntimeException` 상속 | (가변) |
| `UnauthorizedException` | 인증 누락 — 세션에 `loginUser` 없음 | 401 |
| `ForbiddenException` | 인증은 됐으나 권한 부족(운영진 아님 등) | 403 |
| `NotFoundException` | 자원 없음 — 도메인 단위 명시적 NotFound | 404 |
| `GlobalExceptionHandler` | `@RestControllerAdvice`, 예외를 표준 JSON으로 변환 | (예외가 지정) |

이 예외를 실제로 **던지는 쪽**은 [`AuthorizationAspect`](/backend/aop-authorization)다. `@RequireLogin`이 붙은 메서드 진입 전 세션을 검사해 비로그인이면 `UnauthorizedException`, `@RequireAdmin`인데 운영진이 아니면 `ForbiddenException`을 던진다. 즉 권한 검증(AOP)과 응답 변환(Advice)이 도메인 예외를 매개로 깔끔히 분리된다.

```java
// BusinessException — 상태코드를 예외가 들고 다닌다
public class BusinessException extends RuntimeException {
    private final int httpStatus;
    public BusinessException(int httpStatus, String message) {
        super(message);
        this.httpStatus = httpStatus;
    }
    public int getHttpStatus() { return httpStatus; }
}

// 하위 예외는 상태코드를 고정
public class ForbiddenException extends BusinessException {
    public ForbiddenException(String message) { super(403, message); }
}
```

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 도메인 예외 → 글로벌 핸들러 (선언적 경로)

```text
[요청] → AuthorizationAspect(@Before)
          └ 비로그인 → throw UnauthorizedException(401)
          └ 권한부족 → throw ForbiddenException(403)
       → (통과 시) 컨트롤러 메서드 — 정상 흐름만
       → 서비스 — 도메인 위반 시 throw NotFoundException(404) 등
          ↓ 예외 전파
       → GlobalExceptionHandler.handleBusiness()
          └ status(e.getHttpStatus()).body({success:false, message:e.getMessage()})
```

핸들러 본문은 짧다. 예외가 스스로 상태코드와 메시지를 들고 오므로, 핸들러는 그대로 응답에 옮기기만 한다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Map<String, Object>> handleBusiness(BusinessException e) {
        Map<String, Object> body = new HashMap<>();
        body.put("success", false);
        body.put("message", e.getMessage());
        return ResponseEntity.status(e.getHttpStatus()).body(body);
    }
}
```

덕분에 컨트롤러는 [ADR-0011](/infra/adr-madr)의 Before/After처럼 23줄 메서드가 8줄로 줄어든다. 권한 분기와 try-catch가 사라지고 `inquiryService.updateAnswer(...)` 호출 + `ResponseEntity.ok(...)`만 남는다.

### 4-2. 신고 모듈 — HTTP 상태코드 의미 분리 (명시적 경로)

`ReportController`는 글로벌 핸들러에 의존하지 않고, 분기마다 **실패의 원인에 맞는 상태코드를 직접 선택**한다. 같은 "신고 실패"라도 원인이 다르면 코드가 달라야 클라이언트(JS)가 알맞게 안내할 수 있기 때문이다.

| 상황 | 상태코드 | 의미 |
| --- | --- | --- |
| 세션에 `loginUser` 없음 | **401** | 로그인 필요 |
| 본인 자원이 아님(타인 신고 수정·삭제) | **403** | 권한 없음 |
| `reportId`로 조회한 신고가 `null` | **404** | 자원 없음 |
| 잘못된 `targetType`, 자기 자신 신고, 수정 불가 상태 | **400** | 잘못된 요청 |
| 이미 신고함(중복) | **409** | 충돌(Conflict) |
| 예기치 못한 예외 | **500** | 서버 오류 |

핵심은 **409 Conflict**다. 중복 신고는 "요청 형식이 틀렸다(400)"가 아니라 "현재 자원 상태와 충돌한다"는 의미라 409가 정확하다. `submitReport(...)`가 `false`를 반환하면(이미 신고 이력 존재) 409로 응답한다.

```java
boolean submitted = reportService.submitReport(targetType, targetId, ...);
if (!submitted) {                       // 중복 신고
    result.put("message", msg.get("report.api.error.alreadyReported"));
    return ResponseEntity.status(409).body(result);   // 409 Conflict
}
```

수정·삭제·취소 메서드는 401 → 404 → 403 → 400 순으로 가드를 통과시킨다. 즉 "로그인했나 → 자원이 있나 → 내 것이 맞나 → 지금 상태에서 가능한 작업인가" 순서로 좁혀 들어간다.

```java
if (session.getAttribute("loginUser") == null) return status(401)...;
ReportDto report = reportService.getReport(reportId);
if (report == null)                       return status(404)...;   // 없음
if (!loginUserIdx.equals(report.getUserIdx())) return status(403)...; // 남의 것
if (!"IN_REVIEW".equals(report.getStatus())) return status(400)...;  // 상태 위반
```

:::warning 404 vs 403 — 순서가 보안에 영향
신고 모듈은 "자원 없음(404)"을 "권한 없음(403)"보다 **먼저** 확인한다. 자원이 존재하는지부터 노출하는 셈이라, 자원 존재 여부 자체를 숨기려면 둘 다 404로 통일하는 설계도 있다. 이 프로젝트는 사용자 친화적 메시지를 우선해 구분했다 — 면접에서 "왜 이 순서인가, 트레이드오프는?" 질문이 들어오면 이 점을 답하면 좋다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `BusinessException` 계열 + `GlobalExceptionHandler` | ✅ 구현됨 |
| `AuthorizationAspect`가 401/403 예외 발생 | ✅ 구현됨 |
| 신고 모듈 401/403/404/409 분리 | ✅ 구현됨 (명시적 분기) |
| 도메인 예외 전면 적용 | ⏳ 시범 적용 — AJAX 메서드 일부만, 점진 마이그레이션 중 |
| `GlobalExceptionHandler`의 일반 `Exception` 폴백 핸들러 | ❌ 미구현 — 현재 `BusinessException`만 처리. 그 외 예외는 컨트롤러의 `catch (Exception e)` → 500이 담당 |
| 표준 에러 응답 DTO(에러코드·필드 단위) | ❌ 미구현 — `Map<String, Object>`로 응답 |

:::details 두 패턴이 섞여 있는 이유를 한 문장으로
[ADR-0011](/infra/adr-madr)이 "한 번에 전부 바꾸지 말고 메서드 단위로" 마이그레이션하기로 했기 때문에, 글로벌 핸들러를 쓰는 메서드와 직접 상태코드를 고르는 메서드(신고 모듈 등)가 의도적으로 공존한다. 일관성 결여가 아니라 회귀 위험을 낮추려는 단계적 도입의 결과다.
:::

## 6. 면접 답변 3단계

1. **한 줄** — "도메인 예외를 던지면 `@RestControllerAdvice`가 표준 JSON으로 변환하고, 신고 모듈은 401·403·404·409로 실패 원인을 분리합니다."
2. **설계 의도** — "컨트롤러마다 반복되던 권한 분기와 try-catch를 줄이려고 ADR-0011에서 도메인 예외 + 글로벌 핸들러를 도입했습니다. 다만 `@RestControllerAdvice`가 JSP 뷰 컨트롤러까지 건드릴 위험이 있어 AJAX 메서드부터 점진 적용 중이고, 그래서 신고 모듈처럼 직접 상태코드를 고르는 명시적 방식이 아직 공존합니다."
3. **트레이드오프** — "예외가 상태코드를 들고 다니니 핸들러가 단순해지고 응답이 일관됩니다. 반면 전면 적용 전이라 패턴이 섞여 있고, 아직 일반 `Exception` 폴백 핸들러가 없어 예상 밖 예외는 컨트롤러의 catch가 500으로 막습니다. 다음 단계는 폴백 핸들러와 에러코드 표준화입니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 401과 403의 차이는? 신고 모듈은 어떻게 구분하나요?
401(Unauthorized)은 "누구인지 모른다 = 인증 안 됨", 403(Forbidden)은 "누구인진 알지만 권한이 없다"입니다. 신고 모듈은 세션에 `loginUser`가 없으면 401, 로그인은 했지만 `report.getUserIdx()`가 내 `loginUserIdx`와 다르면(남의 신고를 수정·삭제 시도) 403을 반환합니다. AOP 쪽도 같은 의미로 `UnauthorizedException(401)` / `ForbiddenException(403)`을 던집니다.
:::

:::details Q2. 중복 신고를 왜 400이 아니라 409로 했나요?
400은 "요청 자체가 문법적으로 틀렸다", 409(Conflict)는 "요청은 정상인데 현재 자원 상태와 충돌한다"는 뜻입니다. 중복 신고는 요청 형식 문제가 아니라 "이미 신고 이력이 있다"는 상태 충돌이므로 409가 의미상 정확합니다. 반대로 잘못된 `targetType`이나 자기 자신 신고는 요청 자체가 잘못된 것이라 400으로 둡니다.
:::

:::details Q3. `GlobalExceptionHandler`가 모든 예외를 잡나요?
아니요. 현재는 `@ExceptionHandler(BusinessException.class)` 하나뿐이라 도메인 예외 계열만 변환합니다. 그 외 예외(예: NPE, DB 오류)는 글로벌 핸들러를 거치지 않고, 신고 컨트롤러처럼 메서드 내부 `catch (Exception e)`가 잡아 500으로 응답합니다. 일반 `Exception` 폴백 핸들러 추가가 향후 과제입니다.
:::

:::details Q4. `@RestControllerAdvice`를 왜 전면 적용하지 않았나요?
`@RestControllerAdvice`는 JSON 응답을 전제로 합니다. 그런데 이 프로젝트는 JSP 뷰를 반환하는 페이지 컨트롤러가 많아, 거기서 예외가 글로벌 핸들러로 빨려 들어가면 사용자가 보는 화면이 깨질 수 있습니다. 그래서 도메인 예외는 `@ResponseBody`(AJAX) 메서드에서만 던지도록 범위를 좁히고 메서드 단위로 점진 마이그레이션 중입니다(ADR-0011의 Phase 전략).
:::

:::details Q5. 도메인 예외가 상태코드를 직접 들고 다니는 설계의 장단점은?
장점은 핸들러가 단순해진다는 점입니다. `ResponseEntity.status(e.getHttpStatus())`로 끝나서 예외 종류마다 핸들러 메서드를 늘릴 필요가 없습니다. 단점은 HTTP 관심사(상태코드)가 도메인 예외 클래스에 섞인다는 점입니다. 순수한 도메인 모델 관점에선 예외에 "에러코드"만 두고 HTTP 매핑은 핸들러가 책임지는 분리가 더 깔끔할 수 있습니다. 규모가 작고 빠른 일관성을 우선한 현실적 선택입니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 30초 안에 설명할 수 있으면 충분히 이해한 것이다.

1. 도메인 예외 방식과 신고 모듈의 명시적 방식이 **왜 공존**하는지 한 문장으로.
2. 신고 모듈의 **401/403/404/409**를 각각 어떤 상황이 유발하는지.
3. 중복 신고에 **409**를 고른 이유.
4. `@RestControllerAdvice`를 **전면 적용하지 않은** 이유와 그 트레이드오프.

## 퀴즈

<QuizBox
  question="신고 모듈에서 '이미 신고한 대상을 다시 신고'했을 때 반환하는 HTTP 상태코드는?"
  :choices="['400 Bad Request', '403 Forbidden', '409 Conflict', '422 Unprocessable Entity']"
  :answer="2"
  explanation="중복 신고는 요청 형식 오류(400)가 아니라 현재 자원 상태와의 충돌이므로 409 Conflict가 의미상 정확하다. submitReport가 false를 반환하면 409로 응답한다."
/>

<QuizBox
  question="GlobalExceptionHandler에 대한 설명으로 옳은 것은?"
  :choices="['@ControllerAdvice라서 JSP 뷰를 반환한다', '@RestControllerAdvice로 BusinessException을 표준 JSON으로 변환한다', '모든 Exception을 잡는 폴백 핸들러가 구현돼 있다', '상태코드를 핸들러가 직접 결정한다']"
  :answer="1"
  explanation="@RestControllerAdvice이며 현재는 BusinessException만 처리한다. 상태코드는 예외 객체(getHttpStatus)가 들고 오고, 일반 Exception 폴백 핸들러는 아직 없다."
/>

<QuizBox
  question="AuthorizationAspect가 @RequireAdmin 메서드에서 '로그인은 했으나 운영진이 아닌' 사용자에 대해 던지는 예외와 상태코드는?"
  :choices="['UnauthorizedException / 401', 'ForbiddenException / 403', 'NotFoundException / 404', 'BusinessException / 400']"
  :answer="1"
  explanation="인증은 됐지만 권한이 부족한 경우이므로 ForbiddenException(403)을 던진다. 세션에 loginUser 자체가 없으면 UnauthorizedException(401)이다."
/>
