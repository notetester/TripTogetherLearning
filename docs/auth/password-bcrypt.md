---
title: "비밀번호 해싱(BCrypt)"
owner: A
domain: "인증·계정·보안"
tags: ["BCrypt", "비밀번호"]
---

# 비밀번호 해싱(BCrypt)

> 비밀번호는 절대 평문으로 저장하지 않는다. TripTogether는 Spring Security의 BCryptPasswordEncoder로 단방향 해시·자동 salt·내장 work factor를 적용하고, 재설정은 일회성 토큰 메일로만 처리한다.

이 페이지는 인증 도메인의 한 챕터다. 도메인 전체 지도는 [도메인 전체 개요](/domains), 담당별 묶음은 [담당별 보기](/by-area/), 로그인 전체 흐름은 [전체 흐름](/flow/)에서 본다.

## 1. 한 줄 정의

비밀번호 해싱은 사용자가 입력한 평문 비밀번호를 복원 불가능한 단방향 해시 문자열로 변환해 저장하고, 로그인 시에는 같은 알고리즘으로 다시 검증하는 인증 기반 기술이다. TripTogether는 BCrypt 알고리즘을 사용한다.

## 2. 왜 이렇게 설계했나

핵심 전제는 단 하나다. **DB가 통째로 유출돼도 비밀번호 원문은 복원되면 안 된다.**

| 저장 방식 | 유출 시 위험 | 채택 여부 |
| --- | --- | --- |
| 평문 저장 | 그대로 노출, 타 사이트 재사용 공격 | 금지 |
| 단순 해시(MD5/SHA-256) | salt 없으면 레인보우 테이블, GPU로 초당 수십억 시도 | 부적합 |
| BCrypt | salt 자동 포함, work factor로 의도적 저속화 | 채택 |

BCrypt를 고른 이유:

- **자동 salt**: 매번 임의 salt를 생성해 해시 안에 함께 저장한다. 같은 비밀번호라도 사용자마다 다른 해시가 나와 레인보우 테이블이 무력화된다.
- **work factor(cost)**: 해시 반복 횟수를 `2^cost`로 키워 일부러 느리게 만든다. 정상 로그인은 수십 ms로 무시할 수준이지만, 대량 무차별 대입(brute force)은 비용이 폭증한다. 하드웨어가 빨라지면 cost만 올려 강도를 유지할 수 있다.
- **검증 편의**: salt와 cost가 해시 문자열 자체에 인코딩돼 있어, 검증 시 별도 컬럼을 읽을 필요 없이 `matches()` 한 번이면 된다.

:::tip work factor가 핵심인 이유
좋은 해시는 "빠른" 해시가 아니라 "적당히 느린" 해시다. 빠를수록 공격자가 후보 비밀번호를 더 많이 시험할 수 있기 때문이다. BCrypt의 cost는 이 속도를 운영자가 통제하게 해준다.
:::

## 3. 어떤 기술로 구현했나

실제 클래스·테이블 기준이다.

| 구성 요소 | 위치 | 역할 |
| --- | --- | --- |
| `BCryptPasswordEncoder` 빈 | `config/BCryptConfig` | 인코더를 스프링 빈으로 한 번만 등록 |
| `AuthServiceImpl` | `auth/service` | 가입·로그인·재설정 시 인코딩/검증 호출 |
| `UsersVO.userPassword` | `auth/vo` | BCrypt 해시 문자열 보관 필드(평문 아님) |
| `USERS.user_password` | `TripTogetherDB.sql` | varchar(255), nullable. 해시 저장 컬럼 |
| `authMapper.xml` | `resources/mapper` | insertUser/updatePassword/resetPassword 쿼리 |

빈 등록은 의존성 주입을 위한 표준 설정이다.

```java
// config/BCryptConfig
@Bean
public BCryptPasswordEncoder bCryptPasswordEncoder() {
    return new BCryptPasswordEncoder(); // 기본 work factor 적용
}
```

`BCryptConfig`는 별도 인자 없이 기본 생성자를 쓴다. 즉 work factor는 Spring Security가 정한 기본값(strength)을 따르고, 코드에 매직 넘버를 박지 않는다. 이 빈은 `AuthServiceImpl`에 생성자 주입된다.

DB 컬럼은 nullable이다. 소셜 로그인 전용 계정은 비밀번호가 없을 수 있기 때문이며, 이때 `password_enabled = FALSE`로 비밀번호 로그인 자체를 막는다.

## 4. 동작 원리

비밀번호가 코드 어디에서도 평문으로 살아남지 않도록, 세 지점에서만 인코더를 통과한다.

**(1) 회원가입 — 인코딩 후 저장**

```java
// AuthServiceImpl.register
if (user.getUserPassword() != null && !user.getUserPassword().isBlank()) {
    user.setUserPassword(bCryptPasswordEncoder.encode(user.getUserPassword()));
    user.setPasswordEnabled(true);
}
authMapper.insertUser(user);
```

`encode()`가 평문을 해시로 덮어쓴 뒤 INSERT가 실행된다. DB에는 해시만 들어간다.

**(2) 로그인 — matches로 검증**

```java
// AuthServiceImpl.login
if (!bCryptPasswordEncoder.matches(password, user.getUserPassword())) {
    recordLoginResult(user.getUserIdx(), loginMethod, identifier,
                      false, "WRONG_PASSWORD", context);
    loginRiskPolicyService.handleWrongPassword(user, identifier, loginMethod, context);
    return null;
}
```

`matches(평문, 저장된해시)`는 저장된 해시에서 salt와 cost를 꺼내 평문을 같은 방식으로 해시한 뒤 결과를 비교한다. 복호화는 일어나지 않는다. 실패하면 사유 코드(WRONG_PASSWORD)와 함께 로그인 위험 정책으로 넘어가 누적 실패를 추적한다.

**(3) 비밀번호 변경/재설정 — 다시 인코딩**

```java
// 프로필에서 변경
authMapper.updatePassword(userIdx, bCryptPasswordEncoder.encode(newRawPassword));

// 메일 토큰으로 재설정
authMapper.resetPassword(ev.getUserIdx(), bCryptPasswordEncoder.encode(newPassword));
```

두 경로 모두 새 평문을 즉시 인코딩한다. 매핑 쿼리(updatePassword/resetPassword)는 `user_password`를 새 해시로 갱신하고 `password_enabled = TRUE`로 맞춘다.

흐름 요약:

| 단계 | 입력 | 처리 | 저장/판정 |
| --- | --- | --- | --- |
| 가입 | 평문 | encode | 해시 INSERT |
| 로그인 | 평문 | matches | 일치 여부 |
| 변경/재설정 | 새 평문 | encode | 해시 UPDATE |

**비밀번호 재설정 토큰 흐름** — 비밀번호 찾기는 현재 비밀번호를 몰라도 진행되므로, 메일 소유 증명을 일회성 토큰으로 대신한다.

| 단계 | 메서드 | 핵심 동작 |
| --- | --- | --- |
| 요청 | `sendResetPasswordEmail` | 계정/이메일 인증/상태 검증 후 `RESET_PW` 토큰 발급, 메일 발송 |
| 진입 | `verifyResetToken` | 토큰 유효성 확인, 재설정 화면용 사용자 반환 |
| 확정 | `resetPassword` | 토큰 사용 처리(markTokenUsed) 후 새 비밀번호 encode·UPDATE |

토큰은 UUID로 생성되고 만료시간(TTL)이 있으며, 이전 토큰은 발급 시점에 만료 처리(expireOldTokens)된다. 확정 단계에서 토큰을 즉시 used로 표시해 같은 링크 재사용을 막는다.

:::warning 평문 금지 원칙
검증은 항상 "저장된 평문 비교"가 아니라 `matches()`다. 어딘가에서 비밀번호를 평문으로 다시 꺼내 비교하거나, 메일·로그·DB에 평문을 남기는 순간 BCrypt를 쓴 의미가 사라진다. 비밀번호 변경 시에도 기존 비밀번호를 복원하지 않고, 사용자가 입력한 새 평문을 즉시 인코딩한다.
:::

## 5. 구현 상태

구현된 것과 한계를 정직하게 구분한다.

**구현됨**

- BCrypt 빈 등록(`BCryptConfig`)과 가입·로그인·변경·재설정 전 경로의 encode/matches 적용
- 메일 일회성 토큰 기반 비밀번호 재설정(요청→진입→확정 3단계, 토큰 만료·재사용 차단)
- 비밀번호 미보유 계정(`password_enabled = FALSE`) 분기 처리, 소셜 전용 계정 대응
- 로그인 실패 사유 코드화 + 로그인 위험 정책 연계(누적 실패 추적)

**기본값/계획**

- work factor는 기본 생성자 값에 의존한다. cost를 설정 외부화하거나 주기적으로 상향하는 운영 정책은 코드에 명시돼 있지 않다.
- 신규 비밀번호 강도 검증은 일부 경로에서 최소 길이(8자 이상) 수준이다. 문자 종류 조합·유출 비밀번호 차단 같은 강한 정책은 향후 과제다.
- BCrypt cost 상향 시 기존 해시를 로그인 성공 순간에 재해싱(upgrade)하는 자동 마이그레이션은 아직 없다.

## 6. 면접 답변 3단계

**1단계(한 줄)**: 비밀번호는 평문 저장 없이 Spring Security의 BCryptPasswordEncoder로 단방향 해시해 저장하고, 로그인은 matches로 검증합니다.

**2단계(설계 의도)**: BCrypt를 쓴 이유는 salt가 자동으로 포함돼 레인보우 테이블을 막고, work factor로 해시를 의도적으로 느리게 만들어 무차별 대입 비용을 키울 수 있기 때문입니다. salt와 cost가 해시 문자열에 함께 들어가 검증이 단순합니다.

**3단계(구현 디테일)**: 인코더는 BCryptConfig에서 빈으로 한 번만 등록하고 AuthServiceImpl에 주입합니다. 가입·변경·재설정에서는 encode로 해시를 갱신하고, 로그인에서는 matches로 비교합니다. 비밀번호 재설정은 현재 비밀번호 없이 진행되므로 메일로 보낸 일회성 토큰으로 소유를 증명하고, 확정 시 토큰을 used 처리해 재사용을 막습니다. 소셜 전용 계정은 password_enabled 플래그로 비밀번호 로그인을 차단합니다.

## 7. 꼬리질문 + 모범답안

:::details salt를 따로 컬럼에 저장하지 않는데 검증이 되나요?
됩니다. BCrypt 해시 문자열 안에 알고리즘 버전·cost·salt가 모두 인코딩돼 있습니다. 검증 시 matches가 저장된 해시에서 salt와 cost를 추출해 입력 평문을 같은 방식으로 해시한 뒤 비교하므로 별도 salt 컬럼이 필요 없습니다.
:::

:::details 같은 비밀번호인데 사용자마다 해시가 다른 이유는?
가입할 때마다 임의의 salt가 새로 생성돼 해시에 섞이기 때문입니다. 덕분에 두 사용자가 동일한 비밀번호를 써도 저장된 해시는 서로 달라, 해시값만 보고 같은 비밀번호인지 알 수 없고 레인보우 테이블도 무력화됩니다.
:::

:::details work factor를 높이면 무엇이 좋아지고 무엇이 나빠지나요?
높일수록 해시 1회 계산 시간이 늘어 무차별 대입 공격 비용이 커집니다. 대신 정상 로그인 검증 비용도 함께 늘어 서버 CPU 부담이 증가합니다. 그래서 사용자 체감은 거의 없으면서 공격은 비싸지는 지점으로 균형을 맞추고, 하드웨어가 빨라지면 단계적으로 올립니다.
:::

:::details BCrypt와 SHA-256 단순 해시의 차이는?
SHA-256은 빠른 해시라 GPU로 초당 수십억 번 시도가 가능하고 salt도 직접 관리해야 합니다. BCrypt는 salt 자동 포함에 work factor로 일부러 느리게 동작해 대량 추측을 어렵게 만듭니다. 비밀번호처럼 추측 공격 대상에는 빠른 해시가 아니라 느린 해시가 적합합니다.
:::

:::details 비밀번호 재설정 링크가 노출되면 어떻게 막나요?
토큰은 UUID로 추측이 어렵고 만료시간이 있으며, 새 토큰 발급 시 이전 토큰을 만료 처리합니다. 재설정을 확정하는 순간 토큰을 used로 표시해 같은 링크를 두 번 쓸 수 없게 합니다. 또한 재설정은 이메일 인증·계정 상태 검증을 통과한 계정에만 발급됩니다.
:::

## 8. 직접 말해보기

아래를 소리 내어 설명해 보자. 막히면 해당 섹션으로 돌아간다.

1. 평문 저장 대신 BCrypt를 쓰는 이유를 salt와 work factor 두 단어로 설명하기.
2. 가입·로그인·변경 세 경로에서 비밀번호가 각각 어떻게 처리되는지 한 문장씩 말하기(encode vs matches).
3. 비밀번호 재설정이 현재 비밀번호 없이도 안전한 이유를 토큰 관점에서 설명하기.
4. password_enabled 플래그가 왜 필요한지(소셜 전용 계정) 말하기.

## 퀴즈

<QuizBox question="TripTogether가 비밀번호 저장에 BCrypt를 사용하는 가장 큰 이유는?" :choices="['빠른 해시로 로그인을 즉시 끝내려고', '자동 salt와 work factor로 유출·무차별 대입을 방어하려고', '비밀번호를 나중에 복호화해 보여주려고', '이메일 전송 속도를 높이려고']" :answer="1" explanation="BCrypt는 임의 salt를 자동 포함해 레인보우 테이블을 막고, work factor로 해시를 의도적으로 느리게 만들어 무차별 대입 비용을 키운다. 복호화는 불가능하다." />

<QuizBox question="로그인 시 비밀번호 검증 방식으로 옳은 것은?" :choices="['DB의 평문 비밀번호와 직접 비교한다', 'matches로 입력 평문을 같은 방식으로 해시해 저장된 해시와 비교한다', '저장된 해시를 복호화해 평문으로 되돌려 비교한다', 'salt를 별도 컬럼에서 읽어 수동으로 합친다']" :answer="1" explanation="bCryptPasswordEncoder.matches가 저장된 해시에서 salt와 cost를 추출해 입력 평문을 해시한 뒤 비교한다. 복호화도, 평문 저장도 없다." />

<QuizBox question="비밀번호 재설정 토큰이 한 번만 쓰이도록 보장하는 핵심 처리는?" :choices="['토큰을 평문 비밀번호로 저장한다', '확정 단계에서 토큰을 used로 표시하고 이전 토큰을 만료 처리한다', '토큰을 로그에 남겨 추적한다', '토큰을 password_enabled 컬럼에 저장한다']" :answer="1" explanation="resetPassword는 markTokenUsed로 토큰을 즉시 사용 처리하고, 발급 시 expireOldTokens로 이전 토큰을 만료시켜 재사용을 막는다." />
