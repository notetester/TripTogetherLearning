# 이메일 발송

> TripTogether는 `spring-boot-starter-mail`의 `JavaMailSender`로 SMTP 메일을 보내고, 이메일 인증·아이디 찾기·비밀번호 재설정을 **UUID 액션 토큰**(만료·1회용)으로 처리한다. 토큰은 `EMAIL_VERIFICATION_REQUEST`(요청 헤더)와 `EMAIL_VERIFICATION`(발급된 토큰 인스턴스) 두 테이블로 추적한다.

## 1. 한 줄 정의

회원이 직접 비밀번호를 모르는 상태에서도 본인 확인을 할 수 있도록, **이메일로 발송한 일회용 링크 토큰**을 통해 아이디 확인·비밀번호 재설정·이메일 인증을 수행하는 백엔드 기능이다.

## 2. 왜 이렇게 설계했나

이메일 기반 본인 확인은 "메일함에 접근할 수 있는 사람 = 계정 소유자"라는 가정을 활용한다. 이를 안전하게 만들기 위한 네 가지 설계 결정이 있다.

- **토큰을 추측 불가능하게**: 순번이나 짧은 코드 대신 `UUID`(122비트 랜덤)를 링크에 담아, URL을 무차별로 시도해도 맞출 수 없게 한다.
- **토큰을 짧게 살린다**: 발급 후 30분(기본값)만 유효하다. 메일이 유출되더라도 노출 시간을 제한한다.
- **1회용**: 한 번 검증·사용된 토큰은 즉시 `used` 처리해 재사용을 막는다. 새 요청이 들어오면 같은 사용자의 이전 토큰을 모두 무효화(cancel)한다.
- **계정 열거(enumeration) 방지**: "그 이메일은 가입되어 있지 않다" 같은 응답을 절대 주지 않는다. 컨트롤러는 가입 여부와 무관하게 항상 동일한 안내 문구를 반환하고, 실제 분기(성공/실패 사유)는 서버 내부 보안 이벤트 로그에만 남긴다.

또한 메일 발송은 외부 SMTP 서버에 의존하므로 **실패할 수 있는 작업**이다. 그래서 토큰을 먼저 DB에 적재하고 메일을 보낸 뒤, 발송이 실패하면 방금 만든 요청·토큰을 되돌리는(보상) 흐름을 둔다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 메일 전송 라이브러리 | `spring-boot-starter-mail` | SMTP 추상화 |
| 전송 API | `org.springframework.mail.javamail.JavaMailSender` | `MimeMessage` 생성·발송 |
| 메시지 빌더 | `MimeMessageHelper` | 수신자·제목·HTML 본문 세팅 |
| 발송 서비스 | `AuthServiceImpl` | `sendMail()` / `buildEmailHtml()` private 헬퍼 |
| 요청 헤더 VO | `EmailVerificationRequestVO` | 요청 단위 워크플로우 상태 |
| 토큰 VO | `EmailVerificationVO` | 발급된 개별 토큰 인스턴스 |
| 요청 헤더 테이블 | `EMAIL_VERIFICATION_REQUEST` | `purpose / status / pending_email / expired_at` |
| 토큰 테이블 | `EMAIL_VERIFICATION` | `token(UUID) / used / used_at / expired_at` |
| 매퍼 | `AuthMapper` | 토큰 삽입·조회·무효화·사용처리 |

핵심 발송 코드는 단순하다. HTML 본문을 `true`로 넘기는 것이 포인트다.

```java
// AuthServiceImpl.sendMail (요약)
var msg = mailSender.createMimeMessage();
var helper = new MimeMessageHelper(msg, false, "UTF-8");
helper.setFrom(mailFrom());          // 발신 주소 (런타임 설정 우선)
helper.setTo(to);
helper.setSubject(subject);
helper.setText(html, true);          // true = HTML 메일
mailSender.send(msg);                // 실패 시 catch → false 반환
```

SMTP 접속 정보는 `application.properties`의 `spring.mail.*`에 둔다. 운영 값은 자리표시자로만 표기한다.

```properties
spring.mail.host=MAIL_HOST          # 예: 사내/외부 SMTP 호스트
spring.mail.port=465                # SSL 포트
spring.mail.username=MAIL_USERNAME  # 발신 계정
spring.mail.password=MAIL_PASSWORD  # 앱 비밀번호 (절대 공개 금지)
spring.mail.properties.mail.smtp.auth=true
spring.mail.properties.mail.smtp.ssl.enable=true
```

:::warning 보안 주의
SMTP 호스트·계정·비밀번호, OAuth 클라이언트 시크릿 등은 절대 공개 저장소·문서에 노출하면 안 된다. 이 페이지의 값은 전부 `MAIL_HOST`, `MAIL_PASSWORD` 같은 자리표시자다. 실제 키는 외부 설정·시크릿 관리로 분리한다. → [설정·시크릿 관리](/infra/secrets-config)
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### 두 테이블의 역할 분리

| 테이블 | 비유 | 저장 내용 |
| --- | --- | --- |
| `EMAIL_VERIFICATION_REQUEST` | 요청서(헤더) | `purpose`, `pending_email`, `status`, `requested_at`, `ip_address`, `user_agent` |
| `EMAIL_VERIFICATION` | 발급된 링크(토큰) | `token`(UUID), `used`, `used_at`, `expired_at`, `purpose` |

요청 하나당 토큰 하나가 보통이지만, 구조상 한 요청 헤더가 여러 토큰을 가리킬 수 있도록 FK(`email_verification_request_idx`)로 연결한다. 동일 흐름을 가로지르는 추적용으로 `flow_trace_id`, 요청 단위 식별용으로 `request_id`(둘 다 UUID)를 함께 남긴다.

### `purpose` 종류

| purpose | 트리거 화면 | 검증 후 동작 |
| --- | --- | --- |
| `PROFILE_EMAIL` | 회원정보 수정에서 이메일 인증 | 이메일을 인증 상태로 표시(저장은 별도) |
| `FIND_ID` | 아이디 찾기 | 마스킹된 아이디 힌트 노출 |
| `RESET_PW` | 비밀번호 재설정 | 새 비밀번호 입력 화면으로 |
| `VERIFY` | 회원가입 직후 이메일 검증 | 이메일을 `verified`로 업데이트 |

### 발송 흐름 (비밀번호 재설정 예)

```text
[사용자] 비밀번호 찾기 입력
   │  POST /auth/find-pw/send  (identifier = 아이디 또는 이메일)
   ▼
AuthServiceImpl.sendResetPasswordEmail()
   1) 사용자 조회 + 정책 검사(이메일 인증됨? 복구 가능 상태?)
   2) 같은 사용자의 RESET_PW 이전 토큰 전부 cancel/expire
   3) token = UUID.randomUUID()  /  expiredAt = now + 30분
   4) EMAIL_VERIFICATION_REQUEST(status=REQUESTED) insert
   5) EMAIL_VERIFICATION insert
   6) sendMail(...) → baseUrl + "/auth/reset-pw?token=" + token
   7) 발송 실패 시 4)·5) 보상 취소
   ▼
[사용자] 메일의 "비밀번호 재설정하기" 클릭
   │  GET /auth/reset-pw?token=...
   ▼
verifyResetToken(): findValidToken(token, "RESET_PW")
   → 유효(만료 전·미사용)하면 새 비밀번호 입력 화면
   ▼
resetPassword(): markTokenUsed() + BCrypt 해시 저장
```

### 요청 상태 머신

`EMAIL_VERIFICATION_REQUEST.status`는 다음을 따른다.

```text
REQUESTED ──(링크 클릭·검증)──▶ VERIFIED ──(실제 반영)──▶ APPLIED
   │                                                       
   ├──(30분 경과)──────────────────────────────▶ EXPIRED
   └──(새 요청 발급 등)──────────────────────────▶ CANCELLED
```

### 메일 발송 실패 시 보상

메일 전송은 네트워크/SMTP 사정으로 실패할 수 있다. 그래서 토큰을 먼저 적재한 뒤, 실패하면 되돌린다.

```java
boolean sent = sendMail(to, subject, buildEmailHtml(...));
if (!sent) {
    authMapper.cancelEmailVerificationRequest(request.getEmailVerificationRequestIdx());
    authMapper.cancelTokensByRequestId(requestId);   // 발급했던 토큰 무효화
}
// 성공/실패 모두 보안 이벤트 로그에 기록 (MAIL_SEND_FAILED 등)
```

### 런타임 설정으로 덮어쓰기

발신 주소·서비스 base URL·토큰 만료 시간은 코드 상수가 아니라 **DB 런타임 설정 우선**으로 읽는다. 운영 중 재배포 없이 값을 바꿀 수 있다.

```java
private String baseUrl() { return runtimeSetting("app.base-url", baseUrl); }
private int authEmailTokenTtlMinutes(String purpose) {
    return switch (purpose) {
        case "FIND_ID"      -> runtimeSettingInt("auth.email.find-id-token-ttl-minutes", 30);
        case "RESET_PW"     -> runtimeSettingInt("auth.email.reset-password-token-ttl-minutes", 30);
        case "PROFILE_EMAIL"-> runtimeSettingInt("auth.email.profile-email-token-ttl-minutes", 30);
        default             -> runtimeSettingInt("auth.email.default-token-ttl-minutes", 30);
    };
}
```

→ 자세한 우선순위는 [런타임 설정 (DB 우선)](/backend/runtime-settings) 참고.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| SMTP HTML 메일 발송(`JavaMailSender`) | 구현됨 |
| 이메일 인증(`PROFILE_EMAIL` / `VERIFY`) | 구현됨 |
| 아이디 찾기(`FIND_ID`) | 구현됨 |
| 비밀번호 재설정(`RESET_PW`) | 구현됨 |
| UUID 토큰 만료(30분)·1회용·무효화 | 구현됨 |
| 발송 실패 보상(토큰 취소) | 구현됨 |
| 계정 열거 방지(동일 응답) | 구현됨 |
| 런타임 설정으로 만료·base URL 조정 | 구현됨 |
| 발송 큐/재시도(비동기 워커) | 미구현 — 동기 발송, 실패 시 보상만 |
| 메일 템플릿 다국어 본문 | 부분 — 제목/문구는 한국어 위주 |

:::tip 정직한 한계
메일 발송은 현재 **요청 스레드에서 동기 처리**된다. SMTP가 느리면 그만큼 응답이 지연된다. 별도 발송 큐·재시도 백오프·전송 결과 영구 추적(bounce 처리)은 향후 과제다. 다만 발송 실패 시 토큰을 되돌리는 보상은 이미 있어, "토큰만 있고 메일은 안 온" 유령 상태는 막는다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "이메일 인증·아이디 찾기·비밀번호 재설정을 `spring-boot-starter-mail`로 SMTP 메일을 보내고, 본인 확인은 UUID 일회용·만료 토큰으로 처리합니다."
2. **설계 의도**: "토큰을 추측 불가능한 UUID로 만들고 30분 만료·1회용으로 제한했습니다. 새 요청이 오면 이전 토큰을 무효화하고, 계정 열거를 막으려고 가입 여부와 무관하게 동일한 안내를 응답합니다."
3. **운영 견고함**: "메일 발송은 실패할 수 있는 외부 작업이라, 토큰을 먼저 적재하고 발송 실패 시 요청·토큰을 보상 취소합니다. 요청 헤더(`EMAIL_VERIFICATION_REQUEST`)와 토큰(`EMAIL_VERIFICATION`)을 분리해 상태 머신(REQUESTED→VERIFIED→APPLIED)을 추적합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 토큰을 두 테이블로 나눴나요?
요청의 워크플로우 상태(누가·언제·어떤 목적으로 요청했고 지금 어느 단계인지)와, 실제로 발급된 링크 토큰(값·만료·사용 여부)은 수명과 책임이 다릅니다. `EMAIL_VERIFICATION_REQUEST`는 요청 헤더로 `status`·`ip_address`·`user_agent`를 들고, `EMAIL_VERIFICATION`은 토큰 인스턴스로 `used`·`used_at`을 듭니다. FK로 연결해 한 요청이 여러 토큰을 가리킬 수 있게 확장성도 확보했습니다.
:::

:::details Q2. 토큰 만료·1회용은 어떻게 강제하나요?
조회 자체가 게이트입니다. `findValidToken(token, purpose)`는 만료 전·미사용·해당 purpose인 토큰만 돌려줍니다. 검증/사용 시점에 `markTokenUsed()`로 `used`·`used_at`을 찍어 재사용을 막고, 새 요청이 발급되면 같은 사용자의 이전 토큰을 일괄 cancel/expire 합니다. 만료 시각은 발급 시 `now + TTL(기본 30분)`로 박습니다.
:::

:::details Q3. 가입 안 된 이메일로 비밀번호 재설정을 요청하면요?
컨트롤러는 항상 "일치하는 계정이 있으면 안내 메일을 보냈다"는 동일한 메시지를 반환합니다. 사용자 없음·이메일 미인증·복구 불가 상태 등 실제 분기는 서버 내부 보안 이벤트 로그에만 사유 코드로 남깁니다. 응답 차이로 가입 여부를 알아내는 계정 열거 공격을 막기 위함입니다.
:::

:::details Q4. 메일이 안 보내졌는데 토큰만 DB에 남으면 어떻게 되나요?
그 상태를 막는 보상 로직이 있습니다. `sendMail()`이 `false`를 반환하면 방금 insert한 `EMAIL_VERIFICATION_REQUEST`와 `EMAIL_VERIFICATION` 토큰을 `cancelEmailVerificationRequest`·`cancelTokensByRequestId`로 무효화합니다. 그리고 `MAIL_SEND_FAILED` 사유로 보안 이벤트를 남겨 운영에서 추적할 수 있게 합니다.
:::

:::details Q5. HTML 메일은 어떻게 만드나요? XSS 위험은요?
`MimeMessageHelper.setText(html, true)`로 HTML 본문을 보냅니다. 본문은 `buildEmailHtml(title, desc, link, btnText)`가 Java 텍스트 블록에 인라인 스타일로 조립합니다. 본문에 들어가는 동적 값은 우리가 생성한 제목·안내 문구·토큰 링크뿐이고, 사용자 자유 입력을 그대로 끼우지 않으므로 표면은 좁습니다(사용자 입력을 본문에 넣어야 한다면 별도 이스케이프가 필요합니다).
:::

## 8. 직접 말해보기

다음을 막힘 없이 설명할 수 있으면 충분합니다.

- "UUID 액션 토큰"이 무엇이고, 왜 순번/짧은 코드가 아니라 UUID인지
- 토큰의 세 가지 안전장치(만료·1회용·신규 발급 시 이전 무효화)
- 계정 열거를 막기 위해 컨트롤러 응답을 어떻게 통일했는지
- 메일 발송 실패 시 보상 흐름과, 그것이 막아주는 "유령 토큰" 상태
- `EMAIL_VERIFICATION_REQUEST`와 `EMAIL_VERIFICATION`의 책임 차이

연관 주제: [이메일 인증·액션 토큰](/auth/email-verification-token) · [비밀번호 해싱(BCrypt)](/auth/password-bcrypt) · [런타임 설정(DB 우선)](/backend/runtime-settings) · 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="비밀번호 재설정 링크에 담기는 토큰의 형태와 기본 만료 시간으로 옳은 것은?" :choices="['6자리 숫자 OTP, 5분', 'UUID(랜덤), 30분', '사용자 PK 기반 순번, 무제한', 'JWT 액세스 토큰, 1시간']" :answer="1" explanation="AuthServiceImpl는 token = UUID.randomUUID()로 생성하고, expiredAt = now + 30분(기본 TTL, 런타임 설정으로 조정 가능)으로 만료를 둡니다." />

<QuizBox question="가입되지 않은 이메일로 아이디 찾기를 요청했을 때 컨트롤러의 응답으로 옳은 것은?" :choices="['그 이메일은 가입되어 있지 않다고 명시한다', '가입 여부와 무관하게 동일한 안내 문구를 반환한다', 'HTTP 404를 반환한다', '관리자에게만 사유를 푸시한다']" :answer="1" explanation="계정 열거(enumeration)를 막기 위해, 가입 여부·실패 사유와 무관하게 항상 동일한 안내를 반환하고 실제 분기는 서버 내부 보안 이벤트 로그에만 남깁니다." />

<QuizBox question="이메일 발송 요청을 추적하는 두 테이블의 역할을 각각 한 줄로 설명하시오. (주관식)" explanation="EMAIL_VERIFICATION_REQUEST는 요청 헤더로 purpose·pending_email·status(REQUESTED→VERIFIED→APPLIED)·ip/user_agent 등 워크플로우 상태를 저장하고, EMAIL_VERIFICATION은 그 요청으로 발급된 개별 UUID 토큰 인스턴스(token·used·used_at·expired_at)를 저장합니다. FK로 연결됩니다." />
