---
title: "회원 360 뷰"
owner: A
domain: "관리자·운영"
tags: ["회원"]
---

# 회원 360 뷰

> 한 회원의 프로필, 3원 지갑, 소셜 연동, 로그인 이력, 최근 활동, 차단 이력을 단일 화면에 모아 보고, 그 자리에서 프로필 수정·등급/상태 제어까지 끝내는 운영자 단일 뷰.

## 1. 한 줄 정의

회원 360 뷰는 한 명의 `userIdx`를 기준으로 흩어진 여러 테이블을 하나의 응답으로 합쳐(`getMemberContext`) 보여주고, 같은 화면에서 프로필 수정·이메일 변경·상태 전환(ACTIVE/DORMANT/BLOCKED/DELETED)을 즉시 실행할 수 있게 한 관리자 상세 화면이다.

## 2. 왜 이렇게 설계했나

운영자가 한 회원을 판단하려면 여러 정보를 동시에 봐야 한다. 프로필만으로는 부족하고, 로그인 실패가 몰리는지, 차단 이력이 있는지, 최근 어떤 활동을 했는지, 소셜 계정이 몇 개 붙어 있는지가 함께 보여야 신고 처리나 차단 결정을 내릴 수 있다.

- **탭을 옮겨 다니는 비용 제거.** 회원 목록 → 로그인 로그 → 차단 내역 → 지갑을 따로 열면 맥락이 끊긴다. 360 뷰는 이 조각들을 한 번의 조회로 묶는다.
- **조회와 제어의 결합.** 보는 화면과 조치하는 화면이 분리되면 운영이 느려진다. 같은 화면에서 등급·상태를 바꾸게 해 의사결정과 실행 사이 지연을 줄인다.
- **읽기 모델과 쓰기 모델의 분리.** 조회는 여러 테이블을 JOIN/집계한 읽기 전용 뷰(`AdminMemberVO`)로, 제어는 좁은 단일 UPDATE로 나눠 각각 단순하게 유지한다.

:::tip
360 뷰는 "한 화면에서 사람을 통째로 본다"는 운영 패턴이다. CRM의 고객 단일 뷰와 같은 발상으로, 핵심은 데이터 합치기보다 합친 뒤 즉시 조치할 수 있게 만드는 데 있다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 역할 | 구현체 |
| --- | --- |
| 컨트롤러 | `AdminController` — `GET /admin/members/{userIdx}`(상세), `POST .../profile`·`.../email`·`.../status`, `POST /admin/members/bulk/status`, `GET /admin/members/export` |
| 서비스 | `AdminServiceImpl.getMemberContext` / `updateMemberProfile` / `updateMemberEmail` / `changeMemberStatus` / `bulkChangeMemberStatus` |
| 매퍼 | `AdminMapper` + `adminMapper.xml`(`findMemberDetail`, `findLoginHistory`, `findActivityLogsByUser`, `findRecentUserBlocksByUser` 등) |
| 읽기 VO | `AdminMemberVO`(프로필 + 3원 지갑 + 레벨/경험치 + 집계 컬럼), `AdminUserBlockVO`, `AdminActivityLogVO` |
| 주요 테이블 | `USERS`, `USER_SOCIAL`, `USER_LOGIN_HISTORY`, `USER_ACTIVITY_LOG`, `USER_BLOCK_HISTORY`, `EMAIL_VERIFICATION`, `EMAIL_VERIFICATION_REQUEST` |

상세 화면이 합쳐 보여주는 데이터 묶음:

| 묶음 | 출처 | 비고 |
| --- | --- | --- |
| 기본 프로필 | `USERS` | 닉네임·국적·선호언어·계정상태·권한(`user_role`)·등급(`member_grade`) |
| 3원 지갑 | `USERS` 캐시 컬럼 | `cash_balance` / `mileage_balance` / `point_balance` |
| 레벨·경험치 | `USERS` | `level_no` / `exp_points` |
| 소셜 연동 | `USER_SOCIAL` | 연동 수 `social_count`, 연동 제공자 목록 `linked_providers`(예: KAKAO,NAVER) |
| 로그인 통계 | `USER_LOGIN_HISTORY` | 최근 로그인 시각·방법, 성공/실패 횟수 |
| 최근 활동 | `USER_ACTIVITY_LOG` | 요청 URI·도메인·결과 상태 최근 40건 |
| 차단 이력 | `USER_BLOCK_HISTORY` | 최근 차단/해제 내역 |
| 이메일 인증 | `EMAIL_VERIFICATION(_REQUEST)` | 인증 요청·토큰 이력 |

## 4. 동작 원리 (흐름·표·작은 코드)

### 조회 — 흩어진 테이블을 한 응답으로

`getMemberContext`는 회원 한 명을 기준으로 여러 매퍼 호출 결과를 하나의 맵에 담아 돌려준다.

```java
// AdminServiceImpl.getMemberContext (요지)
AdminMemberVO member = adminMapper.findMemberDetail(userIdx);
if (member == null) return null;                 // 없는 회원이면 컨트롤러가 404 메시지 응답

Map<String, Object> result = new HashMap<>();
result.put("member", member);                                          // USERS + 집계 JOIN
result.put("history", adminMapper.findLoginHistory(userIdx, 50));      // 로그인 이력
result.put("securityAudits", adminMapper.findSecurityAuditsByUser(userIdx, 40));
result.put("activityLogs", adminMapper.findActivityLogsByUser(userIdx, 40));
result.put("recentBlocks", adminMapper.findRecentUserBlocksByUser(userIdx, 20));
// emailRequests, emailTokens, chatbotLinkClicks ... 동일 패턴
return result;
```

핵심은 `findMemberDetail` 한 쿼리에서 소셜 수와 로그인 통계까지 서브쿼리로 묶어 가져온다는 점이다. 활동·차단·이메일 같은 시계열 목록만 별도 조회한다.

```sql
-- findMemberDetail (요지): USERS에 소셜 집계와 로그인 통계를 LEFT JOIN
SELECT u.*, IFNULL(s.social_count, 0) AS social_count, s.linked_providers,
       COALESCE(u.last_login_at, h.last_login_at) AS last_login_at,
       h.last_login_method,
       IFNULL(h.login_success_count, 0) AS login_success_count,
       IFNULL(h.login_fail_count, 0)   AS login_fail_count
FROM USERS u
LEFT JOIN ( SELECT user_idx, COUNT(*) AS social_count,
                   GROUP_CONCAT(provider) AS linked_providers
            FROM USER_SOCIAL GROUP BY user_idx ) s ON u.user_idx = s.user_idx
LEFT JOIN ( ... USER_LOGIN_HISTORY 성공/실패 집계 ... ) h ON u.user_idx = h.user_idx
WHERE u.user_idx = #{userIdx}
```

### 제어 — 좁은 단일 작업

| 액션 | 엔드포인트 | 효과 |
| --- | --- | --- |
| 프로필 수정 | `POST /admin/members/{userIdx}/profile` | 닉네임·국적·선호언어를 정규화 후 `UPDATE USERS` |
| 이메일 변경 | `POST /admin/members/{userIdx}/email` | 중복 검사 후 변경, 동시에 email_verified=FALSE 및 email_login_enabled=FALSE로 초기화 |
| 상태 변경 | `POST /admin/members/{userIdx}/status` | ACTIVE / DORMANT / BLOCKED / DELETED 전환 |
| 일괄 상태 | `POST /admin/members/bulk/status` | 선택 회원 다건 상태 변경 |
| 내보내기 | `GET /admin/members/export` | 검색결과·선택·전체를 CSV 또는 Excel로 |

상태 전환은 단순 컬럼 변경이 아니라 부수효과를 동반한다. 특히 ACTIVE 복구는 차단을 푸는 복합 동작이다.

```text
status = ACTIVE   → 활성 IP 차단·블록 해제, 휴면 해제, 상태를 ACTIVE로
                    이전 상태가 BLOCKED였다면 차단 해제 알림 발송
status = DORMANT  → 휴면 전환 + 재로그인 시 해제 확인 플래그
status = BLOCKED  → 회원 단위 차단 처리
status = DELETED  → 소프트 삭제(account_status = DELETED, 행 보존)
```

### 안전장치 두 가지

- **자기 계정 보호.** 상태 변경 시 세션의 `loginUser.userIdx`와 대상이 같으면 거부한다. 일괄 변경도 대상 목록에 본인이 끼면 전체를 막는다. 운영자가 자기 권한을 스스로 잠그는 사고를 차단한다.
- **SYSTEM 계정 보호.** 상태 UPDATE 쿼리 자체에 `user_role != SYSTEM` 조건이 박혀 있어, 신고 자동 처리 등에 쓰는 SYSTEM 계정은 상태가 바뀌지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 프로필 + 3원 지갑 + 소셜 + 로그인 통계 통합 조회 | 구현됨 |
| 최근 활동·차단·이메일 인증 이력 표시 | 구현됨 |
| 프로필/이메일 수정, 상태 전환(4종), 일괄 상태 | 구현됨 |
| 자기 계정·SYSTEM 계정 보호 가드 | 구현됨 |
| 회원 목록 CSV/Excel 내보내기(POI) | 구현됨 |
| 등급/지갑/레벨 메타 수정 매퍼(`updateMemberMeta`) | 매퍼·서비스 존재. 화면 노출 범위는 운영 정책에 따름 |
| 화면 레이아웃 | JSP 데스크톱 기준. 모바일 반응형은 향후 과제 |

:::warning
이메일을 변경하면 그 즉시 이메일 인증과 이메일 로그인 가능 여부가 함께 꺼진다. 운영자가 이메일을 고친 뒤 "왜 로그인이 안 되냐"는 문의가 들어올 수 있으므로, 변경은 회원에게 재인증을 요구하는 동작임을 이해하고 써야 한다.
:::

## 6. 면접 답변 3단계

1. **한 줄.** "회원 360 뷰는 한 회원의 프로필·지갑·소셜·로그인·활동·차단을 한 화면에 모아 보고 그 자리에서 상태까지 바꾸는 운영자 단일 뷰입니다."
2. **설계 의도.** "운영 판단에 필요한 정보가 여러 테이블에 흩어져 있어, 서버에서 한 회원 기준으로 합쳐 내려주고(읽기), 제어는 좁은 단일 UPDATE로 분리했습니다(쓰기)."
3. **차별점.** "조회와 조치를 한 화면에 합치되, 자기 계정·SYSTEM 계정을 못 건드리게 가드를 두고, ACTIVE 복구는 차단 해제와 알림까지 묶은 복합 동작으로 처리합니다."

## 7. 꼬리질문 + 모범답안

:::details 정보를 한 쿼리로 다 JOIN하지 않고 여러 번 조회하는 이유는?
프로필·소셜 수·로그인 통계처럼 1:1 또는 단일 집계로 줄어드는 값은 `findMemberDetail` 한 쿼리에 서브쿼리로 묶습니다. 반면 최근 활동·차단·이메일 이력은 N건짜리 목록이라 같은 쿼리에 JOIN하면 카테시안 곱으로 행이 폭발합니다. 그래서 목록성 데이터는 LIMIT을 건 별도 조회로 나눕니다.
:::

:::details 상태를 BLOCKED에서 ACTIVE로 바꿀 때 단순히 컬럼만 ACTIVE로 바꾸면 안 되는 이유는?
차단은 회원 상태 컬럼 하나가 아니라 IP 차단 규칙·차단 이력·휴면 플래그 등 여러 곳에 흔적을 남기기 때문입니다. ACTIVE 복구는 활성 IP 차단과 블록을 비활성화하고 휴면을 풀고 상태를 ACTIVE로 되돌린 뒤, 이전이 BLOCKED였을 때만 해제 알림을 보냅니다. 컬럼만 바꾸면 IP 차단이 남아 회원이 여전히 못 들어옵니다.
:::

:::details 운영자가 자기 계정을 차단하면 어떻게 되나요?
막습니다. 상태 변경 시 세션 로그인 사용자의 `userIdx`와 대상이 같으면 거부하고, 일괄 변경은 대상 목록에 본인이 포함되면 전체를 거부합니다. 운영자가 실수로 자기 접근을 끊는 락아웃을 방지하기 위한 가드입니다.
:::

:::details 이메일을 바꾸면 인증 상태가 왜 같이 꺼지나요?
바뀐 이메일은 아직 본인 소유가 검증되지 않았기 때문입니다. 변경 시 email_verified와 email_login_enabled를 함께 FALSE로 내려, 새 주소로 재인증을 거치기 전에는 그 이메일로 로그인할 수 없게 합니다. 또 다른 회원이 이미 쓰는 이메일이면 중복 검사로 막습니다.
:::

:::details SYSTEM 계정은 왜 상태를 못 바꾸게 했나요?
SYSTEM은 신고 자동 처리 같은 내부 동작에 쓰는 기능 계정입니다. 운영자가 실수로 차단·삭제하면 자동화가 멈춥니다. 그래서 상태 UPDATE 쿼리 자체에 user_role != SYSTEM 조건을 박아, 서비스 로직을 우회해도 DB 레벨에서 보호되도록 했습니다.
:::

## 8. 직접 말해보기

- 회원 360 뷰가 합쳐 보여주는 7~8개 데이터 묶음과 각 출처 테이블을 막힘 없이 나열해 보기.
- "왜 목록성 데이터는 별도 쿼리로 나눴는지"를 카테시안 곱 관점에서 30초로 설명해 보기.
- BLOCKED → ACTIVE 복구가 단일 UPDATE가 아니라 복합 동작인 이유를 IP 차단·알림까지 엮어 말해 보기.
- 자기 계정 보호와 SYSTEM 계정 보호가 각각 어느 계층(서비스 vs SQL)에서 걸리는지 구분해 답해 보기.

## 퀴즈

<QuizBox question="회원 360 뷰의 getMemberContext에서, 최근 활동 로그나 차단 이력 같은 N건짜리 목록을 회원 기본 조회 쿼리에 함께 JOIN하지 않고 별도 쿼리로 분리하는 가장 큰 이유는?" :choices="['보안 등급이 달라서', '여러 행과 JOIN하면 카테시안 곱으로 결과 행이 폭발하기 때문', 'MyBatis가 JOIN을 지원하지 않아서', '트랜잭션을 쓸 수 없어서']" :answer="1" explanation="프로필이나 소셜 수처럼 단일 값으로 줄어드는 데이터는 한 쿼리에 묶지만, N건 목록을 같은 쿼리에 JOIN하면 행 수가 곱해져 폭발하므로 LIMIT을 건 별도 조회로 분리한다." />

<QuizBox question="관리자가 회원 상태를 BLOCKED에서 ACTIVE로 복구할 때 일어나는 일로 가장 정확한 것은?" :choices="['account_status 컬럼만 ACTIVE로 바꾼다', 'IP 차단과 블록 해제, 휴면 해제까지 한 뒤 이전이 BLOCKED였을 때만 해제 알림을 보낸다', '회원 행을 삭제하고 새로 만든다', '비밀번호를 초기화한다']" :answer="1" explanation="ACTIVE 복구는 단순 컬럼 변경이 아니라 활성 IP 차단·블록 비활성화·휴면 해제를 묶은 복합 동작이며, 이전 상태가 BLOCKED인 경우에만 해제 알림을 발송한다." />

<QuizBox question="회원 360 뷰의 상태 변경에 걸린 안전장치로 옳지 않은 것은?" :choices="['로그인한 운영자가 자기 계정 상태를 바꾸려 하면 거부한다', '상태 UPDATE 쿼리에 user_role != SYSTEM 조건이 있어 SYSTEM 계정은 보호된다', '일괄 변경 대상에 본인이 포함되면 전체를 거부한다', '한 번 BLOCKED가 되면 어떤 방법으로도 다시 ACTIVE로 못 바꾼다']" :answer="3" explanation="BLOCKED 회원은 ACTIVE 상태 변경으로 복구할 수 있다. 자기 계정 보호, SYSTEM 계정 보호, 일괄 변경 시 본인 포함 거부는 모두 실제로 구현된 가드다." />
