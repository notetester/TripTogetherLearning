---
title: "계정 복구·휴면"
owner: A
domain: "인증·계정·보안"
tags: ["휴면", "복구"]
---

# 계정 복구·휴면

> 장기 미접속 계정을 배치로 휴면 전환하고, 로그인 시 본인 확인으로 즉시 복구하며, 이메일 소유 증명만으로 아이디 찾기와 비밀번호 재설정을 안전하게 처리한다.

이 페이지는 TripTogether 인증 도메인의 한 챕터다. 도메인 전체 지도는 [도메인 전체 개요](/domains), 담당자별 구성은 [담당별 보기](/by-area/), 요청이 인터셉터와 서비스를 거치는 큰 흐름은 [전체 흐름](/flow/)에서 본다. 토큰 발급 골격은 [이메일 인증·액션 토큰](/auth/email-verification-token) 페이지와 같은 인프라를 공유한다.

## 1. 한 줄 정의

계정 복구·휴면은 세 가지 회복 시나리오를 묶은 묶음이다. (1) 오래 안 들어온 계정을 자동으로 잠그는 **휴면 자동전환**, (2) 휴면 계정을 로그인 시점에 본인 확인으로 되살리는 **휴면 복구**, (3) 로그인 정보를 잊은 사용자를 위한 **이메일 기반 아이디 찾기와 비밀번호 재설정**.

## 2. 왜 이렇게 설계했나

오래된 계정이 살아 있는 채로 방치되면 탈취 시 피해가 크다. 그래서 일정 기간 미접속이면 자동으로 휴면 상태로 내려, 정상 로그인 경로를 막고 한 번 더 본인 확인을 거치게 한다. 동시에 휴면이 영구 박탈이 아니라 "되살릴 수 있는 잠금"이어야 하므로, 삭제하지 않고 상태 컬럼만 바꾸는 소프트 전환을 택했다.

설계의 핵심 결정 네 가지다.

- **자동전환은 정책 배치로 분리한다.** 휴면 판정은 사용자 요청 흐름이 아니라 주기 스케줄러가 백그라운드에서 처리한다. 그래야 로그인 같은 실시간 경로가 무거워지지 않는다.
- **휴면은 상태 변경일 뿐 데이터 삭제가 아니다.** account_status 컬럼만 DORMANT로 바꾸고 dormant_at으로 시각을 남긴다. 복구하면 ACTIVE로 되돌아가고 본문 데이터는 그대로다.
- **계정 정보 노출을 막는 모호 응답을 쓴다.** 아이디 찾기와 비밀번호 재설정은 입력 이메일이 존재하든 아니든 같은 안내 문구를 반환한다. 가입 여부를 외부에서 캐낼 수 없게 한다.
- **모든 복구 단계를 감사한다.** 휴면 전환과 해제, 아이디 찾기, 비밀번호 재설정의 각 단계를 USER_SECURITY_HISTORY에 남긴다.

:::tip 휴면과 차단은 다르다
DORMANT는 미접속으로 인한 회복 가능한 잠금이고, BLOCKED는 제재로 인한 차단이다. 로그인 시 두 상태를 분기해서 처리하며, 휴면만 사용자가 스스로 즉시 해제할 수 있다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

4계층 구조를 그대로 따른다. 컨트롤러가 입력을 받고, 서비스가 판정과 상태 전환을, 매퍼가 SQL을 담당한다.

| 구성요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 스케줄러 | `DormantAccountScheduler` | `@Scheduled(fixedDelay=300000)` 5분 주기로 정책 배치 트리거 |
| 정책 서비스 | `AdminPolicyServiceImpl` | DORMANT_ACCOUNT_POLICY 도래 시 inactiveDays 전달 호출 |
| 서비스 | `AuthServiceImpl` | 휴면 후보 조회, 휴면 전환, 휴면 해제, 아이디 찾기, 비밀번호 재설정 |
| 컨트롤러 | `AuthController` | `/auth/dormant/release`, `/auth/find-id/*`, `/auth/find-pw/*`, `/auth/reset-pw` |
| 매퍼 | `AuthMapper` | findDormantCandidates, markUserDormant, releaseDormantUser, resetPassword |
| 사용자 VO | `UsersVO` | account_status, dormant_at, last_login_at 매핑 |
| 토큰 VO | `EmailVerificationVO` | FIND_ID, RESET_PW 목적의 1회용 토큰 |
| 감사 VO | `UserSecurityHistoryVO` | 복구 이벤트 단계별 기록 |
| 요청 컨텍스트 | `LoginRequestContext` | requestId, IP, User-Agent 운반 |

핵심 테이블은 USERS(account_status, dormant_at, dormant_release_required, last_login_at, status_changed_at), EMAIL_VERIFICATION과 EMAIL_VERIFICATION_REQUEST(purpose가 FIND_ID 또는 RESET_PW인 토큰), USER_SECURITY_HISTORY(event_type, event_stage, is_success, fail_reason)다.

## 4. 동작 원리 (흐름·표·작은 코드)

**휴면 자동전환.** 스케줄러가 정책 배치를 깨우면, 미접속 기준일 이전 마지막 로그인 계정을 한꺼번에 찾아 DORMANT로 바꾼다. 기준은 last_login_at이 없으면 created_at으로 폴백한다.

```sql
-- findDormantCandidates: 마지막 로그인이 cutoff 이전인 활성 계정
SELECT * FROM USERS
WHERE account_status = ACTIVE
  AND COALESCE(last_login_at, created_at) <= cutoff

-- markUserDormant: 휴면 전환 (전환 시각·해제필요 플래그 기록)
UPDATE USERS
SET account_status = DORMANT, dormant_at = NOW(),
    dormant_release_required = TRUE, status_changed_at = NOW()
WHERE user_idx = userIdx AND account_status = ACTIVE
```

기준 일수는 운영 설정에서 읽고 기본 365일이며, 코드상 최소 1일로 정규화된다.

**휴면 복구.** 로그인은 비밀번호 검증까지는 통과시키되, 계정 상태가 DORMANT면 세션에 임시로 대상 식별자를 담고 정상 로그인 대신 해제 안내를 돌려준다.

| 단계 | 처리 | 결과 |
| --- | --- | --- |
| 비밀번호 검증 통과 | account_status 확인 | DORMANT면 분기 |
| 휴면 분기 | 세션에 dormantPendingUserIdx 저장 | dormantReleaseRequired 응답 |
| 해제 요청 | releaseDormantUser 호출 | ACTIVE 복구, 세션에 로그인 처리 |

```sql
-- releaseDormantUser: ACTIVE 복구 + 마지막 로그인 갱신
UPDATE USERS
SET account_status = ACTIVE, dormant_at = NULL,
    dormant_release_required = FALSE,
    status_changed_at = NOW(), last_login_at = NOW()
WHERE user_idx = userIdx
```

**아이디 찾기.** 이메일을 입력받아 가입 여부와 이메일 인증 여부, 복구 가능 상태인지 검사한다. 통과하면 purpose가 FIND_ID인 1회용 토큰을 발급해 메일로 보내고, 사용자가 링크를 누르면 토큰을 검증한 뒤 **마스킹된 아이디 힌트**를 보여준다. 아이디 전체를 그대로 노출하지 않는다.

**비밀번호 재설정.** 입력값에 골뱅이가 있으면 이메일로, 없으면 아이디로 조회한다. RESET_PW 토큰을 발급하고, 링크 검증 후 새 비밀번호를 BCrypt로 해싱해 저장하며 토큰은 사용 처리한다.

:::warning 복구 가능 상태 가드
아이디 찾기와 비밀번호 재설정은 DELETED와 BLOCKED 계정을 거부한다. 삭제되었거나 제재 중인 계정은 이메일 소유 증명만으로 되살아나면 안 되기 때문이다. 반면 DORMANT는 복구 가능 상태로 본다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: 휴면 자동전환 배치(5분 주기 스케줄러 + DORMANT_ACCOUNT_POLICY 연동), 로그인 시 휴면 분기와 즉시 해제, 이메일 기반 아이디 찾기(마스킹 힌트), 비밀번호 재설정(BCrypt 재해싱), 전 단계 감사 로그, 모호 응답으로 계정 존재 여부 은닉.
- **됨**: 기준 일수와 토큰 만료 시간을 운영 설정에서 동적으로 읽음(기본 휴면 365일, 토큰 TTL 30분). 메일 발송 실패 시 발급 토큰과 요청을 취소하는 롤백.
- **계획/한계**: 휴면 전환 전 사전 안내 메일(전환 임박 통지)은 별도 구성이 필요하고 이 흐름 자체에는 없다. 비밀번호 재설정에 휴면 가드는 추상화돼 있으나, 추가 본인 확인 요소(예: 2차 인증) 결합은 향후 과제다.

## 6. 면접 답변 3단계

1. **한 줄**: 오래 안 쓴 계정은 배치로 휴면 처리하고, 로그인 시 본인 확인으로 되살리며, 아이디와 비밀번호는 이메일 소유 증명으로만 안전하게 복구합니다.
2. **설계 이유**: 휴면은 삭제가 아니라 회복 가능한 잠금이라 상태 컬럼만 바꾸고, 자동 판정은 실시간 경로를 무겁게 하지 않도록 스케줄러로 분리했습니다. 계정 존재 여부 노출을 막으려고 응답을 모호하게 통일했습니다.
3. **구현 근거**: AuthServiceImpl이 휴면 후보 조회와 전환, 해제, 토큰 발급을 담당하고, DormantAccountScheduler가 정책 배치를 주기 호출하며, 모든 단계가 USER_SECURITY_HISTORY에 기록됩니다.

## 7. 꼬리질문 + 모범답안

:::details 휴면 판정을 로그인할 때 즉석에서 하지 않고 왜 배치로 돌리나요
로그인은 지연에 민감한 경로입니다. 매 로그인마다 전체 미접속 계정을 스캔하면 불필요한 부하가 생기고, 판정 책임이 흩어집니다. 배치는 기준일 이전 계정을 한 번에 처리해 일관되게 상태를 맞추고, 로그인은 이미 바뀐 account_status만 확인하면 됩니다.
:::

:::details 아이디 찾기에서 가입 안 된 이메일을 넣으면 어떻게 되나요
가입 여부와 무관하게 동일한 안내 문구를 반환합니다. 내부적으로는 이메일 미존재, 이메일 미인증, 복구 불가 상태를 각각 실패 사유로 감사 로그에 남기지만, 사용자에게 보이는 응답은 같습니다. 공격자가 응답 차이로 회원 이메일을 수집하는 열거 공격을 막기 위함입니다.
:::

:::details 찾은 아이디를 그대로 보여주지 않고 마스킹하는 이유는요
링크를 누른 사람이 메일 수신자 본인이라는 보장이 100퍼센트는 아니기 때문입니다. 마스킹 힌트는 본인이 기억을 떠올리기에는 충분하지만, 제3자가 전체 아이디를 가져가기에는 부족합니다. 길이에 따라 앞뒤 일부만 남기고 가운데를 별표로 가립니다.
:::

:::details 비밀번호 재설정 토큰을 재사용할 수 있나요
없습니다. 토큰은 검증 시 사용 처리되고 만료 시각이 지나면 무효입니다. 새로 요청하면 같은 목적의 이전 활성 요청과 토큰을 먼저 무효화한 뒤 새 토큰을 발급합니다. 1회용과 만료가 함께 걸려 있어 재사용과 오래된 링크 사용을 모두 차단합니다.
:::

:::details 휴면 해제와 차단 해제는 무엇이 다른가요
휴면 해제는 사용자가 로그인 시점에 스스로 즉시 할 수 있고, account_status를 ACTIVE로 되돌리며 마지막 로그인 시각을 갱신합니다. 차단은 제재이므로 사용자가 임의로 풀 수 없고 별도 이의신청 워크플로우를 거칩니다. 코드에서도 DORMANT와 BLOCKED를 다른 분기로 처리합니다.
:::

## 8. 직접 말해보기

- 휴면 자동전환의 트리거(스케줄러)와 판정 기준(마지막 로그인 폴백)을 한 문장으로 설명해 보자.
- 아이디 찾기와 비밀번호 재설정이 계정 존재 여부를 숨기는 방식을, 응답 문구와 감사 로그를 나눠 말해 보자.
- DORMANT, BLOCKED, DELETED 세 상태에서 복구가 허용되는 경우와 막히는 경우를 비교해 말해 보자.

## 퀴즈

<QuizBox question="휴면 자동전환에서 마지막 로그인 정보가 없는 계정의 기준 시각은 무엇으로 폴백하나요?" :choices="['가입 시각 created_at', '항상 휴면 처리 안 함', '현재 시각', '상태 변경 시각 status_changed_at']" :answer="0" explanation="findDormantCandidates 쿼리는 COALESCE(last_login_at, created_at)를 기준일과 비교한다. 즉 한 번도 로그인하지 않아 last_login_at이 없으면 가입 시각으로 판정한다." />

<QuizBox question="아이디 찾기에서 존재하지 않는 이메일을 입력했을 때 시스템의 응답 방식으로 옳은 것은?" :choices="['존재하지 않는다고 명시 안내', '가입 여부와 무관하게 동일한 안내 문구 반환', '에러 코드 404 반환', '관리자에게만 결과 통지']" :answer="1" explanation="계정 열거 공격을 막기 위해 이메일 존재 여부와 상관없이 같은 안내를 반환한다. 실패 사유는 감사 로그에만 남고 사용자 응답에는 드러나지 않는다." />

<QuizBox question="이메일 기반 복구가 거부되는 계정 상태를 모두 고른 표현으로 옳은 것은?" :choices="['ACTIVE와 DORMANT', 'DELETED와 BLOCKED', 'DORMANT만', '모든 상태 허용']" :answer="1" explanation="isRecoverableAccountStatus는 DELETED와 BLOCKED를 거부한다. 삭제되었거나 제재 중인 계정은 이메일 소유 증명만으로 되살아나면 안 되기 때문이며, DORMANT는 복구 가능 상태로 본다." />
