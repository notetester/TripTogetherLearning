---
title: "감사 로그"
owner: A
domain: "관리자·운영"
tags: ["감사"]
---

# 감사 로그

> 감사 로그는 단일 테이블이 아니라 Who·When·Why를 다른 각도에서 보는 네 갈래 기록(관리자 조치·로그인·보안 이벤트·일반 활동)이며, 이들을 request_id 와 flow_trace_id 로 가로질러 한 사건을 재구성하는 추적성 인프라다.

## 1. 한 줄 정의

누가(actor) 언제(timestamp) 무엇에(target) 왜(reason_code) 어떤 조치를 했는지를 책임 추적이 가능한 형태로 영구 기록하고, 인증/계정/일반 활동 이력을 같은 요청 식별자로 묶어 한 사건의 전후 맥락을 추적할 수 있게 하는 운영 감사 계층이다.

## 2. 왜 이렇게 설계했나

관리자 권한은 회원 차단·콘텐츠 삭제·설정 변경처럼 되돌리기 어려운 영향을 미친다. 사후에 분쟁이나 보안 사고가 발생했을 때 누가 무슨 근거로 그 조치를 했는지 답할 수 없으면 운영 신뢰가 무너진다. 그래서 조치 기록은 선택이 아니라 책임 추적성(accountability)의 기본 요건이다.

핵심 설계 결정은 세 가지다.

첫째, **로그를 책임 범위별로 분리**했다. 보안 외 일반 관리자 조치는 `ADMIN_ACTION_AUDIT`, 인증 이벤트는 `USER_LOGIN_HISTORY`, 계정 복구/비밀번호 변경 같은 민감 보안 이벤트는 `USER_SECURITY_HISTORY`, 서비스 전반의 광범위한 활동은 `USER_ACTIVITY_LOG` 가 맡는다. 하나의 거대한 로그 테이블은 쓰기 경합과 질의 비용이 커지고, 보존 정책과 접근 권한을 차등화하기 어렵다.

둘째, **자유 텍스트가 아니라 표준 사유 코드(reason_code)** 를 1급 시민으로 올렸다. detail_summary 같은 사람용 문장만 남기면 집계·필터·다국어 표시가 불가능하다. 그래서 reason_code(예: ADMIN.INITIAL_SETTINGS.EXPORT)로 사유를 코드화하고, 가변 인자는 `reason_args` JSON 컬럼에 구조화해 둔다.

셋째, **request_id 와 flow_trace_id 로 추적성**을 부여했다. 한 번의 HTTP 요청은 request_id(UUID) 하나로 식별되고, 이메일 발송에서 검증까지 여러 요청에 걸친 흐름은 flow_trace_id 하나로 묶인다. 이 두 식별자가 활동 로그·로그인 이력·보안 이력에 공통으로 박혀 있어, 하나의 사건을 테이블을 가로질러 재구성할 수 있다.

:::tip 감사 로그 vs 활동 로그
`USER_ACTIVITY_LOG` 는 정적 리소스를 뺀 거의 모든 요청을 자동으로 넓게 기록하는 텔레메트리에 가깝다. `ADMIN_ACTION_AUDIT` 는 관리자가 의도적으로 내린 결정적 조치만 사유 코드와 함께 좁게 기록하는 책임 추적 로그다. 둘은 보존 정책도 접근 권한도 다르게 다뤄야 한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

네 갈래 기록과 그것을 다루는 실제 구성요소는 다음과 같다.

| 책임 | 테이블 | VO / 컴포넌트 |
| --- | --- | --- |
| 관리자 조치 감사 | `ADMIN_ACTION_AUDIT` | `AdminActionAuditVO`, `AdminActionAuditService.record(...)` |
| 로그인/로그아웃 이력 | `USER_LOGIN_HISTORY` | `AdminLoginAuditVO`(조회용), `UserLoginHistoryVO` |
| 계정/인증 보안 이벤트 | `USER_SECURITY_HISTORY` | `AdminSecurityAuditVO`(조회용), `UserSecurityHistoryVO` |
| 일반 활동 텔레메트리 | `USER_ACTIVITY_LOG` | `ActivityLogInterceptor`, `UserActivityLogVO` |

`ADMIN_ACTION_AUDIT` 의 핵심 컬럼은 Who/When/What/Why 축에 정확히 대응한다.

| 컬럼 | 의미 | 축 |
| --- | --- | --- |
| `actor_user_idx` | 조치를 수행한 관리자 user_idx | Who |
| `created_at` | 조치 시각 (기본값 CURRENT_TIMESTAMP) | When |
| `action_type` / `action_domain` | 조치 유형 / 업무 도메인 | What |
| `target_type` / `target_id` | 대상 유형 / 대상 식별자 | What (대상) |
| `reason_code` / `reason_args` | 표준 사유 코드 / 사유 인자 JSON | Why |
| `detail_summary` | 사람이 읽는 요약 (최대 1000자) | 보조 |

`AdminActionAuditService.record(...)` 는 위 필드를 그대로 인자로 받아 `AdminMapper.insertAdminActionAudit` 으로 한 줄 INSERT 한다. 관리자 화면 조회용 VO(`AdminLoginAuditVO`, `AdminSecurityAuditVO`)는 이력 테이블과 `USERS` 를 조인해 actor/target 의 닉네임까지 함께 담는다.

테이블 차원의 안전장치도 의도적으로 설계됐다.

- `actor_user_idx` 등 사용자 외래키는 모두 `ON DELETE SET NULL` 이다. 관리자 계정이 삭제돼도 감사 행 자체는 사라지지 않고 보존된다.
- `reason_args` 는 MySQL `json` 타입이라 인자를 구조화해 담을 수 있다.
- 조회 패턴에 맞춘 복합 인덱스가 풍부하다. 예: `(action_domain, created_at)`, `(action_type, created_at)`, `(actor_user_idx, created_at)`, `(target_type, target_id)`, `(reason_code, created_at)`.

## 4. 동작 원리 (흐름·표·작은 코드)

### 관리자 조치 기록 (의도적 호출)

관리자 조치는 자동 인터셉터가 아니라, 조치를 수행하는 컨트롤러가 명시적으로 한 줄을 남긴다. 초기 설정 내보내기를 예로 들면 다음과 같다.

```text
// AdminInitialSettingsController (개념 축약)
adminActionAuditService.record(
    "INITIAL_SETTINGS_EXPORT",        // action_type
    "SYSTEM_CONFIG",                  // action_domain
    currentAdminIdx(session),         // actor_user_idx (Who)
    "INITIAL_SETTINGS", "EXPORT",     // target_type / target_id (What)
    "ADMIN.INITIAL_SETTINGS.EXPORT",  // reason_code (Why)
    null,                             // reason_args (JSON)
    "initial settings exported"       // detail_summary
);
```

가져오기(import) 시에는 `reason_args` 에 적용/생략 건수를 JSON으로 담아 사후 분석이 가능하게 한다. 이처럼 사유를 코드로 고정하면 같은 reason_code 기준으로 빈도 집계와 다국어 라벨링이 자연스럽게 따라온다.

### request_id 생성과 전파 (추적성의 근원)

추적성의 출발점은 `ActivityLogInterceptor` 다. 모든 주요 요청의 `preHandle` 에서 UUID 를 만들어 request 속성에 심고, `afterCompletion` 에서 활동 로그 한 줄을 INSERT 한다.

```text
// ActivityLogInterceptor (개념 축약)
preHandle:  request.setAttribute(ATTR_REQUEST_ID, UUID.randomUUID());
afterCompletion:
    requestId    = request.getAttribute(ATTR_REQUEST_ID);
    flowTraceId  = override 있으면 그 값, 없으면 requestId;
    insertActivityLog(requestId, flowTraceId, userIdx, uri, status, ...);
```

핵심은 `flow_trace_id` 의 기본값이 request_id 라는 점이다. 단일 요청이면 둘이 같고, 이메일 발송→검증처럼 여러 요청이 한 흐름이면 첫 요청의 식별자를 override 속성으로 넘겨 흐름 전체를 하나로 묶는다. 같은 요청 안에서 발생한 로그인 이력·보안 이벤트도 이 두 식별자를 공유하므로, 사건 재구성은 식별자 기준 JOIN/필터로 끝난다.

### 한 사건을 가로질러 재구성하기

```text
[요청] POST /TripTogether/auth/reset-pw
   request_id = R1 (이번 요청)
   flow_trace_id = F  (메일 발송 요청에서 시작된 흐름)
        |
        ├─ USER_ACTIVITY_LOG       request_id=R1  flow_trace_id=F   (어느 URI, 응답코드)
        ├─ USER_SECURITY_HISTORY   request_id=R1  flow_trace_id=F   (RESET_PASSWORD 성공/실패)
        └─ USER_LOGIN_HISTORY      request_id=R1  flow_trace_id=F   (자동 로그인 시)
```

운영자는 `flow_trace_id = F` 로 세 테이블을 조회해 메일 발송 → 토큰 검증 → 비밀번호 재설정 → 후속 로그인까지의 타임라인을 한 화면으로 복원한다. 민감 이벤트가 어느 일반 활동의 결과였는지를 끊김 없이 잇는 것이 이 설계의 본질이다.

### 입력값 마스킹

활동 로그는 쿼리스트링을 그대로 남기지 않는다. `token`, `password`, `newPassword`, `currentPassword`, `code`, `state` 같은 민감 키는 값을 `***` 로 마스킹하고, Referer 의 쿼리 부분도 제거한다. 추적성은 식별자(request_id)로 확보하되, 평문 비밀은 로그에 남기지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::warning 구현됨 vs 한계
**구현됨**
- `ADMIN_ACTION_AUDIT` 테이블과 `AdminActionAuditService.record(...)` 단일 진입점, 사유 코드 기반 기록 (예: 초기 설정 내보내기/가져오기)
- `USER_LOGIN_HISTORY` / `USER_SECURITY_HISTORY` 와 그 관리자 조회 VO(`AdminLoginAuditVO`, `AdminSecurityAuditVO`) — actor/target 닉네임 조인 포함
- `ActivityLogInterceptor` 의 request_id 자동 생성, flow_trace_id 기본 전파, 민감 키 마스킹, 조회 최적화 복합 인덱스
- 사용자 외래키 ON DELETE SET NULL 로 감사 행 보존

**한계/계획**
- 모든 관리자 조치가 `ADMIN_ACTION_AUDIT` 로 record 되는지는 호출 측 컨트롤러가 각자 호출해야 하는 수작업 의존 — AOP 자동 감사 같은 강제 장치는 없음
- 분산 추적 표준(W3C traceparent)과의 연동, 로그 변조 방지(append-only/해시 체인) 같은 무결성 보장은 미적용
- 로그 보존/만료 정책의 자동화(파티셔닝·아카이빙)는 코드로 강제되어 있지 않음
:::

## 6. 면접 답변 3단계

1. **한 문장**: 감사 로그는 관리자 조치(`ADMIN_ACTION_AUDIT`)·로그인 이력·보안 이벤트·일반 활동을 책임 범위별로 나눠 기록하고, request_id 와 flow_trace_id 로 한 사건을 테이블을 가로질러 재구성할 수 있게 한 운영 감사 계층입니다.
2. **설계 의도**: 관리자 권한은 되돌리기 어려운 영향을 주므로, 자유 텍스트 대신 표준 사유 코드(reason_code)와 actor/target 을 1급으로 남겨 누가·왜를 집계 가능하게 했고, 사용자 외래키를 ON DELETE SET NULL 로 둬 계정이 삭제돼도 감사 행은 보존됩니다.
3. **트레이드오프**: 추적성은 인터셉터가 만든 request_id 전파로 확보하되 비밀값은 마스킹했고, 다만 관리자 조치 기록은 호출 측이 명시적으로 record 해야 하는 수작업 의존과 로그 무결성(append-only) 미적용이라는 한계가 남아 향후 과제로 둡니다.

## 7. 꼬리질문 + 모범답안

:::details ADMIN_ACTION_AUDIT 와 USER_ACTIVITY_LOG 는 무엇이 다른가요
USER_ACTIVITY_LOG 는 인터셉터가 정적 리소스를 뺀 거의 모든 요청을 자동으로 넓게 남기는 텔레메트리고, ADMIN_ACTION_AUDIT 는 관리자가 의도적으로 내린 결정적 조치만 사유 코드와 함께 좁게 남기는 책임 추적 로그입니다. 전자는 빈도가 높아 보존/샘플링 정책이 중요하고, 후자는 한 줄 한 줄이 책임 근거라 보존이 더 엄격해야 합니다.
:::

:::details reason_code 를 따로 두는 이유가 뭔가요. detail_summary 면 충분하지 않나요
detail_summary 는 사람용 문장이라 집계·필터·다국어 표시에 쓸 수 없습니다. reason_code 를 코드(예: ADMIN.INITIAL_SETTINGS.EXPORT)로 고정하면 같은 사유 기준으로 빈도 집계와 인덱스 조회가 가능하고, 가변 부분은 reason_args JSON 으로 구조화해 둘 다 만족시킵니다. 조회 인덱스도 reason_code, created_at 조합으로 잡혀 있습니다.
:::

:::details request_id 와 flow_trace_id 의 차이를 설명해 주세요
request_id 는 단일 HTTP 요청 하나를 식별하는 UUID 로, 인터셉터의 preHandle 에서 생성됩니다. flow_trace_id 는 이메일 발송에서 검증까지 여러 요청에 걸친 동일 활동 흐름을 묶는 UUID 입니다. 기본값은 request_id 와 같고, 다단계 흐름일 때만 첫 요청의 값을 override 로 이어받아 흐름 전체를 하나로 연결합니다.
:::

:::details 감사 대상 관리자 계정이 삭제되면 로그는 어떻게 되나요
actor_user_idx 외래키가 ON DELETE SET NULL 이라 행 자체는 삭제되지 않고 actor 만 NULL 로 바뀝니다. 책임 추적 로그가 참조 무결성 때문에 함께 지워지면 감사의 목적이 무너지므로, 의도적으로 행 보존을 선택한 설계입니다. 보조로 detail_summary 에 사람이 읽는 맥락이 남습니다.
:::

:::details 비밀번호나 토큰이 로그에 평문으로 남지 않나요
ActivityLogInterceptor 가 쿼리스트링을 저장하기 전에 token, password, newPassword, currentPassword, code, state 같은 민감 키의 값을 *** 로 마스킹하고 Referer 의 쿼리 부분도 제거합니다. 추적성은 평문 비밀이 아니라 request_id 같은 식별자로 확보한다는 원칙입니다.
:::

## 8. 직접 말해보기

- ADMIN_ACTION_AUDIT 의 컬럼을 Who/When/What/Why 축으로 30초 안에 매핑해 설명해 보세요.
- request_id 하나로 활동·보안·로그인 이력을 어떻게 가로질러 재구성하는지, flow_trace_id 가 추가로 푸는 문제가 무엇인지 말해 보세요.
- 자유 텍스트 요약 대신 reason_code 를 1급으로 둔 이유와, 그로 인해 가능해지는 운영 작업을 한 가지 들어 보세요.
- 이 감사 설계의 한계(수작업 record 의존, 로그 무결성 미적용)를 인정하고 개선 방향을 제시해 보세요.

## 퀴즈

<QuizBox question="ADMIN_ACTION_AUDIT 에서 Why(왜 그 조치를 했는가)를 집계 가능한 형태로 담는 컬럼 조합은 무엇인가" :choices="['detail_summary 단일', 'reason_code 와 reason_args', 'action_type 과 target_id', 'actor_user_idx 와 created_at']" :answer="1" explanation="사람용 문장인 detail_summary 대신 표준 사유 코드 reason_code 와 구조화 인자 reason_args JSON 으로 사유를 담아 집계와 필터, 다국어 표시가 가능하게 한다." />

<QuizBox question="단일 HTTP 요청을 식별하는 request_id 와 여러 요청에 걸친 흐름을 묶는 flow_trace_id 의 관계로 옳은 것은" :choices="['둘은 항상 다른 값이다', 'flow_trace_id 의 기본값은 request_id 이고 다단계 흐름일 때만 첫 요청 값을 이어받는다', 'request_id 가 flow_trace_id 를 항상 덮어쓴다', 'flow_trace_id 는 관리자만 수동 입력한다']" :answer="1" explanation="ActivityLogInterceptor 는 flow_trace_id 가 없으면 request_id 를 그대로 쓰고, 이메일 발송에서 검증까지 같은 흐름일 때만 첫 요청의 식별자를 override 로 이어받아 흐름 전체를 하나로 묶는다." />

<QuizBox question="감사 대상 관리자 계정이 삭제될 때 ADMIN_ACTION_AUDIT 행이 보존되도록 하는 외래키 설정은 무엇인가" :choices="['ON DELETE CASCADE', 'ON DELETE SET NULL', 'ON DELETE RESTRICT', '외래키 없음']" :answer="1" explanation="actor_user_idx 외래키가 ON DELETE SET NULL 이라 관리자 계정이 삭제돼도 감사 행은 사라지지 않고 actor 만 NULL 로 바뀐다. 책임 추적 로그가 참조 무결성 때문에 함께 지워지는 것을 막는 의도된 설계다." />
