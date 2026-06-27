# AOP 권한 체크

> 컨트롤러 메서드에 `@RequireLogin` / `@RequireAdmin` 한 줄만 붙이면, AOP `AuthorizationAspect`가 메서드 진입 직전에 세션 로그인·운영진 권한을 검증하고 실패 시 도메인 예외(401/403)를 던진다. ADR-0011의 선언적 보안 패턴이다.

이 페이지는 특정 도메인이 아니라 4명이 만든 모든 컨트롤러가 공통으로 사용하는 **권한 체크 인프라**를 다룬다. 인증·문의·신고·커뮤니티 등 어느 도메인이든 "로그인 필수" 또는 "운영진 전용" 액션은 같은 어노테이션과 같은 Aspect를 거친다.

## 1. 한 줄 정의

`@RequireLogin` / `@RequireAdmin`은 메서드 단위 권한 마커 어노테이션이고, `AuthorizationAspect`는 그 어노테이션이 붙은 메서드 실행 **직전(`@Before`)** 에 `RequestContextHolder`로 현재 세션의 `loginUser`를 꺼내 검증한 뒤, 미인증이면 `UnauthorizedException(401)`, 운영진이 아니면 `ForbiddenException(403)`을 던지는 **선언적 권한 게이트**다.

## 2. 왜 이렇게 설계했나

ADR-0011에 따르면, 도입 전 컨트롤러는 메서드마다 다음 보일러플레이트를 직접 반복했다.

- 세션에서 로그인 유저를 리플렉션 ad-hoc으로 꺼내고(`getLoginUserIdx`, `isAdmin`이 컨트롤러마다 **사본 정의**)
- `if (!isAdmin) { result.put("success", false); ... return status(403); }`
- `try { ... } catch (Exception e) { ... return status(500); }`

이 방식의 문제는 (1) 권한 체크 **누락 위험**(메서드마다 손으로 작성), (2) 응답 포맷 불일치, (3) 리플렉션 비용 + 타입 안전성 결여, (4) 헬퍼 변경 시 모든 사본 동기화 부담이었다.

검토한 대안은 셋이었다.

| 옵션 | 내용 | 평가 |
| --- | --- | --- |
| A. 리플렉션 ad-hoc 유지 | 추가 인프라 0 | 보일러플레이트·누락 위험 지속 |
| B. `HandlerInterceptor` URL 패턴 차단 | Spring 표준, 이미 사용 중 | URL 매칭은 **메서드 단위 분기**에 부적합 |
| C. AOP + 어노테이션 + ArgumentResolver + `RestControllerAdvice` | 메서드 단위 선언적 권한 | 채택 |

핵심은 **메서드 단위 분기**다. 같은 컨트롤러 안에서 "조회는 공개, 수정은 운영진"처럼 메서드별로 권한이 갈리는데, URL 패턴 기반 인터셉터(옵션 B)는 이를 깔끔히 표현하기 어렵다. AOP 어노테이션은 메서드 시그니처만 봐도 권한 요구가 드러나고, `@LoginUser` 파라미터 자동 주입과 결합해 컨트롤러 본문 라인 수를 크게 줄인다.

:::tip 인터셉터와 AOP는 경쟁이 아니라 역할 분담
인터셉터 체인(`login → admin → ...`)은 **URL/페이지 단위**의 굵은 차단(예: 마이페이지 전체를 비로그인 차단)을 맡고, AOP는 같은 컨트롤러 안의 **개별 AJAX 메서드 단위** 권한을 맡는다. 둘 다 컨트롤러 진입 전에 동작하지만 결이 다르다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스)

ADR-0011이 정의한 `common` 하위 컴포넌트들이다.

| 요소 | 클래스 / 위치 | 역할 |
| --- | --- | --- |
| 로그인 마커 | `common/annotation/RequireLogin` (`@Target(METHOD)`) | "로그인 필수" 선언 |
| 운영진 마커 | `common/annotation/RequireAdmin` (`@Target(METHOD)`) | "운영진 전용" 선언 |
| 유저 주입 마커 | `common/annotation/LoginUser` (`@Target(PARAMETER)`) | 세션 유저를 파라미터로 주입 |
| 권한 검증 Aspect | `common/aop/AuthorizationAspect` (`@Aspect @Component`) | `@Before`로 진입 전 검증 |
| 파라미터 리졸버 | `common/resolver/LoginUserArgumentResolver` | `@LoginUser UsersVO` → 세션 유저 |
| 도메인 예외 | `common/exception/{Unauthorized,Forbidden,NotFound}Exception` ← `BusinessException` | HTTP 상태 + 메시지 운반 |
| 전역 핸들러 | `common/exception/GlobalExceptionHandler` (`@RestControllerAdvice`) | 예외 → 표준 JSON |
| 등록 | `config/WebConfig.addArgumentResolvers` | 리졸버를 MVC에 등록 |

`AuthorizationAspect`의 검증 본체는 짧다. 별도 의존 주입 없이 `RequestContextHolder`로 현재 요청의 세션을 직접 꺼내는 점이 특징이다.

```java
@Aspect @Component
public class AuthorizationAspect {

  @Before("@annotation(org.triptogether.common.annotation.RequireLogin)")
  public void checkLogin() {
    if (currentLoginUser() == null) throw new UnauthorizedException(); // 401
  }

  @Before("@annotation(org.triptogether.common.annotation.RequireAdmin)")
  public void checkAdmin() {
    UsersVO user = currentLoginUser();
    if (user == null) throw new UnauthorizedException();               // 401
    if (!user.hasAdminRole()) throw new ForbiddenException("운영진만 접근할 수 있습니다."); // 403
  }

  private UsersVO currentLoginUser() {
    ServletRequestAttributes attrs =
        (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
    if (attrs == null) return null;
    HttpSession session = attrs.getRequest().getSession(false);
    if (session == null) return null;
    Object u = session.getAttribute("loginUser");
    return (u instanceof UsersVO) ? (UsersVO) u : null;
  }
}
```

운영진 판정은 VO에 캡슐화돼 있다. `UsersVO.hasAdminRole()`은 `userRole` 문자열을 `UserRole` enum으로 변환해 `isAdminLike()`(ADMIN/SUPERADMIN 계열)를 묻는다. Aspect는 "운영진인가?"만 알면 되고, "어떤 역할이 운영진인가"의 정의는 VO/enum이 책임진다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 한 요청의 처리 순서

```text
요청 → 인터셉터 체인(URL 단위 굵은 차단)
     → DispatcherServlet → 핸들러 선택
     → @Before AuthorizationAspect : @RequireLogin/@RequireAdmin 검증
         · loginUser 없음           → throw UnauthorizedException(401)
         · loginUser 있고 비운영진   → throw ForbiddenException(403)   [@RequireAdmin]
         · 통과
     → @LoginUser 파라미터 주입(LoginUserArgumentResolver)
     → 컨트롤러 본문 실행 (user는 non-null 가정 안전)
     → 예외 발생 시 GlobalExceptionHandler 가 {success,false,message} 로 변환
```

### 어노테이션 → 예외 → 응답 매핑

| 상황 | 던지는 예외 | HTTP | 응답 본문 |
| --- | --- | --- | --- |
| `@RequireLogin` + 비로그인 | `UnauthorizedException` | 401 | `{ success:false, message:"로그인이 필요합니다." }` |
| `@RequireAdmin` + 비로그인 | `UnauthorizedException` | 401 | 위와 동일 |
| `@RequireAdmin` + 일반 회원 | `ForbiddenException` | 403 | `{ success:false, message:"운영진만 접근할 수 있습니다." }` |
| 도메인 자원 없음 | `NotFoundException` | 404 | `{ success:false, message:"..." }` |

`GlobalExceptionHandler`는 `BusinessException`의 `httpStatus`와 `message`를 그대로 응답에 옮긴다. 즉 새 예외 타입을 추가해도 핸들러를 고칠 필요가 없다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
  @ExceptionHandler(BusinessException.class)
  public ResponseEntity<Map<String,Object>> handle(BusinessException e) {
    return ResponseEntity.status(e.getHttpStatus())
        .body(Map.of("success", false, "message", e.getMessage()));
  }
}
```

### Before / After (ADR-0011 시범 적용)

`InquiryController.editAnswer`가 시범 메서드다. 23줄짜리 수동 권한·예외 처리가 8줄로 줄었다.

```java
// After — @RequireAdmin + @LoginUser
@PostMapping("/{inquiryId}/answer/edit") @ResponseBody
@RequireAdmin
public ResponseEntity<Map<String,Object>> editAnswer(
    @PathVariable Long inquiryId,
    @RequestParam String content,
    @LoginUser UsersVO user) {
  inquiryService.updateAnswer(inquiryId, content, user.getUserIdx());
  return ResponseEntity.ok(Map.of("success", true));
}
```

권한 체크와 예외→응답 변환이 사라지고, 컨트롤러는 **비즈니스 로직만** 남았다.

### 소유자 OR 운영진 패턴

AOP는 "역할 권한"(로그인했나 / 운영진인가)을 본다. 하지만 "이 게시글의 **작성자 본인인가**"처럼 **자원 소유권**은 자원을 조회해야 알 수 있어 AOP 단계에서 판단할 수 없다. 그래서 소유권은 컨트롤러/서비스에서 별도로 본다. 실제 코드의 전형적 형태는 "**소유자이거나 운영진(어드민 모드)이면 허용**"이다.

```java
// DetailController.canEditSpot — 소유자 OR 운영진
private boolean canEditSpot(HttpSession session, ExploreVO spot) {
  if (spot == null) return false;
  if (isAdminMode(session)) return true;             // 운영진(관리 모드)
  UsersVO me = getLoginUser(session);
  return me != null && spot.getUserIdx() != null
      && spot.getUserIdx().equals(me.getUserIdx());  // 본인 소유
}
```

커뮤니티·신고·여행 코스에서도 같은 모양으로, `isOwner = loginUserIdx.equals(post.getUserIdx())`를 계산해 뷰에 내려주거나, `isOwner || hasAdminRole()`로 분기한다.

:::warning "블록 유저 403"의 책임 위치
AOP는 `loginUser`의 **존재**와 **역할**만 본다. 차단(BLOCKED) 상태 사용자를 막는 것은 별도 계층의 일이다. `UsersVO`에는 `accountStatus`(ACTIVE/DORMANT/BLOCKED/DELETED), `blockedUntil`, `blockedReason`이 있고, 차단·휴면 차단은 로그인·IP 차단 인터셉터와 도메인 정책에서 처리한다. "차단된 사용자의 쓰기 요청을 403으로 막는다"는 정책은 AOP 어노테이션이 아니라 그 계층에 둔다고 이해하면 된다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

ADR-0011은 명시적으로 **점진적 마이그레이션** 단계임을 밝힌다. 과장 없이 정리하면:

- **구현됨**: `@RequireLogin` / `@RequireAdmin` 어노테이션, `AuthorizationAspect`(`@Before` 검증), `LoginUserArgumentResolver`(`WebConfig` 등록 완료), `BusinessException` 계열 4종 + `GlobalExceptionHandler`. `InquiryController`의 `editAnswer` / `getAnswerHistory` / `clearBlur`에 **시범 적용**돼 실제 동작한다.
- **진행 중 / 계획**: ADR 로드맵상 Phase 2~5(전체 어드민 메서드 → 일반 로그인 메서드 → 기존 `getLoginUserIdx`·`isAdmin` 헬퍼 제거)는 단계적 진행. 그래서 코드베이스에는 **어노테이션 방식과 기존 명시적 체크가 혼재**한다(의도된 과도기).
- **주의/한계**: `@RestControllerAdvice`는 전역이라 JSON을 반환하는 핸들러에 작동한다. 그래서 ADR은 "도메인 예외는 **시범 적용 메서드에서만** 발생시킨다"는 가정으로 일반 JSP 페이지 컨트롤러에 영향이 가지 않게 통제한다. Spring Security의 `@PreAuthorize` 같은 SpEL 표현식 권한은 도입하지 않았다(이건 그 **경량 대체**다).

## 6. 면접 답변 3단계

1. **한 줄**: "컨트롤러 메서드에 `@RequireLogin`·`@RequireAdmin`을 붙이면 AOP `AuthorizationAspect`가 진입 직전에 세션 권한을 검증하고, 실패 시 401/403 도메인 예외를 전역 핸들러가 표준 JSON으로 변환하는 선언적 보안 구조입니다."
2. **왜**: "원래는 메서드마다 `isAdmin` 체크와 try-catch를 손으로 복붙해 누락·불일치 위험이 컸습니다. URL 패턴 인터셉터로는 같은 컨트롤러의 메서드별 분기를 표현하기 어려워, 메서드 단위 어노테이션 + AOP를 택했고 `@LoginUser` 주입과 결합해 컨트롤러를 비즈니스 로직만 남겼습니다."
3. **트레이드오프/한계**: "역할 권한은 AOP가 보지만 '작성자 본인인가' 같은 자원 소유권은 자원을 조회해야 알 수 있어 컨트롤러에서 '소유자 OR 운영진'으로 따로 봅니다. 또 전면 적용이 아니라 ADR-0011 로드맵에 따른 점진 마이그레이션이라, 아직 기존 명시적 체크와 혼재합니다."

## 7. 꼬리질문 + 모범답안

:::details Q. 인터셉터로도 권한 체크가 되는데 굳이 AOP를 쓴 이유는?
인터셉터는 URL 패턴 단위라 "마이페이지 전체 비로그인 차단" 같은 굵은 차단에 적합합니다. 하지만 같은 컨트롤러에서 조회 메서드는 공개, 수정 메서드는 운영진처럼 **메서드별로 권한이 갈리면** URL 매칭으로 표현하기 번거롭습니다. AOP `@annotation` 포인트컷은 어노테이션이 붙은 메서드만 정확히 가로채므로 메서드 단위 선언이 깔끔합니다. 그래서 둘을 역할 분담합니다.
:::

:::details Q. Aspect가 의존성 주입 없이 어떻게 세션을 꺼내나요?
`RequestContextHolder.getRequestAttributes()`로 현재 스레드에 바인딩된 요청 컨텍스트를 가져와 `HttpServletRequest`, 그 다음 `getSession(false)`로 세션을 얻습니다. `false`라 세션이 없으면 새로 만들지 않고 그대로 미인증으로 처리합니다. 덕분에 Aspect가 `HttpServletRequest`를 파라미터로 받지 않아도 됩니다.
:::

:::details Q. `@RequireAdmin`이 붙은 메서드에 비로그인 사용자가 오면 401인가요 403인가요?
401입니다. `checkAdmin`은 먼저 `loginUser == null`이면 `UnauthorizedException(401)`을 던지고, 로그인은 됐지만 `hasAdminRole()`이 false일 때만 `ForbiddenException(403)`을 던집니다. "누구인지 모름(401)"과 "누구인지는 알지만 권한 없음(403)"을 의미대로 구분한 겁니다.
:::

:::details Q. `@LoginUser`로 주입받은 `user`가 null일 걱정은 안 하나요?
`LoginUserArgumentResolver`는 비로그인 시 null을 주입할 수 있습니다. 다만 같은 메서드에 `@RequireLogin`이나 `@RequireAdmin`이 함께 붙어 있으면 AOP가 **먼저** 비로그인을 차단하므로, 컨트롤러 본문은 `user`가 non-null이라고 가정해도 안전합니다. 어노테이션과 리졸버가 짝으로 동작하도록 설계된 점이 핵심입니다.
:::

:::details Q. 차단(BLOCKED)된 사용자의 쓰기를 막는 건 이 AOP가 하나요?
아닙니다. AOP는 로그인 존재와 운영진 역할만 봅니다. 차단 상태는 `UsersVO.accountStatus`(BLOCKED 등)·`blockedUntil`로 표현되고, 차단·휴면 통제는 로그인/IP 차단 인터셉터와 도메인 정책 계층의 책임입니다. 권한(인가)과 계정 상태(차단)를 다른 계층에 둬서 각 관심사를 분리했습니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 30초씩 설명해 보세요.

- `@RequireLogin`과 `@RequireAdmin`이 각각 어떤 예외를 어떤 상태코드로 던지는지, 그리고 그 분기가 왜 401/403으로 갈리는지.
- "역할 권한(AOP)"과 "자원 소유권(소유자 OR 운영진)"이 왜 다른 계층에서 처리되는지, `canEditSpot` 예로.
- `AuthorizationAspect` → 도메인 예외 → `GlobalExceptionHandler`로 이어지는 응답 일관성 흐름.
- 이 패턴이 Spring Security `@PreAuthorize`의 **경량 대체**인 이유와, 아직 점진 마이그레이션(ADR-0011) 단계인 점.

## 퀴즈

<QuizBox
  question="@RequireAdmin이 붙은 메서드에 '로그인은 했지만 일반 회원'이 접근하면 AuthorizationAspect는 무엇을 하는가?"
  :choices="['UnauthorizedException(401)을 던진다', 'ForbiddenException(403)을 던진다', '컨트롤러를 그대로 실행한다', '로그인 페이지로 리다이렉트한다']"
  :answer="1"
  explanation="checkAdmin은 loginUser가 null이 아니지만 hasAdminRole()이 false일 때 ForbiddenException(403)을 던진다. 비로그인이면 그 전에 401이 난다."
/>

<QuizBox
  question="AOP AuthorizationAspect가 메서드 진입 직전에 검증할 수 있는 것은?"
  :choices="['게시글의 작성자가 본인인지(자원 소유권)', '세션에 loginUser가 존재하는지 / 운영진 역할인지', '요청 본문 JSON이 스키마에 맞는지', '사용자가 BLOCKED 상태인지']"
  :answer="1"
  explanation="AOP는 세션의 로그인 존재와 운영진 역할(hasAdminRole)만 본다. 자원 소유권은 자원을 조회해야 알 수 있어 컨트롤러에서 '소유자 OR 운영진'으로 따로 처리하고, 차단(BLOCKED)은 다른 계층의 책임이다."
/>

<QuizBox
  question="권한 실패 시 던진 도메인 예외를 표준 JSON {success:false, message}로 변환하는 컴포넌트는?"
  :choices="['LoginUserArgumentResolver', 'LoginInterceptor', 'GlobalExceptionHandler(@RestControllerAdvice)', 'DispatcherServlet']"
  :answer="2"
  explanation="@RestControllerAdvice인 GlobalExceptionHandler가 BusinessException의 httpStatus와 message를 그대로 응답에 옮긴다. 새 예외 타입을 추가해도 핸들러는 고칠 필요가 없다."
/>

---

**관련 페이지**: [@LoginUser 리졸버](/backend/login-user-resolver) · [예외 처리](/backend/exception-handling) · [인터셉터 체인](/backend/interceptors)

**허브**: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
