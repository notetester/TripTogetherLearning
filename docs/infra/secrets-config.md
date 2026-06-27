# 설정·시크릿 관리

> TripTogether는 외부 API 키 8종 이상과 DB·SMTP·OAuth 자격증명을 다룬다. 이 페이지는 그 값들이 어디에 정의되고, 어떻게 코드로 주입되며, 무엇을 절대 커밋하면 안 되는지를 정리한다.

여기서 다루는 모든 키 값은 자리표시자(`API_KEY`, `DB_HOST` 등)로만 표기한다. 실제 자격증명은 공개 학습 문서에 절대 적지 않는다.

## 1. 한 줄 정의

설정·시크릿 관리는 **빌드 시점에 고정되는 `application.properties` 값**과 **런타임에 DB에서 덮어쓰는 `APPLICATION_RUNTIME_SETTING` 값** 두 계층으로 외부 의존성의 자격증명·동작 파라미터를 관리하는 체계다.

## 2. 왜 이렇게 설계했나

TripTogether는 단일 WAR로 패키징되는 Spring Boot 4 앱이라, 설정의 1차 출처는 클래스패스의 `application.properties`다. 하지만 키 두 종류는 성격이 다르다.

| 분류 | 예시 | 변경 빈도 | 어디에 둬야 하나 |
| --- | --- | --- | --- |
| 빌드 고정 자격증명 | DB 접속, SMTP, OAuth client-secret, Cloudinary secret | 거의 없음 | `.properties` (배포 환경별 분리) |
| 운영 중 조정 파라미터 | 로그인 위험 임계치, 챗봇 쿼터, 차단 토글 | 자주 | DB 런타임 설정 |

두 번째 묶음을 매번 재빌드·재배포해 바꾸는 것은 비효율적이다. 그래서 `RuntimeSettingService`로 **DB 값을 우선 적용하고, 없으면 `.properties`/하드코딩 fallback으로 떨어지는** 2계층 구조를 만들었다. 키마다 `is_secret` 플래그를 둬, 비밀값은 관리자 화면에서 마스킹·이력 분리 처리할 수 있게 했다.

:::warning 정직한 현재 상태
실제 리포지토리에서 `application.properties`는 **Git에 추적되고 있고 일부 실제 키가 들어 있다**. 반면 로컬 전용 `application-local.properties`는 `.gitignore`로 제외된다. 이상적 구조(아래 5절)와 현재 구현 상태가 다른 지점이며, 면접에서도 "현재는 이렇고, 개선 방향은 환경변수/외부 시크릿 매니저"로 솔직히 말하는 편이 낫다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·키)

`@Value`로 `.properties` 키를 서비스에 주입한다. 키 이름 → 사용 클래스 매핑:

| 설정 키(placeholder) | 주입 클래스 | 용도 |
| --- | --- | --- |
| `openai.api.key` / `openai.model` | `AssistantServiceImpl`, `AiPlanGPTServiceImpl` | GPT-4o-mini 멀티턴·AI 일정 |
| `gemini.api.key` | `ChatbotService`, `IntentContextService`, `RecommendService` | Gemini 2.5 Flash 챗봇·추천 |
| `claude.api.key` / `inquiry.claude.api.key` | 문의 AI 답변 초안 | Claude Haiku |
| `perspective.api.key` | `PerspectiveService` | 독성(TOXICITY) 점수 |
| `gcp.translate.api.key` | `SpotTextTranslationService`, `AdminTranslationServiceImpl` | Google Cloud Translation |
| `google.maps.api-key` | `ExploreController`, `DetailController` | 지도 렌더 |
| `cloudinary.cloud-name/api-key/api-secret` | `CloudinaryService` | 이미지 호스팅 |
| `pixabay.api.key` | `CommunityImageScheduler` | 이미지 fallback 캐싱 |
| `oauth.{kakao,naver,google}.client-id/client-secret/redirect-uri` | `AuthServiceImpl`, `AuthController` | 소셜 로그인 |
| `toss.payments.client-key/secret-key` | `WalletController`, `TossPaymentsClient` | 충전·결제(test mode) |
| `spring.datasource.url/username/password` | MyBatis DataSource | MySQL 접속 |
| `spring.mail.*` | spring-boot-starter-mail | 이메일 인증 발송 |

런타임 설정 계층의 핵심 클래스:

```text
RuntimeSettingVO       settingKey, settingValue, fallbackValue, valueType, secret, editable, active
RuntimeSettingService  getValue/getInt/getBoolean(key, fallback), saveRuntimeSetting(+이력)
RuntimeSettingMapper   APPLICATION_RUNTIME_SETTING 조회/저장
AdminRuntimeSettingController  /admin/runtime-settings 관리 UI
```

`@Value` 키 대부분이 `${openai.api.key:}`처럼 **빈 기본값(`:`)** 을 갖는다. 키가 비어 있어도 컨텍스트가 뜨고, 해당 기능만 비활성/Mock 경로로 빠지게 하기 위한 방어다.

## 4. 동작 원리 (해석 우선순위)

런타임 설정 조회는 항상 fallback 체인을 탄다.

```java
public String getValue(String settingKey, String fallbackValue) {
    RuntimeSettingVO s = mapper.findActiveSettingByKey(settingKey); // 1) DB active 행
    if (s == null) return fallbackValue;                           // 4) 인자 fallback
    if (hasText(s.getSettingValue()))  return s.getSettingValue(); // 2) DB 값
    if (hasText(s.getFallbackValue())) return s.getFallbackValue();// 3) DB fallback 컬럼
    return fallbackValue;                                          // 4) 인자 fallback
}
```

우선순위를 정리하면:

1. DB `settingValue` (관리자가 운영 중 입력)
2. DB `fallbackValue` 컬럼 (설정 행은 있으나 값 미입력)
3. 호출부가 넘긴 코드 fallback (`@Value`로 읽은 `.properties` 값 등)
4. 조회 자체가 예외면 `catch`에서 fallback — **설정 DB 장애가 기능 전체를 멈추지 않는다**

`is_secret` 흐름:

| 단계 | 동작 |
| --- | --- |
| 저장 | `AdminRuntimeSettingController`가 폼의 `secret` 체크박스를 `RuntimeSettingVO.secret`으로 매핑 |
| 이력 | `saveRuntimeSetting`이 변경 전/후 스냅샷을 `RuntimeSettingHistory`에 JSON으로 적재(감사 추적) |
| 표시 | 비밀 플래그가 켜진 값은 관리자 목록에서 평문 노출 대신 마스킹 대상으로 분리 |

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `@Value` 기반 `.properties` 키 주입 | 구현됨 — 위 모든 외부 API가 실제 키로 동작 |
| DB 우선 런타임 설정(2계층, 이력) | 구현됨 — `RuntimeSettingService` + 관리자 UI |
| `is_secret` 마스킹·`value_type`·`editable`·`active` | 구현됨 |
| `application-local.properties` gitignore 분리 | 구현됨 (로컬 프로필) |
| `application.properties` 비밀값 분리 | **미흡** — 추적 파일에 키 일부 포함, 개선 과제 |
| 환경변수/외부 시크릿 매니저(Vault·SSM 등) | 계획 — 미도입 |
| 키 로테이션·만료 자동화 | 계획 — 수동 |

:::tip 이상적 구조 (개선 방향)
`.properties`에는 키 **이름만** 두고 값은 환경변수로 주입한다: `openai.api.key=${OPENAI_API_KEY}`. 그러면 추적 파일에는 placeholder만 남고, 실제 값은 배포 환경(컨테이너 env, CI secret, 시크릿 매니저)에서 공급된다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** "설정은 빌드 고정값(`application.properties`)과 운영 중 바뀌는 값(DB `APPLICATION_RUNTIME_SETTING`) 두 계층으로 나누고, DB 값을 우선하되 없으면 properties/코드 fallback으로 떨어지게 했습니다."
2. **설계 이유:** "AI 키·OAuth secret처럼 거의 안 바뀌는 값과, 챗봇 쿼터·위험 임계치처럼 자주 조정하는 값은 변경 비용이 다릅니다. 후자를 재배포 없이 바꾸려고 `RuntimeSettingService`에 DB 우선 + 이력 + `is_secret` 마스킹을 넣었습니다."
3. **한계·개선:** "현재 `application.properties`에 일부 실제 키가 추적되는 문제가 있어, properties는 키 이름만 두고 값은 환경변수/시크릿 매니저로 빼는 것이 다음 개선입니다."

## 7. 꼬리질문 + 모범답안

:::details Q. 설정값이 DB·properties·코드 세 군데 있는데 무엇이 이기나?
DB의 active 행 `settingValue`가 1순위, 그다음 DB `fallbackValue` 컬럼, 그다음 호출부가 넘긴 코드 fallback(주로 `@Value`로 읽은 properties 값), 마지막으로 조회 예외 시 fallback입니다. 즉 운영 중 관리자가 DB에 넣은 값이 항상 우선하고, 설정 DB 장애 시에도 properties/코드 기본값으로 무중단 동작합니다.
:::

:::details Q. `is_secret` 플래그는 실제로 무엇을 막나?
DB 컬럼과 `RuntimeSettingVO.secret`으로 비밀 여부를 표시하고, 관리자 목록 화면에서 평문 노출 대신 마스킹 대상으로 분리합니다. 다만 이는 표시 계층 보호이고, 실제 값은 여전히 DB에 저장되므로 DB 접근 통제와 함께 봐야 합니다. 키 저장 자체를 암호화하는 단계는 향후 과제입니다.
:::

:::details Q. `@Value("${openai.api.key:}")`에서 끝의 콜론은 왜 있나?
키가 정의되지 않았을 때 **빈 문자열을 기본값**으로 쓰겠다는 뜻입니다. 키 없이도 애플리케이션 컨텍스트가 정상 기동하고, 해당 AI 기능만 비활성/예외 처리 경로로 빠집니다. 키가 없어도 떠야 하는 부분 기능과, 반드시 있어야 하는 핵심 설정(DB 등)을 의도적으로 구분한 것입니다.
:::

:::details Q. 로컬과 운영 설정은 어떻게 분리했나?
`application-local.properties`를 별도 프로필로 두고 `.gitignore`로 제외했습니다. 로컬은 localhost MySQL 같은 개발 자격증명을, 기본 properties는 공용 설정을 담습니다. 실행 시 `-Dspring-boot.run.profiles=local`로 오버라이드합니다. 다만 기본 properties에 실제 키가 남아 있는 점은 개선 대상입니다.
:::

:::details Q. OAuth client-secret 같은 값을 코드/문서에 노출하지 않으려면?
원칙적으로 (1) properties에는 `${ENV_VAR}` 참조만 두고 값은 배포 환경 env로 주입, (2) 공개 문서·로그·예외 메시지에 키를 찍지 않기, (3) 깃 히스토리에 한번 올라간 키는 폐기 후 재발급(로테이션) 입니다. TripTogether 학습 문서도 모든 키를 `API_KEY` 같은 placeholder로만 표기합니다.
:::

## 8. 직접 말해보기

- "DB 우선 + properties fallback" 2계층을, 챗봇 쿼터 값 변경을 예로 들어 1분 안에 설명해 보세요.
- 빌드 고정값과 런타임 조정값을 가르는 기준(변경 빈도·재배포 비용)을 직접 정의해 말해 보세요.
- 현재 `application.properties`에 키가 추적되는 문제를, 환경변수 주입으로 어떻게 고칠지 마이그레이션 순서로 설명해 보세요.

관련 페이지: [AI 통합 맵](/flow/ai-integration-map) · [인증·세션 흐름](/flow/auth-session-flow) · [Git 협업 전략](/infra/git-workflow) · 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="RuntimeSettingService.getValue가 값을 결정하는 우선순위로 옳은 것은?"
  :choices="['코드 fallback → DB settingValue → DB fallbackValue', 'DB settingValue → DB fallbackValue → 인자 fallback', 'properties → DB settingValue만, fallback 없음', 'DB fallbackValue → DB settingValue → 예외 throw']"
  :answer="1"
  explanation="active 행의 settingValue가 1순위, 비어 있으면 DB fallbackValue, 그래도 없으면 호출부가 넘긴 인자 fallback 순서로 떨어집니다. 조회 예외 시에도 fallback을 반환해 무중단 동작합니다."
/>

<QuizBox
  question="@Value('${gemini.api.key:}') 처럼 키 끝에 콜론을 붙인 이유로 가장 적절한 것은?"
  :choices="['키를 암호화하기 위해', '키가 없을 때 빈 문자열을 기본값으로 써 컨텍스트 기동을 막지 않으려고', '키를 DB에서 읽기 위해', 'JSP에서 사용하기 위해']"
  :answer="1"
  explanation="콜론 뒤가 기본값입니다. 여기서는 빈 문자열이라, 키가 없어도 앱이 뜨고 해당 AI 기능만 비활성/예외 경로로 빠집니다."
/>

<QuizBox
  question="공개 리포지토리에서 시크릿을 다룰 때 잘못된 관행은?"
  :choices="['properties에 값 대신 환경변수 참조를 둔다', 'application-local.properties를 .gitignore로 제외한다', '실제 API 키를 학습 문서에 그대로 적는다', '깃에 올라간 키는 폐기 후 재발급한다']"
  :answer="2"
  explanation="실제 키를 문서·코드·로그에 노출하는 것이 핵심 위반입니다. 문서에는 API_KEY 같은 placeholder만, 값은 환경변수로 주입하고, 노출된 키는 즉시 로테이션해야 합니다."
/>
