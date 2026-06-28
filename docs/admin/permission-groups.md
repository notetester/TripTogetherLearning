---
title: "권한 그룹"
owner: A
domain: "관리자·운영"
tags: ["권한"]
---

# 권한 그룹

> 관리자 권한은 코드 한 줄로 끝나는 값이 아니라, 개별 권한 → 권한 그룹 → 실효 권한 코드로 합성되고, 부여는 요청·승인·적용을 분리해 모든 변경에 요청자·승인자·사유를 영구 기록으로 남기는 거버넌스 모델이다.

## 1. 한 줄 정의

`ADMIN_PERMISSION_POLICY`(개별 권한 카탈로그)와 `ADMIN_PERMISSION_GROUP_POLICY`(권한 묶음 카탈로그)를 기반으로, 특정 관리자에게 권한을 부여할 때 요청(request) → 승인(approve) → 적용(active)의 3단계를 한 행 안에서 상태로 추적하고, 누가 요청하고 누가 승인했으며 무슨 사유였는지를 회수 후에도 지워지지 않게 보존하는 관리자 권한 거버넌스 도메인이다.

## 2. 왜 이렇게 설계했나

관리자 권한은 회원 차단·콘텐츠 삭제·런타임 설정 변경처럼 되돌리기 어려운 조치로 이어진다. 권한을 단일 컬럼(예: user_role 하나)으로만 다루면 두 가지가 무너진다. 첫째, 세밀한 분리가 불가능하다. 커뮤니티만 다루는 운영자와 회원 정지까지 하는 운영자를 같은 한 글자로 구분할 수 없다. 둘째, 누가 왜 그 권한을 줬는지 추적할 수 없다.

그래서 세 가지 결정을 했다.

첫째, **권한을 세 층으로 분리**했다. 개별 권한(permission_code)이 최소 단위이고, 여러 개별 권한을 묶은 것이 권한 그룹(group_code), 그룹과 개별 권한을 다시 묶어 실무 직무에 매핑한 것이 실효 권한 코드(admin_permission_code)다. 운영 직무가 바뀌면 그룹 구성만 고치면 되고, 그 그룹을 가진 모든 관리자에게 일괄 반영된다.

둘째, **부여를 요청·승인·적용으로 분리**했다. 권한을 주는 행위 자체에 2인 원칙을 적용한다. 한 관리자가 요청을 올리고, 별도의 상위 권한(슈퍼어드민)이 승인해야 비로소 권한이 활성화된다. 자기 자신에게 조용히 권한을 부여하는 경로를 구조적으로 막는다.

셋째, **부여 행위를 영구 기록**으로 남긴다. 부여 행은 회수(revoke)되어도 삭제하지 않고 is_active만 0으로 내린다. 요청자·승인자·실제 적용자·사유가 같은 행에 남아 있어, 사후에 권한 이력을 그대로 재구성할 수 있다. 이는 감사 로그 도메인의 책임 추적성 원칙과 같은 방향이다.

:::tip 권한 그룹 vs 실효 권한 코드
권한 그룹(group)은 개별 권한의 묶음이다. 실효 권한 코드(admin_permission_code)는 그 위 단계로, 여러 그룹과 개별 권한을 한 번 더 묶어 직무 단위로 매핑한 번들이다. 그룹은 재사용 가능한 부품, 실효 코드는 그 부품을 조립한 완성품에 가깝다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

핵심 테이블과 그 책임은 다음과 같다.

| 책임 | 테이블 | 핵심 컬럼 |
| --- | --- | --- |
| 개별 권한 카탈로그 | `ADMIN_PERMISSION_POLICY` | permission_code, display_name, is_active |
| 권한 그룹 카탈로그 | `ADMIN_PERMISSION_GROUP_POLICY` | group_code, display_name |
| 그룹 구성(그룹에 든 권한) | `ADMIN_PERMISSION_GROUP_ITEM` | group_code, permission_code |
| 실효 권한 코드 카탈로그 | `ADMIN_PERMISSION_CODE_POLICY` | admin_permission_code, display_name |
| 실효 코드 구성(그룹) | `ADMIN_PERMISSION_CODE_GROUP_ITEM` | admin_permission_code, group_code |
| 실효 코드 구성(개별) | `ADMIN_PERMISSION_CODE_PERMISSION_ITEM` | admin_permission_code, permission_code |
| 관리자별 개별 권한 부여 | `ADMIN_PERMISSION` | user_idx, permission_code, is_active |
| 관리자별 그룹 부여 | `ADMIN_PERMISSION_GROUP` | user_idx, group_code, is_active |

부여 행에는 행위자 추적용 컬럼이 함께 박혀 있다. `granted_request_by_user_idx`(요청자), `granted_approval_by_user_idx`(승인자), `granted_by_user_idx`(실제 적용자), `description`(사유), `granted_at`/`revoked_at`(부여·회수 시각)이다. 모든 행위자 컬럼은 `USERS.user_idx`를 참조하되 `ON DELETE SET NULL`이라, 행위자 계정이 삭제돼도 부여 행 자체는 남는다.

코드 측은 `controller → service → mapper → vo` 4계층을 따른다.

- 컨트롤러: `SuperAdminController`(`/superAdmin/**`). 권한 관리·코드 번들 관리·요청 승인 엔드포인트가 모여 있다.
- 서비스: `SuperAdminServiceImpl`. `requestPermissions`, `approvePermissionRequest`, `rejectPermissionRequest`, `grantDirectPermission`, `revokeDirectPermission`, `getPermissionAuditLog` 등을 노출한다.
- 매퍼/매핑: `SuperAdminMapper` + `SuperAdminMapper.xml`. 실제 SQL이 여기 있다.
- VO: `SuperAdminPermissionVO`, `SuperAdminPermissionRequestVO`, `SuperAdminAuditLogVO`, `SuperAdminPermissionCodePolicyVO`.

## 4. 동작 원리 (흐름·표·작은 코드)

부여 워크플로우는 **한 행의 상태 전이**로 표현된다. 요청·승인이 별도 테이블이 아니라 `ADMIN_PERMISSION` 한 행의 컬럼 조합으로 단계를 나타낸다.

| 단계 | is_active | request_by | approval_by | revoked_at |
| --- | --- | --- | --- | --- |
| 요청됨(대기) | 0 | 있음 | NULL | NULL |
| 승인됨(적용) | 1 | 있음 | 있음 | NULL |
| 반려됨 | 0 | 있음 | 있음 | 있음 |

요청은 비활성(0) 행으로 들어가고, 요청자만 채워진다.

```sql
INSERT INTO ADMIN_PERMISSION
  (user_idx, permission_code, is_active, granted_request_by_user_idx, description, ...)
VALUES (대상, 권한코드, 0, 요청자, 사유, ...)
```

승인은 대기 행만 골라 활성화하고 승인자·적용자를 채운다. WHERE 절이 대기 상태(is_active = 0, 요청자 있음, 승인자 없음, 미회수)를 조건으로 못박아, 이미 처리된 요청을 다시 승인하는 중복 처리를 막는다.

```sql
UPDATE ADMIN_PERMISSION
SET is_active = 1, granted_by_user_idx = 승인자, granted_approval_by_user_idx = 승인자
WHERE admin_permission_idx = ? AND is_active = 0
  AND granted_request_by_user_idx IS NOT NULL
  AND granted_approval_by_user_idx IS NULL AND revoked_at IS NULL
```

반려는 활성화하지 않고 `revoked_at`만 찍어 흔적을 남긴다. 대기 목록(`findPendingRequests`)은 같은 조건(비활성·요청자 있음·승인자 없음·미회수)으로 골라 보여주므로, 승인/반려가 끝나면 자연스럽게 목록에서 사라진다.

대기 행이 재요청될 때를 대비해 INSERT는 `ON DUPLICATE KEY UPDATE`로 멱등하게 처리된다. (user_idx, permission_code) 유니크 제약 위에서, 이미 비활성 상태일 때만 요청자·사유를 갱신하고 활성 권한은 건드리지 않는다.

런타임 권한 검증은 이 도메인이 아니라 공통 AOP가 맡는다. `@RequireAdmin`이 붙은 메서드 진입 직전에 `AuthorizationAspect`가 세션의 loginUser를 꺼내 운영진 여부를 확인하고, 실패 시 `ForbiddenException`을 던진다(ADR-0011). 즉 이 도메인은 권한을 정의·부여·기록하고, 실제 게이트는 인터셉터/AOP가 건다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: 개별 권한·그룹·실효 코드 3층 카탈로그와 그 구성 테이블, 관리자별 부여(`ADMIN_PERMISSION`/`ADMIN_PERMISSION_GROUP`), 요청 → 승인/반려 워크플로우, 대기 목록·대기 건수 조회, 직접 부여/회수, 권한 변경 이력 조회(`getPermissionAuditLog`), 일괄 권한 갱신, 코드 번들 CRUD·토글.
- 구현됨: 요청자·승인자·적용자·사유·시각이 부여 행에 영구 기록되며, 회수는 소프트 방식(is_active = 0)이라 이력이 보존된다(소프트 삭제 원칙, ADR-0008).
- 부분/주의: 부여 행이 곧 이력이라, 권한 이력은 "현재 부여 상태 + 행위자 메타"를 보여주는 형태다. 권한 한 건의 모든 변경을 시계열 다중 행으로 누적하는 별도 append-only 이력 테이블은 두지 않는다.
- 계획/한계: 권한 코드별 세분화된 메뉴 단위 접근 제어를 코드 레벨에서 일관 강제하는 정책 엔진은 아직 단순하다(운영진 여부 중심 게이트 + 화면 단위 권한 표시). API 명세 자동화(Swagger 등)는 없다.

## 6. 면접 답변 3단계

1. **한 줄**: 관리자 권한을 개별 권한·그룹·실효 코드 3층으로 합성하고, 부여는 요청·승인·적용을 분리해 요청자·승인자·사유를 영구 기록으로 남기는 권한 거버넌스 모델입니다.
2. **설계 이유**: 권한을 단일 컬럼으로 다루면 세밀한 직무 분리도, 누가 왜 줬는지 추적도 안 됩니다. 그래서 권한을 묶음으로 조립 가능하게 만들고, 부여 자체에 요청·승인 2인 원칙을 적용했습니다.
3. **구현 핵심**: 부여 워크플로우를 별도 테이블이 아니라 `ADMIN_PERMISSION` 한 행의 상태 전이로 표현합니다. is_active·요청자·승인자·revoked_at 조합이 단계를 나타내고, 승인 UPDATE의 WHERE가 대기 상태를 못박아 중복 처리를 막습니다. 런타임 게이트는 `@RequireAdmin` + `AuthorizationAspect`가 별도로 담당합니다.

## 7. 꼬리질문 + 모범답안

:::details 왜 요청과 승인을 분리했나요? 한 번에 부여하면 안 되나요?
권한 부여는 그 자체로 위험한 조치라 2인 원칙을 적용했습니다. 한 관리자가 요청을 올리고 상위 권한(슈퍼어드민)이 승인해야 활성화되므로, 한 사람이 자기 자신에게 조용히 권한을 부여하는 경로가 구조적으로 막힙니다. 요청·승인·적용 행위자가 각각 다른 컬럼에 기록돼 사후 책임 추적도 됩니다. 단순 직접 부여 경로(grantDirectPermission)도 있지만, 그것 역시 적용자와 사유가 남습니다.
:::

:::details 요청·승인을 별도 테이블 없이 한 행으로 표현하면 동시성 문제는 없나요?
승인·반려 UPDATE의 WHERE 절에 대기 상태 조건(is_active = 0, 승인자 NULL, 미회수)을 모두 넣어, 이미 처리된 행은 다시 매칭되지 않습니다. 두 승인이 동시에 들어와도 먼저 커밋된 쪽만 조건을 만족하고 나머지는 영향 행 수 0이 됩니다. 요청 INSERT는 (user_idx, permission_code) 유니크 제약 위에서 ON DUPLICATE KEY UPDATE로 멱등하게 처리해 중복 요청 행이 생기지 않습니다.
:::

:::details 권한 그룹과 실효 권한 코드의 차이는 뭔가요?
권한 그룹은 개별 권한의 재사용 가능한 묶음입니다. 실효 권한 코드는 그 위 단계로, 여러 그룹과 개별 권한을 한 번 더 합쳐 직무 단위로 매핑한 번들입니다. 그룹은 부품, 실효 코드는 조립된 완성품에 가깝습니다. 덕분에 직무가 바뀌면 실효 코드의 구성만 바꾸면 되고, 권한 묶음은 그룹 단위로 재사용됩니다.
:::

:::details 권한을 회수하면 기록이 사라지나요?
아니요. 회수는 행 삭제가 아니라 is_active를 0으로 내리는 소프트 방식이라, 요청자·승인자·적용자·사유·부여 시각이 그대로 남습니다. 행위자 컬럼은 USERS를 ON DELETE SET NULL로 참조해, 행위자 계정이 지워져도 부여 행 자체는 보존됩니다. 회수 이력이 남아야 사후 감사가 가능하기 때문입니다.
:::

:::details 실제로 메뉴 접근을 막는 건 이 권한 데이터인가요?
정의·부여·기록은 이 도메인이 하지만, 런타임 차단 게이트는 공통 AOP가 겁니다. `@RequireAdmin`이 붙은 컨트롤러 메서드 진입 전 `AuthorizationAspect`가 세션 loginUser의 운영진 여부를 확인하고 실패 시 ForbiddenException을 던집니다. 즉 권한 모델은 누가 무엇을 할 수 있는지를 데이터로 정의하고, 인터셉터/AOP가 그 데이터를 근거로 실제 요청을 막는 분업 구조입니다.
:::

## 8. 직접 말해보기

- `ADMIN_PERMISSION` 한 행만 보고 그 권한이 요청 대기인지, 승인 적용인지, 반려인지 어떻게 구분하는지 컬럼 조합으로 설명해 보세요.
- 권한을 단일 user_role 컬럼으로만 다뤘다면 어떤 운영 시나리오에서 막혔을지 두 가지를 들어 보세요.
- 승인 UPDATE의 WHERE 조건이 왜 중복 승인을 막아 주는지, 영향 행 수 관점에서 말해 보세요.
- 권한 그룹과 실효 권한 코드를 부품·완성품 비유 없이 실제 테이블 이름으로 구분해 설명해 보세요.

## 퀴즈

<QuizBox question="ADMIN_PERMISSION 한 행에서 승인 대기(요청됨) 상태를 나타내는 컬럼 조합으로 옳은 것은?" :choices="['is_active가 1이고 승인자가 채워진 상태', 'is_active가 0이고 요청자는 있으나 승인자는 비어 있고 미회수 상태', 'is_active가 1이고 회수 시각이 찍힌 상태', '요청자와 승인자가 모두 비어 있는 상태']" :answer="1" explanation="요청은 비활성 행으로 들어가며 요청자만 채워집니다. 승인되면 is_active가 1이 되고 승인자가 채워집니다." />

<QuizBox question="권한 그룹과 실효 권한 코드의 관계를 가장 정확히 설명한 것은?" :choices="['둘은 같은 개념이며 이름만 다르다', '실효 권한 코드가 개별 권한이고 그룹이 그것을 묶은 상위 단계다', '권한 그룹은 개별 권한의 묶음이고 실효 권한 코드는 그룹과 개별 권한을 다시 합친 상위 번들이다', '권한 그룹은 회원 등급이고 실효 코드는 결제 등급이다']" :answer="2" explanation="개별 권한을 묶은 것이 그룹, 그룹과 개별 권한을 한 번 더 묶어 직무 단위로 매핑한 것이 실효 권한 코드입니다." />

<QuizBox question="권한 회수(revoke)를 행 삭제가 아니라 is_active를 0으로 내리는 소프트 방식으로 처리하는 주된 이유는?" :choices="['DB 용량을 줄이기 위해서', '요청자 승인자 사유 등 부여 이력을 보존해 사후 감사를 가능하게 하려고', '권한을 더 빠르게 재부여하려고', '외래키 제약을 우회하려고']" :answer="1" explanation="회수해도 행을 남겨 두면 누가 왜 부여했고 언제 회수됐는지가 그대로 보존되어 책임 추적과 감사가 가능합니다." />
