---
title: "IP 차단 (CIDR)"
owner: A
domain: "관리자·운영"
tags: ["IP차단", "CIDR"]
---

# IP 차단 (CIDR)

> 개별 IP뿐 아니라 CIDR 대역·IP 범위·국가·ASN 단위까지 Allow/Block 규칙을 만들고, 요청마다 DB를 치지 않고 인메모리 캐시로 비교해, 모든 페이지 진입의 가장 앞단에서 악성 트래픽을 끊는다.

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트다. 이 페이지는 `admin`(관리자·운영) 도메인의 **애플리케이션 레벨 IP/대역 차단** 기능을 다룬다. 핵심은 단일 클래스가 아니라 세 부분의 협업이다 — 규칙을 비교하는 인터셉터 `IpBlockInterceptor`, 규칙을 메모리에 들고 있는 `BlockRuleCacheService`, 규칙을 관리하는 `AdminBlockController`. 진입점은 관리자 화면 `/admin/blocks`이고, 실제 차단 판정은 모든 요청의 `preHandle` 단계에서 일어난다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 보안·모더레이션 큰 그림은 [모더레이션·거버넌스 흐름](/flow/moderation-governance)에서 본다.

## 1. 한 줄 정의

`IpBlockInterceptor.preHandle`은 들어온 요청의 클라이언트 IP·국가·ASN을 인메모리 규칙 스냅샷(`BlockRuleCacheService`)과 대조해, BLOCK 규칙에 걸리면 HTTP 403과 함께 `/blocked-access` 안내 페이지로 forward 하고 그 외에는 통과시키는, 모든 페이지보다 먼저 도는 보안 게이트다.

## 2. 왜 이렇게 설계했나

대량 DDoS나 봇넷 방어는 본래 CDN·WAF·Nginx 같은 **앞단 인프라 계층**의 일이다. 그런데도 애플리케이션 안에 차단 계층을 둔 이유는, 로그인 실패 누적, 악성 회원의 IP, 챗봇·API 남용처럼 **애플리케이션 문맥이 있어야 판단되는 정밀 차단**이 따로 필요하기 때문이다. 인프라 계층은 이런 도메인 신호를 모른다.

핵심 설계 결정 네 가지.

- **요청마다 DB 조회 금지** — 모든 요청의 최앞단에서 도는 코드가 매번 DB를 치면 그 자체가 병목이자 장애 지점이 된다. 그래서 규칙을 `AtomicReference`에 담긴 불변 스냅샷으로 메모리에 들고, 비교는 순수 인메모리 연산으로 한다. DB 접근은 규칙이 바뀔 때만 일어난다.
- **차단 단위를 5종으로 일반화** — 단일 IP만으로는 클라우드 대역·국가 단위 공격을 못 막는다. 그래서 매칭 방식을 `SINGLE_IP / CIDR / RANGE / COUNTRY / ASN` 다섯 가지로 두고, 한 테이블에서 모두 표현한다.
- **Allow가 Block을 이긴다(화이트리스트 우선)** — 같은 대역을 통째로 막되 신뢰하는 한 IP만 뚫는 운영이 흔하다. ALLOW 규칙에 먼저 걸리면 즉시 통과시켜, 광범위한 BLOCK의 예외 구멍을 안전하게 낸다.
- **차단해도 서비스는 안 죽는다(fail-open)** — 규칙 비교·로그 적재에서 예외가 나도 정상 사용자의 요청 흐름을 막지 않는다. 차단 로그 적재 실패는 경고만 남기고 삼킨다. 보안 보조 기능이 가용성을 깨면 안 된다는 원칙이다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 위치 / 식별자 | 역할 |
| --- | --- | --- |
| 차단 게이트 | `config.IpBlockInterceptor` (`HandlerInterceptor`) | 모든 요청 `preHandle`에서 IP/회원 규칙 평가 |
| 규칙 캐시 | `config.BlockRuleCacheService` | DB→메모리→파일 3단 캐시, 스냅샷 보관 |
| 규칙 조회 매퍼 | `config.IpBlockMapper` (`@Mapper`) | `findActiveIpBlockRules` / `findActiveUserBlockRules` |
| 판정 결과 객체 | `common.vo.BlockDecisionVO` | blocked 여부·blockKind·matchType·targetKey 캡슐화 |
| 규칙 VO | `common.vo.IpBlockRuleVO` | `matchType`·`cidrNotation`·`ruleAction`·`priority` 등 |
| 관리자 API | `admin.controller.AdminBlockController` (`/admin/blocks`) | 규칙 CRUD·토글·배치·캐시 동기화 |
| 안내 화면 | `common.controller.BlockedAccessController` (`/blocked-access`) | 차단 사용자에게 최소 정보만 노출 |
| 차단 규칙 테이블 | `IP_BLOCKLIST` | 규칙 본체 (아래 핵심 컬럼) |
| 묶음 관리 | `IP_BLOCK_BATCH` / `..._OPERATION` / `..._OPERATION_RULE` | 피드·정책 단위 일괄 규칙 |
| 차단 감사 | `BLOCK_ACCESS_LOG` | 차단된 요청을 IP·국가·ASN·핸들러와 함께 적재 |

`IP_BLOCKLIST`의 차단 판정에 직접 쓰이는 핵심 컬럼:

| 컬럼 | 의미 |
| --- | --- |
| `match_type` | SINGLE_IP / CIDR / RANGE / COUNTRY / ASN |
| `cidr_notation` | CIDR 표기 (예 203.0.113.0/24) |
| `range_start_ip` / `range_end_ip` | IP 범위 양 끝 |
| `country_code` / `asn` | 국가·ASN 단위 차단 키 |
| `rule_action` | BLOCK 또는 ALLOW |
| `block_target_key` | 규칙 식별 키 (예 CIDR:203.0.113.0/24) |
| `priority` | 평가 우선순위 |
| `is_active` / `is_effective_active` | 현재 유효·실제 평가 대상 여부 |

:::tip CIDR 비교는 어떻게 하나
숫자 비교가 아니라 비트마스크 비교다. `InetAddress.getByName`으로 클라이언트 IP와 서브넷을 바이트 배열로 만들고, 둘 다 `BigInteger`로 바꾼 뒤 prefix 길이만큼의 마스크를 AND 해서 같으면 같은 대역이다. `BigInteger`라서 IPv4·IPv6 길이를 같은 코드로 처리하고, prefix 0~비트수 범위 검증·길이 불일치 검증으로 비정상 입력은 false로 떨군다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

**인터셉터 체인 위치.** `WebConfig.addInterceptors`에서 등록 순서가 곧 평가 순서다. IP 차단은 거의 맨 앞에 둔다 — 차단할 요청에 굳이 활동 로그·로그인·알림 처리를 태울 이유가 없기 때문이다.

```text
localeChange → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification
                 ▲ 차단 게이트가 인증·알림보다 앞
```

`/blocked-access`와 `/security/appeal/**`는 차단 평가에서 제외한다. 차단된 사용자도 안내 화면과 차단 해제 신청 경로에는 접근해야 하기 때문이다.

**한 요청의 판정 순서.**

| 단계 | 처리 |
| --- | --- |
| 1 | 클라이언트 IP 추출 — `X-Forwarded-For` 등 프록시 헤더 우선, 없으면 `getRemoteAddr` |
| 2 | IP 정규화 — IPv6 루프백/매핑(`::1`, `::ffff:`)을 IPv4로 환원 |
| 3 | 국가·ASN 추출 — `CF-IPCountry`·`CF-ASN` 등 CDN 헤더에서 |
| 4 | IP 규칙 평가 — ALLOW면 즉시 통과, BLOCK이면 차단 |
| 5 | 회원 규칙 평가 — 로그인 사용자의 계정 상태·USER_ONLY·USER_IP 규칙 |
| 6 | 차단 시 — `BLOCK_ACCESS_LOG` 적재 후 403 + `/blocked-access` forward |

**매칭 분기(추상화).**

```java
switch (matchType) {
    case "SINGLE_IP" -> clientIp.equals(normalizeIp(rule.getIpAddress()));
    case "CIDR"      -> matchesCidr(clientIp, rule.getCidrNotation());
    case "RANGE"     -> matchesRange(clientIp, rule.getRangeStartIp(), rule.getRangeEndIp());
    case "COUNTRY"   -> matchesCountry(countryCode, rule);
    case "ASN"       -> matchesAsn(asn, rule);
}
```

**실시간 동기화.** 관리자가 규칙을 만들거나 토글하면 `AdminBlockController`가 `invalidateAndRefresh`를 호출한다. 캐시는 DB에서 활성 규칙을 다시 읽어 새 스냅샷으로 교체하고, 그 스냅샷을 파일(`block-rule-cache.json`)에도 기록한다. 파일 캐시는 **재기동 직후 DB 조회 전에도** 마지막 규칙으로 즉시 방어를 시작하기 위한 보조 수단이다. 스냅샷 교체가 `AtomicReference.set` 한 번이라 비교 중인 요청과 경합 없이 무중단으로 바뀐다.

```text
관리자 규칙 변경 → DB UPSERT → invalidateAndRefresh
                                  ├─ DB 활성 규칙 재조회
                                  ├─ AtomicReference 스냅샷 교체 (무중단)
                                  └─ block-rule-cache.json 기록 (재기동 대비)
```

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| SINGLE_IP / CIDR / RANGE 매칭 | 구현됨 (비트마스크·범위 비교) |
| ALLOW 우선 화이트리스트 | 구현됨 |
| 인메모리 캐시 + 파일 캐시 + 무중단 교체 | 구현됨 |
| 관리자 규칙 CRUD·토글·배치·일괄 토글 | 구현됨 (`/admin/blocks`) |
| 회원 차단(계정 상태·USER_ONLY·USER_IP) 동일 게이트 평가 | 구현됨 |
| 차단 감사 로그(`BLOCK_ACCESS_LOG`) + 다국어 안내 화면 | 구현됨 |
| 정책 피드 업로드(Excel/API)로 대량 규칙 import | 구현됨 |
| COUNTRY / ASN 매칭 | 코드 구현됨. 단, 국가·ASN은 **CDN이 채워주는 헤더**에 의존 — 그 헤더가 없으면 매칭되지 않음 |
| 실제 GeoIP·ASN 자체 조회 | 미구현 (상위 CDN/WAF 헤더 전제) |
| 인프라단 DDoS 방어 | 범위 밖 — 이 계층은 정밀 차단 전용 |

:::warning 운영 전제
국가·ASN 차단은 애플리케이션이 직접 IP를 조회하지 않고 `CF-IPCountry`·`CF-ASN` 같은 신뢰된 프록시 헤더를 읽는다. CDN 뒤가 아니면 이 헤더는 비어 있어 해당 규칙은 사실상 비활성이다. 또 `X-Forwarded-For`는 클라이언트가 위조할 수 있으므로, 신뢰된 프록시 뒤에서만 의미가 있다.
:::

## 6. 면접 답변 3단계

1. **한 문장** — 모든 요청의 최앞단 인터셉터에서, 인메모리 규칙 캐시와 클라이언트 IP를 대조해 개별 IP·CIDR 대역·범위·국가·ASN 단위로 Allow/Block을 판정하는 애플리케이션 레벨 차단 게이트입니다.
2. **설계 의도** — DDoS는 인프라가 막고, 이 계층은 로그인 실패·악성 회원처럼 애플리케이션 문맥이 필요한 정밀 차단을 맡습니다. 요청마다 DB를 치면 병목이라 규칙을 불변 스냅샷으로 메모리에 두고, 관리자가 규칙을 바꾸면 스냅샷을 통째로 원자적 교체해 실시간 반영합니다.
3. **트레이드오프** — ALLOW를 BLOCK보다 먼저 평가해 광범위 차단의 예외를 안전하게 내고, 규칙 비교·로그 적재가 실패해도 정상 요청은 막지 않는 fail-open으로 가용성을 우선했습니다. 대신 국가·ASN 차단은 CDN 헤더 신뢰가 전제라 단독 서버에선 한계가 있습니다.

## 7. 꼬리질문 + 모범답안

:::details 요청마다 DB를 조회하지 않는데, 규칙 변경은 어떻게 즉시 반영되나요
규칙은 `AtomicReference`에 담긴 불변 스냅샷입니다. 관리자 API가 규칙을 바꾸면 `invalidateAndRefresh`가 DB에서 활성 규칙을 다시 읽어 새 스냅샷을 만들고 `set` 한 번으로 교체합니다. 평가 중인 요청은 이전 스냅샷을 그대로 보다가, 다음 요청부터 새 스냅샷을 봅니다. 락 없이 무중단으로 바뀌고, 같은 내용을 파일에도 써서 재기동 직후 DB 조회 전에도 마지막 규칙으로 방어를 시작합니다.
:::

:::details CIDR이 같은 대역인지 어떻게 판단하나요
숫자 대소 비교가 아니라 비트마스크 비교입니다. 클라이언트 IP와 서브넷 주소를 각각 바이트 배열로 만들고 `BigInteger`로 변환한 뒤, prefix 길이만큼 상위 비트가 1인 마스크를 두 값에 AND 해서 같으면 같은 대역으로 봅니다. `BigInteger`를 쓰면 IPv4와 IPv6를 길이만 다를 뿐 동일한 로직으로 처리할 수 있고, prefix 범위와 주소 길이 일치를 검증해 비정상 입력은 false로 떨어집니다.
:::

:::details ALLOW와 BLOCK 규칙이 같은 IP에 동시에 걸리면 어떻게 되나요
규칙 목록을 순회하면서 매칭되는 규칙을 만났을 때, 그 규칙이 ALLOW면 즉시 통과시키고 BLOCK이면 차단합니다. 운영에서는 넓은 대역을 BLOCK으로 막고 신뢰 IP만 ALLOW로 뚫는 화이트리스트 패턴이 흔해서, ALLOW가 먼저 평가되도록 우선순위와 순서를 잡습니다. 즉 화이트리스트가 블랙리스트를 이깁니다.
:::

:::details 클라이언트 IP를 X-Forwarded-For에서 읽는데 위조 위험은 없나요
있습니다. `X-Forwarded-For`는 클라이언트가 임의로 채울 수 있어서, 신뢰된 프록시·CDN 뒤에 있을 때만 의미가 있습니다. 그 전제에서 첫 번째 값을 클라이언트 IP로 보고, IPv6 루프백·IPv4 매핑 주소를 정규화해 비교합니다. 국가·ASN도 직접 조회가 아니라 CDN이 채운 헤더를 신뢰하는 구조라, 단독 서버에서는 IP 외 매칭이 비활성에 가깝습니다. 그래서 이 계층은 인프라 방어를 대체하는 게 아니라 보완하는 위치로 설계했습니다.
:::

:::details 차단된 사용자는 아무 페이지도 못 보나요, 해제 신청은 어떻게 하나요
차단 시 403과 함께 `/blocked-access` 안내 화면으로 forward 하는데, 이 경로와 차단 해제 신청 경로는 차단 평가에서 제외합니다. 안내 화면에는 우회 단서가 될 규칙 키나 상세 사유를 노출하지 않고 요청 ID와 최소 정보만 보여주며, 상세 근거는 `BLOCK_ACCESS_LOG`에서 운영자가 확인합니다. 사용자는 별도 차단 해제 신청 워크플로우로 이의를 제기할 수 있습니다.
:::

## 8. 직접 말해보기

- 이 계층이 인프라단 DDoS 방어와 어떻게 역할을 나누는지, 왜 둘 다 필요한지 한 문단으로 설명해 보라.
- CIDR 매칭이 비트마스크 AND로 귀결되는 과정을, IP를 바이트 배열에서 `BigInteger`로 바꾸는 이유까지 포함해 설명해 보라.
- 규칙을 인메모리 스냅샷으로 두면서도 실시간 변경을 보장하는 메커니즘(원자적 교체·파일 캐시)을 그림 없이 말로 풀어 보라.
- ALLOW 우선과 fail-open이라는 두 선택이 각각 무엇을 우선한 트레이드오프인지 짚어 보라.

## 퀴즈

<QuizBox question="IpBlockInterceptor가 인터셉터 체인에서 거의 맨 앞에 배치되는 가장 큰 이유는?" :choices="['로그인 인증을 먼저 끝내야 하므로', '차단할 요청에 활동 로그·로그인·알림 처리를 태우지 않기 위해', 'CIDR 계산이 무겁기 때문에', '다국어 메시지를 먼저 로드해야 하므로']" :answer="1" explanation="차단될 요청을 인증·로그·알림 단계까지 보내는 것은 낭비다. 그래서 IP 차단 게이트를 체인 앞쪽에 두어 부적합 요청을 일찍 끊는다." />

<QuizBox question="같은 IP에 ALLOW 규칙과 BLOCK 규칙이 모두 매칭될 때의 동작은?" :choices="['항상 BLOCK이 이긴다', 'ALLOW에 먼저 걸리면 즉시 통과시킨다', '둘 다 무시하고 오류를 낸다', 'priority가 낮은 쪽을 따른다']" :answer="1" explanation="화이트리스트 우선 설계다. 넓은 대역을 BLOCK으로 막고 신뢰 IP만 ALLOW로 뚫는 운영을 지원하기 위해, ALLOW에 매칭되면 즉시 allow를 반환한다." />

<QuizBox question="규칙을 요청마다 DB에서 읽지 않고 인메모리 스냅샷으로 두면서도, 관리자의 규칙 변경을 무중단으로 즉시 반영하는 핵심 메커니즘은?" :choices="['요청마다 캐시를 비우고 다시 채운다', 'AtomicReference에 담긴 불변 스냅샷을 통째로 원자적으로 교체한다', '스케줄러가 1분마다 전체 규칙을 폴링한다', '규칙 변경 시 서버를 재기동한다']" :answer="1" explanation="invalidateAndRefresh가 DB에서 활성 규칙을 다시 읽어 새 스냅샷을 만들고 AtomicReference.set 한 번으로 교체한다. 평가 중인 요청과 경합 없이 다음 요청부터 새 규칙이 적용된다." />
