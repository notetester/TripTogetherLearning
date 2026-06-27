---
title: "WAF 어댑터(AWS/Cloudflare)"
owner: A
domain: "인증·계정·보안"
tags: ["WAF", "어댑터"]
---

# WAF 어댑터(AWS/Cloudflare)

> 위험 판정으로 결정된 IP/CIDR 차단을, 운영사별로 다른 외부 보안 장비(AWS WAF, Cloudflare, Nginx)에 동기화하는 어댑터 계층이다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
이웃 페이지: [로그인 위험도 평가](/auth/login-risk-assessment) · [차단 해제 신청](/auth/security-appeal) · [모더레이션·거버넌스](/flow/moderation-governance)

## 1. 한 줄 정의

WAF 어댑터는 `WafSyncAdapter` 인터페이스 하나에 운영사별 구현체(`AwsWafSdkAdapter`, `CloudflareDirectWafAdapter`, `NginxDirectWafAdapter`, Gateway 변형)를 꽂아두고, DB에 활성화된 Provider 설정을 보고 적절한 어댑터로 차단/해제 명령을 라우팅하는 구조다.

## 2. 왜 이렇게 설계했나

같은 의미의 "이 IP를 막아라"가 외부 장비마다 호출 방식이 전혀 다르다. AWS는 SDK로 IPSet 주소 목록을 갱신하고, Cloudflare는 REST API에 JSON을 POST하며, Nginx는 별도 관리 API를 친다. 이 차이를 위험 판정 로직 안에 섞으면 분기 지옥이 된다.

- **어댑터 패턴으로 차이를 격리한다.** 호출부(`HttpWafSyncProvider`)는 `WafSyncAdapter` 인터페이스만 알고, 운영사별 프로토콜은 각 구현체가 흡수한다.
- **설정 주도(DB-driven).** 어떤 장비를 쓸지는 코드 배포가 아니라 `SECURITY_ASSESSMENT_PROVIDER_CONFIG` 테이블의 `provider_code`/`endpoint_url`로 결정된다. 운영 중 장비를 추가/교체해도 코드 변경이 없다.
- **계층화된 방어(Defense in Depth).** 활성 Provider가 여러 개면 하나만 고르지 않고 가능한 어댑터를 모두 실행한 뒤 결과를 합산한다. 앞단(Cloudflare)과 클라우드 WAF(AWS)를 동시에 막는 것이 보안의 정석이기 때문이다.
- **장애 시 안전 정책 분리.** 외부 장비 호출이 실패해도 서비스 로그인 흐름이 멈추면 안 되므로, Provider별 `fail_open` 플래그로 실패를 "대기/검토"로 둘지 "실패 확정"으로 둘지 정한다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

핵심은 인터페이스 1개와 그것을 구현하는 어댑터 군, 그리고 이들을 모아 라우팅하는 Provider다.

| 클래스 | 역할 | `@Order` |
| --- | --- | --- |
| `WafSyncAdapter` (인터페이스) | `supports(provider, item)` + `sync(provider, item)` 계약 | - |
| `MockWafSyncAdapter` | 데모/모의 Provider를 외부 호출 없이 로컬 처리 | 0 (최우선) |
| `AwsWafSdkAdapter` | AWS SDK v2 `Wafv2Client`로 IPSet 직접 갱신 | 10 |
| `CloudflareDirectWafAdapter` | Cloudflare API 직접 호출(HTTP 위임) | 10 |
| `NginxDirectWafAdapter` | Nginx 관리 API 직접 호출(HTTP 위임) | 10 |
| `AwsWafGatewayAdapter` / `CloudflareWafGatewayAdapter` | 내부 Gateway 경유 호출 | 20 |
| `HttpWafSyncProvider` | 활성 Provider 조회 → 지원 어댑터로 라우팅 → 결과 합산 | - |
| `WafSyncHttpClient` | HTTP 어댑터 공통 처리(엔드포인트 검증·메서드·재시도·시크릿) | - |
| `SecurityProviderSecretResolver` | `ENV:` / `PROP:` 참조명을 실제 API 키로 해석 | - |

데이터·VO:

- `SECURITY_ASSESSMENT_PROVIDER_CONFIG` 테이블 → `SecurityAssessmentProviderConfigVO` (provider_code, provider_kind, endpoint_url, api_key_ref, model_name, fail_open, retry_count 등)
- `SECURITY_WAF_SYNC_QUEUE` 테이블 → `SecurityWafSyncQueueVO` (sync_action, target_type IP/CIDR, target_value, status)
- 활성 Provider 목록은 `LoginRiskPolicyMapper.findEnabledWafProviderConfigs()`로 조회

위험 판정(`AI_MODEL` Provider)에는 형제 어댑터 `SecurityAssessmentAdapter` / `GenericAiRiskAssessmentAdapter`가 같은 패턴으로 분리되어 있다. 자세한 판정 로직은 [로그인 위험도 평가](/auth/login-risk-assessment) 참고.

## 4. 동작 원리(흐름·표·작은 코드)

### 라우팅 흐름

`HttpWafSyncProvider.sync(item)`이 큐 항목 하나를 받아 다음을 수행한다.

```text
큐 항목(SecurityWafSyncQueueVO: BLOCK / IP / 203.0.113.x)
  ↓ findEnabledWafProviderConfigs() 로 활성 Provider 전부 조회
  ↓ 각 Provider마다 @Order 오름차순으로 adapter.supports(provider, item) 검사
  ↓ 처음 true인 어댑터 1개가 그 Provider를 처리 (break)
  ↓ 여러 Provider면 결과 리스트를 합산
최종 status = FAILED? > EXTERNAL_PROVIDER_PENDING? > SYNCED
```

`supports()` 분기는 `provider_code` 접두사로 갈린다. Mock(`@Order(0)`)이 먼저 가로채고, 그다음 Direct(`@Order(10)`), 마지막에 Gateway(`@Order(20)`)가 잡는다. AWS만 SDK 어댑터라 엔드포인트 URL이 없어도 동작하고, Cloudflare/Nginx Direct는 `endpoint_url`이 있어야 `supports()`가 true다.

### AWS는 SDK로 IPSet을 직접 갱신

`AwsWafSdkAdapter`는 HTTP가 아니라 `Wafv2Client`를 쓴다. IPSet은 낙관적 잠금(lock token)을 쓰므로, 현재 목록을 읽어 수정한 뒤 같은 토큰으로 되쓰는 read-modify-write다.

```java
// model_name = region=ap-northeast-2;scope=REGIONAL;ipSetId=...;ipSetName=...
GetIpSetResponse current = client.getIPSet(...);          // 현재 주소 + lockToken
List<String> addresses = new ArrayList<>(current.ipSet().addresses());

if (isRemoveAction(action)) addresses.remove(target);     // UNBLOCK/ALLOW/DELETE/REMOVE
else if (!addresses.contains(target)) addresses.add(target);

client.updateIPSet(... .addresses(addresses)
                       .lockToken(current.lockToken()));   // 토큰 불일치면 충돌 실패
```

단일 IPv4는 `/32`, 단일 IPv6는 `/128`로 정규화해서 넣는다(`normalizeIpTarget`). 인증은 키를 코드에 두지 않고 AWS SDK의 Default Credential Provider Chain에 위임한다.

### Cloudflare/Nginx Direct는 공통 HTTP 클라이언트로 위임

`CloudflareDirectWafAdapter.sync()`는 한 줄로 `WafSyncHttpClient.call(provider, item)`에 위임한다. 공통 클라이언트가 다음을 책임진다.

| 단계 | 처리 |
| --- | --- |
| 호출 제한 | `ProviderCallThrottler`로 동시성/분당 한도 확인(초과 시 THROTTLED) |
| 엔드포인트 검증 | `{targetValue}` 등 템플릿 치환 후 scheme 검사 — http/https만 허용 |
| Mock 단락 | `mock://` 또는 데모 Provider면 외부 호출 없이 SYNCED 반환 |
| 메서드 결정 | request_method 또는 model_name의 method, 없으면 차단=POST·해제=DELETE |
| 시크릿 주입 | `SecurityProviderSecretResolver`로 api_key_ref 해석 후 Authorization Bearer |
| 재시도 | retry_count + 선형 백오프(backoff x 시도횟수) |
| 결과 매핑 | 2xx면 SYNCED, 아니면 fail_open에 따라 PENDING 또는 FAILED |

### 결과 합산 규칙

여러 장비를 동시에 동기화하므로 큐 항목의 최종 상태는 보수적으로 합산한다.

```text
하나라도 FAILED                  → FAILED
실패는 없고 하나라도 PENDING      → EXTERNAL_PROVIDER_PENDING
전부 SYNCED                       → SYNCED
```

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현됨
- 어댑터 패턴 골격(`WafSyncAdapter` + 라우터 `HttpWafSyncProvider`)과 `@Order` 기반 우선순위 선택은 완성.
- `AwsWafSdkAdapter`는 AWS SDK v2 `Wafv2Client`로 IPSet read-modify-write를 실제 코드로 구현(IPv4/v6 정규화, lock token, fail_open 처리 포함).
- `WafSyncHttpClient`의 엔드포인트 scheme 검증, 템플릿 치환, 재시도/백오프, 스로틀링, 시크릿 참조 해석은 동작.
- `MockWafSyncAdapter`로 외부 키 없이 데모/시연 경로가 보장됨(provider_code에 MOCK/DEMO, `mock://` 엔드포인트, mock 모델명 감지).
- 설정·큐는 DB 테이블(`SECURITY_ASSESSMENT_PROVIDER_CONFIG`, `SECURITY_WAF_SYNC_QUEUE`)로 영속.
:::

:::warning Mock·미연동·향후
- 실제 운영 AWS/Cloudflare 계정·자격증명은 환경에 연결되어 있지 않다. 키는 `api_key_ref`에 `ENV:API_KEY` 같은 참조명만 두고 런타임에 해석하는 방식이라, 환경 변수가 비어 있으면 외부 호출 대신 Mock 경로로 시연한다.
- Cloudflare/Nginx Direct·Gateway 어댑터는 응답 스키마를 운영사별로 정밀 파싱하지 않고 HTTP 2xx 여부만 본다. 운영 API 스키마가 확정되면 어댑터별 응답 파싱만 분리할 계획.
- IPSet 동기화는 항목 단위 처리라 대량 배치 최적화/페이지네이션은 향후 과제.
:::

## 6. 면접 답변 3단계

1. **한 문장:** "위험 판정으로 나온 IP 차단을, 운영사마다 다른 외부 WAF(AWS·Cloudflare·Nginx)에 동기화하는 부분을 어댑터 패턴으로 분리했습니다."
2. **설계 의도:** "호출부는 `WafSyncAdapter` 인터페이스만 알고, 어떤 장비를 쓸지는 DB의 Provider 설정으로 결정합니다. 활성 장비가 여러 개면 하나만 고르지 않고 모두 실행해 계층 방어를 하고, 결과는 FAILED 우선으로 보수적으로 합산합니다."
3. **구체 근거:** "AWS는 SDK v2 `Wafv2Client`로 IPSet을 lock token 기반 read-modify-write 하고, Cloudflare/Nginx는 공통 `WafSyncHttpClient`로 위임해 엔드포인트 scheme 검증·재시도·시크릿 참조 해석을 한곳에서 처리합니다. 외부 호출 실패는 `fail_open` 정책으로 대기/실패를 가릅니다."

## 7. 꼬리질문+모범답안

:::details Q1. 왜 전략 패턴이 아니라 어댑터 패턴이라고 부르나요?
의도가 "기존에 인터페이스가 제각각인 외부 시스템(AWS SDK, Cloudflare REST, Nginx API)을 우리 공통 인터페이스 `WafSyncAdapter`에 맞춰 끼우는 것"이기 때문입니다. 알고리즘을 갈아끼우는 전략 패턴과 형태는 닮았지만, 핵심 동기가 "이질적 외부 API를 한 계약으로 정합"이라 어댑터로 분류합니다. 선택 로직(`supports` + `@Order`)이 더해진 점은 전략적 요소이기도 합니다.
:::

:::details Q2. 여러 어댑터가 같은 Provider를 supports할 때 충돌은 어떻게 막나요?
`@Order`로 우선순위를 두고, 라우터가 오름차순으로 돌다 처음 true인 어댑터에서 `break` 합니다. Mock(0)이 가장 먼저 가로채 데모를 보호하고, Direct(10)가 Gateway(20)보다 먼저 잡습니다. 또 `supports()` 조건을 `provider_code` 접두사 + 엔드포인트 유무로 좁혀 한 Provider가 한 어댑터에만 매칭되게 설계했습니다.
:::

:::details Q3. AWS IPSet 갱신 중 다른 관리자가 동시에 바꾸면요?
IPSet은 lock token으로 낙관적 동시성 제어를 합니다. 저는 `getIPSet`으로 현재 주소와 토큰을 읽고, 수정 후 같은 토큰으로 `updateIPSet` 합니다. 그사이 누가 바꿔 토큰이 달라지면 갱신이 충돌로 실패하고, 그 실패는 `fail_open` 정책에 따라 PENDING 또는 FAILED로 남아 재시도/검토 대상이 됩니다.
:::

:::details Q4. 외부 WAF가 죽으면 로그인까지 막히지 않나요?
막히지 않습니다. WAF 동기화는 큐 기반 후속 작업이라 로그인 판정 경로와 분리돼 있고, Provider별 `fail_open` 플래그로 실패를 흡수합니다. `fail_open=1`이면 즉시 차단 확정 대신 EXTERNAL_PROVIDER_PENDING으로 두고, `fail_open=0`이면 FAILED로 남겨 운영자가 재시도합니다. 공통 클라이언트에는 타임아웃·재시도·스로틀도 있어 외부 장애가 서비스로 전파되지 않습니다.
:::

:::details Q5. API 키는 어디에 두나요? DB에 평문으로 넣나요?
아니요. 실제 키는 DB에 저장하지 않고 `api_key_ref`에 `ENV:API_KEY` 또는 `PROP:name` 같은 참조명만 둡니다. 런타임에 `SecurityProviderSecretResolver`가 Spring `Environment`에서 실제 값을 해석해 Authorization Bearer 헤더로 주입합니다. 덕분에 설정 테이블을 공유하거나 백업해도 자격증명이 노출되지 않습니다.
:::

## 8. 직접 말해보기

- 새 운영사(예: 또 다른 CDN) WAF를 추가하려면 코드에서 무엇을 새로 만들고, DB에는 무엇을 넣어야 하는지 30초로 설명해 보세요.
- `fail_open=1`과 `fail_open=0`이 같은 외부 장애 상황에서 큐 상태를 어떻게 다르게 남기는지, 그리고 운영자가 각각 어떤 후속 조치를 하는지 말해 보세요.
- AWS만 HTTP가 아니라 SDK 어댑터로 따로 둔 이유를, IPSet의 lock token 동작과 엮어 설명해 보세요.

## 퀴즈

<QuizBox question="WAF 어댑터 라우팅에서 활성 Provider가 여러 개일 때 TripTogether가 택한 방식은?" :choices="['우선순위가 가장 높은 어댑터 하나만 실행한다', '가능한 어댑터를 모두 실행하고 결과를 합산한다', '무작위로 하나를 골라 실행한다', '항상 AWS 어댑터만 실행한다']" :answer="1" explanation="계층화된 방어 원칙에 따라 활성 Provider를 모두 실행한 뒤, 하나라도 FAILED면 FAILED, 실패 없이 PENDING이 있으면 EXTERNAL_PROVIDER_PENDING, 전부 성공이면 SYNCED로 합산한다." />

<QuizBox question="AwsWafSdkAdapter가 HTTP 클라이언트가 아니라 SDK를 쓰면서 IPSet 갱신 시 사용하는 동시성 제어 수단은?" :choices="['분산 락 서버', 'lock token 기반 낙관적 동시성 제어', 'DB 행 잠금', '제어 없음 무조건 덮어쓰기']" :answer="1" explanation="getIPSet으로 현재 주소와 lock token을 읽고 같은 토큰으로 updateIPSet 한다. 그사이 다른 변경으로 토큰이 달라지면 충돌로 실패한다." />

<QuizBox question="실제 외부 API 키를 다루는 방식으로 코드 근거에 맞는 설명은?" :choices="['DB에 평문으로 저장한다', 'api_key_ref에 ENV 또는 PROP 참조명만 두고 런타임에 SecurityProviderSecretResolver가 해석한다', '어댑터 소스코드에 하드코딩한다', 'JSP 화면에서 입력받아 세션에 보관한다']" :answer="1" explanation="api_key_ref에는 ENV:API_KEY 같은 참조명만 저장하고, 런타임에 SecurityProviderSecretResolver가 Spring Environment에서 실제 값을 해석해 Authorization 헤더로 주입한다." />
