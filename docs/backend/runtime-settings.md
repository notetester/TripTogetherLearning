# 런타임 설정 (DB 우선)

> 메일 주소·OAuth 키·토큰 TTL 같은 운영 파라미터를 `application.properties`가 아니라 DB 행으로 두고, 재배포 없이 관리자 화면에서 바꾸는 구조다. 핵심은 `APPLICATION_RUNTIME_SETTING` 테이블과 `RuntimeSettingService`의 3단 폴백.

[도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

운영 중 바뀔 수 있는 설정값(메일 발신자, OAuth client-id/secret, 인증 토큰 유효시간, 휴면 기준일 등)을 DB의 `APPLICATION_RUNTIME_SETTING` 행으로 저장하고, 코드가 그 값을 properties보다 **우선** 읽되 없으면 안전하게 폴백하는 설정 거버넌스 계층이다.

## 2. 왜 이렇게 설계했나

전통적인 `application.properties` / 환경변수 방식은 값을 바꾸려면 재배포(또는 최소 재기동)가 필요하다. 그런데 다음과 같은 값은 운영 중에 자주, 또는 급하게 바뀐다.

- OAuth client-id/secret, redirect-uri (소셜 콘솔 키 교체·도메인 변경)
- 메일 발신자 주소
- 이메일 인증/비번 재설정 토큰의 유효 시간(분)
- 휴면 계정 전환 기준 미접속 일수
- 차단 규칙 캐시 파일 경로, 공개 base-url

이런 값을 코드/properties에 박아두면 작은 정책 변경에도 빌드·배포 파이프라인을 태워야 한다. 그래서 "운영 파라미터는 데이터다"라는 관점으로 **DB 우선(DB-first)** 설정 테이블을 도입했다.

설계 시 지킨 3가지 원칙:

- **DB 우선, properties 폴백** — DB 행이 없거나 조회가 실패해도 기존 `@Value` 기본값으로 동작이 유지된다. 즉 설정 테이블은 "있으면 우선, 없어도 안전"한 오버레이다.
- **변경 이력 보존** — 누가 언제 무엇을 어떤 값으로 바꿨는지 `APPLICATION_RUNTIME_SETTING_HISTORY`에 스냅샷으로 남긴다. 키 교체가 사고로 이어졌을 때 추적·롤백 근거가 된다.
- **민감값 표시 분리** — `is_secret` 플래그로 OAuth secret 같은 값을 UI에서 마스킹/구분 처리할 수 있게 메타데이터를 함께 둔다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 계층 | 구성요소 | 역할 |
| --- | --- | --- |
| 테이블 | `APPLICATION_RUNTIME_SETTING` | 설정 본체. `setting_key` UNIQUE |
| 테이블 | `APPLICATION_RUNTIME_SETTING_HISTORY` | 설정별 버전(`version_no`)·변경 스냅샷 |
| VO | `RuntimeSettingVO` / `RuntimeSettingHistoryVO` | 행 매핑 |
| 서비스 | `RuntimeSettingService` | 읽기(`getValue`/`getInt`/`getBoolean`) + 저장(`saveRuntimeSetting`) |
| 매퍼 | `RuntimeSettingMapper` + `runtimeSettingMapper.xml` | MyBatis @Mapper |
| 관리자 | `AdminRuntimeSettingController` (`/admin/runtime-settings`) | 목록·검색·생성·수정 화면 |

테이블 핵심 컬럼:

```sql
CREATE TABLE APPLICATION_RUNTIME_SETTING (
  setting_idx     BIGINT PK AUTO_INCREMENT,
  setting_key     VARCHAR(160) NOT NULL UNIQUE,   -- 예: oauth.kakao.client-id
  setting_group   VARCHAR(60)  DEFAULT 'GENERAL', -- MAIL / OAUTH_KAKAO / AUTH_EMAIL ...
  display_name    VARCHAR(160) NOT NULL,
  setting_value   TEXT,          -- DB 우선 값 (비어 있으면 폴백)
  fallback_value  TEXT,          -- DB 값이 비었을 때 쓸 보조 기본값
  value_type      VARCHAR(30) DEFAULT 'STRING',   -- STRING/NUMBER/BOOLEAN/URL/SECRET
  is_secret       TINYINT(1) DEFAULT 0,
  is_editable     TINYINT(1) DEFAULT 1,
  is_active       TINYINT(1) DEFAULT 1,
  updated_by_user_idx BIGINT,    -- FK USERS(user_idx) ON DELETE SET NULL
  created_at      DATETIME, updated_at DATETIME
);
```

`value_type`은 저장형이 모두 `text`이므로 **타입 메타데이터(표시·검증용 힌트)**이고, 실제 형변환은 서비스의 `getInt`/`getBoolean`이 호출 시점에 수행한다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 읽기 — 3단 폴백

코드는 properties를 직접 읽지 않고 서비스를 거친다. 예를 들어 `AuthServiceImpl`은 메일 발신자/토큰 TTL을 이렇게 얻는다.

```java
// AuthServiceImpl 내부 (개념 추상화)
private String mailFrom() {
    // 1순위 DB setting_value → 2순위 DB fallback_value → 3순위 @Value 주입 mailFrom
    return runtimeSettingService.getValue("spring.mail.username", mailFrom);
}
private int tokenTtl() {
    return runtimeSettingService.getInt("auth.email.default-token-ttl-minutes", 30);
}
```

`getValue`의 우선순위는 다음과 같다.

| 순서 | 출처 | 조건 |
| --- | --- | --- |
| 1 | DB `setting_value` | `is_active=1`이고 값이 비어있지 않음 |
| 2 | DB `fallback_value` | `setting_value`가 비어있을 때 |
| 3 | 호출자 인자(보통 `@Value` 기본값) | 행이 없거나 위가 모두 비었거나 **조회 예외** |

```java
public String getValue(String key, String fallback) {
    try {
        RuntimeSettingVO s = mapper.findActiveSettingByKey(key); // is_active=1만
        if (s == null) return fallback;
        if (hasText(s.getSettingValue()))  return s.getSettingValue().trim();
        if (hasText(s.getFallbackValue())) return s.getFallbackValue().trim();
        return fallback;
    } catch (Exception e) {       // DB 장애·테이블 부재 시에도
        return fallback;          // 앱은 기존 기본값으로 계속 동작
    }
}
```

`getBoolean`은 `1/true/Y/yes`(대소문자 무시)를 참으로 본다. `getInt`는 파싱 실패 시 폴백을 반환한다. 즉 **설정 계층의 실패가 기능 장애로 번지지 않도록** 모든 경로가 폴백으로 수렴한다.

:::tip 왜 `findActiveSettingByKey`가 따로 있나
읽기용 조회는 `is_active = 1 LIMIT 1`로 비활성 행을 자동 제외한다. 반면 관리자 화면용 조회(`findRuntimeSettings`)는 `includeInactive` 토글로 비활성 행까지 보여준다. 런타임 소비 경로와 관리 경로의 가시성 규칙이 다르다.
:::

### 4-2. 쓰기 — upsert + 이력 적재 (단일 트랜잭션)

`saveRuntimeSetting`은 `@Transactional`로 본체 갱신과 이력 적재를 묶는다.

```text
saveRuntimeSetting(input, actorIdx)
  ├─ before = key/idx로 기존 행 조회 (없으면 신규)
  ├─ 필드 정규화 (group 기본 GENERAL, valueType 기본 STRING, 공백→null)
  ├─ before == null ? insertRuntimeSetting : updateRuntimeSetting
  └─ insertRuntimeSettingHistory(
        changeType = CREATE | UPDATE,
        actorUserIdx, before/after value, before/after snapshot(JSON))
```

이력의 `version_no`는 애플리케이션이 계산하지 않고 INSERT SQL이 원자적으로 매긴다.

```sql
INSERT INTO APPLICATION_RUNTIME_SETTING_HISTORY (..., version_no, ...)
VALUES (...,
  (SELECT COALESCE(MAX(h.version_no),0)+1
     FROM APPLICATION_RUNTIME_SETTING_HISTORY h
    WHERE h.setting_idx = #{settingIdx}),
  ...);
```

스냅샷(`before_config_json`/`after_config_json`)은 서비스가 직접 만든 작은 JSON 문자열로, 키를 `escapeJson`으로 이스케이프해 저장한다.

### 4-3. 관리자 화면

`AdminRuntimeSettingController`(`/admin/runtime-settings`)가 그룹/키워드/비활성포함 필터로 목록을 렌더링하고, 같은 화면에서 생성(`POST /`)·수정(`POST /{settingIdx}`)을 처리한다. 수정자는 세션의 `loginUser`(`UsersVO`)에서 `userIdx`를 꺼내 `updated_by_user_idx`로 기록한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 구현 완료
- `APPLICATION_RUNTIME_SETTING` / `..._HISTORY` 테이블 + seed 마이그레이션(`20260510_application_runtime_settings.sql`)
- 3단 폴백 읽기(`getValue/getInt/getBoolean`), upsert+이력 트랜잭션 쓰기
- 관리자 목록·검색·생성·수정 화면, 변경 이력 50건 조회
- 실제 소비처: 메일 발신자, base-url/public-base-url, 이메일 토큰 TTL, 휴면 기준일, 차단 캐시 파일 경로, 로그인 위험정책 일부
:::

:::warning 한계·주의
- **캐시 없음** — `getValue`는 호출마다 DB를 조회한다(인덱스 단건이라 가볍지만, 핫패스에서 호출 빈도는 유의). 인메모리 캐시/무효화는 도입돼 있지 않다.
- **모든 키가 자동 반영되지는 않음** — 코드가 명시적으로 `runtimeSettingService.getValue("키", ...)`로 읽는 키만 DB 우선이 적용된다. seed에 행이 있어도 소비 코드가 없으면 표시만 된다.
- **이력은 단방향 기록** — UI에서 특정 버전으로 한 번에 되돌리는 "롤백 버튼"은 없다. 이력은 추적·수동 복원 근거다.
- **민감값은 평문 저장** — `is_secret`은 표시 구분 메타데이터이며 컬럼 자체를 암호화하지는 않는다. 실제 secret 관리 정책은 운영 환경 통제에 의존한다.
:::

## 6. 면접 답변 3단계

1. **한 줄** — "메일·OAuth 키·토큰 TTL 같은 운영 파라미터를 properties가 아니라 DB 테이블에 두고, 재배포 없이 관리자 화면에서 바꾸는 DB 우선 설정 계층입니다."
2. **메커니즘** — "`RuntimeSettingService.getValue`가 DB `setting_value` → DB `fallback_value` → 호출자의 `@Value` 기본값 순으로 폴백합니다. 조회가 실패해도 마지막 폴백으로 수렴해서 설정 장애가 기능 장애로 번지지 않습니다. 변경은 `@Transactional`로 본체 upsert와 이력 적재를 묶고, 이력 `version_no`는 INSERT SQL이 원자적으로 매깁니다."
3. **트레이드오프** — "값마다 한 번 더 DB를 타는 비용과, 재배포 없이 즉시 반영·이력 추적이라는 운영 이점을 맞바꿨습니다. 현재는 캐시가 없어 핫패스 다빈도 키는 캐시 도입이 후속 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details Q. 왜 환경변수/Vault가 아니라 DB에 넣었나요?
환경변수는 변경 시 재기동이 필요하고 이력이 남지 않습니다. 이 프로젝트는 "누가 언제 무슨 값으로 바꿨는지"를 `_HISTORY` 스냅샷으로 남기고, 관리자 화면에서 비개발자도 토큰 TTL·휴면 기준 같은 정책을 즉시 조정하는 게 목표였습니다. Vault는 secret 전용 통제에는 더 강하지만 운영 UI·이력·일반 설정을 한 화면에서 다루는 요구에는 무거웠습니다. 대신 `is_secret` 플래그로 민감값을 구분합니다.
:::

:::details Q. DB가 죽으면 OAuth 로그인이 막히지 않나요?
`getValue`는 try/catch로 예외를 삼키고 호출자가 넘긴 폴백(보통 `@Value`로 주입된 properties 값)을 반환합니다. 즉 DB 설정 계층은 "오버레이"라서, 테이블이 없거나 조회가 실패해도 앱은 기존 properties 기본값으로 동작합니다. 다만 DB에만 넣고 properties 폴백을 비워둔 키는 이 안전망이 없으므로, 중요한 키는 properties 기본값을 함께 두는 게 원칙입니다.
:::

:::details Q. value_type이 text 컬럼인데 왜 두나요?
저장은 전부 `text`라 `value_type`은 실제 형을 강제하지 않습니다. 관리자 UI의 입력/표시 힌트와 의도 문서화 용도이고, 실제 형변환은 소비 시점에 `getInt`/`getBoolean`이 수행하며 파싱 실패 시 폴백으로 빠집니다. 즉 타입 안전성은 "저장 스키마"가 아니라 "읽기 API"가 책임집니다.
:::

:::details Q. 동시에 두 관리자가 같은 키를 수정하면?
`setting_key`에 UNIQUE 제약이 있고 저장은 단일 트랜잭션입니다. 마지막 쓰기가 본체를 덮어쓰는 last-write-wins이며, 두 변경 모두 `_HISTORY`에 각각 버전으로 남습니다. `version_no`는 `MAX(version_no)+1`을 INSERT 시점에 계산해 충돌 없이 증가합니다. 낙관적 락(버전 비교 후 거부)까지는 구현돼 있지 않습니다.
:::

:::details Q. 캐시가 없는데 성능 문제는요?
조회는 `setting_key` UNIQUE 인덱스 단건 + `LIMIT 1`이라 개별 비용은 작습니다. 다만 매 호출마다 DB를 타므로, 요청당 수십 번 읽히는 핫패스 키라면 짧은 TTL 캐시나 부팅 시 1회 로드 + 변경 시 무효화 전략이 적합합니다. 현재는 단순성·즉시 반영을 우선해 무캐시로 두었고, 이게 알려진 트레이드오프입니다.
:::

## 8. 직접 말해보기

- `getValue`의 폴백 3단계를 출처와 함께 순서대로 설명해 보세요. 어느 단계에서 예외가 안전망이 되나요?
- 설정 변경 한 번에 어떤 테이블 두 곳이 어떻게 바뀌는지, 트랜잭션 경계와 `version_no` 계산 위치를 말해 보세요.
- "그냥 환경변수 쓰면 되지 않나"라는 반박에, 이력·즉시반영·비개발자 운영 관점으로 1분 안에 방어해 보세요.

## 퀴즈

<QuizBox question="RuntimeSettingService.getValue의 폴백 우선순위로 옳은 것은?" :choices="['호출자 기본값 → DB fallback_value → DB setting_value', 'DB setting_value → DB fallback_value → 호출자 기본값', 'DB fallback_value → DB setting_value → 호출자 기본값', 'properties → 환경변수 → DB']" :answer="1" explanation="활성 행의 setting_value가 1순위, 비어 있으면 fallback_value, 그래도 없거나 조회 예외면 호출자가 넘긴 기본값(보통 @Value 주입값)으로 폴백한다." />

<QuizBox question="설정 변경 이력의 version_no는 어디서 계산되는가?" :choices="['Java 서비스가 카운터로 증가', 'INSERT SQL이 MAX(version_no)+1로 원자 계산', 'DB 트리거', 'AUTO_INCREMENT 컬럼']" :answer="1" explanation="insertRuntimeSettingHistory의 VALUES 절 안에서 해당 setting_idx의 MAX(version_no)+1을 서브쿼리로 계산해 매긴다. 애플리케이션이 따로 카운트하지 않는다." />

<QuizBox question="DB 조회가 실패(예: 테이블 부재)했을 때 getValue의 동작은?" :choices="['예외를 던져 요청 실패', 'null 반환', '호출자가 넘긴 fallback 인자를 반환', '빈 문자열 반환']" :answer="2" explanation="try/catch로 예외를 삼키고 fallback 인자를 반환한다. 그래서 DB 설정 계층 장애가 기능 장애로 번지지 않는다." />
