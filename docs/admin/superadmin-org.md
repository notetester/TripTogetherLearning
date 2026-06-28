---
title: "superAdmin·조직"
owner: A
domain: "관리자·운영"
tags: ["superAdmin", "조직"]
---

# superAdmin·조직

> 관리자 계정 자체를 만들고 권한을 부여하며, 조직 서열과 급여 메타데이터를 관리하는 최상위 운영 콘솔이다.

## 1. 한 줄 정의

`/superAdmin/**` 는 일반 관리 화면(`/admin/**`)보다 한 단계 위의 메타 관리 영역으로, 누가 관리자가 되고 어떤 권한을 갖는지, 조직 안에서 어디에 위치하는지를 정의한다. 일반 관리자가 콘텐츠와 회원을 다룬다면, 이 영역은 관리자 그 자체를 다룬다.

## 2. 왜 이렇게 설계했나

관리자 권한을 코드 곳곳의 문자열 비교(`role.equals(ADMIN)`)로 흩뿌리면, 권한이 하나 늘 때마다 컨트롤러를 고쳐야 하고 누가 무엇을 할 수 있는지 한눈에 보이지 않는다. TripTogether는 이를 두 축으로 분리했다.

- **신원/소속 축**: 사람이 조직 어디에 있는가. `USERS` 테이블의 `admin_*` 컬럼군(본부·부서·팀·직책·서열·티어 등)과 상급자 자기참조 `admin_manager` 로 표현한다.
- **권한 축**: 사이트에서 무엇을 할 수 있는가. `ADMIN_PERMISSION` 계열 테이블과 실효 권한 코드(번들)로 표현하며, 최종 권한은 DB 뷰가 합산한다.

이렇게 두 축을 떼어 놓으면, 직책이 같아도 권한은 다르게 줄 수 있고, 권한 한 묶음을 코드 하나로 정의해 여러 관리자에게 동일하게 적용할 수 있다. 권한 부여·회수는 전부 사유와 함께 이력으로 남는다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

진입점은 `SuperAdminController`(`@RequestMapping("/superAdmin")`)이고, 보호는 `SuperAdminInterceptor` 가 담당한다. 4계층 규칙대로 `SuperAdminService` → `SuperAdminServiceImpl` → `SuperAdminMapper` 로 내려간다.

| 관심사 | 테이블 / 클래스 |
| --- | --- |
| 관리자 식별·조직 메타 | `USERS`(user_role, admin_division, admin_department, admin_team, admin_position, admin_rank, admin_tier, admin_manager …) |
| 직접 부여 권한 | `ADMIN_PERMISSION`(user_idx + permission_code, is_active) |
| 권한 그룹 정책/구성 | `ADMIN_PERMISSION_GROUP_POLICY`, `ADMIN_PERMISSION_GROUP_ITEM`, `ADMIN_PERMISSION_GROUP`(부여) |
| 실효 권한 코드(번들) | `ADMIN_PERMISSION_CODE_POLICY` + `..._PERMISSION_ITEM` + `..._GROUP_ITEM` |
| 최종 합산 권한 | 뷰 `ADMIN_EFFECTIVE_PERMISSION_VW`(DIRECT / GROUP / CODE_DIRECT / CODE_GROUP 4개 소스 UNION) |
| 직책 사전 | `ADMIN_POSITION_POLICY`(admin_position_code, sort_order) |
| 급여/역량 변경 이력 | `SALARY_CHANGE_AUDIT`(batch_id, field_name, old_value, new_value) |
| 조직 enum 사전 | `AdminPositionEnum`, `AdminRankEnum`, `AdminTierEnum`, `AdminRoleEnum`, `AdminDivisionEnum` 등 |
| 급여 Excel | `SalaryExcelExporter`, `SalaryExcelImporter`(Apache POI) |

권한 코드의 성격은 enum `UserRole`(USER, BUSINESS, PARTNER, BOT, ADMIN, SUPERADMIN, SYSTEM)이 정한다. 문자열 분기 대신 `isAdminLike()`, `isSuperAdmin()`, `isProtectedRole()` 같은 정책 메서드로 판단한다.

## 4. 동작 원리 (흐름·표·작은 코드)

세 등급의 운영 권한은 별도 enum이 아니라 **role + 실효 권한 코드**의 조합으로 표현된다.

| 등급 개념 | 표현 방식 | 가능한 일 |
| --- | --- | --- |
| Super Admin | user_role = SUPERADMIN (또는 ADMIN + SUPER_ADMIN 권한) | superAdmin 콘솔 전체, 관리자 임명·해제 |
| Operation Admin | ADMIN + 도메인 권한 코드(MEMBER_ADMIN, OPS_POLICY_ADMIN 등) | 회원·정책 등 운영 화면 |
| Report Admin | ADMIN + REPORT_ADMIN 권한 코드 | 신고 처리 화면 |

`AdminInterceptor` 의 URL_PERMISSION_MAP 이 경로별 필요 권한을 정한다. 예: `/admin/reports` 는 REPORT_ADMIN, `/admin/members` 는 MEMBER_ADMIN. superAdmin은 이런 코드를 묶거나 풀어 각 관리자에게 부여한다.

진입 보호 흐름:

```text
요청 → SuperAdminInterceptor.preHandle
  세션 loginUser 없음 → /auth/login?redirect= 로 이동
  loginUser.hasAdminRole() false → 홈으로 리다이렉트
  통과 → 콘솔 진입 (세부 권한은 화면 내 정책으로 관리)
```

권한 부여 흐름(Service 위임 패턴):

```java
// 관리자 임명: 일반 유저를 ADMIN 으로
superAdminService.grantAdmin(userIdx);
// 권한 코드 번들 적용 (감사 주체 기록)
superAdminService.updatePermissionCode(userIdx, permissionCode);
// 그룹 배정 / 직접 권한 부여 — 모두 loginUser.getUserIdx() 를 행위자로 남김
```

최종 권한 계산은 코드가 아니라 뷰가 한다. `ADMIN_EFFECTIVE_PERMISSION_VW` 는 직접 부여, 그룹 경유, 코드 번들 내 개별권한, 코드 번들 내 그룹권한의 네 경로를 모두 UNION 해 user_idx 별 실효 권한 집합을 만든다. 그래서 한 사람이 여러 경로로 같은 권한을 받아도 중복 없이 합산된다.

조직 서열은 enum 사전으로 표준화한다. 직책은 사원부터 회장까지(`AdminPositionEnum`), 서열은 IC1~IC7 / M1~M5(`AdminRankEnum`), 티어는 T1~T5(`AdminTierEnum`). 급여 구간(band/grade/step)은 Excel로 일괄 갱신하며, 모든 변경은 batch_id 로 묶여 `SALARY_CHANGE_AUDIT` 에 필드 단위로 남는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현된 것
- 관리자 임명/해제, 일괄 해제, 일괄 권한 설정 (`/superAdmin/members/**`)
- 권한 코드 번들·권한 그룹·개별 권한 CRUD와 활성 토글
- 실효 권한 뷰 기반 합산, 권한/그룹 변경 이력 조회
- 조직도 화면(`/superAdmin/org`), 급여/역량 일람표, Excel 내보내기/업로드(미리보기 후 확정 적용)
- 통계 대시보드(휴면 관리자, 권한 없는 관리자, 상급자 없는 관리자 탐지)
:::

:::warning 한계 / 계획
- 진입 게이트는 ADMIN 계열이면 통과하고, 세부 등급 분리는 콘솔 내부 권한 정책으로 관리하는 구조다. 따라서 Super/Operation/Report 의 경계는 화면 진입이 아니라 권한 코드 부여로 강제된다.
- 권한 부여 요청-승인 2단계 컬럼(granted_request_by / granted_approval_by)은 스키마에 있으나, 현재 흐름은 superAdmin이 직접 적용하는 단일 단계에 가깝다.
- 조직 enum 일부(seniority/level/band/grade/step)는 주로 급여·평가 메타데이터이며 권한 판단에는 쓰이지 않는다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: superAdmin 영역은 관리자 계정 자체를 만들고 권한과 조직 위치를 정의하는 메타 관리 콘솔입니다.
2. **설계 의도**: 권한 판단을 코드 문자열 비교가 아니라 DB의 권한 코드·그룹·실효 권한 뷰로 데이터화해서, 권한을 묶어 재사용하고 부여 이력을 남기도록 분리했습니다.
3. **핵심 근거**: 신원/조직 축은 USERS의 admin 컬럼군과 상급자 자기참조로, 권한 축은 ADMIN_PERMISSION 계열과 ADMIN_EFFECTIVE_PERMISSION_VW 로 표현하고, 진입은 SuperAdminInterceptor 가 막습니다.

## 7. 꼬리질문 + 모범답안

:::details 권한을 USERS에 컬럼으로 박지 않고 왜 별도 테이블로 뺐나
한 관리자가 여러 권한을 가질 수 있고, 같은 권한 묶음을 여러 명에게 동일하게 적용해야 합니다. 컬럼이면 권한이 늘 때마다 스키마를 바꿔야 하지만, 행으로 두면 권한 추가가 데이터 입력이 되고, 권한 코드 번들로 묶어 재사용할 수 있습니다. 부여 시각·사유·행위자도 행 단위로 남길 수 있습니다.
:::

:::details 한 사람이 직접 권한과 그룹 권한을 동시에 받으면 중복은 어떻게 처리되나
권한 계산을 애플리케이션이 아니라 ADMIN_EFFECTIVE_PERMISSION_VW 뷰가 합니다. 직접, 그룹 경유, 코드 번들의 개별권한, 코드 번들의 그룹권한 네 경로를 UNION 하되 distinct 라서 같은 권한 코드는 한 번만 남습니다. 소스 구분 컬럼이 있어 어느 경로로 받았는지도 추적됩니다.
:::

:::details SuperAdminInterceptor 가 통과시켰는데도 세부 화면에서 막히는 이유는
진입 인터셉터는 ADMIN 계열인지만 봅니다. 실제 도메인 화면 접근은 AdminInterceptor 의 URL_PERMISSION_MAP 이 경로별로 필요한 권한 코드를 요구합니다. 예를 들어 신고 화면은 REPORT_ADMIN 이 없으면 접근이 막힙니다. 그래서 같은 ADMIN이라도 부여된 권한 코드에 따라 화면이 갈립니다.
:::

:::details SUPERADMIN 과 SYSTEM 역할을 일반 관리 화면에서 못 건드리게 한 이유는
UserRole 의 PROTECTED_ROLES 에 SUPERADMIN 과 SYSTEM 을 넣어 isProtectedRole 로 보호합니다. 일반 관리자가 최상위 계정이나 시스템 자동 계정의 상태·역할을 바꾸면 권한 상승이나 자동화 붕괴 위험이 있어, 이들은 별도 최고관리자 흐름에서만 다루도록 격리했습니다.
:::

:::details 급여 Excel 업로드에서 데이터 정합성은 어떻게 지키나
업로드는 미리보기와 확정 적용 두 단계로 나뉩니다. 먼저 파일을 파싱해 변경 미리보기를 보여주고, 확정 시에만 적용합니다. 모든 변경은 같은 batch_id 로 묶여 SALARY_CHANGE_AUDIT 에 필드 단위 old_value, new_value 로 기록되므로, 어느 업로드가 어떤 값을 바꿨는지 추적·롤백 판단이 가능합니다.
:::

## 8. 직접 말해보기

- superAdmin 콘솔과 일반 admin 화면의 책임 경계를 두 문장으로 설명해 보세요.
- 권한이 직접·그룹·코드 세 경로로 부여될 때 최종 실효 권한이 어떻게 합쳐지는지 뷰 관점에서 말해 보세요.
- 조직 서열(직책·서열·티어)과 사이트 권한이 왜 분리되어야 하는지 근거를 들어 보세요.

관련 문서: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [권한 그룹](/admin/permission-groups) · [감사 로그](/admin/audit-logs)

## 퀴즈

<QuizBox question="한 관리자에게 직접 권한, 그룹 경유 권한, 코드 번들 권한이 동시에 부여되었을 때 최종 실효 권한 집합을 만들어 주는 것은 무엇인가" :choices="['각 컨트롤러의 문자열 비교 로직', 'ADMIN_EFFECTIVE_PERMISSION_VW 뷰의 4개 소스 UNION', 'USERS 테이블의 admin_permission 단일 컬럼', 'SuperAdminInterceptor 의 preHandle']" :answer="1" explanation="권한 계산은 애플리케이션이 아니라 뷰 ADMIN_EFFECTIVE_PERMISSION_VW 가 직접, 그룹, 코드 번들의 개별권한, 코드 번들의 그룹권한 네 경로를 distinct UNION 으로 합쳐 user_idx 별 실효 권한을 만든다." />

<QuizBox question="SuperAdminInterceptor 가 superAdmin 콘솔 진입에서 검사하는 핵심 조건은 무엇인가" :choices="['특정 도메인 권한 코드 보유 여부', '세션 로그인 여부와 hasAdminRole 관리자 계열 여부', 'SUPERADMIN 역할 단독 보유 여부', 'CSRF 토큰 일치 여부']" :answer="1" explanation="진입 인터셉터는 세션에 loginUser 가 있는지와 hasAdminRole 즉 ADMIN 계열인지만 본다. 신고나 회원 같은 세부 화면 권한은 그 다음 단계인 AdminInterceptor 의 URL 권한 매핑이 강제한다." />

<QuizBox question="조직 서열을 표준화하는 enum 매칭으로 옳은 것은" :choices="['AdminPositionEnum 은 T1부터 T5까지의 티어', 'AdminRankEnum 은 IC1부터 IC7과 M1부터 M5까지의 서열', 'AdminTierEnum 은 사원부터 회장까지의 직책', 'UserRole 은 급여 호봉을 정의']" :answer="1" explanation="직책은 AdminPositionEnum 사원부터 회장까지, 서열은 AdminRankEnum IC1부터 IC7 그리고 M1부터 M5, 티어는 AdminTierEnum T1부터 T5 로 분리되어 조직 메타데이터를 표준화한다." />
