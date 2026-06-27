---
title: "이메일 인증·액션 토큰"
owner: A
domain: "인증·계정·보안"
tags: ["이메일", "토큰"]
---

# 이메일 인증·액션 토큰

> 이메일로 보낸 1회용 UUID 링크 하나로 아이디 찾기·비밀번호 재설정·프로필 이메일 인증을 모두 처리하고, 발급부터 사용까지 전 과정을 감사 로그로 남긴다.

이 페이지는 TripTogether 인증 도메인의 한 챕터다. 도메인 전체 지도는 [도메인 전체 개요](/domains), 담당자별 구성은 [담당별 보기](/by-area/), 요청이 인터셉터·서비스·메일을 거치는 큰 흐름은 [전체 흐름](/flow/)에서 본다.

## 1. 한 줄 정의

이메일 인증·액션 토큰은 "이 이메일 주소를 가진 사람만 누를 수 있는, 만료되고 1회만 쓰이는 비밀 링크"를 발급·발송·검증하는 메커니즘이다. 아이디 찾기(FIND_ID), 비밀번호 재설정(RESET_PW), 프로필 이메일 인증(PROFILE_EMAIL)이 모두 같은 토큰 골격을 공유한다.

## 2. 왜 이렇게 설계했나

여러 기능이 "이메일 소유 증명"이라는 같은 문제를 푼다. 각 기능마다 다른 토큰 테이블과 다른 발송 코드를 두면 만료·1회용·재요청 무효화 같은 보안 규칙이 제각각 어긋난다. 그래서 한 가지 토큰 모델로 통일했다.

설계의 핵심 결정 세 가지다.

- 토큰 값은 추측 불가능해야 한다. 순번이나 짧은 코드 대신 `UUID.randomUUID()` 문자열을 쓰고, 컬럼에 UNIQUE 제약을 걸어 충돌과 중복 사용을 막는다.
- 요청과 토큰을 두 테이블로 분리한다. 워크플로우 상태(요청됨→인증됨→반영됨)는 `EMAIL_VERIFICATION_REQUEST`가 맡고, 실제 발급된 링크 인스턴스는 `EMAIL_VERIFICATION`이 맡는다. 한 요청에서 토큰을 재발급해도 이력이 보존된다.
- 모든 단계를 감사한다. 발급(ISSUE)·검증(VERIFY)·완료(COMPLETE)·실패를 `USER_SECURITY_HISTORY`에 남겨, 누가 언제 어떤 이메일로 무엇을 시도했는지 사후 추적이 가능하다.

:::tip 왜 두 테이블인가
`EMAIL_VERIFICATION_REQUEST`는 헤더(요청 단위 상태 머신), `EMAIL_VERIFICATION`은 라인(발급된 토큰 그 자체)이라고 보면 된다. 사용자가 링크를 다시 보내달라고 하면 새 토큰 row가 쌓이고 옛 토큰은 무효화되지만, 같은 요청으로 묶여 흐름이 끊기지 않는다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

4계층 구조를 그대로 따른다: `AuthController` → `AuthService`/`AuthServiceImpl` → `AuthMapper`(@Mapper) → VO. 메일 발송은 Spring의 `JavaMailSender`를 쓴다.

| 구성요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 컨트롤러 | `AuthController` | `/find-id/send`, `/find-id/verify`, `/verify-email`, 비밀번호 재설정 엔드포인트 매핑 |
| 서비스 | `AuthServiceImpl` | UUID 생성, 만료 계산, 메일 발송, 검증·완료 처리 |
| 매퍼 | `AuthMapper` | 토큰 insert/조회/무효화, 보안 이력 기록 |
| 요청 VO | `EmailVerificationRequestVO` | `EMAIL_VERIFICATION_REQUEST` 매핑 (status 상태 머신) |
| 토큰 VO | `EmailVerificationVO` | `EMAIL_VERIFICATION` 매핑 (token/used/expired_at) |
| 감사 VO | `UserSecurityHistoryVO` | 발급·검증·완료 이벤트 단위 기록 |
| 컨텍스트 | `LoginRequestContext` | requestId, IP, User-Agent 운반 |

핵심 컬럼만 추리면 다음과 같다.

- `EMAIL_VERIFICATION`: `token`(UUID, UNIQUE), `purpose`, `expired_at`, `used`, `used_at`, `cancelled_at`, `request_id`, `flow_trace_id`
- `EMAIL_VERIFICATION_REQUEST`: `status`(REQUESTED / VERIFIED / APPLIED / EXPIRED / CANCELLED), `pending_email`, `verified_at`, `applied_at`, `ip_address`, `user_agent`

`purpose` 값은 코드에서 FIND_ID, RESET_PW, PROFILE_EMAIL 문자열로 다룬다. 만료 시간은 고정값이 아니라 런타임 설정에서 목적별로 읽고, 값이 없으면 기본 30분이다.

```java
// 목적별 TTL을 APPLICATION_RUNTIME_SETTING에서 읽고, 없으면 30분
int ttl = authEmailTokenTtlMinutes(purpose); // 기본값 30
LocalDateTime expiredAt = LocalDateTime.now().plusMinutes(ttl);
String token = UUID.randomUUID().toString();
```

## 4. 동작 원리 (흐름·표·작은 코드)

세 목적의 흐름이 거의 동일하다. 비밀번호 재설정을 예로 발급부터 실행까지 단계다.

1. 사용자가 식별자(아이디 또는 이메일)를 제출한다.
2. 같은 사용자·목적의 기존 요청과 토큰을 먼저 무효화한다 — `cancelActiveEmailVerificationRequests`, `expireOldTokens`. 옛 링크가 동시에 살아 있지 않게 한다.
3. 새 `requestId`(UUID)와 `flowTraceId`를 정하고, 새 `token`(UUID)과 `expiredAt`을 만들어 두 테이블에 insert한다.
4. `JavaMailSender`로 링크가 담긴 메일을 보낸다. 발송이 실패하면 방금 만든 요청과 토큰을 즉시 취소해 끊긴 링크가 남지 않게 한다.
5. ISSUE 단계를 `USER_SECURITY_HISTORY`에 기록한다.
6. 사용자가 링크를 누르면 `findValidToken(token, purpose)`로 토큰을 조회한다. 만료·사용됨·취소됨이면 거부하고 실패를 기록한다.
7. 유효하면 토큰을 사용 처리(used=1, used_at)하고 본 작업을 실행한다 — 비밀번호 재설정은 `BCryptPasswordEncoder`로 해시해 저장한다. COMPLETE를 기록한다.

토큰의 상태 전이를 한눈에 보면 다음과 같다.

| 상태 | 의미 | 트리거 |
| --- | --- | --- |
| 발급(REQUESTED) | 토큰 생성·메일 발송 완료 | 사용자 요청 |
| 만료 | expired_at 경과 | 시간 경과(조회 시 무효 판정) |
| 취소(CANCELLED) | 신규 요청 발급 등으로 무효화 | 재요청 / 발송 실패 |
| 사용(VERIFIED→APPLIED) | 링크 클릭·검증·본 작업 실행 | 사용자 클릭 |

검증 핵심 로직은 다음 형태다.

```java
EmailVerificationVO ev = authMapper.findValidToken(token, "RESET_PW");
if (ev == null) {
    // 만료/사용됨/취소됨/잘못된 토큰 → 실패 기록 후 거부
    return false;
}
authMapper.markTokenUsed(ev.getVerifyIdx());      // 1회용 보장
authMapper.resetPassword(ev.getUserIdx(), hashed); // 본 작업 실행
```

ID 찾기 힌트도 같은 토큰을 탄다. 사용자는 이메일만으로 요청하고, 링크를 눌러 이메일 소유를 증명한 뒤에야 가려진 아이디를 확인한다. 비회원이 미식별 이메일로 요청할 수 있으므로 토큰의 `user_idx`는 NULL을 허용한다. 응답은 가입 여부와 무관하게 동일하게 보여 계정 존재 여부가 노출되지 않게 한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 구현됨
- FIND_ID / RESET_PW / PROFILE_EMAIL 세 목적의 발급·발송·검증 전 과정
- UUID 토큰 + UNIQUE 제약, 목적별 TTL(기본 30분), 1회용 used 처리
- 재요청 시 기존 요청·토큰 무효화, 메일 발송 실패 시 즉시 취소(보상)
- requestId·flowTraceId로 묶인 전 생명주기 감사(`USER_SECURITY_HISTORY`)
- 요청/토큰 2테이블 분리와 status 상태 머신
- 비밀번호 BCrypt 해시 저장
:::

:::warning 한계·전제
- TTL은 목적별 런타임 설정이며 현재 기본값은 모두 30분이다. 24시간급 장기 토큰을 쓰려면 설정값을 올리면 되지만 기본 운영값은 30분이다.
- 메일 발송 자체는 SMTP 가용성에 의존한다. 발송 실패는 토큰 취소로 보상하지만 사용자에게는 재시도가 필요하다.
- 토큰 정리(만료 row 물리 삭제)는 별도 배치가 아니라 조회 시 무효 판정과 cascade 위주다. 대량 누적 시 정리 정책은 향후 과제다.
:::

## 6. 면접 답변 3단계

- 한 문장: 이메일 소유 증명이 필요한 기능들을 1회용·만료형 UUID 토큰 하나로 통일하고 전 과정을 감사 로그로 남깁니다.
- 한 단락: 아이디 찾기·비밀번호 재설정·프로필 이메일 인증이 같은 토큰 모델을 공유합니다. 요청 단위 상태는 EMAIL_VERIFICATION_REQUEST, 발급된 토큰은 EMAIL_VERIFICATION으로 분리해 재발급해도 이력이 보존됩니다. 발급 시 기존 토큰을 무효화하고, 만료·1회용을 검증 시점에 강제하며, 발급·검증·완료를 USER_SECURITY_HISTORY에 기록합니다.
- 더 깊게: requestId와 flowTraceId로 여러 요청을 한 흐름으로 묶어 추적성을 확보했고, 메일 발송 실패 시 토큰을 즉시 취소하는 보상 처리로 끊긴 링크를 남기지 않습니다. 비회원 ID 찾기는 user_idx NULL을 허용하되 응답을 균일화해 계정 존재 노출을 막습니다.

## 7. 꼬리질문 + 모범답안

:::details 토큰을 추측하기 어렵게 만든 방법은
순번이나 짧은 코드 대신 UUID 랜덤 문자열을 토큰 값으로 쓰고, 컬럼에 UNIQUE 제약을 걸어 충돌·중복 사용을 차단합니다. 검증은 token과 purpose를 함께 조건으로 조회해 다른 목적의 토큰이 교차 사용되지 않게 합니다.
:::

:::details 같은 사용자가 링크를 여러 번 요청하면
새 요청을 만들기 전에 cancelActiveEmailVerificationRequests와 expireOldTokens로 같은 사용자·목적의 기존 요청·토큰을 무효화합니다. 그래서 동시에 살아 있는 링크는 항상 가장 최근 것 하나뿐입니다.
:::

:::details 메일 발송이 실패하면 토큰은 어떻게 되나
발송 실패를 감지하면 방금 insert한 요청과 토큰을 즉시 취소(cancel)합니다. DB에는 토큰이 생겼지만 메일이 안 간 불일치 상태를 남기지 않기 위한 보상 처리이고, 실패도 보안 이력에 기록합니다.
:::

:::details 만료와 1회용은 어디서 강제되나
발급 시 expired_at을 LocalDateTime.now().plusMinutes(ttl)로 박아두고, 검증 시 findValidToken이 만료·used·cancelled를 모두 걸러냅니다. 본 작업을 실행하기 전 토큰을 used 처리해 같은 링크가 두 번 효력을 갖지 못하게 합니다.
:::

:::details 아이디 찾기에서 계정 존재 여부가 새지 않게 하려면
가입 여부와 무관하게 응답 메시지를 동일하게 유지하고, 식별 가능 여부와 별개로 메일 발송 흐름을 태웁니다. 토큰의 user_idx는 NULL을 허용해 비회원 요청도 같은 경로로 처리됩니다.
:::

## 8. 직접 말해보기

다음을 소리 내어 설명해 보자. 막히는 지점이 약한 부분이다.

- EMAIL_VERIFICATION_REQUEST와 EMAIL_VERIFICATION을 왜 나눴고 각각 무엇을 책임지는가
- 토큰 발급 → 메일 발송 → 클릭 → 검증 → 본 작업까지의 순서와 각 단계의 실패 처리
- 만료·1회용·재요청 무효화를 코드의 어느 시점에서 강제하는가
- requestId와 flowTraceId가 감사·추적에서 하는 역할
- 아이디 찾기에서 계정 존재 여부를 숨기는 이유와 방법

## 퀴즈

<QuizBox question="이메일 인증·액션 토큰에서 토큰 값으로 사용하는 것은 무엇인가" :choices="['짧은 6자리 숫자 코드', 'UUID 랜덤 문자열', '사용자 PK 순번', '이메일 주소의 해시']" :answer="1" explanation="순번이나 짧은 코드는 추측이 쉬우므로 UUID 랜덤 문자열을 토큰으로 쓰고 컬럼에 UNIQUE 제약을 건다." />

<QuizBox question="요청 단위 상태(요청됨에서 반영됨까지)를 추적하는 테이블은 무엇인가" :choices="['EMAIL_VERIFICATION', 'EMAIL_VERIFICATION_REQUEST', 'USER_SECURITY_HISTORY', 'USERS']" :answer="1" explanation="워크플로우 상태 머신은 EMAIL_VERIFICATION_REQUEST가 맡고, 발급된 토큰 인스턴스 자체는 EMAIL_VERIFICATION이 맡는다." />

<QuizBox question="메일 발송이 실패했을 때 시스템이 하는 처리로 옳은 것은 무엇인가" :choices="['토큰을 그대로 두고 사용자에게만 알린다', '토큰의 만료 시간을 늘린다', '방금 만든 요청과 토큰을 즉시 취소한다', '같은 토큰으로 자동 재발송한다']" :answer="2" explanation="DB에는 토큰이 있는데 메일은 안 간 불일치를 막기 위해 발송 실패 시 요청과 토큰을 즉시 취소하는 보상 처리를 한다." />
