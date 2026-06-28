---
title: "관리자·운영 개요"
owner: A
domain: "관리자·운영"
tags: ["관리자"]
---

# 관리자·운영 개요

> TripTogether의 관리자·운영 도메인은 회원 360 뷰, 모더레이션, 감사 로그, 권한 그룹, 런타임 설정, 매출·환불, 조직(superAdmin)까지 묶어 서비스 전체를 운영자가 통제·추적할 수 있게 하는 거버넌스 계층이다.

## 1. 도메인 소개

관리자·운영 도메인은 다른 모든 도메인 위에 얹히는 **횡단(cross-cutting) 운영 계층**이다. 커뮤니티 글, 문의, 결제, AI 챗봇 등 각 도메인이 만든 데이터를 운영자가 한곳에서 조회·조치·추적한다. 핵심 책임은 네 가지다.

- **관측(Observe)**: 대시보드 통계, 회원 360 뷰, 로그인 감사, 보안 이력, AI 사용량 모니터링
- **조치(Act)**: 게시글·댓글·회원 차단/해제, IP 차단, 신고 처리, AI 답변·챗봇 차단
- **추적(Audit)**: 모든 관리자 조치를 표준 사유 코드와 함께 `ADMIN_ACTION_AUDIT`에 남김
- **통제(Govern)**: 권한 그룹으로 관리자 권한을 분리하고, 정책·설정을 코드 재배포 없이 DB에서 바꿈

관리자는 `/admin/**`, 최상위 관리자(조직·급여·관리자 계정)는 `/superAdmin/**` 경로로 분리되어 있다. 두 영역 모두 인터셉터 체인과 AOP 권한 검사로 보호된다.

## 2. 담당과 경계

이 자료는 **중립 서술**을 원칙으로 한다. TripTogether는 4명이 도메인을 수직 분담해 만든 팀 프로젝트이며, 관리자·운영 도메인은 그중 한 담당 영역으로 분류된다. 특정 개인을 "내 영역"으로 지칭하지 않고, 코드·DB·ADR에 드러난 사실만 기준으로 한다.

관리자 도메인은 다른 도메인의 산출물에 의존하므로 경계가 넓다.

| 협력 도메인 | 관리자가 다루는 대상 |
| --- | --- |
| 커뮤니티·신고 | 게시글/댓글 모더레이션, 신고 처리, 네이티브 광고 CRUD |
| 문의·알림 | 문의 상태 관리, 답변 이력, AI 답변 초안 모니터링 |
| 인증·보안 | 로그인 감사, IP 차단, 계정 차단/해제 |
| AI 어시스턴트·챗봇 | 사용량·쿼터·차단 모니터링, 모더레이션 스케줄러 |
| 커머스·리워드 | 매출 통계, 환불 처리, 지갑 정책 |

:::tip 경계 원칙
운영 화면은 데이터를 **소유하지 않고 조회·조치만 한다.** 예를 들어 게시글 본문은 커뮤니티 도메인이 소유하고, 관리자 도메인은 그 글을 BLUR 처리하거나 신고를 종결하는 **조치 권한**만 가진다. 이 분리가 소프트 삭제·감사 로그 설계의 전제다.
:::

## 3. 핵심 기술

세 가지 축이 이 도메인의 성격을 결정한다.

### 권한 그룹 (Permission Group)

관리자에게 권한을 개별 부여하지 않고 **권한 그룹**으로 묶어 부여한다. 정책과 부여가 테이블 수준에서 분리되어 있다.

- `ADMIN_PERMISSION_POLICY` — 개별 권한 정의(무엇을 할 수 있나)
- `ADMIN_PERMISSION_GROUP_POLICY` — 권한 묶음 정의(역할)
- `ADMIN_PERMISSION_GROUP_ITEM` — 그룹에 속한 권한 매핑
- `ADMIN_PERMISSION_GROUP` — 특정 관리자에게 그룹 부여
- `ADMIN_PERMISSION_CODE_POLICY` 외 — 실효 권한 코드(예: CS_MANAGER_L1) 기반 확장

정책(policy)과 부여(grant)를 분리했기 때문에, 그룹 구성만 바꾸면 그 그룹에 속한 모든 관리자의 실효 권한이 한 번에 바뀐다.

### 감사 로그 (Audit Log)

모든 관리자 조치는 표준 형태로 기록된다. 진입점은 `AdminActionAuditService.record(...)` 한 곳이고, `AdminActionAuditVO`가 `ADMIN_ACTION_AUDIT` 테이블에 적재된다.

| 컬럼 | 의미 |
| --- | --- |
| action_type | 조치 유형(예: 차단, 해제) |
| action_domain | 업무 도메인(community, auth ...) |
| actor_user_idx | 수행한 관리자 |
| target_type / target_id | 조치 대상 |
| reason_code | 표준 사유 코드 |
| reason_args | 사유 인자 JSON |
| detail_summary | 사람이 읽는 요약 |

`reason_code`로 사유를 표준화하고 `reason_args`에 가변 인자를 JSON으로 둔 점이 핵심이다. 자유 텍스트 대신 코드로 남기면 통계·필터·다국어 표기가 가능하다.

### 런타임 설정 (Runtime Setting · DB 우선)

운영 중 자주 바뀌는 값(임계치, 토글 등)을 코드/재배포가 아니라 DB에서 바꾼다. `RuntimeSettingService`가 `APPLICATION_RUNTIME_SETTING`을 읽고, 변경은 `APPLICATION_RUNTIME_SETTING_HISTORY`에 이력으로 남는다.

```text
RuntimeSettingVO {
  settingKey, settingGroup, settingValue, fallbackValue,
  valueType,            // 값 타입(문자/숫자/불리언 등)
  secret,               // 시크릿 여부 → 화면에서 마스킹
  editable, active
}
```

`fallbackValue`로 DB 미설정 시 안전한 기본값을 보장하고, `secret` 플래그로 화면 노출을 통제한다. ADR-0009는 모더레이션 정책 값(도배 윈도우, 신고 BLUR 임계값 등)을 같은 철학으로 DB 정책 객체에 외부화했음을 기록한다.

## 4. 권장 학습 순서

추상에서 구체로, 그리고 통제 → 조치 → 추적 순으로 따라가면 도메인 전체가 한 줄로 연결된다.

1. [관리자 대시보드](/admin/dashboard) — 운영자가 처음 보는 통계·진입점
2. [회원 360 뷰](/admin/member-360) — 한 회원의 모든 활동을 한 화면에 모으는 패턴
3. [모더레이션 파이프라인](/admin/moderation-pipeline) — Perspective 비동기 감지 + ai_flagged + BLUR + 관리자 해제(ADR-0010)
4. [감사 로그](/admin/audit-logs) — 표준 사유 코드 기반 조치 추적
5. [IP 차단(CIDR)](/admin/ip-block-cidr) — SINGLE_IP/CIDR/RANGE 등 매치 타입과 배치 운영
6. [런타임 설정](/admin/runtime-settings) — DB 우선 설정과 이력 관리
7. [권한 그룹](/admin/permission-groups) — 정책·부여 분리 권한 모델
8. [superAdmin·조직](/admin/superadmin-org) — 관리자 계정·조직 구조·급여 Excel
9. [매출·환불](/admin/finance-refund) — 매출 통계와 환불 워크플로우
10. [데이터 내보내기(Excel)](/admin/data-export) — Apache POI 기반 내보내기
11. [면접 플레이북](/admin/interview-playbook) — 압축 정리와 예상 질문

허브로 돌아가기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 5. 구현 상태 (됨 vs Mock/계획)

운영 도메인의 핵심은 대부분 실제 구현되어 있다. 정직하게 구분한다.

| 기능 | 상태 |
| --- | --- |
| 회원 360 뷰, 대시보드 통계, 로그인/보안 감사 | 구현됨 |
| 모더레이션(Perspective 독성 + ai_flagged + BLUR + 관리자 해제) | 구현됨 (ADR-0010) |
| 감사 로그(ADMIN_ACTION_AUDIT, 사유 코드) | 구현됨 |
| 권한 그룹(정책/부여 분리) | 구현됨 |
| 런타임 설정(DB 우선 + 이력) | 구현됨 |
| IP 차단(CIDR/RANGE 등 + 배치) | 구현됨 |
| superAdmin 조직·급여 Excel 업로드 | 구현됨 |
| 매출·환불·지갑 정책 | 구현됨 (단, 결제는 Toss 연동, 항공권 공급사는 Mock 프로바이더) |
| Excel 내보내기(Apache POI) | 구현됨 |

:::warning 한계
- 항공권 공급은 **Mock 프로바이더**라 매출 데이터의 항공 부분은 실거래가 아니다.
- AI 응답 품질을 정량 평가하는 체계가 없어, AI 모니터링은 사용량·쿼터·차단 위주다(품질 메트릭은 향후 과제).
- 관리자 화면은 JSP 데스크톱 레이아웃 위주로, 모바일 반응형/SPA는 향후 과제.
- API 문서(Swagger)는 없다.
:::

## 6. 단골 면접 질문 5개

이 도메인에서 면접관이 가장 자주 파고드는 지점이다. 각 항목은 학습 페이지와 연결된다.

1. **관리자가 게시글을 가렸을 때 어떻게 추적하나?** — 표준 사유 코드와 `ADMIN_ACTION_AUDIT` 설계, 자유 텍스트 대신 reason_code를 쓴 이유 → [감사 로그](/admin/audit-logs)
2. **AI가 독성으로 표시한 글을 곧바로 삭제하지 않은 이유는?** — false positive 비용, 비동기 호출, BLUR 점진 공개 + 관리자 해제(Human-in-the-Loop, ADR-0010) → [모더레이션 파이프라인](/admin/moderation-pipeline)
3. **운영 중 임계값을 바꿔야 하면 재배포하나?** — 런타임 설정 DB 우선, fallbackValue, secret 마스킹, 변경 이력 → [런타임 설정](/admin/runtime-settings)
4. **관리자마다 권한을 어떻게 다르게 주나?** — 권한 그룹으로 정책과 부여를 분리한 테이블 모델, 그룹만 바꿔 일괄 반영 → [권한 그룹](/admin/permission-groups)
5. **회원 한 명의 모든 활동을 어떻게 한 화면에 모으나?** — 여러 도메인 데이터를 user_idx로 집계하는 360 뷰 패턴과 성능 고려 → [회원 360 뷰](/admin/member-360)

:::details 한 문장 요약으로 답하기
"관리자 도메인은 각 도메인 데이터를 **소유하지 않고 조회·조치만 하며**, 모든 조치를 표준 사유 코드로 감사 로그에 남기고, 권한은 그룹으로 분리하며, 정책·설정은 DB 우선으로 재배포 없이 바꾼다. 핵심 모더레이션은 자동 차단이 아니라 **사람이 최종 판단하는 BLUR + 해제** 구조다."
:::

## 퀴즈

<QuizBox question="관리자 조치 감사 로그에서 사유를 자유 텍스트가 아니라 reason_code 표준 코드로 남긴 가장 큰 이유는?" :choices="['로그 저장 용량을 줄이려고', '통계·필터·다국어 표기를 가능하게 하려고', 'AI가 더 빠르게 글을 차단하려고', '관리자 비밀번호를 보호하려고']" :answer="1" explanation="표준 사유 코드는 reason_args JSON과 함께 저장되어 집계·필터·다국어 표기가 가능하다. 자유 텍스트는 사람이 읽기엔 좋지만 기계 처리가 어렵다." />

<QuizBox question="ADR-0010 모더레이션 파이프라인이 AI 독성 감지 후 글을 즉시 자동 삭제하지 않고 BLUR 처리 후 관리자 해제를 둔 이유로 가장 적절한 것은?" :choices="['Perspective API가 무료라서', '거짓 양성 비용을 줄이고 사람이 최종 판단하도록', '글을 삭제하면 좋아요 캐시가 깨져서', '관리자 권한 그룹이 없어서']" :answer="1" explanation="false positive가 있을 수 있으므로 자동 차단 대신 점진적 공개(BLUR)와 관리자 수동 해제로 Human-in-the-Loop을 유지한다." />

<QuizBox question="런타임 설정(RuntimeSettingVO)에서 DB에 값이 없을 때 안전한 기본값을 보장하는 필드는?" :choices="['settingKey', 'valueType', 'fallbackValue', 'secret']" :answer="2" explanation="fallbackValue는 DB 미설정 시 사용되는 기본값이고, secret은 화면 마스킹, valueType은 값 타입을 의미한다." />
