---
title: "런타임 설정"
owner: A
domain: "관리자·운영"
tags: ["런타임설정"]
---

# 런타임 설정 (DB 우선 구성)

> 재배포 없이 운영값을 바꾼다. properties/환경변수 대신 `APPLICATION_RUNTIME_SETTING` 테이블을 1차 소스로 두고, 모든 변경을 이력 테이블에 버전으로 남긴다.

관련 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 같은 메커니즘의 백엔드 관점은 [런타임 설정 (DB 우선)](/backend/runtime-settings), 변경 추적은 [감사 로그](/admin/audit-logs) 참고.

## 1. 한 줄 정의

OAuth 키, 메일 발신자, Base URL, 토큰 TTL 같은 운영 파라미터를 코드/properties가 아니라 DB 행으로 관리하고, 관리자 화면에서 바꾸면 다음 요청부터 즉시 반영되며 변경 전후가 이력으로 보존되는 구성 체계다.

## 2. 왜 이렇게 설계했나

JSP/WAR + 내장 Tomcat 배포에서 `application.properties`나 환경변수를 고치면 반드시 재빌드 또는 재기동이 따른다. 운영 중 카카오 redirect URI를 교체하거나 이메일 토큰 유효 시간을 늘리는 정도의 변경에 배포 파이프라인 전체를 도는 것은 과하다.

- **재배포 제거**: 값을 DB에서 1차 조회하므로, 행만 바꾸면 다음 요청부터 새 값이 적용된다.
- **안전한 폴백**: DB 행이 없거나 조회가 실패해도 기존 properties/`@Value`/기본값으로 자동 회귀한다. 즉 DB 의존이 단일 실패점이 되지 않는다.
- **변경 추적**: 누가·언제·무엇을 어떤 값으로 바꿨는지 이력 테이블에 버전(version_no)으로 남겨, 감사와 롤백 근거를 만든다.
- **민감/공개 분리**: OAuth secret 같은 민감 설정은 `is_secret` 플래그로 구분해 표시·노출 정책을 다르게 가져간다.

:::tip 설계 한 줄 요약
"DB 우선, 실패 시 기존 설정으로 폴백" — 운영 유연성을 얻으면서도 기존 properties 안전망을 버리지 않는 절충이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo)을 그대로 따른다.

| 구성요소 | 클래스/파일 | 역할 |
| --- | --- | --- |
| 조회/저장 서비스 | `RuntimeSettingService` | DB 우선 조회, 타입 변환, 저장 + 이력 기록을 한 트랜잭션으로 |
| Mapper 인터페이스 | `RuntimeSettingMapper` (`@Mapper`) | 조회/목록/이력/insert/update 정의 |
| Mapper XML | `resources/mapper/runtimeSettingMapper.xml` | 실제 SQL과 resultMap |
| 설정 VO | `RuntimeSettingVO` | 한 설정 행. key/group/value/fallback/valueType/secret/editable/active |
| 이력 VO | `RuntimeSettingHistoryVO` | 변경 이력 한 건. version_no/changeType/before·after 값과 스냅샷 |
| 관리자 컨트롤러 | `AdminRuntimeSettingController` (`/admin/runtime-settings`) | 목록 화면, 생성/수정 폼 처리 |
| 일괄 내보내기/가져오기 | `InitialSettingsService` | 런타임 설정을 다른 정책과 묶어 JSON export/import |

DB 테이블은 두 개다.

- **`APPLICATION_RUNTIME_SETTING`**: 설정 본문. `setting_key`(UNIQUE), `setting_group`, `display_name`, `setting_value`, `fallback_value`, `value_type`, `is_secret`, `is_editable`, `is_active`, `description`, `updated_by_user_idx`.
- **`APPLICATION_RUNTIME_SETTING_HISTORY`**: 설정별 변경 이력. `version_no`, `change_type`(CREATE/UPDATE/IMPORT/RESET), `actor_user_idx`, before/after 값과 fallback, 그리고 전후 전체 스냅샷 JSON.

`value_type` 은 5종이다: STRING / NUMBER / BOOLEAN / URL / SECRET. 이 값은 관리자 화면 표시와 의미 구분용이며, 실제 형 변환은 서비스의 `getInt`/`getBoolean` 같은 접근 메서드가 담당한다.

:::details seed 되는 주요 설정 그룹 (마이그레이션 기준)
- MAIL: 메일 발신자 username (SECRET)
- APP: app.base-url, app.public-base-url (URL)
- SECURITY: 차단 규칙 캐시 파일 경로 (STRING)
- AUTH_EMAIL: 기본/아이디찾기/비번재설정/프로필 이메일 토큰 TTL 분 (NUMBER, 기본 30)
- AUTH_ACCOUNT: 휴면 전환 미접속 기준일 (NUMBER, 기본 365)
- OAUTH_KAKAO / OAUTH_NAVER / OAUTH_GOOGLE: client-id, client-secret(SECRET), redirect/link/logout URI
:::

## 4. 동작 원리 (흐름·표·작은 코드)

핵심은 **읽기 경로의 우선순위**와 **쓰기 경로의 이력 동봉**이다.

### 4-1. 읽기 — DB 우선 + 다단계 폴백

호출부는 settingKey와 fallback을 함께 넘긴다.

```java
// 호출 예시 (개념 단순화)
String cacheFile = runtimeSettingService.getValue(
        "security.block.cache.file", defaultCacheFilePath);
int ttl = runtimeSettingService.getInt(
        "auth.email.reset-password-token-ttl-minutes", 30);
```

`getValue` 의 우선순위는 다음과 같다.

| 순위 | 조건 | 반환 |
| --- | --- | --- |
| 1 | is_active=1 행의 setting_value 가 있음 | setting_value (trim) |
| 2 | setting_value 비어 있고 fallback_value 있음 | fallback_value (trim) |
| 3 | 행 없음 / 조회 예외 발생 | 호출부가 넘긴 fallback 인자 |

조회 자체가 예외를 던져도 try/catch 로 잡아 호출부 fallback 으로 회귀하므로, DB 장애가 인증·메일 같은 기능을 멈추지 않는다. `getInt`/`getBoolean` 은 `getValue` 결과를 파싱하며, 파싱 실패 시에도 fallback 으로 떨어진다. BOOLEAN 은 1/true/Y/yes 를 참으로 본다.

### 4-2. 쓰기 — 저장과 이력을 한 트랜잭션으로

관리자가 폼을 제출하면 `saveRuntimeSetting` 이 `@Transactional` 안에서 다음을 수행한다.

1. settingIdx(수정) 또는 settingKey(신규)로 **변경 전(before)** 행을 읽는다.
2. before 가 없으면 insert, 있으면 update 한다.
3. 저장 후 행을 다시 읽어 **변경 후(after)** 를 만든다.
4. 같은 트랜잭션에서 이력 행을 추가한다. version_no 는 해당 setting_idx 의 `MAX(version_no)+1` 로 SQL 안에서 채번하고, change_type 은 신규면 CREATE, 기존이면 UPDATE, before/after 의 value·fallback·전체 스냅샷 JSON 을 함께 기록한다.

```text
관리자 폼 제출
  → before 행 조회
  → insert | update
  → after 행 재조회
  → history insert (version_no = MAX+1, before/after 스냅샷)
  [ 위 전부 하나의 @Transactional ]
```

저장과 이력이 한 트랜잭션이라, 본문은 바뀌고 이력만 누락되는 어긋남이 생기지 않는다.

### 4-3. 목록·이력 조회

`AdminRuntimeSettingController` 의 목록 화면은 그룹/키워드/비활성포함 필터를 받는다. 키워드는 setting_key·display_name·description 을 LIKE 로 동시 검색하고, includeInactive 가 꺼져 있으면 is_active=1 만 본다. 특정 키의 변경 이력은 created_at 내림차순으로, 서비스가 limit 을 1~100 으로 클램프해 조회한다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| DB 우선 조회 + 다단계 폴백 (`getValue`/`getInt`/`getBoolean`) | 구현됨 |
| 저장 + 변경 이력 자동 버전 채번 | 구현됨 |
| 관리자 목록/생성/수정 화면 (`/admin/runtime-settings`) | 구현됨 |
| 그룹/키워드/비활성포함 필터, 키별 이력 보기 | 구현됨 |
| `is_secret` 로 민감 설정 분리 | 구현됨 (플래그·표시 구분) |
| 마이그레이션 seed (OAuth/Mail/URL/TTL/휴면) | 구현됨 |
| 다른 정책과 묶은 JSON export/import (`InitialSettingsService`) | 구현됨 (IMPORT 경로 존재) |
| 설정 변경 시 외부 캐시 자동 무효화 보장 | 부분 — 호출 시점 조회 기반, 별도 캐시가 있는 영역은 갱신 주기에 의존 |
| 값 형식 검증 (예: URL/NUMBER 강제 유효성) | 계획 — value_type 은 표시/의미용, 강한 입력 검증은 향후 과제 |
| 시크릿 암호화 저장 | 계획 — 현재는 is_secret 플래그로 노출만 구분, 저장 자체 암호화는 미구현 |

:::warning 정직한 한계
`value_type` 이 URL/NUMBER 라고 해서 입력이 그 형식임을 DB가 강제하지는 않는다. 잘못된 NUMBER 가 들어가면 읽기 시점에 파싱 실패로 fallback 으로 떨어진다 — 안전하지만, 운영자는 값이 무시되었다는 사실을 바로 알기 어렵다. 입력 단계 검증 강화가 후속 과제다.
:::

## 6. 면접 답변 3단계

**1단계 (한 문장)**
운영 파라미터를 properties 대신 DB 행으로 두고, DB 우선·실패 시 기존 설정 폴백으로 읽으며, 변경을 버전 이력으로 남기는 런타임 설정 체계입니다.

**2단계 (설계 의도)**
JSP/WAR 배포에서 redirect URI나 토큰 TTL 같은 값을 바꿀 때마다 재기동하는 비용을 없애려는 것이 동기입니다. 다만 DB를 1차 소스로 두되, 행이 없거나 조회가 실패하면 properties/기본값으로 폴백해 DB가 단일 실패점이 되지 않게 했습니다. 저장과 이력 기록을 한 트랜잭션으로 묶어 감사와 롤백 근거를 확보했습니다.

**3단계 (구현 근거)**
`RuntimeSettingService.getValue` 가 is_active 행 → fallback_value → 호출부 fallback 순으로 떨어지고, 예외도 잡아 폴백합니다. `saveRuntimeSetting` 은 변경 전/후를 읽어 `APPLICATION_RUNTIME_SETTING_HISTORY` 에 MAX version_no + 1 로 버전을 채번하고 before/after 스냅샷을 남깁니다. 키는 setting_key UNIQUE, 민감값은 is_secret 으로 구분합니다.

## 7. 꼬리질문 + 모범답안

::: details DB가 죽으면 OAuth 로그인이나 메일 발송이 멈추나요
아닙니다. 읽기 경로가 try/catch 로 감싸여 있어 조회 예외 시 호출부가 넘긴 fallback 인자로 회귀합니다. seed 시 properties 성격 값에는 fallback_value 를 채워두거나, 호출부에서 기존 기본값을 넘기므로, DB 장애 상황에서도 기존 동작으로 degrade 됩니다.
:::

::: details 설정을 바꿨는데 즉시 반영되나요, 캐시가 끼면요
`getValue` 계열은 호출 시점에 조회하므로 다음 요청부터 새 값이 보입니다. 다만 일부 영역은 별도 캐시(예: 차단 규칙 파일 캐시)를 갖고 있어, 그 캐시의 갱신 주기에 따라 반영이 지연될 수 있습니다. 즉시성이 중요한 키는 캐시 무효화 트리거를 추가하는 것이 개선 방향입니다.
:::

::: details value_type 이 NUMBER 인데 글자가 들어가면요
DB는 막지 않습니다. 읽기 시 `getInt` 가 파싱에 실패하면 fallback 으로 떨어져 잘못된 값이 그대로 쓰이지는 않습니다. 안전하지만 조용히 무시되는 단점이 있어, 입력 단계 검증을 강화하는 것이 후속 과제입니다.
:::

::: details 시크릿(OAuth client-secret)은 어떻게 보호하나요
현재는 is_secret 플래그로 관리자 화면 표시와 노출 정책을 구분합니다. 저장 자체를 암호화하지는 않으므로, 운영에서는 DB 접근 통제와 별도 비밀 관리가 전제됩니다. 컬럼 레벨 암호화는 계획 단계입니다.
:::

::: details 누가 언제 바꿨는지 추적되나요, 롤백은요
모든 저장이 같은 트랜잭션에서 이력 행을 남깁니다. setting_idx 별 version_no, change_type, actor_user_idx, before/after value 와 전체 스냅샷 JSON 이 보존되어 누가 무엇을 바꿨는지 추적됩니다. 롤백은 이전 버전의 값을 다시 저장하는 방식으로 가능하며, 그 저장 역시 새 이력으로 기록됩니다.
:::

## 8. 직접 말해보기

다음을 소리 내어 설명해 보자.

1. 이 프로젝트는 운영값을 왜 properties 대신 DB에 두었고, 그 트레이드오프는 무엇인가.
2. `getValue` 의 폴백 3단계를 순서대로, 각 단계가 언제 작동하는지.
3. 저장과 이력 기록을 한 트랜잭션으로 묶은 이유와, version_no 채번 방식.
4. is_secret 와 value_type 이 각각 무엇을 보장하고 무엇을 보장하지 않는지.

## 퀴즈

<QuizBox question="RuntimeSettingService의 getValue가 값을 찾는 우선순위로 옳은 것은?" :choices="['호출부 fallback 인자, 그다음 DB setting_value', '활성 행의 setting_value, 비어 있으면 fallback_value, 그래도 없거나 예외면 호출부 fallback', 'properties 값을 항상 먼저, DB는 보조', 'fallback_value를 항상 우선']" :answer="1" explanation="활성(is_active) 행의 setting_value를 먼저 보고, 비면 fallback_value, 행이 없거나 조회 예외면 호출부가 넘긴 fallback으로 떨어집니다. DB 우선이되 안전하게 폴백합니다." />

<QuizBox question="설정을 저장할 때 변경 이력 기록에 대한 설명으로 옳은 것은?" :choices="['이력은 별도 배치로 나중에 적재된다', '저장과 이력 insert가 같은 트랜잭션에서 일어나고 version_no는 해당 setting의 MAX 값에 1을 더해 채번한다', '이력은 수정 때만 남고 신규 생성은 남기지 않는다', 'version_no는 전체 테이블에서 전역 증가한다']" :answer="1" explanation="saveRuntimeSetting은 @Transactional 안에서 본문 저장 후 이력을 남기며, version_no는 같은 setting_idx의 MAX version_no 더하기 1로 SQL에서 채번합니다. 신규는 CREATE, 기존은 UPDATE로 기록됩니다." />

<QuizBox question="value_type이 NUMBER인 설정에 숫자가 아닌 문자열이 저장되면 어떻게 되나?" :choices="['DB 제약으로 저장 자체가 거부된다', '읽을 때 getInt가 파싱에 실패해 fallback 값으로 떨어진다', '애플리케이션이 기동 시 예외로 중단된다', '자동으로 0으로 변환되어 저장된다']" :answer="1" explanation="value_type은 표시와 의미 구분용이라 DB가 형식을 강제하지 않습니다. getInt가 파싱에 실패하면 fallback으로 회귀하므로 안전하지만 값이 조용히 무시되는 한계가 있어 입력 검증 강화가 후속 과제입니다." />
