---
title: "인증·계정·보안 개요"
owner: A
domain: "인증·계정·보안"
tags: ["세션", "OAuth", "보안"]
---

# 인증·계정·보안 개요

> 누가 들어오는지(인증), 그 사람이 정상 사용자인지(위험 평가), 차단됐다면 어떻게 풀어주는지(복구·이의신청)까지를 한 도메인에서 책임진다. TripTogether 모든 보호 자원의 출입구다.

## 한눈에

이 도메인은 **세션 기반 인증**을 중심으로 일반 로그인·소셜 로그인·이메일 인증·비밀번호 재설정을 처리하고, 그 위에 **로그인 위험도 평가**와 **계정 차단·휴면·복구** 흐름을 얹은 모듈이다. 외부 보안 인프라(WAF/CDN)와의 연동까지 인터페이스로 추상화해 둔 점이 특징이다.

| 항목 | 내용 |
| --- | --- |
| 패키지 | `org.triptogether.auth` (controller / service / mapper / risk / vo) |
| 진입 컨트롤러 | `AuthController` (`/auth/**`), `SecurityAppealController` (`/security/appeal/**`) |
| 핵심 VO | `UsersVO`, `UserSocialVO`, `EmailVerificationVO`, `UserLoginHistoryVO`, `SecurityAppealVO` |
| 핵심 테이블 | `USERS`, `USER_SOCIAL`, `EMAIL_VERIFICATION`, `USER_LOGIN_HISTORY`, `LOGIN_RISK_POLICY`, `SECURITY_ACTION_APPEAL` |
| 담당 라벨 | A (익명 라벨 — [담당별 보기](/by-area/) 참고) |

## 담당과 경계

이 프로젝트는 4명이 도메인을 수직 분담해 공동 개발했고, 인증·계정·보안 도메인은 **담당 라벨 A**에 속한다. 같은 라벨이 관리자·운영 도메인도 맡아, "사용자를 차단하는 정책(관리자)"과 "차단당한 사용자가 인증·복구를 시도하는 흐름(인증)"이 한 사람의 책임 범위 안에서 맞물린다.

- **인증이 끝나는 지점**: 세션에 `loginUser`(=`UsersVO`)를 심는 순간부터는 공통 인프라(인터셉터·AOP 권한·`@LoginUser`)가 이어받는다. 그 공통 계층은 [백엔드](/backend/) 챕터가 다룬다.
- **인증이 시작되는 지점**: 요청이 컨트롤러에 닿기 전 인터셉터 체인(locale → ipBlock → activityLog → login → admin → …)을 통과한다. 로그인 여부 자체를 강제하는 것은 인터셉터, 세분화된 권한은 AOP의 몫이다.

## 핵심 기술

| 기술 | 어디에 쓰나 | 구현 위치 |
| --- | --- | --- |
| **세션 인증** | 로그인 성공 시 세션 속성 `loginUser`에 `UsersVO` 저장 | `AuthController.loginProcess` |
| **OAuth 2.0** | 카카오·네이버·구글 소셜 로그인/연동, state 검증으로 CSRF 방지 | `AuthController` `/auth/{provider}/callback` |
| **BCrypt** | 비밀번호 단방향 해싱·검증 | `BCryptPasswordEncoder` (`spring-security-crypto`) |
| **이메일 인증·액션 토큰** | 가입 인증·아이디 찾기·비밀번호 재설정용 일회성 토큰 메일 | `EMAIL_VERIFICATION`, `spring-boot-starter-mail` |
| **로그인 위험도 평가** | 로그인 시 IP·이력 기반 위험 판단 → 허용/검토/차단 | `LoginRiskAssessmentProvider`, `LoginRiskPolicyService` |
| **WAF/CDN 연동** | 위험 판정 결과를 외부 방화벽에 동기화(어댑터 패턴) | `risk` 패키지의 `WafSyncAdapter` 구현체들 |
| **소프트 삭제·상태 머신** | 계정 상태 `account_status`(ACTIVE/DORMANT/BLOCKED/DELETED)로 관리 | `UsersVO.accountStatus`, ADR-0008 |

:::tip 위험 평가는 "확장 지점"으로 설계됨
`LoginRiskAssessmentProvider`는 `Optional<LoginRiskAssessmentResult> assess(...)` 한 메서드만 가진 인터페이스다. AI 모델이든 룰 엔진이든 상위 관제 연동이든, 이 인터페이스를 구현해 Spring Bean으로만 등록하면 `LoginRiskPolicyService`가 자동으로 결과를 수집한다. "지금 당장 외부 AI가 없어도 골격은 동작한다"가 핵심.
:::

## 로그인 한 번에 무슨 일이 일어나나

```text
POST /auth/login (identifier, password)
  → LoginRequestContext 구성 (IP, User-Agent, requestId, flowTraceId)
  → AuthService.login(): BCrypt 검증 + 위험도 평가
       └ 위험 판정: 허용 / 검토 필요(review) / 차단(denied)
  → 계정 상태 분기
       ├ DORMANT  → 휴면 해제 안내(dormantReleaseRequired)
       ├ BLOCKED  → 차단 메시지 + 사유/해제시각
       └ ACTIVE   → 세션에 loginUser 저장 + 관리자 권한 로드
  → JSON 응답 { success, redirect | message }
```

로그인은 페이지 이동이 아니라 **Ajax JSON 응답**(`@ResponseBody`)으로 처리해, 휴면·차단·위험 판정 같은 분기를 프런트가 부드럽게 보여줄 수 있게 했다. 모든 로그인/로그아웃 시도는 `USER_LOGIN_HISTORY`에 기록되고, 소셜 로그아웃은 외부 토큰 폐기까지 추적(`flowTraceId`)한다.

## 구현 상태 (정직하게)

| 기능 | 상태 |
| --- | --- |
| 일반 로그인·로그아웃·회원가입 | 구현됨 |
| 카카오·네이버·구글 OAuth (로그인·연동·해제) | 구현됨 (state 검증 포함) |
| 이메일 인증·아이디 찾기·비밀번호 재설정 | 구현됨 (일회성 토큰) |
| BCrypt 해싱 | 구현됨 |
| 휴면 전환·해제, 차단·차단 해제 신청 | 구현됨 (`DormantAccountScheduler` 배치 포함) |
| 로그인 위험 평가 **골격**(인터페이스·정책·이력·검토 큐) | 구현됨 |
| 외부 AI 위험 판정 실연동 | **계획/Mock** — `GenericAiRiskAssessmentAdapter` 등은 스텁, 실제 모델 미연동 |
| WAF/CDN 동기화 실연동 | **부분/Mock** — `MockWafSyncAdapter`가 기본, AWS/Cloudflare 어댑터는 자격 증명 필요 |

:::warning 보안 표기 원칙
이 학습 자료는 공개 저장소에 있으므로 실제 키·호스트·계정·내부 IP는 담지 않는다. 설정값은 `API_KEY`, `DB_HOST` 같은 **자리표시자**로만 표현한다. 모델명·기술명·클래스명은 공개해도 무방하다.
:::

## 권장 학습 순서

1. [로그인·세션](/auth/login-session) — 세션에 `loginUser`를 심는다는 게 무슨 뜻인지부터
2. [OAuth 소셜 로그인](/auth/oauth-social) — state로 CSRF 막기, 신규/기존 사용자 분기
3. [이메일 인증·액션 토큰](/auth/email-verification-token) — 일회성 토큰 한 가지로 3가지 흐름 처리
4. [비밀번호 해싱(BCrypt)](/auth/password-bcrypt) — 왜 암호화가 아니라 단방향 해싱인가
5. [로그인 위험도 평가](/auth/login-risk-assessment) — 인터페이스 확장 지점과 정책 테이블
6. [계정 복구·휴면](/auth/account-recovery) — 상태 머신과 배치 스케줄러
7. [차단 해제 신청](/auth/security-appeal) — 차단된 사용자가 다시 들어오는 합법 경로
8. [WAF 어댑터(AWS/Cloudflare)](/auth/waf-adapters) — 어댑터 패턴으로 외부 인프라 추상화
9. [면접 플레이북](/auth/interview-playbook) — 위 내용을 말로 묶기

> 처음이라면 1~4번만으로도 면접에서 "인증 어떻게 했어요?"에 답할 수 있다. 5번 이후는 한 단계 깊은 질문 대비용이다.

## 허브로 돌아가기

- [도메인 전체 개요](/domains)
- [담당별 보기](/by-area/)
- [전체 흐름](/flow/) · 그중 [인증·세션 흐름](/flow/auth-session-flow)

## 단골 면접 질문 5개

1. **세션 인증과 JWT 중 왜 세션을 골랐나?** — JSP 서버 렌더링 + 단일 WAS 구조라 서버 세션이 단순하고, 강제 로그아웃·세션 무효화가 즉시 가능하다.
2. **OAuth에서 CSRF는 어떻게 막았나?** — 인가 요청마다 `state`를 발급해 세션에 저장하고, 콜백에서 `consumeOauthState`로 검증·소비한다.
3. **비밀번호는 어떻게 저장하나?** — 평문 저장 없이 `BCryptPasswordEncoder`로 솔트 포함 해싱하고, 로그인 시 `matches`로만 검증한다.
4. **차단된 계정이 영구히 못 들어오나?** — 아니다. `SECURITY_ACTION_APPEAL` 기반 이의신청(차단 해제 신청) 흐름으로 합법적 복구 경로를 둔다.
5. **로그인 위험 평가에서 AI는 실제로 붙어 있나?** — 골격(인터페이스·정책·검토 큐)은 구현됐고 외부 AI/WAF 실연동은 Mock 단계임을 정직하게 구분해 답한다.

## 퀴즈

<QuizBox question="TripTogether에서 로그인 성공 시 사용자 정보가 저장되는 위치는?" :choices="['JWT 토큰을 발급해 클라이언트 로컬스토리지에 저장', '세션 속성 loginUser에 UsersVO 저장', '쿠키에 사용자 비밀번호를 평문으로 저장', '매 요청마다 DB를 다시 조회']" :answer="1" explanation="이 프로젝트는 세션 기반 인증을 사용한다. 로그인 성공 시 세션 속성 loginUser에 UsersVO를 저장하고, 이후 인터셉터와 AOP가 이를 읽어 권한을 판단한다." />

<QuizBox question="LoginRiskAssessmentProvider 인터페이스를 인터페이스로 둔 가장 큰 설계 의도는?" :choices="['DB 조회 속도를 높이려고', 'AI 룰엔진 관제연동 등 다양한 평가 구현체를 Bean 등록만으로 갈아끼우기 위해', 'JSP 렌더링을 빠르게 하려고', '비밀번호 해싱 알고리즘을 교체하려고']" :answer="1" explanation="평가 로직을 인터페이스 뒤에 두면 외부 AI가 아직 없어도 골격이 동작하고, 나중에 구현체를 Bean으로 등록하기만 하면 LoginRiskPolicyService가 자동으로 결과를 수집한다. 확장에 열린 설계다." />

<QuizBox question="account_status 컬럼이 BLOCKED인 사용자에 대한 설명으로 옳은 것은?" :choices="['로그인 자체가 차단되며 영구히 복구 불가', '차단 메시지를 보여주되 차단 해제 신청 흐름으로 복구 경로를 제공', '비밀번호만 맞으면 정상 로그인됨', '자동으로 DORMANT로 전환됨']" :answer="1" explanation="BLOCKED 계정은 로그인 시 차단 메시지와 사유 또는 해제 시각을 받지만, SECURITY_ACTION_APPEAL 기반 차단 해제 신청으로 합법적 복구 경로가 열려 있다." />
