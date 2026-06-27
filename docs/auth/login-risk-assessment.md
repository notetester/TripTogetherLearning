---
title: "로그인 위험도 평가"
owner: A
domain: "인증·계정·보안"
tags: ["위험평가", "감사"]
---

# 로그인 위험도 평가

> 로그인 실패와 접속 패턴을 정책 기반으로 집계해 계정·IP를 자동 잠그고, AI/외부 모듈은 보조 판단만 제안하며 최종 차단은 관리자 검토 또는 결정적 임계값으로 확정한다.

## 1. 한 줄 정의

로그인 위험도 평가는 `USER_LOGIN_HISTORY`에 쌓인 인증 이력을 정책(`LOGIN_RISK_POLICY`)에 따라 집계해, 계정 단위·IP 단위로 반복 실패와 분산 공격 징후를 감지하고, 임계값 도달 시 임시 잠금·보호조치·관리자 검토 큐 등록을 수행하는 인증 보안 계층이다.

## 2. 왜 이렇게 설계했나

비밀번호 단순 검증만으로는 크리덴셜 스터핑(한 IP가 수많은 계정을 시도)과 무차별 대입(한 계정을 반복 시도)을 막을 수 없다. 그래서 두 축을 분리해서 본다.

- **계정 축**: 특정 사용자의 최근 실패 횟수가 기준을 넘으면 그 계정만 임시 잠근다. 정상 사용자가 옆 사람 때문에 막히지 않게 한다.
- **IP 축**: 한 IP에서 발생한 실패 수와 그 IP가 건드린 서로 다른 식별자 수(분산도)를 함께 본다. 식별자가 많을수록 스터핑 신호가 강하다.

또 핵심 설계 판단이 두 가지 있다.

:::tip 정책을 코드가 아니라 DB로
임계값·관찰 기간·잠금 시간·경고 시작 횟수를 모두 `LOGIN_RISK_POLICY` 행으로 둔다. 운영 중 공격 강도에 맞춰 관리자가 값을 조정하고, 변경 이력은 `LOGIN_RISK_POLICY_HISTORY`에 스냅샷으로 남는다. 코드 재배포 없이 보안 강도를 바꾼다.
:::

:::warning AI는 제안만, 차단은 결정적으로
AI/외부 위험 모듈의 출력은 곧장 차단으로 이어지지 않는다. 결과는 PROPOSED 상태로 `LOGIN_RISK_EXTERNAL_ASSESSMENT`에 적재되고, 실제 잠금은 결정적 임계값 또는 관리자 승인으로만 확정된다. 모델 오탐이 정상 사용자를 즉시 막는 사고를 구조적으로 차단한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 실제 식별자 | 역할 |
| --- | --- | --- |
| 핵심 엔진 | `LoginRiskPolicyService` | 계정/IP 평가, 잠금·보호·검토 큐 등록 |
| 호출 지점 | `AuthServiceImpl.login()` | checkPreLogin → 비번검증 → handleWrongPassword/handleLoginSuccess |
| 보조 판단 확장점 | `LoginRiskAssessmentProvider` (인터페이스) | 외부 모듈을 Bean으로 꽂는 SPI |
| HTTP 어댑터 진입 | `HttpSecurityAssessmentProvider` | enabled 프로바이더 + `SecurityAssessmentAdapter` 체인 위임 |
| 외부 호출 어댑터 | `GenericAiRiskAssessmentAdapter`, `GenericPolicyAuthorityAssessmentAdapter` | 실제 외부 엔드포인트 호출(HTTP) |
| Mock 어댑터 | `InternalAiGatewayStubAssessmentAdapter` | 외부 연동 전 항상 PASS 반환(stub) |
| 요청/응답 DTO | `LoginRiskAssessmentRequest`, `LoginRiskAssessmentResult` | ip·country·asn·observedCount·distinctIdentifierCount 등 운반 |
| 결정 결과 | `LoginRiskDecisionVO` | denied/locked/actionType/blockedUntil/remainingAttempts |

핵심 테이블:

- `USER_LOGIN_HISTORY` — 모든 로그인/로그아웃 시도. user_idx, is_success, fail_reason, ip_address, user_agent, request_id, flow_trace_id. 위험 집계의 원천이자 감사 로그.
- `LOGIN_RISK_POLICY` — policy_code, threshold_count, observation_minutes, distinct_account_threshold, lock_duration_minutes, warning_before_count, ai_assist_enabled.
- `LOGIN_RISK_REVIEW_QUEUE` — 관리자 검토 대상(PENDING → APPROVED/REJECTED/HOLD).
- `LOGIN_RISK_EXTERNAL_ASSESSMENT` — AI/외부/기관 판단 결과. risk_score, risk_level, recommendation_action, decision_status(PROPOSED/APPLIED/IGNORED/PENDING), country_code, asn.

## 4. 동작 원리 (흐름·표·작은 코드)

로그인 한 번에서 위험 평가가 끼어드는 지점은 셋이다.

```text
login(identifier, password, context)
  1) checkPreLogin        -> 이미 IP 잠금이면 즉시 거부
  2) 비밀번호 불일치       -> handleWrongPassword (계정/IP 평가)
  3) 비밀번호 일치 성공     -> handleLoginSuccess  (카운터 리셋)
```

**계정 축 평가** (`evaluateAccountWrongPassword`):

```text
관찰창 내 해당 계정 실패수 = countRecentWrongPasswordByUser(userIdx, since)
if 실패수 >= threshold:
    계정 임시 잠금(blockedUntil) + RiskEvent(THRESHOLD_REACHED) + maybeProtectAccount
elif 남은횟수 <= warningBeforeCount:
    경고 메시지(remainingAttempts) 반환
```

**IP 축 평가** (`evaluateIpWrongPassword`): `failures = countRecentWrongPasswordByIp`, `distinct = countRecentDistinctIdentifiersByIp`. 두 조건이 모두 임계를 넘으면 IP 잠금을, 더 강한 임계를 넘으면 관리자 검토(`maybeCreateIpReview`)를 만든다.

| 신호 | 집계 함수 | 결과 actionType |
| --- | --- | --- |
| 계정 반복 실패 | countRecentWrongPasswordByUser | ACCOUNT_TEMP_LOCK |
| 계정 잠금 반복 | countRecentAccountLocks | ACCOUNT_PROTECTION_REQUIRED |
| IP 실패 + 분산 | countRecentWrongPasswordByIp / DistinctIdentifiers | IP_LOGIN_LOCK |
| IP 의심(고임계) | 동일 + require_admin_review | 관리자 검토 큐 |

**보호조치와 항소**: `maybeProtectAccount`는 한 계정이 짧은 기간에 반복적으로 잠기면 보호 상태로 두고, 이메일 검증된 사용자에게 일회성 토큰이 담긴 항소(appeal) 링크를 메일로 보낸다. 즉 고위험 계정은 자동 차단 후, 본인 이메일 검증을 통한 차단 해제 신청 경로로 복구한다.

**보조 판단 파이프라인** (`recordAssessmentCandidates`): 정책에 `ai_assist_enabled`가 켜져 있으면 등록된 `LoginRiskAssessmentProvider`들을 호출한다. 결과가 있으면 PROPOSED로, 없으면 PENDING(READY_FOR_PROVIDER)으로 `LOGIN_RISK_EXTERNAL_ASSESSMENT`에 적재한다. 어느 경로든 즉시 차단하지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 계정/IP 임계 기반 자동 잠금 | 구현됨 |
| 정책 DB화 + 변경 이력 스냅샷 | 구현됨 |
| 분산도(distinct identifier) 기반 IP 평가 | 구현됨 |
| 관리자 검토 큐 + 알림 | 구현됨 |
| 반복 잠금 보호조치 + 이메일 항소 토큰 | 구현됨 |
| `USER_LOGIN_HISTORY` 감사 적재 | 구현됨 |
| AI/외부 보조 판단 SPI + 어댑터 체인 | 구조 구현됨 |
| 실제 외부 AI/관제 엔드포인트 연동 | 기본은 Mock(`InternalAiGatewayStubAssessmentAdapter`가 PASS) |
| country_code·asn(GeoIP) 채움 | 스키마·DTO는 준비, 호출부는 대부분 null 전달(계획) |
| MFA(2차 인증, TOTP/SMS) | 미구현 — 고위험은 잠금+이메일 항소로 대응 |

:::warning 정직한 한계
GeoIP 기반 지역 변경 감지는 컬럼(country_code, asn)과 DTO 필드까지 갖췄지만, 실제 평가 호출에서 이 값을 채워 넣는 enrichment는 아직 연결되지 않아 현재 평가는 실패 횟수·분산도·시간창 중심이다. 또한 별도의 2차 인증(MFA) 단계는 없고, 고위험 계정은 임시 잠금 후 이메일 검증 기반 항소로 복구한다. 면접에서는 이 둘을 확장 포인트로 솔직히 말하는 편이 강하다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "로그인 실패 이력을 정책 기반으로 계정 축과 IP 축으로 나눠 집계해 임계값에서 자동 잠그고, AI/외부 모듈은 보조 제안만 하고 최종 차단은 결정적 규칙이나 관리자 검토로 확정합니다."
2. **설계 의도**: "크리덴셜 스터핑과 무차별 대입은 신호가 다릅니다. IP가 건드린 서로 다른 식별자 수까지 봐서 분산 공격을 잡고, 임계값은 DB 정책으로 빼서 재배포 없이 강도를 조정합니다."
3. **안전장치**: "모델 출력이 사용자를 즉시 막지 못하게 PROPOSED 상태로만 적재하고, 모든 시도는 `USER_LOGIN_HISTORY`에 감사로 남깁니다. 보호조치는 본인 이메일 검증 항소로 되돌릴 수 있게 했습니다."

## 7. 꼬리질문 + 모범답안

:::details 왜 계정 잠금과 IP 잠금을 분리했나?
공격 모델이 다르기 때문이다. 한 계정 반복 실패는 그 계정만 임시 잠그면 충분하고, 한 IP가 다수 식별자를 시도하면 IP 자체를 막아야 한다. 분리하면 정상 사용자가 같은 IP의 공격자 때문에 무차별로 막히는 일을 줄이고, 각 축에 맞는 임계값을 따로 둘 수 있다.
:::

:::details distinct identifier count는 무엇을 잡나?
한 IP에서 시도한 서로 다른 로그인 식별자 수다. 같은 계정만 반복하면 무차별 대입이지만, 짧은 시간에 수십 개 계정을 건드리면 크리덴셜 스터핑 신호다. `distinct_account_threshold`로 이 분산도가 임계를 넘을 때만 IP 잠금·검토를 발동해 오탐을 줄인다.
:::

:::details AI 판단이 곧바로 차단하지 않는 이유는?
모델은 오탐을 낸다. 그 출력이 즉시 차단으로 이어지면 정상 사용자가 모델 실수로 막힌다. 그래서 결과를 PROPOSED 또는 PENDING으로 `LOGIN_RISK_EXTERNAL_ASSESSMENT`에 적재만 하고, 실제 적용은 결정적 임계값이나 관리자 승인을 거친다. 자동화의 속도와 사람 검토의 안전성을 분리한 것이다.
:::

:::details 임계값을 코드가 아니라 DB에 둔 이유는?
공격 강도는 시시각각 바뀐다. DB 정책으로 빼면 운영자가 관찰 기간·임계·잠금 시간을 즉시 조정할 수 있고, 변경은 `LOGIN_RISK_POLICY_HISTORY`에 전후 스냅샷으로 남아 감사와 롤백이 된다. 보안 파라미터를 코드 배포 주기에 묶지 않으려는 결정이다.
:::

:::details 위험 평가와 감사는 어떻게 연결되나?
모든 로그인/로그아웃 시도는 성공·실패 무관하게 `USER_LOGIN_HISTORY`에 ip_address, fail_reason, request_id, flow_trace_id와 함께 기록된다. 위험 집계 함수(countRecentWrongPasswordByUser 등)는 바로 이 테이블을 시간창으로 질의한다. 즉 감사 로그가 곧 위험 평가의 입력이라, 별도 파이프라인 없이 일관성을 유지한다.
:::

## 8. 직접 말해보기

- 계정 축과 IP 축 평가가 각각 무엇을 막는지, 그리고 distinct identifier가 왜 필요한지 30초로 설명해 보라.
- "AI가 위험하다고 했는데 왜 자동으로 안 막느냐"는 질문에, PROPOSED 상태와 관리자 검토 큐를 근거로 답해 보라.
- 현재 GeoIP와 MFA가 어디까지 되어 있는지(스키마는 있으나 enrichment 미연결, MFA 미구현)를 과장 없이 말해 보라.

## 퀴즈

<QuizBox question="로그인 위험 평가에서 한 IP가 건드린 서로 다른 로그인 식별자 수(distinct identifier count)가 주로 잡아내려는 공격은?" :choices="['단일 계정 무차별 대입', '여러 계정을 노리는 크리덴셜 스터핑', 'SQL 인젝션', '세션 고정 공격']" :answer="1" explanation="분산도가 높다는 것은 한 출발지가 다수 계정을 시도한다는 뜻으로 크리덴셜 스터핑 신호다. distinct_account_threshold로 이 분산도를 본다." />

<QuizBox question="AI/외부 모듈의 위험 판단 결과가 LOGIN_RISK_EXTERNAL_ASSESSMENT에 PROPOSED로 적재될 때 일어나는 일로 옳은 것은?" :choices="['해당 계정이 즉시 영구 차단된다', '곧바로 IP가 WAF에 동기화된다', '제안 상태로만 남고 적용은 결정적 임계값이나 관리자 승인을 거친다', '사용자에게 자동으로 MFA가 강제된다']" :answer="2" explanation="모델 오탐이 사용자를 즉시 막지 못하도록 PROPOSED는 제안일 뿐이며 실제 적용은 결정적 규칙 또는 관리자 검토로만 확정된다." />

<QuizBox question="로그인 위험 평가의 집계 입력이자 감사 기록을 동시에 담당하는 테이블은?" :choices="['LOGIN_RISK_POLICY', 'USER_LOGIN_HISTORY', 'LOGIN_RISK_WAF_SYNC_QUEUE', 'SECURITY_ASSESSMENT_PROVIDER_CONFIG']" :answer="1" explanation="모든 로그인 시도가 USER_LOGIN_HISTORY에 기록되고, 위험 집계 함수가 이 테이블을 시간창으로 질의하므로 감사와 평가 입력이 한 곳에서 일관된다." />
