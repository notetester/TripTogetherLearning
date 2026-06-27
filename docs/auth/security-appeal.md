---
title: "차단 해제 신청"
owner: A
domain: "인증·계정·보안"
tags: ["차단", "신청"]
---

# 차단 해제 신청

> 위험 평가로 차단된 계정·IP가 로그인 없이도 이메일 본인확인 후 해제를 신청하고, 관리자가 검토해 차단을 풀어주는 비인증 워크플로우.

## 1. 한 줄 정의

차단 해제 신청은 로그인 위험 평가(LoginRiskAssessment)에 의해 차단된 사용자·IP가 **로그인하지 못하는 상태에서도** 자신을 소명하고 차단 해제를 요청할 수 있게 하는 공개 채널이다. `SecurityAppealController`가 토큰/요청ID 기반 폼을 제공하고, 이메일 본인확인을 거쳐 신청을 접수하며, 관리자가 검토 후 승인하면 차단이 풀린다.

## 2. 왜 이렇게 설계했나

차단된 계정은 정의상 로그인할 수 없으므로, **세션 인증을 전제로 한 일반 문의 경로를 쓸 수 없다.** 그래서 이 도메인은 비인증(공개) 진입을 허용하되, 무차별 신청과 사칭을 막기 위한 안전장치를 겹겹이 쌓는 방향으로 설계됐다.

- **비인증 진입**: 차단 안내 메일/화면에 담긴 토큰 또는 요청ID로만 폼에 접근한다. 아무나 임의로 신청 폼을 열 수 없다.
- **이메일 본인확인 선행**: 요청ID만 있는 경우, 먼저 이메일로 검증 토큰을 받아야 실제 신청 폼이 열린다. 사칭과 스팸을 1차로 거른다.
- **다단계 레이트리밋**: 검증 메일 발송 횟수, 거부 후 재신청 쿨다운, 누적 거부 한도, IP 일일 한도, 결과 조회 실패 횟수까지 정책으로 통제한다.
- **모든 단계 감사 로그화**: 발송·접수·결정 전 과정을 보안 감사 테이블에 남겨 사후 추적이 가능하다.
- **관리자 검토 게이트**: 자동 해제는 없다. 모든 해제는 관리자의 명시적 승인을 거친다(ADR-0001 신고 자동차단 금지 정신과 일관).

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

신청자 공개 화면은 `SecurityAppealController`, 비즈니스 로직과 관리자 결정은 `LoginRiskPolicyService`, 영속성은 `LoginRiskPolicyMapper`가 담당한다. 관리자 화면은 `AdminLoginRiskPolicyController`가 제공한다.

| 구성요소 | 클래스/뷰 | 역할 |
| --- | --- | --- |
| 공개 컨트롤러 | `SecurityAppealController` (`/security/appeal/**`) | 폼·검증·제출·결과조회 라우팅 |
| 도메인 서비스 | `LoginRiskPolicyService` | 본인확인·접수·관리자 결정·해제 적용 |
| 매퍼 | `LoginRiskPolicyMapper` + `loginRiskPolicyMapper.xml` | 토큰/신청/정책/감사 CRUD |
| 관리자 컨트롤러 | `AdminLoginRiskPolicyController` (`/admin/login-risk/appeals`) | 목록·결정·일괄처리·내보내기 |
| 신청 VO | `SecurityAppealVO` | 신청 레코드(상태·대상·검토 결과) |
| 토큰 VO | `SecurityAppealTokenVO` | 이메일 검증 토큰(만료·사용시각) |
| 폼 컨텍스트 VO | `SecurityAppealFormVO` | 화면 렌더용 검증 상태·대상 정보 |
| 정책 VO | `SecurityAppealPolicyVO` / `...PolicyHistoryVO` | 신청 정책과 변경 이력 |

DB 테이블:

| 테이블 | 용도 |
| --- | --- |
| `SECURITY_APPEAL`(신청) | 신청 본문·상태(appeal_status)·검토자·검토 코멘트 |
| `SECURITY_ACTION_APPEAL_TOKEN` | 이메일 검증/접근 토큰, 만료·사용 추적 |
| `SECURITY_APPEAL_POLICY` / `..._HISTORY` | 신청 정책 값과 변경 이력 |
| `SECURITY_RISK_ASSESSMENT` | 차단 원인이 된 위험 평가(토큰의 source_assessment_idx로 연결) |

신청 화면 뷰는 `security/appeal/` 아래 `form`, `verify`, `verify-sent`, `done`, `result` JSP로 나뉘며, 모든 화면은 `lang` 파라미터로 4개국어(ko/en/ja/zh)를 지원한다.

## 4. 동작 원리(흐름·표·작은 코드)

진입 방식이 두 가지다. **토큰 진입**(차단 안내 메일의 링크)은 본인확인이 끝난 상태라 바로 신청 폼이 열리고, **요청ID 진입**은 이메일 본인확인을 먼저 통과해야 한다.

```text
[요청ID 진입]
GET /security/appeal/new?requestId=...   -> verify.jsp (이메일 입력)
POST /security/appeal/verify             -> 검증 토큰 생성 + 메일 발송 -> verify-sent.jsp
(메일 링크) GET /security/appeal?token=.. -> form.jsp (신청 작성)
POST /security/appeal                     -> 신청 접수 -> done.jsp (publicRequestId 발급)

[관리자]
GET  /admin/login-risk/appeals            -> 신청 목록
POST /admin/login-risk/appeals/{idx}/{decision} -> ACCEPTED 시 차단 해제

[결과 조회]
POST /security/appeal/result (publicRequestId + 이메일) -> 처리 상태 확인
```

핵심 라우팅 분기는 컨트롤러의 `tokenForm`에 있다. 토큰이 없고 요청ID만 있으면 본인확인 화면으로 보낸다.

```java
if ((token == null || token.isBlank()) && requestId != null && !requestId.isBlank()) {
    return "security/appeal/verify";   // 이메일 본인확인 먼저
}
return "security/appeal/form";          // 토큰 있으면 바로 작성
```

접수 단계(`submitPublicSecurityAppeal`)에서는 유효 토큰 없이는 거부하고, 정책에 따라 거부 쿨다운·누적 거부 한도·IP 일일 한도를 차례로 검사한 뒤, 8자리 공개 추적번호 `SAP-XXXXXXXX`를 발급한다. 동시에 관리자 알림과 보안 감사 로그를 남기고, 사용자 계정과 연동된 경우 내부 문의(Inquiry)도 함께 생성한다.

관리자 결정 상태머신(`decideSecurityAppeal`)은 결정어를 정규화한다.

| 입력 결정 | 정규화 상태 | 효과 |
| --- | --- | --- |
| accept / accepted | ACCEPTED | 차단 해제 적용 + 결과 통지 |
| reject / rejected | REJECTED | 거부, 재신청 쿨다운 시작 |
| hold | HOLD | 보류(기본값) |
| close / closed | CLOSED | 종결 |

ACCEPTED일 때만 `applyAcceptedSecurityAppeal`이 호출되어 실제 차단을 풀고, 모든 결정은 신청자 이메일/사이트 알림으로 결과가 통지된다.

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현됨
- 토큰/요청ID 두 경로 진입, 이메일 본인확인, 검증 메일 발송(`spring-boot-starter-mail`)
- 공개 추적번호(SAP-) 발급, `publicRequestId` + 이메일로 결과 조회
- 관리자 목록·단건 결정·일괄 결정, ACCEPTED 시 차단 해제 적용
- 다단계 레이트리밋(검증 메일/거부 쿨다운/누적 거부/IP 일일/결과 조회 실패)
- 전 과정 보안 감사 로그, 관리자 알림, Excel/CSV 내보내기(Apache POI)
- 4개국어 화면·메일, 정책 값 DB 관리 + 변경 이력
:::

:::warning 한계·주의
- 차단 사유가 된 외부 위험 신호(AWS WAF / Cloudflare 어댑터) 연동 자체는 부분 구현이며, 신청 처리의 신뢰도는 위험 평가 데이터 품질에 의존한다.
- 신청 화면은 JSP 데스크톱 레이아웃 위주로, 모바일 반응형은 향후 과제다.
- 신청 본문에 대한 자동 위험도/독성 정량 평가는 이 채널에는 적용되어 있지 않다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: 차단된 계정·IP가 로그인 없이 이메일 본인확인 후 해제를 신청하고, 관리자가 검토해 차단을 푸는 비인증 워크플로우입니다.
2. **설계 의도**: 차단된 사용자는 로그인할 수 없으니 공개 진입을 허용하되, 토큰·이메일 검증·다단계 레이트리밋·감사 로그로 사칭과 남용을 막았습니다. 자동 해제는 없고 모든 해제는 관리자 승인을 거칩니다.
3. **구현 근거**: `SecurityAppealController`가 토큰/요청ID 폼을 라우팅하고, `LoginRiskPolicyService`가 `SECURITY_ACTION_APPEAL_TOKEN`으로 본인확인을 강제한 뒤 `SECURITY_APPEAL`에 SAP-추적번호로 접수합니다. 관리자가 ACCEPTED로 결정하면 해제가 적용되고 결과가 통지됩니다.

## 7. 꼬리질문+모범답안

:::details 차단된 사용자는 로그인이 안 되는데 어떻게 신청 화면에 접근하나요
세션 인증을 전제하지 않는 공개 라우트 `/security/appeal/**`를 사용합니다. 차단 안내 메일·화면에 담긴 토큰이나 요청ID로만 진입할 수 있고, 요청ID만 있으면 이메일 본인확인을 먼저 통과해야 신청 폼이 열립니다.
:::

:::details 토큰 진입과 요청ID 진입은 무엇이 다른가요
토큰 진입은 검증 메일 링크로 들어오는 경로라 이미 본인확인이 끝난 상태로 간주해 바로 작성 폼을 엽니다. 요청ID 진입은 본인확인 전 단계라 `verify.jsp`로 보내 이메일을 받고, 검증 토큰을 메일로 발급한 뒤 그 링크(토큰 경로)로 다시 들어오게 합니다.
:::

:::details 남용은 어떻게 막나요
정책 기반 다단계 레이트리밋을 둡니다. 일정 시간 내 검증 메일 발송 횟수, 거부 후 재신청 쿨다운, 누적 거부 한도, IP 대상 신청의 일일 한도, 결과 조회 실패 횟수까지 각각 한도를 두고, 한도를 넘으면 신청·조회를 막습니다. 모든 시도는 감사 로그로 남습니다.
:::

:::details 관리자가 승인하면 자동으로 차단이 풀리나요, 결정 상태는 어떻게 나뉘나요
결정은 ACCEPTED / REJECTED / HOLD / CLOSED로 정규화되고, ACCEPTED일 때만 해제 로직이 실행됩니다. 자동 해제는 없으며 관리자의 명시적 결정이 게이트입니다. 모든 결정은 신청자에게 이메일과 사이트 알림으로 통지되고 감사 로그에 기록됩니다.
:::

:::details 신청자는 처리 결과를 어떻게 확인하나요
접수 시 발급한 공개 추적번호(SAP- 접두 8자리)와 본인 이메일을 결과 조회 화면에 입력하면 됩니다. 이메일이 신청 시 저장된 값과 일치해야 하고, 조회 실패가 한도를 넘으면 레이트리밋이 걸립니다. 보관 기간이 지난 신청은 만료로 안내합니다.
:::

## 8. 직접 말해보기

- 차단된 계정이 신청 화면에 접근하는 두 경로와 그 차이를 30초로 설명해보세요.
- 사칭과 스팸을 막기 위한 안전장치를 진입·접수·조회 단계별로 하나씩 들어보세요.
- 관리자 결정 상태 4가지를 말하고, 그중 무엇이 실제 차단 해제를 트리거하는지 설명해보세요.

## 퀴즈

<QuizBox question="차단 해제 신청 채널이 비인증(공개) 진입을 허용하는 근본 이유는 무엇인가" :choices="['관리자 권한이 필요 없어서', '차단된 계정은 로그인할 수 없어 세션 인증 경로를 쓸 수 없기 때문', '이메일 발송 비용을 줄이려고', 'JSP가 세션을 지원하지 않아서']" :answer="1" explanation="차단된 계정은 정의상 로그인할 수 없으므로 세션 인증을 전제한 일반 문의 경로를 쓸 수 없다. 대신 토큰·이메일 검증·레이트리밋으로 남용을 막는다." />

<QuizBox question="요청ID만 가지고 신청 폼에 진입할 때 가장 먼저 요구되는 단계는 무엇인가" :choices="['관리자 승인', '결제 정보 입력', '이메일 본인확인 후 검증 토큰 수신', '캡차 입력']" :answer="2" explanation="토큰이 없고 요청ID만 있으면 verify 화면으로 보내 이메일을 받고 검증 토큰을 메일로 발급한다. 그 토큰 경로로 다시 들어와야 작성 폼이 열린다." />

<QuizBox question="관리자 결정 중 실제 차단 해제 로직을 실행하는 상태는 무엇인가" :choices="['HOLD', 'REJECTED', 'CLOSED', 'ACCEPTED']" :answer="3" explanation="decideSecurityAppeal은 결정을 ACCEPTED, REJECTED, HOLD, CLOSED로 정규화하고 ACCEPTED일 때만 applyAcceptedSecurityAppeal로 차단을 해제한다. 자동 해제는 없다." />
