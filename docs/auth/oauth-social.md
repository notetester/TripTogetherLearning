---
title: "OAuth 소셜 로그인"
owner: A
domain: "인증·계정·보안"
tags: ["OAuth", "소셜로그인"]
---

# OAuth 소셜 로그인

> Kakao·Naver·Google 인가 코드를 토큰으로 교환해 사용자 정보를 받아오고, 이미 연동된 소셜이면 기존 계정으로 로그인, 처음이면 추가 정보 입력 후 신규 가입한다. 세 제공자의 응답 차이는 한 곳에서 흡수하고, 그 뒤 흐름은 완전히 공통이다.

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트다. 이 페이지는 `auth` 모듈의 **소셜 로그인·연동** 기능을 다룬다. 진입점은 모두 `AuthController`이고, 실제 처리는 `AuthServiceImpl`, 연동 정보는 `USER_SOCIAL` 테이블에 저장된다. 세션 인증 자체의 기초는 [로그인·세션](/auth/login-session), 토큰 발급은 [이메일 인증·액션 토큰](/auth/email-verification-token)에서 다룬다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

OAuth 소셜 로그인은 **비밀번호를 우리 서버가 받지 않고**, 제공자(Kakao·Naver·Google)가 인증을 대신해 준 뒤 발급한 인가 코드를 받아, 그 코드를 액세스 토큰으로 교환하고 토큰으로 사용자 고유 ID를 조회해 우리 서비스 계정과 연결하는 위임 인증 방식이다. OAuth 일반 개념은 [용어집 OAuth](/glossary/oauth) 참고.

## 2. 왜 이렇게 설계했나

- **비밀번호를 직접 다루지 않는다**: 제공자가 본인 확인을 책임지므로, 우리는 비밀번호 저장·검증 부담과 유출 위험을 지지 않는다.
- **가입 장벽을 낮춘다**: 국내 사용자가 이미 가진 Kakao·Naver·Google 계정으로 1~2클릭 가입이 가능하다.
- **제공자별 차이를 한 곳에서만 흡수한다**: 세 제공자는 응답 JSON 구조가 모두 다르다. 그 차이를 콜백 메서드 안에서만 `SocialUserInfo`로 변환하고, 그 뒤 공통 로직은 제공자를 구분하지 않는다.
- **계정 잠금 위험을 막는다**: 소셜 연동을 해제할 때 마지막 로그인 수단이 사라지면 사용자가 영영 로그인할 수 없다. 그래서 **최소 1개 인증 수단**을 항상 강제한다.

:::tip 핵심 불변식
한 사용자가 같은 제공자를 두 번 연동할 수 없고(`USER_SOCIAL`의 `uk_user_provider`), 하나의 소셜 계정이 두 사용자에게 붙을 수도 없다(`uk_provider_user`). 그리고 연동 해제 후 로그인 수단이 0개가 되는 것을 서비스 계층이 막는다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 클래스 / 테이블 | 역할 |
| --- | --- | --- |
| 진입·콜백 컨트롤러 | `AuthController` (`/auth/**`) | 인가 URL 리다이렉트, 콜백 수신, 세션 처리 |
| 핵심 로직 | `AuthServiceImpl` | 토큰 교환, 사용자 조회, 기존·신규 분기 |
| HTTP 호출 | OkHttp 5.x | 제공자 토큰·프로필 API 호출 |
| 공통 사용자 모델 | `SocialUserInfo` | provider·providerUserId·email·nickname 4필드로 정규화 |
| 임시 가입 상태 | `SocialTempVO` (세션 키 socialTemp) | 추가 정보 입력 전 임시 보관 |
| 연동 영속 | `UserSocialVO` → `USER_SOCIAL` | provider별 1행, provider_user_id 저장 |
| 매퍼 | `AuthMapper` (+ mapper XML) | findSocialByProviderAndId, insertSocial, deleteSocial 등 |

`USER_SOCIAL` 테이블 구조 핵심:

```sql
provider          varchar(50)   -- KAKAO, NAVER, GOOGLE
provider_user_id  varchar(255)  -- 제공자가 준 고유 ID
UNIQUE KEY uk_provider_user (provider, provider_user_id)  -- 소셜 1개 = 사용자 1명
UNIQUE KEY uk_user_provider (user_idx, provider)          -- 사용자당 제공자 1개
FK fk_social_user (user_idx) REFERENCES USERS ON DELETE CASCADE
```

저장하는 것은 **provider와 provider_user_id뿐**이다. 액세스 토큰은 DB에 보관하지 않고, 로그아웃 시 제공자 토큰을 무효화할 때만 잠시 세션에 둔다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 인가 코드 → 토큰 → 사용자 정보 (로그인)

```text
1. 사용자가 소셜 로그인 클릭
   GET /auth/kakao  →  authService.getKakaoAuthUrl(false) 로 제공자 인가 화면 리다이렉트
2. 제공자가 본인 확인 후 우리 콜백으로 code 전달
   GET /auth/kakao/callback?code=...
3. code 를 액세스 토큰으로 교환 (getKakaoAccessToken)
4. 토큰으로 프로필 조회 → 제공자별 JSON 을 SocialUserInfo 로 변환
5. processSocialLogin: USER_SOCIAL 에서 provider+providerUserId 조회
   - 있으면  → 기존 UsersVO 반환 (기존 계정 로그인)
   - 없으면  → SocialTempVO 반환 (신규, 추가 정보 입력으로)
```

제공자별 차이를 흡수하는 정규화 (Kakao 예시):

```java
SocialUserInfo socialInfo = SocialUserInfo.builder()
        .provider("KAKAO")
        .providerUserId(info.get("id").getAsString())
        .email(extractKakaoEmail(info))      // 카카오는 이메일이 중첩·없음 가능
        .nickname(extractKakaoNickname(info))
        .build();
return processSocialLogin(socialInfo, buildContext(request));
```

Naver는 응답 최상위 `response` 객체 안에 사용자 정보가 들어 있고, 이메일·닉네임은 `has()`로 존재를 확인한 뒤 꺼낸다. 변환만 다를 뿐, 그 다음 `processSocialLogin`은 셋 다 똑같다.

### 기존 계정 vs 신규 분기

`processSocialLogin`이 분기점이다.

| 조건 | 반환 타입 | 컨트롤러 처리 |
| --- | --- | --- |
| 연동 기록 있음·계정 정상 | `UsersVO` | 세션 loginUser 설정 후 홈 리다이렉트 |
| 연동 기록 있음·DELETED/DORMANT | null | 로그인 거부 (삭제·휴면) |
| 연동 기록 없음 (신규) | `SocialTempVO` | socialTemp 세션 저장 후 추가 정보 페이지로 |

```java
UserSocialVO social = authMapper.findSocialByProviderAndId(provider, providerUserId);
if (social != null) {
    UsersVO user = authMapper.findByIdx(social.getUserIdx());
    // DELETED/DORMANT 차단 후 최종 로그인 시각 갱신, 이력 기록
    return authMapper.findByIdx(user.getUserIdx());
}
return SocialTempVO.builder()      // 신규 → 임시 VO
        .provider(info.getProvider()).providerUserId(info.getProviderUserId())
        .email(info.getEmail()).nickname(info.getNickname()).build();
```

신규 사용자는 `/auth/social/complete`에서 닉네임·국적·언어를 입력하면 `completeSocialRegister`가 `USERS`와 `USER_SOCIAL`을 함께 만든다. 이때 **소셜 가입은 이메일을 로그인 수단으로 만들지 않는다**: `userEmail=null`, `passwordEnabled=false`, `emailLoginEnabled=false`로 시작하고, 이메일은 본인이 별도로 등록·인증해야 비로소 공식 로그인 수단이 된다.

### currentSocialProvider 와 로그아웃

로그인이 어느 제공자로 이뤄졌는지 세션 속성 `currentSocialProvider`(KAKAO/NAVER/GOOGLE)에 기록한다. 일반 로그아웃 `/auth/logout`은 이 값을 보고 제공자별 로그아웃 흐름으로 분기한다. 로컬 계정이면 바로 세션 무효화, 소셜이면 제공자 로그아웃·토큰 폐기(`revokeSocialAccessToken`)까지 거친 뒤 세션을 무효화한다. CSRF·세션 위조 방지를 위해 Naver·Google 콜백은 `state` 값을 발급(`issueOauthState`)하고 콜백에서 1회용으로 소비(`consumeOauthState`)한다.

### 기존 계정에 소셜 연동 / 해제

이미 로그인한 사용자가 마이페이지에서 소셜을 **연동**하는 경로(`/auth/link/{provider}`)도 있다. `linkSocial`은 두 가지를 막는다.

- 그 소셜이 **다른 계정**에 이미 붙어 있으면 거부 (`findSocialByProviderAndId`)
- 내 계정에 **같은 제공자**가 이미 있으면 거부 (`findSocialByUserIdxAndProvider`)

**해제**(`unlinkSocial`)는 최소 1개 인증 수단 불변식의 핵심이다.

```java
boolean hasIdLogin = hasUsableIdLogin(user);      // 아이디+비밀번호 사용 가능?
boolean hasEmailLogin = hasUsableEmailLogin(user); // 이메일 로그인 사용 가능?
long remainingSocials = ...;                       // 해제 후 남는 소셜 수
if (!hasIdLogin && !hasEmailLogin && remainingSocials <= 0) {
    throw new IllegalStateException("로그인 수단이 남지 않아 처리할 수 없습니다 ...");
}
```

즉 아이디 로그인·이메일 로그인·다른 소셜 중 하나라도 남아야만 해제할 수 있다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: Kakao·Naver·Google 인가 코드→토큰→프로필 조회, 기존·신규 분기, `SocialTempVO` 추가 정보 입력, `USER_SOCIAL` 연동·해제, 최소 1개 인증 수단 강제, `state` 검증, 제공자별 로그아웃·토큰 폐기, 로그인 이력 기록.
- 제공자 비밀값은 코드에 두지 않고 설정·런타임 설정에서 주입한다(자리표시자 `API_KEY` 형태). 운영 환경값은 공개 자료에 포함하지 않는다.
- 계획·한계: 모바일은 JSP 데스크톱 레이아웃 위주라 소셜 버튼 반응형은 향후 과제. Apple 등 추가 제공자는 미연동.

:::warning 오해 주의
소셜 로그인은 비밀번호를 우리가 안 받을 뿐, 인증을 안 하는 게 아니다. 본인 확인을 제공자에게 위임하고 그 결과(코드·토큰)를 신뢰하는 구조다. 그래서 콜백 `state` 검증과 토큰 교환이 무너지면 인증 전체가 무너진다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: 소셜 로그인은 Kakao·Naver·Google이 본인 확인을 대신하고 발급한 인가 코드를 토큰으로 교환해 사용자 고유 ID를 받아, 우리 `USER_SOCIAL`에 매핑해 로그인하는 위임 인증입니다.
2. **설계 의도**: 제공자마다 응답 JSON이 달라서 콜백에서 `SocialUserInfo` 4필드로 정규화하고, 그 뒤 `processSocialLogin`은 제공자를 구분하지 않게 했습니다. 연동 기록이 있으면 기존 계정 로그인, 없으면 `SocialTempVO`로 추가 정보를 받아 신규 가입합니다.
3. **안전장치**: `USER_SOCIAL`에 두 개의 UNIQUE 제약으로 소셜과 계정의 1대1을 보장하고, 연동 해제 시 로그인 수단이 0개가 되지 않도록 서비스에서 최소 1개 인증 수단을 강제합니다. Naver·Google은 `state`로 콜백 위조를 막습니다.

## 7. 꼬리질문 + 모범답안

:::details 인가 코드를 받았는데 왜 바로 사용자 정보를 못 조회하나요?
인가 코드는 1회용 단기 자격증명이라 그 자체로는 프로필을 조회할 수 없습니다. 반드시 토큰 엔드포인트에서 액세스 토큰으로 교환한 뒤, 그 토큰으로 프로필 API를 호출해야 합니다. 코드 교환을 서버에서 하므로 토큰이 브라우저에 노출되지 않습니다.
:::

:::details 같은 이메일로 일반 가입한 사용자가 소셜로 또 로그인하면 어떻게 되나요?
소셜 식별 기준은 이메일이 아니라 provider_user_id입니다. `processSocialLogin`은 provider와 provider_user_id로만 기존 연동을 찾으므로, 연동 기록이 없으면 신규로 분기합니다. 다만 추가 정보 단계에서 같은 이메일의 인증된 계정이 있으면 `getSocialEmailNotice`가 연동을 권장하는 안내를 띄워, 사용자가 새 계정 대신 기존 계정에 연동하도록 유도합니다.
:::

:::details 소셜 연동을 마지막 하나까지 해제하려 하면요?
`unlinkSocial`이 아이디 로그인·이메일 로그인·남는 소셜 수를 모두 확인해, 셋 다 없어지면 IllegalStateException으로 막습니다. 먼저 다른 로그인 수단을 추가하라고 안내합니다. 최소 1개 인증 수단을 보장해 계정 잠금을 방지하는 설계입니다.
:::

:::details Naver·Google에만 state가 있고 Kakao 로그인 진입에는 안 보이는 이유는?
state는 콜백이 우리가 시작한 요청에 대한 응답인지 검증하는 CSRF 방지값입니다. Naver·Google 콜백은 `consumeOauthState`로 1회용 검증을 거칩니다. 운영 정책상 제공자별로 적용 범위가 다를 수 있으며, 보안을 높이려면 세 제공자 모두 state 검증을 일관 적용하는 것이 바람직합니다.
:::

:::details 액세스 토큰은 DB에 저장하나요?
아니요. `USER_SOCIAL`에는 provider와 provider_user_id만 저장합니다. 액세스 토큰은 로그아웃 시 제공자 토큰을 폐기(revoke)할 때만 잠시 세션에 두고, 영구 보관하지 않습니다. 토큰 유출 표면을 줄이는 선택입니다.
:::

## 8. 직접 말해보기

- 소셜 로그인에서 인가 코드와 액세스 토큰의 역할 차이를 한 문장씩으로 설명해 보라.
- 세 제공자의 응답 차이를 어디서, 어떤 객체로 흡수하는지 클래스 이름과 함께 말해 보라.
- 연동 해제가 위험한 이유와 그것을 막는 불변식을 코드 흐름으로 설명해 보라.
- currentSocialProvider가 로그아웃에서 왜 필요한지 말해 보라.

## 퀴즈

<QuizBox question="소셜 콜백에서 제공자별로 서로 다른 응답 JSON을 하나로 정규화하는 공통 객체는?" :choices="['UsersVO', 'SocialUserInfo (provider·providerUserId·email·nickname)', 'LoginRequestContext', 'UserSocialVO']" :answer="1" explanation="Kakao·Naver·Google 응답 구조는 모두 다르지만 콜백 메서드에서 SocialUserInfo 4필드로 변환한다. 그 뒤 processSocialLogin은 제공자를 구분하지 않는다." />

<QuizBox question="processSocialLogin이 USER_SOCIAL에서 연동 기록을 찾지 못했을 때 반환하는 것은?" :choices="['null 을 반환해 로그인을 거부한다', '곧바로 USERS 에 신규 행을 만들고 UsersVO 를 반환한다', 'SocialTempVO 를 반환해 추가 정보 입력 단계로 보낸다', 'IllegalStateException 을 던진다']" :answer="2" explanation="신규 사용자는 닉네임·국적·언어를 받기 전이라 바로 가입하지 않는다. SocialTempVO를 세션 socialTemp에 담아 추가 정보 페이지로 보내고, completeSocialRegister에서 비로소 USERS와 USER_SOCIAL을 만든다." />

<QuizBox question="소셜 연동 해제(unlinkSocial)가 막는 핵심 위험은?" :choices="['같은 제공자를 두 번 연동하는 것', '연동 해제 후 로그인 수단이 0개가 되어 계정에 영영 못 들어가는 것', '액세스 토큰이 DB에 저장되는 것', '관리자 권한이 사라지는 것']" :answer="1" explanation="아이디 로그인·이메일 로그인·남는 소셜이 모두 없어지면 사용자가 다시 로그인할 수 없다. 그래서 최소 1개 인증 수단을 강제하고, 0개가 되는 해제는 예외로 거부한다." />
