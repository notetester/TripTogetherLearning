# BCrypt

> TripTogether는 비밀번호를 **절대 평문으로 저장하지 않는다**. 회원가입·비밀번호 변경 시 `BCryptPasswordEncoder.encode()`로 단방향 해시를 만들어 `USERS.user_password`에 넣고, 로그인 때는 `matches()`로 비교한다. 해시에서 원래 비밀번호를 되돌릴 수는 없다.

## 1. 한 줄 정의

**BCrypt**는 비밀번호 전용 **단방향 해시 함수**다. 같은 비밀번호라도 매번 다른 **salt**가 섞여 결과가 달라지고, **work factor(cost)** 만큼 일부러 느리게 계산해 무차별 대입(brute force)을 어렵게 만든다. TripTogether에서는 Spring Security의 `BCryptPasswordEncoder`를 `@Bean`으로 등록해 인증 도메인 전역에서 쓴다. 저장 대상 컬럼은 `USERS.user_password`이고, VO 필드 주석도 명시적으로 "BCrypt 해시 비밀번호"다.

## 2. 왜 이렇게 설계했나

비밀번호를 평문이나 단순 해시(MD5/SHA-256 한 번)로 저장하면, DB가 유출되는 순간 사용자 계정 전체가 위험해진다. BCrypt는 이 위협을 정면으로 겨냥한다.

- **단방향성** — 해시는 복호화 키가 없다. 서버조차 저장된 값에서 원래 비밀번호를 알아낼 수 없으므로, "비밀번호 찾기"는 재설정([이메일 액션 토큰](/glossary/oauth) 기반)으로만 가능하고 평문을 메일로 보내는 일이 구조적으로 불가능하다.
- **salt 내장** — 같은 비밀번호 `1234`라도 사용자마다 해시 결과가 다르다. 이는 **레인보우 테이블**(미리 계산해 둔 해시 사전) 공격을 무력화하고, 두 사용자가 같은 비밀번호를 써도 DB에서 그 사실이 드러나지 않게 한다. salt는 따로 컬럼을 두지 않아도 해시 문자열 안에 함께 들어간다.
- **의도된 느림(cost factor)** — SHA-256은 너무 빨라서 공격자가 초당 수억 번 시도할 수 있다. BCrypt는 cost(기본 10 → `2^10`회 반복)만큼 느리게 계산해, 정상 로그인 1회 비용은 무시할 만하지만 대량 대입은 비현실적으로 비싸게 만든다.

:::tip 해시 ≠ 암호화
암호화(encryption)는 키로 복호화가 가능한 양방향이고, 해시(hashing)는 되돌릴 수 없는 단방향이다. 비밀번호는 "원문을 복원할 필요가 전혀 없는" 값이므로 암호화가 아니라 해시가 정답이다. 복호화가 불가능하다는 점이 약점이 아니라 핵심 보안 속성이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 역할 |
| --- | --- |
| `BCryptConfig` (`config` 패키지) | `BCryptPasswordEncoder`를 `@Bean`으로 등록하는 설정 클래스 |
| `BCryptPasswordEncoder` (Spring Security crypto) | 실제 `encode()` / `matches()` 수행 |
| `AuthServiceImpl` | 인코더를 주입받아 회원가입·로그인·비밀번호 재설정/변경에서 호출 |
| `UsersVO.userPassword` | 해시 문자열이 담기는 필드 (`USERS.user_password` 매핑) |
| `UsersVO.passwordEnabled` | 비밀번호 로그인 가능 여부 플래그 (소셜 전용 계정은 `false`) |

빈 등록은 단순하다 — 생성자에 cost를 넘기지 않으므로 기본 strength(10)를 쓴다:

```java
@Configuration
public class BCryptConfig {
    @Bean
    public BCryptPasswordEncoder bCryptPasswordEncoder() {
        return new BCryptPasswordEncoder();   // 기본 cost = 10
    }
}
```

`AuthServiceImpl`은 이 빈을 `final` 필드로 주입받아(`@RequiredArgsConstructor`) 인증 흐름 전반에서 재사용한다.

## 4. 동작 원리 (흐름·표·작은 코드)

핵심은 두 가지 동작뿐이다 — **저장할 때 `encode`, 검증할 때 `matches`**.

| 시점 | 메서드 호출 위치 (`AuthServiceImpl`) | 하는 일 |
| --- | --- | --- |
| 회원가입 | `register()` | `encode(rawPassword)` → `user_password` 저장, `passwordEnabled=true` |
| 로그인 | `login()` | `matches(입력, 저장된해시)`가 false면 `WRONG_PASSWORD`로 실패 처리 |
| 비밀번호 재설정 | `resetPassword()` | 토큰 검증 후 `encode(newPassword)`로 갱신 |
| 비밀번호 변경 | `updatePassword()` | `encode(newRawPassword)`로 갱신 + 보안 이벤트 기록 |
| 본인 확인 | `checkPassword()` | 프로필 수정 등에서 `matches`로 현재 비밀번호 재확인 |

**저장 (회원가입):** 평문은 메모리에서만 잠깐 다뤄지고, DB에 닿는 건 해시뿐이다.

```java
// register(UsersVO user)
if (user.getUserPassword() != null && !user.getUserPassword().isBlank()) {
    user.setUserPassword(bCryptPasswordEncoder.encode(user.getUserPassword()));
    user.setPasswordEnabled(true);
}
authMapper.insertUser(user);   // user_password 컬럼에는 해시만 들어간다
```

**검증 (로그인):** 저장된 해시를 복호화하는 게 아니라, 입력값을 **같은 salt/cost로 다시 해시해 비교**한다. 이 비교를 `matches`가 내부에서 처리한다.

```java
// login(...)
if (!bCryptPasswordEncoder.matches(password, user.getUserPassword())) {
    recordLoginResult(user.getUserIdx(), loginMethod, identifier,
            false, "WRONG_PASSWORD", context);
    loginRiskPolicyService.handleWrongPassword(user, identifier, loginMethod, context);
    return null;
}
```

BCrypt 해시 문자열은 `$2a$10$...` 형태로, 알고리즘 버전·cost·salt·해시가 **한 문자열 안에 모두** 들어 있다(추상 예시):

```text
$2a$10$N9qo8uLOickgx2ZMRZoMy.Mr...   // cost=10, 그 뒤 22자 salt + 31자 해시
└┬┘ └┬┘ └──────────── salt + hash ────────────┘
버전 cost
```

그래서 `matches`는 별도 salt 컬럼 없이도, 저장된 문자열에서 salt와 cost를 읽어 입력값을 동일하게 재계산할 수 있다.

:::warning 비밀번호가 없는 계정도 있다
소셜 전용 가입(Kakao/Naver/Google)은 비밀번호를 만들지 않으므로 `passwordEnabled=false`이고 `user_password`는 비어 있다. 로그인 코드는 `matches` 이전에 `passwordEnabled`를 먼저 확인해, 비밀번호 로그인이 비활성인 계정에는 해시 비교 자체를 시도하지 않는다. 로컬 로그인 수단이 모두 사라지면 비밀번호를 비워 비활성화하는 정리 로직도 있다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: `BCryptConfig` 빈 등록, 회원가입·재설정·변경 시 `encode` 저장, 로그인·본인확인 시 `matches` 검증, 평문 DB 저장 전무, 소셜 전용 계정의 `passwordEnabled` 분기, 로그인 실패 시 위험도 평가(`LoginRiskPolicyService`) 연계.
- **기본값 사용**: cost는 생성자 인자 없이 **기본 strength 10**을 사용한다(운영 하드웨어에 맞춰 cost를 올리는 튜닝은 명시적으로 하고 있지 않음 — 향후 강화 여지).
- **계획/유의**: cost 상향 시 기존 해시는 그대로 두고 다음 로그인 때 재해시(rehash)하는 자동 마이그레이션은 도입 전. 비밀번호 정책(길이·복잡도)은 애플리케이션 검증 레이어에서 다루며 BCrypt 자체와는 별개다.

## 6. 면접 답변 3단계

1. **한 문장** — "TripTogether는 비밀번호를 평문으로 저장하지 않고, Spring Security의 `BCryptPasswordEncoder`로 단방향 해시해서 `USERS.user_password`에 저장합니다. 로그인 때는 복호화가 아니라 `matches()`로 비교합니다."
2. **왜** — "BCrypt는 사용자마다 다른 salt를 해시에 내장해 레인보우 테이블을 무력화하고, cost factor만큼 일부러 느리게 계산해 무차별 대입을 비싸게 만듭니다. 단방향이라 DB가 유출돼도 원래 비밀번호를 복원할 수 없습니다."
3. **어떻게** — "`BCryptConfig`에서 인코더를 빈으로 등록하고, `AuthServiceImpl`이 회원가입·재설정·변경에서 `encode`로 저장, 로그인·본인확인에서 `matches`로 검증합니다. 소셜 전용 계정은 `passwordEnabled` 플래그로 해시 비교를 건너뜁니다."

## 7. 꼬리질문 + 모범답안

:::details "왜 SHA-256 같은 일반 해시 대신 BCrypt인가요?"
SHA-256은 빠르게 설계된 범용 해시라 비밀번호에는 오히려 부적합합니다. 공격자가 GPU로 초당 수억 번 대입할 수 있고, salt를 직접 관리해야 합니다. BCrypt는 salt를 해시 문자열에 내장하고 cost factor로 의도적으로 느려서, 정상 로그인 1회 비용은 무시할 만하지만 대량 대입은 비현실적으로 비싸집니다. 그래서 비밀번호 전용 해시로 BCrypt를 씁니다.
:::

:::details "salt는 어디에 저장하나요? 별도 컬럼이 있나요?"
별도 컬럼이 없습니다. BCrypt 해시 문자열(`$2a$10$...`) 안에 버전·cost·salt·해시가 함께 들어 있습니다. 그래서 `matches`는 저장된 문자열 하나에서 salt와 cost를 읽어 입력값을 동일하게 재해시해 비교합니다. `USERS` 테이블에 salt 컬럼을 따로 두지 않는 이유입니다.
:::

:::details "같은 비밀번호인데 두 사용자의 해시가 다른 이유는?"
가입할 때마다 새 salt가 무작위로 생성돼 해시에 섞이기 때문입니다. 덕분에 같은 `1234`를 써도 DB에는 서로 다른 해시가 저장되고, 한 사람의 해시를 깨도 다른 사람에게 그대로 통하지 않으며, 두 사용자가 같은 비밀번호를 쓴다는 사실 자체가 DB에서 드러나지 않습니다.
:::

:::details "DB가 통째로 유출되면 비밀번호는 안전한가요?"
원문을 즉시 알아낼 수는 없습니다. 단방향이라 복호화가 불가능하고, salt가 내장돼 레인보우 테이블도 막힙니다. 다만 BCrypt도 절대 안전은 아니며, 약한 비밀번호는 cost를 감안해도 시간을 들이면 추측될 수 있습니다. 그래서 cost 상향·비밀번호 정책·유출 시 강제 재설정 같은 운영 대응을 함께 둡니다.
:::

:::details "소셜 로그인 사용자는 비밀번호 검증을 어떻게 하나요?"
하지 않습니다. 소셜 전용 계정은 `passwordEnabled=false`이고 `user_password`가 비어 있어, 로그인 흐름에서 `matches`를 호출하기 전에 `passwordEnabled`를 먼저 확인해 비밀번호 로그인을 차단합니다. 나중에 본인이 아이디/이메일 로그인을 추가하면 그때 비밀번호를 `encode`해 설정합니다.
:::

## 8. 직접 말해보기

- "비밀번호를 평문으로 저장하면 안 되는 이유와, BCrypt가 그걸 어떻게 막는지 30초로 설명해보세요." (단방향 + salt + cost)
- "로그인 검증이 '복호화'가 아니라 '재해시 후 비교'인 이유를 말해보세요." (`matches`가 저장된 salt/cost로 입력을 다시 해시)
- "같은 비밀번호인데 사용자마다 해시가 다른 이유를 한 줄로 말해보세요." (사용자별 무작위 salt 내장)

더 보기: [세션 / 쿠키](/glossary/session-cookie) · [OAuth](/glossary/oauth) · [CSRF](/glossary/csrf) · [DTO / VO](/glossary/dto-vo) | 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether가 회원가입 시 BCryptPasswordEncoder.encode()로 만든 결과를 저장하는 컬럼은?" :choices="['USERS.user_password (해시)', 'USERS.user_password (평문)', '별도 SALT 컬럼', 'JSESSIONID 쿠키']" :answer="0" explanation="encode()로 만든 단방향 해시가 USERS.user_password에 저장된다. 평문은 저장하지 않으며, salt는 별도 컬럼이 아니라 해시 문자열 안에 함께 들어간다." />

<QuizBox question="BCrypt에서 같은 비밀번호라도 사용자마다 해시 결과가 다른 이유는?" :choices="['cost factor가 매번 바뀌어서', '사용자마다 무작위 salt가 해시에 섞이기 때문', 'DB가 암호화돼 있어서', '로그인할 때마다 재암호화하기 때문']" :answer="1" explanation="가입할 때마다 무작위 salt가 생성돼 해시에 내장된다. 그래서 같은 비밀번호도 서로 다른 해시가 되고 레인보우 테이블 공격이 무력화된다." />

<QuizBox question="로그인 시 저장된 비밀번호 검증을 올바르게 설명한 것은?" :choices="['저장된 해시를 복호화해 입력과 비교한다', '입력값을 저장된 salt/cost로 다시 해시해 matches()로 비교한다', '평문끼리 직접 비교한다', '서버가 원래 비밀번호를 메일로 보내 확인한다']" :answer="1" explanation="BCrypt 해시는 단방향이라 복호화가 불가능하다. matches()는 저장된 문자열에서 salt와 cost를 읽어 입력값을 동일하게 재해시한 뒤 비교한다." />
