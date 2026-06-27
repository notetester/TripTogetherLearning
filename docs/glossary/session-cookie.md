# 세션 / 쿠키

> TripTogether는 JWT가 아니라 **서버 세션**으로 로그인을 유지한다. 로그인하면 `UsersVO`를 세션에 담고(`loginUser`), 브라우저는 `JSESSIONID` 쿠키 하나만 들고 다닌다.

## 1. 한 줄 정의

**세션**은 서버 메모리(embedded Tomcat)에 사용자별로 보관되는 상태 저장소이고, **쿠키**(`JSESSIONID`)는 그 세션을 가리키는 식별자다. 로그인 사용자 정보(`UsersVO`)는 서버 세션 속성 `loginUser`에 저장되며, 브라우저에는 세션 ID만 오간다. 토큰(JWT)을 클라이언트에 발급하지 않는다.

## 2. 왜 이렇게 설계했나

TripTogether는 React SPA가 아니라 **JSP 서버 사이드 렌더링**(JSTL/EL, WAR, embedded Tomcat) 기반 웹앱이다. 이 구조에서는 세션 인증이 자연스럽고 비용이 낮다.

- **서버 렌더링과의 정합성** — 화면을 서버가 그리므로 매 요청에서 서버가 "누구인지"를 즉시 알아야 한다. 세션은 `request.getSession()` 한 번으로 끝난다. 토큰을 별도 헤더로 파싱·검증하는 SPA 패턴이 불필요하다.
- **상태 즉시 무효화** — 강제 로그아웃·계정 차단이 필요할 때 서버가 세션을 `invalidate()`하면 끝이다. JWT처럼 "만료 전까지 살아있는 토큰"을 블랙리스트로 따로 관리할 필요가 없다.
- **인터셉터·AOP·`@LoginUser`와의 일관성** — 인증의 단일 진실은 세션 속성 `loginUser` 하나다. [인터셉터](/glossary/interceptor)(`LoginInterceptor`), [AOP](/glossary/aop)(`AuthorizationAspect`), `@LoginUser` 자동 주입이 **모두 같은 세션 키**를 읽는다. 인증 소스가 한 곳이라 일관성·디버깅이 쉽다.

:::tip JWT를 왜 안 썼나
JWT는 stateless API(여러 서버·모바일 클라이언트·마이크로서비스)에 강하다. TripTogether는 단일 WAR + JSP 모놀리식이라 그 이점이 작고, 오히려 즉시 무효화·세션 기반 다국어 로케일 저장 같은 stateful 요구가 더 컸다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 역할 | 핵심 키/타입 |
| --- | --- | --- |
| `HttpSession` (Servlet API) | embedded Tomcat이 관리하는 서버 세션 | 속성 `loginUser` = `UsersVO` |
| `JSESSIONID` 쿠키 | 브라우저가 세션을 가리키는 식별자 | Tomcat 자동 발급 |
| `UsersVO` | 세션에 저장되는 로그인 사용자 객체 | `userIdx`, `userRole`, `accountStatus`, `memberGrade`, 지갑 잔액 등 |
| `LoginInterceptor` | 로그인 필요 URL을 컨트롤러 앞에서 차단 | `session.getAttribute("loginUser")` |
| `LoginUserArgumentResolver` | `@LoginUser UsersVO user` 파라미터 자동 주입 | 비로그인 시 `null` |
| `AuthorizationAspect` | `@RequireLogin`/`@RequireAdmin` 메서드 권한 검증 | 같은 세션 키 사용 |
| `AuthController` | 로그인 성공 시 세션에 적재, 로그아웃 시 무효화 | `setAttribute` / `invalidate` |

세션 인증 외에 세션은 **다국어 로케일**도 들고 있다. `SessionLocaleResolver`(기본 `KOREAN`)가 `?lang=` 값을 세션에 저장해 같은 브라우저 세션에서 언어를 유지한다 ([i18n](/glossary/i18n-term) 참고).

로그인 직후 `UsersVO`를 세션에 넣는 핵심 코드 (`AuthController`):

```java
// 로그인 검증 통과 후
session.setAttribute("loginUser", user);   // UsersVO를 세션에 적재
loadAdminPermissions(session, user);       // 관리자면 권한도 세션에
result.put("redirect", resolveLoginRedirect(...));
```

세 가지 인증 장치가 **모두 같은 세션 키**를 읽는다:

```java
// LoginUserArgumentResolver — @LoginUser 자동 주입
HttpSession session = request.getSession(false);
Object loginUser = session.getAttribute("loginUser");
return (loginUser instanceof UsersVO) ? loginUser : null;

// AuthorizationAspect — @RequireLogin 검증 (실패 시 UnauthorizedException)
if (currentLoginUser() == null) throw new UnauthorizedException();
```

## 4. 동작 원리 (흐름·표·작은 코드)

**로그인 → 인증된 요청 → 로그아웃** 한 사이클:

| 단계 | 무슨 일이 일어나나 |
| --- | --- |
| 1. 로그인 POST | `AuthController`가 비밀번호([BCrypt](/glossary/bcrypt)) 검증, 계정 상태(`DORMANT`/`BLOCKED`) 확인 |
| 2. 세션 적재 | `session.setAttribute("loginUser", user)` — 서버가 세션 생성, `JSESSIONID` 쿠키를 `Set-Cookie`로 응답 |
| 3. 이후 요청 | 브라우저가 `JSESSIONID`를 자동 전송 → Tomcat이 세션 복원 |
| 4. 인터셉터 검사 | `LoginInterceptor`가 보호 경로(`/mypage/**`, `/wallet/**`, `/inquiry/**`)에서 `loginUser` 유무 확인. 없으면 `redirect`로 로그인 페이지 이동 |
| 5. 컨트롤러 진입 | `@LoginUser UsersVO user`에 세션 사용자가 주입됨. `@RequireLogin`/`@RequireAdmin` 메서드면 AOP가 한 번 더 검증 |
| 6. 로그아웃 | `session.invalidate()` — 세션 폐기, 쿠키 무효화 |

비로그인 사용자가 보호 경로에 접근하면 `LoginInterceptor`가 **원래 가려던 경로를 보존**해 로그인 후 되돌려보낸다:

```java
String target = request.getRequestURI();           // 원래 경로
String redirectUrl = request.getContextPath()
        + "/auth/login?redirect=" + URLEncoder.encode(target, UTF_8);
response.sendRedirect(redirectUrl);
return false;                                       // 컨트롤러 진입 차단
```

**중요한 패턴 — 잔액 변동 시 세션 갱신:** 캐시 충전·결제·프로필 수정처럼 `UsersVO` 값이 바뀌면, 세션의 `loginUser`도 **다시 덮어써서** 화면과 세션 상태를 일치시킨다. (예: `WalletController`, `FlightController`, `ProfileController`가 처리 후 `session.setAttribute("loginUser", freshUser)` 호출.)

:::warning 세션은 신뢰원, 화면 값이 아니다
권한·잔액 같은 민감 값은 폼에서 받은 값이 아니라 **세션의 `UsersVO`**를 기준으로 판단한다. 클라이언트가 보낸 `userIdx`를 그대로 믿지 않는다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: 세션 인증(`loginUser`), `JSESSIONID` 쿠키 기반 식별, `LoginInterceptor` 경로 보호, `@LoginUser` 자동 주입, `@RequireLogin`/`@RequireAdmin` AOP, 로그아웃 `invalidate()`, 소셜 로그인 후에도 동일 세션에 적재(Kakao/Naver/Google), 잔액·프로필 변경 시 세션 갱신, 세션 기반 로케일.
- **계획/유의**: 단일 embedded Tomcat 세션이라 **수평 확장(다중 인스턴스) 시 세션 공유(Redis 등) 미도입**. 세션 타임아웃·쿠키 보안 속성(`HttpOnly`/`Secure`/`SameSite`)을 코드에서 명시 설정하지 않고 컨테이너 기본값에 의존(운영 배포 시 강화 대상). 모바일·외부 클라이언트용 토큰 인증은 현재 범위 밖.

## 6. 면접 답변 3단계

1. **한 문장** — "TripTogether는 JWT가 아니라 서버 세션으로 로그인을 유지합니다. 로그인하면 `UsersVO`를 세션 속성 `loginUser`에 담고, 브라우저는 `JSESSIONID` 쿠키만 들고 다닙니다."
2. **왜** — "JSP 서버 렌더링 모놀리식이라 매 요청에서 서버가 사용자를 즉시 알아야 하고, 강제 로그아웃·차단 시 `session.invalidate()` 한 번으로 즉시 무효화가 됩니다. 인터셉터·AOP·`@LoginUser`가 전부 같은 세션 키를 읽어 인증 소스가 하나로 통일됩니다."
3. **어떻게** — "`LoginInterceptor`가 `/mypage`·`/wallet`·`/inquiry` 같은 보호 경로를 컨트롤러 앞에서 막고, 통과하면 `@LoginUser`가 세션 사용자를 주입합니다. 잔액·프로필이 바뀌면 세션의 `loginUser`를 다시 덮어써서 상태를 일치시킵니다."

## 7. 꼬리질문 + 모범답안

:::details "세션과 JWT 중 왜 세션인가요?"
JWT는 stateless 분산 API에 유리하지만, TripTogether는 단일 WAR + JSP 모놀리식이라 그 이점이 작습니다. 반대로 즉시 무효화(차단·강제 로그아웃), 세션 기반 로케일 저장 같은 stateful 요구가 더 컸고, 인터셉터/AOP가 세션을 직접 읽는 구조라 세션이 더 단순하고 일관됐습니다.
:::

:::details "`JSESSIONID`만으로 사용자를 어떻게 식별하나요?"
쿠키에는 세션 ID만 들어 있고 사용자 정보 자체는 없습니다. 서버가 `JSESSIONID`로 자신의 세션 저장소에서 `loginUser`(`UsersVO`)를 꺼냅니다. 따라서 쿠키가 탈취돼도 토큰처럼 자체 정보를 담지 않으며, 서버에서 세션을 무효화하면 즉시 무력화됩니다.
:::

:::details "`@LoginUser`로 주입된 user가 null일 수 있나요?"
가능합니다. 리졸버는 비로그인 시 `null`을 주입합니다. 다만 `@RequireLogin`/`@RequireAdmin`이 붙은 메서드는 `AuthorizationAspect`가 진입 직전에 차단하므로, 그런 메서드 본문에서는 non-null로 가정해도 안전합니다. 보호 어노테이션이 없는 곳에서는 null 체크가 필요합니다.
:::

:::details "로그인 후 잔액이 바뀌면 세션은 어떻게 되나요?"
세션의 `UsersVO`는 스냅샷이라, 캐시 충전·결제·프로필 수정 후에는 갱신된 사용자를 다시 조회해 `session.setAttribute("loginUser", freshUser)`로 덮어씁니다. 이렇게 하지 않으면 화면이 옛 잔액을 보여주거나 권한 판단이 어긋날 수 있습니다.
:::

:::details "서버를 여러 대로 늘리면 세션은 어떻게 되나요?"
현재는 embedded Tomcat 단일 인스턴스의 메모리 세션이라, 다중 인스턴스로 확장하면 세션이 공유되지 않는 한계가 있습니다. 해결책은 sticky session(로드밸런서 고정) 또는 Redis 같은 외부 세션 저장소 도입인데, 이는 현재 구현 범위 밖의 향후 과제입니다.
:::

## 8. 직접 말해보기

- "TripTogether가 JWT 대신 세션을 쓴 이유를 30초로 설명해보세요." (서버 렌더링 + 즉시 무효화 + 단일 인증 소스)
- "비로그인 사용자가 `/mypage`에 접근하면 어디서 무슨 일이 일어나나요?" (`LoginInterceptor` → redirect 보존 → 로그인 페이지)
- "세션 인증과 인터셉터·AOP·`@LoginUser`가 어떻게 한 줄로 연결되는지 말해보세요." (모두 세션 키 `loginUser`를 읽음)

더 보기: [인터셉터](/glossary/interceptor) · [AOP](/glossary/aop) · [CSRF](/glossary/csrf) · [BCrypt](/glossary/bcrypt) · [OAuth](/glossary/oauth) | 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether에서 로그인한 사용자 정보(UsersVO)는 어디에 저장되는가?" :choices="['클라이언트가 들고 다니는 JWT 토큰 안', '서버 세션 속성 loginUser', 'JSESSIONID 쿠키 값 자체', 'localStorage']" :answer="1" explanation="UsersVO는 서버 세션 속성 loginUser에 저장된다. 브라우저에는 세션을 가리키는 JSESSIONID 쿠키만 오가며, 사용자 정보 자체는 클라이언트에 담기지 않는다(JWT 아님)." />

<QuizBox question="비로그인 사용자가 /mypage 같은 보호 경로에 접근할 때 컨트롤러 진입을 막는 것은?" :choices="['AuthorizationAspect(AOP)', 'LoginUserArgumentResolver', 'LoginInterceptor', 'SessionLocaleResolver']" :answer="2" explanation="LoginInterceptor가 보호 경로에서 세션의 loginUser 유무를 검사해 없으면 원래 경로를 보존한 채 로그인 페이지로 리다이렉트하고 컨트롤러 진입을 차단한다. AOP의 @RequireLogin은 메서드 단위 검증으로 역할이 다르다." />

<QuizBox question="캐시 충전·프로필 수정 후 코드가 session.setAttribute('loginUser', freshUser)를 다시 호출하는 이유는?" :choices="['세션을 무효화하기 위해', '세션의 UsersVO 스냅샷을 갱신된 값으로 일치시키기 위해', '새 JSESSIONID를 발급받기 위해', '로케일을 바꾸기 위해']" :answer="1" explanation="세션의 UsersVO는 로그인 시점 스냅샷이라, 잔액·프로필이 바뀌면 갱신된 사용자로 덮어써 화면과 세션 상태를 일치시킨다. 그렇지 않으면 옛 값으로 권한·잔액 판단이 어긋날 수 있다." />
