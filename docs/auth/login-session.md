---
title: "로그인·세션"
owner: A
domain: "인증·계정·보안"
tags: ["세션", "로그인"]
---

# 로그인·세션

> TripTogether는 JWT가 아니라 서버 세션에 로그인 사용자(UsersVO)를 담아 인증 상태를 유지한다. BCrypt로 비밀번호를 검증하고, LoginInterceptor가 보호 경로를 가드한다.

## 1. 한 줄 정의

로그인은 식별자·비밀번호를 BCrypt로 검증해 통과한 사용자를 세션 속성 `loginUser`에 저장하는 것이고, 세션은 그 이후 모든 요청에서 사용자를 다시 인증 없이 식별하는 서버측 상태다.

## 2. 왜 이렇게 설계했나

이 프로젝트는 JSP 기반 서버 렌더링 모놀리식 웹앱(WAR, embedded Tomcat, context-path `/TripTogether`)이다. 클라이언트가 별도 SPA가 아니라 서버가 화면을 그리는 구조이므로, 인증 상태를 서버가 직접 들고 있는 세션 방식이 자연스럽다.

세션을 택한 이유를 JWT와 대비하면 다음과 같다.

| 항목 | 서버 세션 (채택) | JWT |
| --- | --- | --- |
| 상태 위치 | 서버 메모리/세션 저장소 | 클라이언트 토큰 |
| 즉시 무효화 | `session.invalidate()` 한 줄 | 토큰 만료 전 강제 차단 어려움 |
| 차단/휴면 반영 | 다음 요청 즉시 반영 | 별도 블랙리스트 필요 |
| 적합 환경 | 서버 렌더링(JSP) 모놀리식 | 무상태 API·다중 클라이언트 |

차단(BLOCKED)·휴면(DORMANT)·삭제(DELETED) 같은 계정 상태를 운영자가 누르면 곧바로 효력이 생겨야 하는데, 세션은 무효화가 즉시이므로 이 요구에 잘 맞는다. 반면 JWT는 한 번 발급하면 만료 전까지 유효해, 즉시 강제 로그아웃을 위해 별도 블랙리스트 인프라가 필요하다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

- 진입점: `auth/controller/AuthController` — `/auth/login`(화면 GET, Ajax POST), `/auth/logout`, `/auth/register`
- 인증 로직: `auth/service/AuthServiceImpl#login(identifier, password, context)`
- 사용자 모델: `auth/vo/UsersVO` (USERS 테이블), 권한 enum `auth/vo/UserRole`
- 비밀번호: Spring Security `BCryptPasswordEncoder`
- 보호 경로 가드: `config/LoginInterceptor`
- 사용자 자동 주입: `common/resolver/LoginUserArgumentResolver` (애너테이션 `@LoginUser`)
- 권한 가드(AOP): `common/aop/AuthorizationAspect` (`@RequireLogin`/`@RequireAdmin`)

USERS 테이블의 인증 관련 핵심 컬럼:

| 컬럼 | 의미 |
| --- | --- |
| `user_password` | BCrypt 해시 (평문 저장 안 함) |
| `password_enabled` | 비밀번호 로그인 허용 여부 (소셜 전용 계정은 false) |
| `email_login_enabled` | 이메일로도 로그인 허용 여부 |
| `account_status` | ACTIVE / DORMANT / BLOCKED / DELETED |
| `user_role` | USER / ADMIN |
| `last_login_at` | 마지막 로그인 시각 |

## 4. 동작 원리 (흐름·표·작은 코드)

### 로그인 처리 순서

`AuthServiceImpl#login`은 게이트를 차례로 통과시킨다. 어느 단계든 실패하면 이유 코드를 로그인 이력에 남기고 중단한다.

1. 식별자가 이메일 형식이면 EMAIL, 아니면 ID 방식으로 사용자 조회
2. 위험도 사전 평가 (denied면 즉시 중단)
3. 사용자 없음 → 실패 (USER_NOT_FOUND)
4. 계정 상태 DELETED → 실패
5. 이메일 로그인 시 email_verified·email_login_enabled 검사
6. password_enabled 검사
7. BCrypt 비밀번호 대조
8. BLOCKED·DORMANT 상태 처리 (만료된 차단은 자동 해제)
9. 성공 시 last_login_at 갱신, 성공 이력 기록, 갱신된 사용자 반환

```java
// 비밀번호 검증 (평문은 절대 비교하지 않는다)
if (!bCryptPasswordEncoder.matches(password, user.getUserPassword())) {
    recordLoginResult(user.getUserIdx(), loginMethod, identifier,
            false, "WRONG_PASSWORD", context);
    loginRiskPolicyService.handleWrongPassword(user, identifier, loginMethod, context);
    return null;
}
```

### 세션 저장

컨트롤러는 서비스가 사용자를 반환하면 세션에 담는다. 차단·휴면은 별도 분기로 클라이언트에 신호를 보낸다.

```java
session.setAttribute("loginUser", user);   // 이후 요청의 인증 근거
clearSocialSession(session);
loadAdminPermissions(session, user);       // 관리자면 권한 집합도 세션에
```

### 가드와 자동 주입

보호 경로(마이페이지, 소셜 연동 등)는 `LoginInterceptor`가 컨트롤러 이전에 막는다. 비로그인이면 원래 가려던 경로를 `redirect` 파라미터로 인코딩해 로그인 페이지로 보내고, 로그인 성공 후 그 경로로 되돌린다.

```java
// LoginInterceptor: 비로그인 접근 시
String encodedTarget = URLEncoder.encode(target, StandardCharsets.UTF_8);
response.sendRedirect(contextPath + "/auth/login?redirect=" + encodedTarget);
return false;
```

컨트롤러 메서드는 매번 세션을 캐스팅하지 않고 `@LoginUser UsersVO user`로 받아 `LoginUserArgumentResolver`가 세션에서 자동 주입한다.

### 로그아웃

`/auth/logout`은 마지막 로그인 수단을 본다. LOCAL이면 로그아웃 이력을 남기고 `session.invalidate()`로 끝낸다. 소셜이면 해당 제공자 로그아웃 플로우(상태값 검증·토큰 폐기·콜백)를 거친 뒤 세션을 무효화한다.

```java
// 일반 로그아웃의 핵심
authService.recordLogoutHistory(loginUser, "LOCAL", true, null, context);
session.invalidate();   // 세션 전체 폐기 → 인증 상태 즉시 소멸
return "redirect:/";
```

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: BCrypt 검증, 세션 저장·무효화, LoginInterceptor 가드 + redirect 복귀, `@LoginUser` 자동 주입, 차단/휴면/삭제 상태 분기, 로그인·로그아웃 이력 기록, 오픈 리다이렉트 최소 방어(safeRedirect)
- 구현됨(인접): 소셜 로그아웃 시 제공자 토큰 폐기, 로그인 위험도 사전 평가 연동
- 향후/한계: 세션 저장소는 단일 인스턴스(embedded Tomcat) 전제 — 다중 서버 수평 확장 시 외부 세션 저장소가 필요. 모바일은 데스크톱 JSP 레이아웃 위주. JWT/무상태 API는 채택하지 않음(설계 선택)

:::tip safeRedirect
로그인 후 복귀 경로는 그대로 믿지 않는다. `http://`·`https://`·`javascript:`로 시작하면 버려 오픈 리다이렉트를 막고, 슬래시로 시작하는 내부 경로만 허용한다.
:::

## 6. 면접 답변 3단계

1. 한 줄: 서버 세션 기반 인증입니다. 로그인이 성공하면 사용자 객체를 세션 속성 loginUser에 담고, 이후 요청은 그 세션으로 사용자를 식별합니다.
2. 메커니즘: 비밀번호는 BCryptPasswordEncoder matches로만 검증하고 평문을 비교하지 않습니다. 보호 경로는 LoginInterceptor가 컨트롤러 앞에서 막으며, 비로그인이면 원래 경로를 redirect 파라미터로 보존해 로그인 후 돌려보냅니다. 컨트롤러는 @LoginUser로 세션 사용자를 자동 주입받습니다.
3. 설계 의도: JSP 서버 렌더링 모놀리식이라 세션이 자연스럽고, 무엇보다 차단·휴면을 누르면 즉시 효력이 생겨야 하는데 session.invalidate가 즉시 무효화를 보장합니다. JWT는 만료 전 강제 차단에 별도 블랙리스트가 필요해 이 요구에 불리했습니다.

## 7. 꼬리질문 + 모범답안

:::details 왜 JWT가 아니라 세션인가
서버 렌더링 모놀리식 환경에서 인증 상태를 서버가 직접 들고 있는 편이 단순하고, 차단·휴면 같은 운영 액션이 다음 요청에 즉시 반영돼야 하기 때문입니다. JWT는 발급 후 만료 전까지 유효해 즉시 무효화에 별도 블랙리스트가 필요합니다. 다중 클라이언트 무상태 API였다면 JWT가 더 적합했을 겁니다.
:::

:::details 비밀번호는 어떻게 저장·검증하나
USERS user_password에는 평문이 아니라 BCrypt 해시만 저장합니다. 검증은 평문 비교가 아니라 BCryptPasswordEncoder matches로 입력값을 같은 알고리즘으로 처리해 대조합니다. BCrypt는 솔트가 해시에 포함되고 비용 계수로 느리게 설계돼 대량 대입에 강합니다.
:::

:::details 로그인이 필요한 페이지에 비로그인으로 접근하면
LoginInterceptor가 컨트롤러 실행 전에 세션의 loginUser를 확인하고, 없으면 요청을 중단합니다. 이때 가려던 URI와 쿼리를 합쳐 URL 인코딩한 뒤 redirect 파라미터로 로그인 페이지에 넘기고, 로그인 성공 후 그 경로로 복귀시킵니다.
:::

:::details 차단된 사용자가 유효한 세션을 갖고 있으면 어떻게 막나
로그인 시점에 BLOCKED 상태면 진입을 막고, 만료 시각이 지난 차단은 자동 해제 후 재조회합니다. 운영자가 차단하면 세션 무효화 또는 다음 인증 흐름에서 상태가 반영되며, 세션 방식이라 즉시 무효화가 가능합니다. JWT였다면 동일 보장이 어렵습니다.
:::

:::details 로그아웃이 단순히 세션만 지우는 게 아닌 이유
일반 로그아웃은 이력을 남기고 session.invalidate로 끝나지만, 소셜 로그인 사용자는 제공자 측 세션·토큰도 정리해야 합니다. 그래서 마지막 로그인 수단을 보고 카카오/네이버/구글이면 상태값 검증과 액세스 토큰 폐기, 콜백을 거친 뒤 세션을 무효화합니다.
:::

## 8. 직접 말해보기

- TripTogether가 JWT 대신 세션을 택한 이유를 차단·휴면 운영 시나리오로 30초 안에 설명해 보세요.
- 비로그인 사용자가 마이페이지에 접근한 순간부터 로그인 성공 후 그 페이지로 돌아오기까지의 흐름을 LoginInterceptor와 redirect 파라미터 중심으로 말해 보세요.
- BCrypt matches가 평문 비교와 무엇이 다른지, 솔트와 비용 계수를 들어 설명해 보세요.

## 퀴즈

<QuizBox question="TripTogether에서 로그인한 사용자를 인증 상태로 유지하는 방식은?" :choices="['클라이언트에 JWT 토큰을 저장한다', '서버 세션 속성 loginUser에 UsersVO를 담는다', '쿠키에 사용자 비밀번호를 저장한다', 'OAuth 액세스 토큰을 localStorage에 둔다']" :answer="1" explanation="서버 렌더링 모놀리식 구조에 맞춰 세션 속성 loginUser에 UsersVO를 저장해 인증 상태를 유지한다." />

<QuizBox question="비밀번호 검증에 대한 설명으로 옳은 것은?" :choices="['평문 비밀번호를 DB 값과 문자열 비교한다', 'BCryptPasswordEncoder matches로 해시를 대조한다', 'JWT 서명으로 검증한다', '세션 ID를 비밀번호로 사용한다']" :answer="1" explanation="user_password에는 BCrypt 해시만 저장하고, 검증은 평문 비교가 아니라 BCryptPasswordEncoder matches로 한다." />

<QuizBox question="JWT 대신 세션을 택한 핵심 이유로 가장 적절한 것은?" :choices="['세션이 항상 더 빠르기 때문', '차단·휴면 같은 상태를 즉시 무효화로 반영하기 쉽기 때문', '세션은 암호화가 필요 없기 때문', 'JWT는 자바에서 쓸 수 없기 때문']" :answer="1" explanation="session.invalidate로 즉시 무효화가 되어 차단·휴면 운영 액션이 다음 요청에 바로 반영된다. JWT는 만료 전 강제 차단에 별도 블랙리스트가 필요하다." />
