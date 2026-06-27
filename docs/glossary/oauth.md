# OAuth

> 비밀번호를 우리 서버에 주지 않고도 "카카오/네이버/구글이 신원을 보증"하게 만드는 위임 인증 프로토콜. TripTogether는 OAuth2 **인가 코드(Authorization Code)** 흐름으로 소셜 로그인·연동을 구현했고, 자체 회원 모델과 `USER_SOCIAL`로 연결해 **계정당 인증 수단을 여러 개** 유지한다.

## 1. 한 줄 정의

**OAuth2**는 사용자가 제3자(IdP, 카카오/네이버/구글)에서 인증하고, 그 결과를 우리 서비스가 **인가 코드 → 액세스 토큰 → 사용자 식별자(`providerUserId`)** 순서로 위임받아 로그인을 성립시키는 표준이다. TripTogether에서는 이렇게 받은 `provider`(KAKAO/NAVER/GOOGLE) + `providerUserId` 쌍을 `USER_SOCIAL` 테이블에 저장해 자체 `USERS` 레코드와 연결한다. 인증이 끝나면 결국 [세션](/glossary/session-cookie)에 `loginUser`(`UsersVO`)를 담는 점은 일반 로그인과 동일하다 — OAuth는 "누구인지 확인하는 단계"만 바깥에 위임할 뿐이다.

## 2. 왜 이렇게 설계했나

- **비밀번호를 보관하지 않는다** — 소셜 로그인 사용자는 우리가 비밀번호를 받지도, 저장하지도 않는다. 소셜 가입(`completeSocialRegister`)은 `passwordEnabled=false`, `userPassword=null`로 만든다. 유출 표면이 줄고, 비밀번호 정책·재설정 책임을 IdP에 위임한다.
- **인가 코드 흐름(서버사이드)을 택했다** — TripTogether는 JSP 서버 렌더링 + 단일 WAR라 토큰을 브라우저 JS에 노출할 이유가 없다. 액세스 토큰 교환과 사용자 정보 조회는 전부 서버(`AuthServiceImpl`)에서 일어나고, 브라우저는 리다이렉트만 오간다. Implicit/PKCE-SPA 패턴보다 이 구조에 자연스럽다.
- **여러 인증 수단을 한 계정에 공존**시킨다 — `USERS`는 ID 로그인·이메일 로그인·소셜 연동을 동시에 가질 수 있고(`uk_user_provider`로 provider별 1개), 그래서 **연동 해제 시 마지막 수단이 사라지는 사고**를 코드로 막는다(아래 5절).
- **provider별 차이를 한 곳에서 흡수**한다 — 카카오/네이버/구글은 응답 JSON 구조가 제각각이라, 각 핸들러가 `SocialUserInfo`(provider/providerUserId/email/nickname)로 정규화한 뒤 공통 로직(`processSocialLogin`)으로 합류시킨다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 역할 |
| --- | --- |
| `AuthController` | `/auth/{kakao,naver,google}` 진입·콜백, `/auth/link/**` 연동, `/auth/unlink` 해제 라우팅 |
| `AuthService` / `AuthServiceImpl` | 인가 URL 생성, 코드→토큰 교환, 사용자 정보 조회, 로그인/연동/해제 비즈니스 로직 |
| `SocialUserInfo` (VO) | provider별 응답을 통일한 정규화 객체 |
| `SocialTempVO` | 신규 소셜 사용자가 닉네임·국적·언어 입력 전까지 세션(`socialTemp`)에 임시 보관 |
| `UserSocialVO` / `USER_SOCIAL` 테이블 | `provider` + `provider_user_id`로 소셜 계정을 `USERS`에 연결 |
| `USERS` 테이블 | `password_enabled`·`email_login_enabled`·`email_verified`·`is_verified_member` 플래그로 인증 수단 상태 관리 |

`USER_SOCIAL` 핵심 제약 (`TripTogetherDB.sql`):

```sql
UNIQUE KEY uk_provider_user  (provider, provider_user_id), -- 한 소셜계정 = 한 회원
UNIQUE KEY uk_user_provider  (user_idx, provider),         -- 회원당 provider별 1개
CONSTRAINT fk_social_user FOREIGN KEY (user_idx)
    REFERENCES USERS (user_idx) ON DELETE CASCADE
```

state 위조 방지(CSRF성 공격 방어)는 세션에 일회용 state를 저장하고 콜백에서 대조한다 — 네이버·구글은 `state`, 카카오 로그아웃은 `kakaoLogoutState`. 토큰은 화면 인증 흐름에서만 쓰고, 로그아웃 시 네이버·구글은 `revoke` 엔드포인트로 액세스 토큰을 폐기한다.

## 4. 동작 원리 (흐름·표·작은 코드)

**인가 코드 로그인 흐름** (구글 예시, 카카오/네이버 동일 구조):

| 단계 | 위치 | 하는 일 |
| --- | --- | --- |
| 1 | 사용자 → `/auth/google` | 서버가 일회용 `state` 발급·세션 저장 후 IdP 인가 URL로 redirect |
| 2 | IdP 로그인 화면 | 사용자가 동의 → IdP가 `code` + `state`를 redirect_uri로 반환 |
| 3 | `/auth/google/callback` | `state` 일치 검증(불일치면 거부) |
| 4 | `AuthServiceImpl` | `code` → 액세스 토큰 교환(서버↔IdP) |
| 5 | `AuthServiceImpl` | 토큰으로 사용자 정보 조회 → `SocialUserInfo`로 정규화 |
| 6 | `processSocialLogin` | `USER_SOCIAL` 조회: 있으면 `UsersVO`, 없으면 `SocialTempVO` |
| 7a | 기존 회원 | 세션 `loginUser` 적재 → 로그인 완료 |
| 7b | 신규 회원 | `/auth/social/complete`에서 추가 정보 입력 → 가입 |

인가 URL 생성과 신규/기존 분기의 실제 코드(추상화):

```java
// 인가 URL — response_type=code, scope, state
"https://accounts.google.com/o/oauth2/v2/auth?client_id=" + clientId
    + "&redirect_uri=" + encode(redirectUri)
    + "&response_type=code&scope=" + encode("openid email profile")
    + "&state=" + encode(state);

// 콜백 공통 분기 (processSocialLogin)
UserSocialVO social = authMapper.findSocialByProviderAndId(provider, providerUserId);
if (social != null) {                 // 이미 연동된 계정
    UsersVO user = authMapper.findByIdx(social.getUserIdx());
    // DELETED/DORMANT 가드 후 lastLogin 갱신 → 로그인 성공
    return user;
}
return SocialTempVO.builder()...build(); // 신규 → 추가 정보 입력으로
```

:::tip 로그인 모드 vs 연동 모드
같은 IdP라도 진입 경로가 둘이다. `/auth/google`(로그인)과 `/auth/link/google`(이미 로그인한 사용자의 계정에 연동 추가)은 **redirect_uri가 다르다**(`googleRedirectUri` vs `googleLinkRedirectUri`). 연동 모드 콜백은 사용자 정보만 추출해 `linkSocial`로 현재 `loginUser`에 붙인다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨** — 카카오·네이버·구글 3종 인가 코드 로그인, 신규 가입(`SocialTempVO` → `completeSocialRegister`), 기존 계정 연동(`linkSocial`)·해제(`unlinkSocial`), state 검증, 네이버·구글 토큰 revoke, 소셜 로그아웃 redirect 흐름, 로그인/로그아웃 히스토리 기록.
- **됨(안전 불변식)** — 연동 해제 시 **"마지막 로그인 수단 보호"**. `unlinkSocial`은 ID 로그인(`hasUsableIdLogin`)·이메일 로그인(`hasUsableEmailLogin`)·남은 소셜이 **모두 0이면** `IllegalStateException`을 던져 해제를 거부한다.

```java
if (!hasIdLogin && !hasEmailLogin && remainingSocials <= 0) {
    throw new IllegalStateException(
        "연동 해제 후 사용할 수 있는 로그인 수단이 남아 있지 않아 처리할 수 없습니다...");
}
```

- **설계상 정직한 점** — 소셜 가입자는 이메일을 받아오더라도 그것만으로 이메일 로그인이 열리지 않는다. 이메일 로그인은 사용자가 별도로 등록·인증(`email_verified` + `email_login_enabled` + `password_enabled`)해야 "사용 가능한 수단"이 된다. 소셜 이메일이 이미 인증된 회원의 것이면 `getSocialEmailNotice`가 신규가입 대신 **연동을 권장**(`RECOMMEND_LINK`)한다.
- **환경 의존** — `client_id`/`client_secret`/redirect_uri는 설정값(`API_KEY`/`API_SECRET` 자리표시자)으로 주입된다. 실제 키는 공개 저장소에 없다.

:::warning revoke는 best-effort
네이버·구글 토큰 revoke 실패는 로그아웃 자체를 막지 않고 `TOKEN_REVOKE_FAILED` 사유만 히스토리에 남긴다. 즉 우리 세션은 항상 무효화되지만, IdP 측 토큰 폐기는 네트워크 상황에 따라 실패할 수 있는 약결합 동작이다.
:::

## 6. 면접 답변 3단계

1. **한 줄** — "소셜 로그인은 OAuth2 인가 코드 흐름으로 구현했습니다. IdP에서 인증을 위임받아 `provider`+`providerUserId`를 `USER_SOCIAL`에 매핑하고, 최종적으로는 일반 로그인과 같은 세션에 `loginUser`를 담습니다."
2. **설계 이유** — "서버 렌더링 단일 WAR라 토큰을 브라우저에 노출할 이유가 없어 서버사이드 인가 코드 흐름을 택했고, 비밀번호를 보관하지 않습니다. 계정 하나에 ID·이메일·소셜을 공존시켜 인증 수단을 다중화했습니다."
3. **트레이드오프/디테일** — "연동 해제 시 마지막 로그인 수단이 사라지면 계정 잠금이 되므로, `unlinkSocial`에서 남은 수단을 세고 0이면 예외로 거부합니다. state로 콜백 위조를 막고, 로그아웃 시 네이버·구글은 토큰 revoke까지 시도합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 인가 코드 흐름과 Implicit 흐름의 차이는? 왜 인가 코드를 썼나요?
Implicit는 액세스 토큰을 redirect의 URL 프래그먼트로 브라우저에 바로 던져 토큰이 노출되고 폐기됐습니다. 인가 코드 흐름은 브라우저에는 단명(短命) `code`만 오고, 토큰 교환은 `client_secret`을 가진 서버에서만 일어납니다. TripTogether는 서버에서 토큰을 다루므로 토큰을 클라이언트에 노출하지 않는 인가 코드 흐름이 맞습니다.
:::

:::details Q2. `state` 파라미터는 왜 필요한가요?
콜백 위조(CSRF성) 방어용입니다. 진입 시 일회용 `state`를 세션에 저장하고 콜백에서 대조해, 사용자가 시작하지 않은 인증 결과가 주입되는 걸 막습니다. TripTogether는 네이버·구글 로그인/연동에 provider+모드별 키로 state를 발급·소비하고, 불일치하면 콜백을 거부합니다.
:::

:::details Q3. 같은 이메일로 소셜 가입과 일반 가입이 겹치면 어떻게 되나요?
소셜 식별 기준은 이메일이 아니라 `providerUserId`라 충돌하지 않습니다. 다만 소셜 이메일이 이미 인증된 회원의 것이면, 신규 가입을 강행하지 않고 `getSocialEmailNotice`가 "기존 계정에 연동"을 권장합니다. 연동은 로그인 상태에서 `/auth/link/**`로 수행되어 한 사용자에 안전하게 붙습니다.
:::

:::details Q4. 소셜만으로 가입한 사용자가 연동을 끊으면 계정에서 잠기지 않나요?
그걸 막는 게 `unlinkSocial`의 핵심 가드입니다. 해제 후 남는 ID 로그인·이메일 로그인·다른 소셜이 모두 없으면 예외를 던져 해제를 거부하고, 사용자에게 다른 수단을 먼저 추가하라고 안내합니다. 즉 "마지막 인증 수단"은 절대 제거되지 않습니다.
:::

:::details Q5. provider마다 응답이 다른데 어떻게 통일했나요?
카카오는 최상위 `id`와 중첩된 `kakao_account`, 네이버는 `response` 래퍼, 구글은 `sub`로 식별자를 줍니다. 각 콜백 핸들러가 이 차이를 흡수해 `SocialUserInfo`(provider/providerUserId/email/nickname)로 정규화하고, 이후 `processSocialLogin` 공통 로직은 단일 형태만 다룹니다. 새 provider 추가 시 변환부만 늘리면 됩니다.
:::

## 8. 직접 말해보기

- "TripTogether의 소셜 로그인을 인가 코드 흐름 6~7단계로 설명해 보세요. `code`, 액세스 토큰, `providerUserId`, 세션이 각각 어디서 등장하나요?"
- "한 계정에 ID·이메일·소셜을 공존시킬 때 생기는 위험과, 코드가 그걸 어떻게 방어하는지 말해 보세요."
- "소셜 가입자에게 이메일이 있어도 이메일 로그인이 바로 열리지 않는 이유를 설명해 보세요."

관련 문서: [세션·쿠키](/glossary/session-cookie) · [BCrypt](/glossary/bcrypt) · [인터셉터](/glossary/interceptor) · [인증 도메인 개요](/auth/) · [소셜 로그인 상세](/auth/oauth-social) · [인증·세션 흐름](/flow/auth-session-flow) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="TripTogether 소셜 로그인이 채택한 OAuth2 흐름과 그 이유로 가장 적절한 것은?"
  :choices="['Implicit 흐름 — 토큰을 브라우저에 바로 주어 빠르므로', '인가 코드 흐름 — 서버에서 code를 토큰으로 교환해 토큰을 클라이언트에 노출하지 않으므로', 'Client Credentials 흐름 — 사용자 없이 서버 간 인증이므로', 'Resource Owner Password 흐름 — 비밀번호를 직접 받아 IdP에 전달하므로']"
  :answer="1"
  explanation="서버 렌더링 단일 WAR 구조라 토큰을 브라우저에 노출할 이유가 없어, code를 서버에서 토큰으로 교환하는 인가 코드 흐름을 택했다. 비밀번호도 받지 않는다."
/>

<QuizBox
  question="unlinkSocial이 IllegalStateException으로 연동 해제를 거부하는 조건은?"
  :choices="['연동된 소셜이 2개 이상일 때', '해제 후 ID 로그인·이메일 로그인·남은 소셜이 모두 없을 때', '이메일이 아직 인증되지 않았을 때', '계정 상태가 DORMANT일 때']"
  :answer="1"
  explanation="마지막 로그인 수단 보호 불변식. 해제 후 사용 가능한 인증 수단이 하나도 남지 않으면 예외를 던져 계정 잠금을 막는다."
/>

<QuizBox
  question="소셜 응답의 provider별 JSON 차이를 흡수하기 위해 콜백 핸들러가 변환하는 정규화 객체는?"
  :choices="['UsersVO', 'SocialUserInfo', 'LoginRequestContext', 'UserSocialVO']"
  :answer="1"
  explanation="카카오/네이버/구글의 서로 다른 응답을 provider/providerUserId/email/nickname을 가진 SocialUserInfo로 통일한 뒤, 공통 로직 processSocialLogin으로 합류시킨다."
/>
