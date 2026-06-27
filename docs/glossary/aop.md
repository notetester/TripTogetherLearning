# AOP (관점지향 프로그래밍)

> 권한 체크, 로깅, 한도 검증처럼 여러 메서드에 흩어져 반복되는 **횡단 관심사**(cross-cutting concern)를, 본문 코드를 건드리지 않고 한곳에 모아 자동 적용하는 기법. TripTogether는 `@RequireLogin`/`@RequireAdmin` 어노테이션 + `AuthorizationAspect`로 권한 검증을 중앙화했다 (ADR-0011).

## 1. 한 줄 정의

**AOP**는 비즈니스 로직과 직교(orthogonal)하면서 여러 곳에 반복되는 관심사 — 권한 체크, 트랜잭션, 로깅 — 를 **Aspect**라는 별도 모듈로 분리하고, **Pointcut**(어디에)과 **Advice**(무엇을)로 지정해 메서드 호출 전후에 자동으로 끼워 넣는 기법이다. TripTogether에서는 컨트롤러 메서드에 `@RequireLogin`/`@RequireAdmin`만 붙이면 `AuthorizationAspect`가 진입 직전 세션 권한을 검증한다.

## 2. 왜 이렇게 설계했나

ADR-0011 이전, 컨트롤러 메서드마다 권한 체크와 try-catch 응답 변환이 통째로 복사돼 있었다.

```text
if (!isAdmin(session)) {                 // 메서드마다 반복
    result.put("success", false);
    result.put("message", "운영진만 ...");
    return ResponseEntity.status(403).body(result);
}
try { ... } catch (Exception e) { ... }  // 메서드마다 반복
```

이 보일러플레이트는 네 가지 문제를 낳았다.

- **권한 체크 누락 위험** — 메서드마다 직접 작성하니 한 곳 빠뜨리면 곧 보안 구멍.
- **응답 포맷 불일치** — `success`/`message`를 손으로 채워 메서드마다 미묘하게 다름.
- **리플렉션 ad-hoc 비용** — `getLoginUserIdx`, `isAdmin` 헬퍼가 컨트롤러마다 사본으로 존재, 변경 시 전부 동기화.
- **의도 불명확** — 메서드 시그니처만 봐서는 "로그인 필요"인지 "운영진 전용"인지 알 수 없음.

AOP는 이 관심사를 **선언적**으로 바꾼다. 메서드에 `@RequireAdmin` 한 줄을 붙이면 권한 요구가 시그니처에 드러나고, 검증 로직은 `AuthorizationAspect` 한 곳에만 존재한다. 누락은 코드 리뷰에서 즉시 보이고, 응답 포맷은 `GlobalExceptionHandler`가 일관되게 변환한다.

:::tip 왜 인터셉터가 아니라 AOP인가
[인터셉터](/glossary/interceptor)는 **URL 패턴** 단위로 동작한다 (`/mypage/**`는 로그인 필요 등). 하지만 같은 컨트롤러 안에서 "이 메서드는 조회라 공개, 저 메서드는 수정이라 운영진 전용"처럼 **메서드 단위**로 갈리는 권한은 URL 매칭으로 표현하기 어렵다. AOP 어노테이션은 메서드 시그니처에 직접 붙어 이 분기를 자연스럽게 표현한다. ADR-0011은 Option B(인터셉터) 대신 Option C(AOP)를 이 이유로 선택했다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

Spring AOP(`spring-boot-starter-aop`, AspectJ 어노테이션) 기반. 핵심 구성 요소는 다음과 같다.

| 구성 요소 | 종류 | 역할 |
| --- | --- | --- |
| `@RequireLogin` | 메서드 어노테이션 (`@Target(METHOD)`, RUNTIME) | "로그인 필요" 마킹 |
| `@RequireAdmin` | 메서드 어노테이션 | "운영진(ADMIN/SUPERADMIN) 전용" 마킹 |
| `@LoginUser` | 파라미터 어노테이션 (`@Target(PARAMETER)`) | 세션의 `UsersVO`를 파라미터에 자동 주입 |
| `AuthorizationAspect` | `@Aspect @Component` | `@Before` advice로 진입 직전 권한 검증 |
| `LoginUserArgumentResolver` | `HandlerMethodArgumentResolver` | `@LoginUser` 파라미터 → `UsersVO` 주입 (AOP는 아니지만 짝을 이룸) |
| `GlobalExceptionHandler` | `@RestControllerAdvice` | `Unauthorized`/`Forbidden` 예외 → 표준 응답 |
| `WalletChargeLimitAspect` | `@Aspect @Component` | 또 다른 AOP 사례 — 충전 한도 검증 |

권한 검증의 핵심은 `AuthorizationAspect`다. `@LoginUser` 자동 주입은 `HandlerMethodArgumentResolver`로 구현된 별개 장치이지만, AOP와 같은 세션 키(`loginUser`)를 읽어 한 쌍으로 동작한다 (상세는 [세션/쿠키](/glossary/session-cookie) 참고).

## 4. 동작 원리 (흐름·표·작은 코드)

### AuthorizationAspect — `@Before` advice

`@annotation(...)` 포인트컷은 "해당 어노테이션이 붙은 메서드"를 가리킨다. 실패 시 도메인 예외를 던지고, `GlobalExceptionHandler`가 401/403 응답으로 변환한다.

```java
@Aspect
@Component
public class AuthorizationAspect {

    @Before("@annotation(org.triptogether.common.annotation.RequireLogin)")
    public void checkLogin() {
        if (currentLoginUser() == null) {
            throw new UnauthorizedException();          // 401
        }
    }

    @Before("@annotation(org.triptogether.common.annotation.RequireAdmin)")
    public void checkAdmin() {
        UsersVO user = currentLoginUser();
        if (user == null) throw new UnauthorizedException();           // 401
        if (!user.hasAdminRole())
            throw new ForbiddenException("운영진만 접근할 수 있습니다."); // 403
    }
    // currentLoginUser()는 RequestContextHolder로 세션의 loginUser를 꺼낸다
}
```

주목할 점: Aspect가 `HttpSession`을 파라미터로 받지 않고 **`RequestContextHolder`로 현재 요청을 직접 꺼낸다**. 덕분에 컨트롤러 시그니처를 오염시키지 않고, 별도 의존 주입 없이 동작한다.

### 한 요청이 거치는 순서

| 단계 | 처리 | 담당 |
| --- | --- | --- |
| 1 | URL 패턴 보호 경로 차단 (인터셉터 체인) | `LoginInterceptor` 등 |
| 2 | 컨트롤러 메서드 진입 **직전** 권한 검증 | `AuthorizationAspect` (`@Before`) |
| 3 | `@LoginUser UsersVO user` 파라미터 주입 | `LoginUserArgumentResolver` |
| 4 | 컨트롤러 본문 실행 (user는 non-null 가정 안전) | 컨트롤러 |
| 5 | 던져진 도메인 예외 → 표준 응답 변환 | `GlobalExceptionHandler` |

### Before / After (ADR-0011 실측)

권한 + try-catch가 23줄이던 메서드가 8줄로 줄었다.

```java
// After — 어노테이션이 의도를 선언, 본문은 핵심만
@PostMapping("/{inquiryId}/answer/edit")
@ResponseBody
@RequireAdmin                                   // ← AOP가 진입 전 검증
public ResponseEntity<Map<String, Object>> editAnswer(
        @PathVariable Long inquiryId,
        @RequestParam String content,
        @LoginUser UsersVO user) {              // ← 세션 사용자 자동 주입
    inquiryService.updateAnswer(inquiryId, content, user.getUserIdx());
    return ResponseEntity.ok(Map.of("success", true));
}
```

→ 라인 수 약 64% 감소, 권한 의도가 시그니처에 명시.

### 또 다른 Aspect — 충전 한도 검증

권한만 AOP인 건 아니다. `WalletChargeLimitAspect`는 `execution(...)` 포인트컷으로 `WalletService`의 충전 메서드를 가로채 등급별 한도를 검증한다. **서비스 본 코드를 건드리지 않고** 정책을 끼워 넣은 사례다.

```java
@Before("execution(* org.triptogether.myPage.service.WalletService.simulateCashCharge(..)) "
      + "&& args(userIdx, amount, ..)")
public void beforeSimulate(JoinPoint jp, Long userIdx, long amount) {
    validate(userIdx, amount);   // 1회/일/월 한도 초과 시 IllegalStateException
}
```

:::warning FAIL-OPEN 설계 주의
`WalletChargeLimitAspect`는 정책 조회가 실패하면 결제를 막지 않고 통과시킨다(FAIL-OPEN). 결제 흐름을 부수 검증이 끊지 않게 한 의도적 선택이지만, 한도 우회 가능성이 있으므로 권한 검증(FAIL-CLOSED, 의심되면 차단)과는 정책 방향이 반대임을 면접에서 구분해 설명하면 좋다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: `AuthorizationAspect`(`@RequireLogin`/`@RequireAdmin`), `LoginUserArgumentResolver`(`@LoginUser`), `GlobalExceptionHandler` 표준 응답 변환, `WalletChargeLimitAspect` 한도 검증. AOP·어노테이션·리졸버·예외 핸들러 인프라 일체.
- **점진 마이그레이션 중**: ADR-0011은 의도적으로 **시범 적용** 단계다. `InquiryController`의 일부 메서드(`editAnswer`, `getAnswerHistory`, `clearBlur`)에 먼저 적용했고, 나머지 어드민/로그인 메서드와 기존 `getLoginUserIdx`·`isAdmin` 헬퍼 제거는 Phase 2~5로 예정됐다. 따라서 **현재 코드에는 어노테이션 방식과 기존 명시적 체크가 혼재**한다. 회귀 위험을 줄이려 한 번에 옮기지 않는다.
- **유의**: Spring Security를 전면 도입하지 않은 환경이라, AOP는 그 선언적 보안의 **작은 자체 구현**이다. 일반 사용자 페이지(JSP view 반환)에는 어노테이션을 적용하지 않아 영향이 없다.

## 6. 면접 답변 3단계

1. **한 문장** — "권한 체크 같은 횡단 관심사를 Spring AOP로 중앙화했습니다. 컨트롤러 메서드에 `@RequireLogin`/`@RequireAdmin`만 붙이면 `AuthorizationAspect`가 진입 직전에 세션 권한을 검증합니다."
2. **왜** — "이전엔 메서드마다 `isAdmin` 체크와 try-catch 응답 변환이 복사돼 있어 권한 누락·포맷 불일치 위험이 컸습니다. AOP로 옮기면 검증 로직이 한 곳에만 있고, 어노테이션이 시그니처에서 의도를 선언해 리뷰에서 누락이 바로 보입니다."
3. **어떻게** — "`@Before("@annotation(RequireAdmin)")` 포인트컷으로 메서드 진입 전 advice를 실행하고, 실패하면 `UnauthorizedException`(401)/`ForbiddenException`(403)을 던집니다. `GlobalExceptionHandler`가 표준 응답으로 변환하고, `@LoginUser`는 별도 ArgumentResolver로 세션 사용자를 주입해 시그니처를 깔끔하게 만듭니다. ADR-0011 기준 시범 메서드에서 라인 수가 64% 줄었습니다."

## 7. 꼬리질문 + 모범답안

:::details "AOP와 인터셉터의 차이는 무엇인가요? 왜 둘 다 쓰나요?"
인터셉터는 **URL 패턴** 단위로 컨트롤러 앞에서 동작하고(`HandlerInterceptor`), AOP는 **메서드(또는 빈 메서드 호출)** 단위로 동작합니다. TripTogether는 `/mypage/**` 같은 경로 전체 보호는 인터셉터로, 같은 컨트롤러 안에서 메서드마다 갈리는 운영진 권한은 AOP로 처리합니다. 인터셉터는 서블릿 디스패치 레벨, AOP는 스프링 빈 프록시 레벨이라 적용 범위가 다릅니다. 메서드 단위 분기를 URL 매칭으로 표현하면 부자연스러워 AOP가 적합합니다.
:::

:::details "Spring AOP는 어떻게 메서드를 가로채나요? 한계는?"
Spring AOP는 **런타임 프록시** 기반입니다. 대상 빈을 감싼 프록시(인터페이스면 JDK 동적 프록시, 아니면 CGLIB)가 advice를 먼저 실행한 뒤 실제 메서드를 호출합니다. 한계는 (1) **스프링 빈을 거치는 호출에만** 적용된다는 점 — 같은 클래스 내부의 `this.method()` 자기 호출은 프록시를 안 거쳐 advice가 안 걸립니다. (2) `final` 메서드/클래스는 CGLIB가 못 감쌉니다. 컴파일 타임 위빙(AspectJ)이 아니라 런타임 프록시라 생기는 제약입니다.
:::

:::details "@RequireLogin이 빠진 메서드는 어떻게 막나요? 어노테이션 누락이 보안 구멍 아닌가요?"
맞습니다, AOP는 "붙인 메서드"만 검사하므로 누락이 곧 구멍입니다. 그래서 다층 방어를 둡니다: URL 단위 `LoginInterceptor`가 보호 경로를 1차로 막고, AOP가 메서드 단위로 2차 검증합니다. 또 어노테이션은 시그니처에 드러나 코드 리뷰에서 누락이 즉시 보입니다. 현재는 시범 적용 단계라 ADR-0011의 마이그레이션 계획(Phase 2~5)으로 점진 확대 중입니다.
:::

:::details "Aspect가 HttpSession을 어떻게 얻나요? 파라미터로 안 받던데요."
`RequestContextHolder.getRequestAttributes()`로 현재 스레드에 바인딩된 요청을 꺼내고, 거기서 `getSession(false)` → `getAttribute("loginUser")`로 `UsersVO`를 얻습니다. 컨트롤러 시그니처에 `HttpSession`을 추가하지 않아 본문이 깨끗하고, Aspect에 별도 의존 주입도 필요 없습니다. 단, 이 방식은 HTTP 요청 스레드 컨텍스트가 있어야 동작하므로 비동기/배치 스레드에선 주의가 필요합니다.
:::

:::details "권한 검증과 충전 한도 검증, 둘 다 AOP인데 실패 정책이 다른 이유는?"
권한은 **FAIL-CLOSED** — 검증 자체가 의심스러우면 차단해야 안전합니다(`Unauthorized`/`Forbidden`). 반면 `WalletChargeLimitAspect`는 정책 조회 실패 시 결제를 통과시키는 **FAIL-OPEN**입니다. 부가 정책(한도)이 핵심 결제 흐름을 끊지 않게 한 의도적 선택입니다. 같은 AOP라도 관심사 성격에 따라 실패 시 기본 동작을 반대로 설계한다는 점을 구분하는 게 중요합니다.
:::

## 8. 직접 말해보기

- "AOP가 무엇이고 TripTogether에서 어떤 횡단 관심사를 처리하는지 30초로 설명해보세요." (권한·한도 검증 / `@RequireAdmin` + `AuthorizationAspect`)
- "`@RequireAdmin`을 붙인 메서드에 비로그인 사용자가 접근하면 401/403 중 무엇이 떨어지고 왜인지 말해보세요." (user가 null → 401, 로그인했지만 운영진 아님 → 403)
- "AOP 대신 인터셉터로 같은 일을 했다면 어디서 불편했을지 설명해보세요." (메서드 단위 권한 분기를 URL 패턴으로 표현하기 어려움)
- "Spring AOP가 자기 호출(self-invocation)에 안 걸리는 이유를 설명해보세요." (프록시를 안 거치는 내부 `this.method()` 호출)

더 보기: [인터셉터](/glossary/interceptor) · [세션/쿠키](/glossary/session-cookie) · [HTTP 메서드·상태코드](/glossary/http-methods) · [4계층 구조](/glossary/layered-architecture) | 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether에서 @RequireLogin / @RequireAdmin이 붙은 컨트롤러 메서드의 권한을 진입 직전에 검증하는 컴포넌트는?" :choices="['LoginInterceptor', 'AuthorizationAspect', 'LoginUserArgumentResolver', 'GlobalExceptionHandler']" :answer="1" explanation="AuthorizationAspect가 @Before advice로 @annotation(RequireLogin/RequireAdmin) 포인트컷에 매칭된 메서드 진입 직전 세션의 loginUser를 검증한다. 인터셉터는 URL 패턴 단위, 리졸버는 파라미터 주입, 핸들러는 예외→응답 변환으로 역할이 다르다." />

<QuizBox question="@RequireAdmin이 붙은 메서드에 '로그인은 했지만 운영진이 아닌' 사용자가 접근하면?" :choices="['UnauthorizedException(401)이 던져진다', 'ForbiddenException(403)이 던져진다', '컨트롤러가 정상 실행된다', 'LoginInterceptor가 리다이렉트한다']" :answer="1" explanation="AuthorizationAspect.checkAdmin은 user가 null이면 401(Unauthorized), user는 있지만 hasAdminRole()이 false면 403(Forbidden)을 던진다. 로그인 O + 권한 X 이므로 403이다." />

<QuizBox question="AOP를 인터셉터 대신 권한 체크에 선택한 ADR-0011의 핵심 이유로 가장 적절한 것은?" :choices="['AOP가 인터셉터보다 항상 빠르기 때문', 'URL 패턴이 아니라 메서드 단위로 권한 분기를 선언적으로 표현할 수 있기 때문', 'Spring Security를 전면 도입하기 위해', '세션 없이 동작하기 때문']" :answer="1" explanation="같은 컨트롤러 안에서 메서드마다 갈리는 권한(조회는 공개, 수정은 운영진 전용)은 URL 패턴 매칭으로 표현하기 어렵다. AOP 어노테이션은 메서드 시그니처에 직접 붙어 이 분기를 선언적으로 표현하므로 ADR-0011은 인터셉터(Option B) 대신 AOP(Option C)를 선택했다." />
