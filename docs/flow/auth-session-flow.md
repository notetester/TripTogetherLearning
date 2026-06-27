# 인증·세션 흐름

> 입력 자격증명을 검증하고 위험을 평가한 뒤, 통과한 사용자만 세션 속성 `loginUser`로 식별하며, 이후 모든 보호 요청을 인터셉터와 AOP가 그 세션 하나로 가드한다.

이 페이지는 TripTogether의 인증 한 줄기 — **로그인(로컬/소셜) → 위험 평가 → 세션 발급 → 가드 → `@LoginUser` 주입 → 로그아웃** — 을 끝에서 끝까지 추적한다. 도메인 소개는 [인증·계정·보안 개요](/auth/), 전체 흐름 허브는 [전체 흐름](/flow/), 도메인 지도는 [도메인 전체 개요](/domains), 담당별 묶음은 [담당별 보기](/by-area/)를 참고한다.

## 1. 한 줄 정의

TripTogether의 인증은 **서버 세션 기반**이다. 비밀번호는 `BCryptPasswordEncoder`로 검증하고, 소셜은 OAuth2 인가코드 교환으로 사용자를 식별하며, 검증을 통과한 `UsersVO`를 `HttpSession`의 `loginUser` 속성에 담는다. 이후 보호된 URL은 `LoginInterceptor`가, 어노테이션이 붙은 컨트롤러 메서드는 `AuthorizationAspect`가, 컨트롤러 파라미터는 `LoginUserArgumentResolver`가 각각 같은 세션 속성을 읽어 처리한다.

## 2. 왜 이렇게 설계했나

JSP(JSTL/EL) 기반 서버 렌더링 + embedded Tomcat 구조라, 토큰(JWT)을 클라이언트가 들고 다니는 SPA 방식보다 **서버 세션**이 자연스럽다. 한 곳(세션)에 신원을 두고, 가드 지점을 셋(인터셉터·AOP·리졸버)으로 분리한 이유는 책임을 나누기 위해서다.

| 가드 지점 | 막는 대상 | 실패 시 결과 |
| --- | --- | --- |
| `LoginInterceptor` | URL 패턴 전체(마이페이지·지갑·소셜 연동·문의) | 로그인 페이지로 리다이렉트(원래 경로 보존) |
| `AuthorizationAspect` | 어노테이션 붙은 메서드(`@RequireLogin`/`@RequireAdmin`) | 예외 → `GlobalExceptionHandler` 표준 응답 |
| `LoginUserArgumentResolver` | 가드가 아니라 주입 — 컨트롤러 파라미터 | 비로그인 시 `null` 주입 |

또 하나의 핵심 결정은 **로그인 시도 자체를 보안 자산으로 본 것**이다. 성공/실패 모두 `USER_LOGIN_HISTORY`에 남기고, 실패가 누적되면 위험 평가 모듈이 개입한다. 인증은 단순 통과/거부가 아니라 감사·통계·위험 대응의 입구다.

:::tip 핵심 분리
URL 단위 차단은 인터셉터, 메서드 단위 권한은 AOP, 신원 주입은 리졸버. 이 세 가지를 헷갈리지 않는 것이 인증 흐름 이해의 절반이다. 정책 근거는 ADR-0011.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 역할 | 구현체 | 비고 |
| --- | --- | --- |
| 인증 진입점 | `AuthController` (`/auth/**`) | 로그인·로그아웃·가입·소셜·복구를 한 컨트롤러에서 |
| 인증 로직 | `AuthService` / `AuthServiceImpl` | 인터페이스 + ServiceImpl |
| 위험 평가 | `LoginRiskPolicyService`, `LoginRiskAssessmentProvider`(확장점) | 사전·사후 평가 훅 |
| URL 가드 | `LoginInterceptor` | `WebConfig`에 경로 등록 |
| 메서드 가드 | `AuthorizationAspect` + `@RequireLogin`/`@RequireAdmin` | AOP `@Before` |
| 신원 주입 | `LoginUserArgumentResolver` + `@LoginUser` | `addArgumentResolvers` 등록 |
| 비밀번호 | `BCryptPasswordEncoder` | `spring-security-crypto` |
| 세션 신원 | `UsersVO` (세션 속성 `loginUser`) | — |

핵심 테이블:

- `USERS` — 신원과 상태. `account_status`(ACTIVE/DORMANT/BLOCKED/DELETED), `user_role`(USER/ADMIN), `password_enabled`, `email_verified`, `email_login_enabled`.
- `USER_SOCIAL` — provider(KAKAO/NAVER/GOOGLE) + provider_user_id ↔ user_idx 연결.
- `USER_LOGIN_HISTORY` — 모든 LOGIN/LOGOUT 이벤트. `is_success`, `fail_reason`, `auth_provider`, `session_id`, `request_id`, `flow_trace_id`, `ip_address`.
- `LOGIN_RISK_COUNTER` / `LOGIN_RISK_EVENT` / `LOGIN_RISK_REVIEW_QUEUE` — 위험 카운터·이벤트·검토 큐.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 로컬 로그인 (`POST /auth/login`)

`AuthServiceImpl.login`은 순서가 곧 정책이다. 위에서 막히면 아래는 실행되지 않는다.

```text
1. identifier가 이메일 형식인지 판별 → loginMethod = EMAIL or ID
2. 사용자 조회 (findByEmail / findByUserId)
3. checkPreLogin: 사전 위험 평가 → denied면 즉시 차단
4. 사용자 없음 → 실패 기록(USER_NOT_FOUND)
5. account_status가 DELETED → 차단
6. (이메일 로그인일 때) email_verified / email_login_enabled 확인
7. password_enabled 확인
8. BCrypt matches → 불일치면 handleWrongPassword(위험 카운터 누적)
9. BLOCKED/DORMANT 상태 처리
10. updateLastLoginAt + 성공 기록 + handleLoginSuccess
```

컨트롤러는 그 결과를 JSON으로 응답한다. 같은 "로그인 실패"라도 사용자에게는 구분을 최소화하되, 휴면(`DORMANT`)·차단(`BLOCKED`)은 별도 플래그로 내려 화면이 휴면 해제/차단 안내를 띄우게 한다.

```java
session.setAttribute("loginUser", user);   // 신원 확정
clearSocialSession(session);               // 이전 소셜 흔적 정리
loadAdminPermissions(session, user);        // 관리자면 권한 세트 적재
```

여기서 `loginUser`가 세션에 들어가는 순간이 곧 "로그인 완료"의 정의다.

### 4.2 소셜 로그인 (콜백 → `processSocialLogin`)

카카오·네이버·구글은 응답 JSON 구조가 제각각이지만, 공통 객체 `SocialUserInfo`(provider, providerUserId, email, nickname)로 흡수해 단일 경로로 합류시킨다.

```text
/auth/{provider} → 인가 URL 리다이렉트
provider 인증 → /auth/{provider}/callback?code=...(&state=...)
code → access token 교환 → 사용자 정보 조회 → SocialUserInfo
processSocialLogin:
  USER_SOCIAL 연동 있음 → 기존 UsersVO 반환 → 세션 발급
  연동 없음           → SocialTempVO 반환 → /auth/social/complete (추가정보 입력)
```

네이버·구글은 OAuth `state`를 세션에 발급·소비(`issueOauthState`/`consumeOauthState`)해 CSRF성 위조 콜백을 거른다. 소셜 로그인 성공 시 세션에 `currentSocialProvider`를 기록해, 나중에 로그아웃에서 어느 제공자 로그아웃 엔드포인트로 보낼지를 결정한다.

### 4.3 가드와 주입

```text
보호 URL 요청
  → LoginInterceptor.preHandle: 세션 loginUser 없으면
    /auth/login?redirect=<원래경로> 로 리다이렉트(원래 경로 인코딩 보존)

보호 메서드 호출
  → AuthorizationAspect @Before:
     @RequireLogin → loginUser 없으면 UnauthorizedException
     @RequireAdmin → 비로그인 401성, 비관리자 ForbiddenException

컨트롤러 파라미터 @LoginUser UsersVO user
  → LoginUserArgumentResolver: 세션 loginUser 주입(없으면 null)
```

`@RequireLogin`이 붙은 메서드는 AOP가 먼저 막으므로, 컨트롤러 본문에서 `@LoginUser` 파라미터는 사실상 non-null로 다룰 수 있다. 가드와 주입의 협력이다.

### 4.4 인터셉터 체인 속 위치

인증 가드는 진공에 있지 않다. `WebConfig`가 등록하는 체인 순서는 locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification이다. 즉 **IP 차단·활동 로그가 로그인 가드보다 먼저** 돈다 — 차단된 IP는 로그인 시도 전에 걸러지고, 모든 요청은 로그인 여부와 무관하게 활동 로그에 남는다. 인터셉터 체인 자체는 [인터셉터 체인](/backend/interceptors)에서 다룬다.

### 4.5 로그아웃 (제공자별 분기)

로그아웃은 단순 `session.invalidate()`가 아니다. 세션의 `currentSocialProvider`를 보고 분기한다.

| 로그인 출처 | 로그아웃 경로 | 추가 동작 |
| --- | --- | --- |
| 로컬 | `/auth/logout` 즉시 | 이력 기록 후 세션 무효화 |
| 카카오 | `/auth/kakao/logout` → 카카오 로그아웃 → 콜백 | state 검증 후 세션 무효화 |
| 네이버 | `/auth/naver/logout` | access token revoke 시도 후 콜백 |
| 구글 | `/auth/google/logout` | access token revoke 시도 후 콜백 |

모든 분기는 `recordLogoutHistory`로 `USER_LOGIN_HISTORY`에 LOGOUT 이벤트를 남기고, `flow_trace_id`로 로그아웃 진입→콜백→완료를 한 흐름으로 묶는다. 네이버·구글은 토큰 폐기 실패 시 `fail_reason`(예: TOKEN_REVOKE_FAILED)을 기록하되 사용자 세션은 끝낸다 — 외부 폐기 실패가 로컬 로그아웃을 막지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 로컬 로그인/로그아웃, BCrypt 검증, 세션 발급, 회원가입.
- 카카오·네이버·구글 OAuth 로그인 + 마이페이지 소셜 연동/해제, state 검증.
- `LoginInterceptor` URL 가드, `AuthorizationAspect`(`@RequireLogin`/`@RequireAdmin`), `@LoginUser` 자동 주입.
- 성공/실패/로그아웃 전건의 `USER_LOGIN_HISTORY` 감사 기록, `flow_trace_id` 추적.
- 이메일 인증·아이디 찾기·비밀번호 재설정(액션 토큰).
- 로그인 위험 평가 훅(사전 평가·오답 누적·검토 큐)과 계정 상태머신(ACTIVE/DORMANT/BLOCKED/DELETED).
:::

:::warning Mock·계획·한계
- 위험 평가의 외부 AI/정책기관 연동은 `LoginRiskAssessmentProvider` **확장 인터페이스**로 열어둔 형태다. 실제 외부 모델 연동 여부는 환경/구성에 의존하며, 자리표시자(`API_KEY`, `DB_HOST`) 외 비밀값은 코드에 두지 않는다.
- 세션은 단일 인스턴스 embedded Tomcat 기준. 다중 인스턴스 세션 공유(클러스터링)는 별도 구성 과제.
- 인증 화면은 JSP 데스크톱 레이아웃 위주이며, 반응형/SPA 전환은 향후 과제.
:::

## 6. 면접 답변 3단계

**1단계 (한 문장).** "세션 기반 인증입니다. 로컬은 BCrypt로, 소셜은 OAuth2 인가코드 교환으로 검증한 뒤 `UsersVO`를 세션 속성 `loginUser`에 담고, 인터셉터·AOP·아규먼트 리졸버가 그 세션 하나를 공유해 가드와 주입을 합니다."

**2단계 (왜).** "JSP 서버 렌더링 구조라 토큰보다 서버 세션이 자연스러웠습니다. 그리고 가드를 셋으로 나눴습니다 — URL 단위는 `LoginInterceptor`, 메서드 단위 권한은 `AuthorizationAspect`(`@RequireLogin`/`@RequireAdmin`), 신원 주입은 `LoginUserArgumentResolver`(`@LoginUser`). 책임이 분리돼 컨트롤러 본문은 신원이 보장된 상태로 단순해집니다."

**3단계 (깊이).** "로그인 시도를 보안 자산으로 다뤘습니다. 성공·실패·로그아웃 전건을 `USER_LOGIN_HISTORY`에 남기고 `flow_trace_id`로 다단계 흐름을 추적합니다. 비밀번호 오답은 위험 카운터로 누적돼 임계 초과 시 검토 큐로 가고, 계정은 ACTIVE/DORMANT/BLOCKED/DELETED 상태머신으로 관리합니다. 소셜 로그아웃은 제공자별로 토큰 폐기까지 시도하되, 외부 실패가 로컬 세션 종료를 막지 않도록 했습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 비로그인 사용자가 보호 URL에 접근하면 어떻게 되나요?
`LoginInterceptor.preHandle`이 세션의 `loginUser`가 없음을 확인하고, 원래 가려던 경로(쿼리 포함)를 URL 인코딩해 `/auth/login?redirect=...`로 리다이렉트합니다. 로그인 성공 후 `resolveLoginRedirect`가 이 값을 검증(`safeRedirect`로 외부 URL·javascript 스킴 제거)해 원래 경로로 되돌립니다. 오픈 리다이렉트를 막으면서 UX를 보존하는 처리입니다.
:::

:::details Q2. `@RequireLogin`과 `LoginInterceptor`는 역할이 겹치지 않나요?
대상 단위가 다릅니다. 인터셉터는 `/mypage/**`처럼 **URL 패턴 전체**를 사전 차단하고, AOP는 특정 **컨트롤러 메서드** 단위로 동작합니다. 인터셉터로 묶기 애매한 산발적 보호 지점이나 관리자 권한(`@RequireAdmin`) 검증은 메서드 어노테이션이 적합합니다. 또 인터셉터는 리다이렉트(화면용), AOP는 예외→표준 응답(주로 API용)으로 실패 처리 방식도 다릅니다.
:::

:::details Q3. 세 가지 소셜 제공자의 응답 차이는 어떻게 흡수하나요?
각 콜백 핸들러가 제공자 JSON에서 식별자(카카오 id, 네이버 response.id, 구글 sub)와 이메일·닉네임을 꺼내 공통 객체 `SocialUserInfo`로 변환합니다. 이후 `processSocialLogin`은 `USER_SOCIAL`에서 provider+providerUserId로 연동 여부만 보고 단일 로직으로 처리합니다 — 기존 연동이면 `UsersVO`, 신규면 `SocialTempVO`를 반환해 추가정보 입력 화면으로 보냅니다.
:::

:::details Q4. 로그인 실패를 왜 굳이 다 기록하나요? 메시지는 왜 뭉뚱그리나요?
감사·통계·위험 대응 때문입니다. `USER_LOGIN_HISTORY`에 `fail_reason`(USER_NOT_FOUND, WRONG_PASSWORD, ACCOUNT_BLOCKED 등)과 IP·세션을 남겨 이상 패턴을 분석합니다. 반면 사용자 화면 메시지는 아이디 존재 여부 같은 정보가 새지 않도록 절제합니다 — 내부 기록은 상세히, 외부 노출은 최소로라는 분리입니다.
:::

:::details Q5. 소셜 로그아웃에서 외부 토큰 폐기가 실패하면 사용자는 로그아웃이 안 되나요?
됩니다. 네이버·구글 로그아웃은 `revoke...AccessToken`을 시도하지만, 실패해도 `fail_reason`(TOKEN_REVOKE_FAILED)만 이력에 남기고 `session.invalidate()`로 로컬 세션은 끝냅니다. 외부 의존성의 실패가 사용자의 로그아웃 의도를 막으면 안 되기 때문입니다. 카카오는 state 불일치 시 STATE_MISMATCH를 기록하되 마찬가지로 세션은 무효화합니다.
:::

## 8. 직접 말해보기

- 화이트보드에 다음 한 줄을 그리고 설명하기: 요청 → ipBlock → activityLog → LoginInterceptor → (컨트롤러) AuthorizationAspect → LoginUserArgumentResolver. 각 단계가 무엇을 보고 무엇을 막는지.
- "세션에 `loginUser`가 들어가는 정확한 순간"을 로컬·소셜 각각에 대해 한 문장으로 말하기.
- 로컬 로그인 실패 사유 4가지와 계정 상태 4가지(ACTIVE/DORMANT/BLOCKED/DELETED)를 외워서 말하고, 각각 화면에 어떻게 보이는지 덧붙이기.
- 더 깊은 가지는 [OAuth 소셜 로그인](/auth/oauth-social), [로그인 위험도 평가](/auth/login-risk-assessment), [로그인·세션](/auth/login-session), [AOP 권한 체크](/backend/aop-authorization), [@LoginUser 리졸버](/backend/login-user-resolver)로 이어서 말해보기.

## 퀴즈

<QuizBox question="TripTogether에서 사용자가 로그인되었다는 사실의 기준은 무엇인가?" :choices="['JWT 토큰이 쿠키에 저장된 것', 'HttpSession의 loginUser 속성에 UsersVO가 담긴 것', 'USER_LOGIN_HISTORY에 성공 행이 생긴 것', 'BCrypt 검증이 통과한 것']" :answer="1" explanation="로컬과 소셜 모두 검증 통과 후 세션 속성 loginUser에 UsersVO를 담는 순간이 로그인 완료의 정의다. 인터셉터, AOP, 리졸버가 모두 이 속성을 읽는다." />

<QuizBox question="URL 패턴 전체(예: 마이페이지)를 비로그인 접근으로부터 막고 로그인 페이지로 리다이렉트하는 컴포넌트는?" :choices="['AuthorizationAspect', 'LoginUserArgumentResolver', 'LoginInterceptor', 'GlobalExceptionHandler']" :answer="2" explanation="LoginInterceptor가 preHandle에서 세션 loginUser 부재를 확인하고 원래 경로를 보존한 채 로그인 페이지로 리다이렉트한다. 메서드 단위 권한은 AuthorizationAspect, 파라미터 주입은 리졸버가 담당한다." />

<QuizBox question="소셜 로그인 콜백에서 USER_SOCIAL에 연동 기록이 없는 신규 사용자에게 반환되는 객체와 다음 행동은?" :choices="['UsersVO를 반환하고 즉시 세션 발급', 'SocialTempVO를 반환하고 추가정보 입력 화면으로 이동', 'null을 반환하고 로그인 실패 처리', 'AdminLoginAuditVO를 반환하고 감사 로그 기록']" :answer="1" explanation="processSocialLogin은 연동이 있으면 UsersVO를 돌려 세션을 발급하고, 없으면 provider/providerUserId/email/nickname을 담은 SocialTempVO를 돌려 /auth/social/complete 추가정보 입력으로 보낸다." />
