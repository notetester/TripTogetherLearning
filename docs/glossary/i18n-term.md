# i18n (국제화)

> 사용자 노출 문자열을 코드에서 분리해 `.properties` 언어팩으로 외부화하고, 요청마다 결정된 Locale에 맞는 번역을 골라 출력하는 Spring MVC 표준 국제화 메커니즘.

TripTogether는 화면(JSP)뿐 아니라 API 응답·예외 메시지까지 한국어(ko)·영어(en)·일본어(ja)·중국어(zh) 4개국어를 일관 적용한다. 이 페이지는 i18n의 개념과 TripTogether 실제 구성(`MessageSource`, `SessionLocaleResolver`, `LocaleChangeInterceptor`, `MessageUtil`)을 함께 설명한다.

상위 맥락은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 볼 수 있고, 요청 가로채기와 출력 단계는 [인터셉터](/glossary/interceptor)·[MVC와 JSP](/glossary/mvc-jsp), AI 응답의 다국어 처리는 [AI 통합 맵](/flow/ai-integration-map)과 연결된다.

## 1. 한 줄 정의

i18n(internationalization, i와 n 사이에 18글자)은 코드에 텍스트를 하드코딩하지 않고, "키 → 언어별 번역"을 외부 파일(언어팩)에 두어, 런타임에 현재 Locale로 메시지를 조회·치환하는 설계다. TripTogether에서는 Spring의 `MessageSource`가 언어팩을 읽고, 요청별 Locale은 `LocaleContextHolder`가 들고 있는다.

## 2. 왜 이렇게 설계했나

문자열을 코드에 직접 박으면 언어가 늘어날 때마다 분기(`if (lang.equals("en"))`)가 폭발하고, 번역 담당자가 자바 코드를 건드려야 한다. 키-값 외부화는 이 결합을 끊는다.

- **관심사 분리:** 개발자는 키(`community.api.error.loginRequired`)만 쓰고, 번역은 `.properties` 파일에서 독립적으로 관리한다.
- **도메인별 번들 분리:** 한 거대한 `messages.properties` 대신 `auth`, `community`, `inquiry`, `wallet`처럼 기능별로 쪼개 충돌·머지 비용을 줄인다(4계층·도메인 모듈 구조와 정렬).
- **화면 너머까지 일관성(ADR-0013):** JSP의 `<spring:message>`만이 아니라, 컨트롤러의 `result.put("message", ...)`와 서비스의 예외 메시지까지 같은 번들로 끌어와 "화면은 영어인데 알림은 한국어" 같은 불일치를 없앤다.
- **세션 기억:** 사용자가 한 번 고른 언어를 세션에 저장해, 페이지를 옮겨도 선택이 유지되도록 한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·파일)

핵심은 모두 `config/WebConfig.java`에 빈으로 선언되어 있다.

| 구성 요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 메시지 소스 | `ReloadableResourceBundleMessageSource` | `classpath:messages/*` 약 20개 basename을 읽음 |
| Locale 저장소 | `SessionLocaleResolver` (기본 `Locale.KOREAN`) | 결정된 언어를 세션에 보관 |
| 언어 전환기 | `LocaleChangeInterceptor` (`paramName="lang"`) | `?lang=en` 파라미터로 세션 Locale 변경 |
| API/예외 메시지 헬퍼 | `common/util/MessageUtil` | `LocaleContextHolder` 기준으로 코드에서 메시지 조회 |
| 언어팩 | `resources/messages/{module}_{ko,en,ja,zh}.properties` | 키-값 번역 본체 |

번들 basename은 도메인 단위로 등록된다(발췌):

```java
messageSource.setBasenames(
    "classpath:messages/auth",
    "classpath:messages/community",
    "classpath:messages/inquiry",
    "classpath:messages/wallet"
    // ... admin, assistant, chatbot, course(s), detail, explore,
    //     footer, header, home, mypage, package, report, recommend,
    //     superAdmin, shop, security
);
messageSource.setDefaultEncoding("UTF-8");
messageSource.setUseCodeAsDefaultMessage(true); // 키 누락 시 키 자체 노출
```

:::tip useCodeAsDefaultMessage(true)
번역이 빠진 키는 예외를 던지지 않고 키 코드(`community.detail.back`) 그대로 화면에 나온다. 운영 중 깨짐 없이 "어떤 키가 비었는지"를 눈으로 잡는 안전장치다. 대신 누락이 사용자에게 노출될 수 있어 런타임 검증이 약하다는 트레이드오프가 있다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

언어 선택부터 출력까지 한 요청 안에서 일어나는 일:

```text
헤더 언어 셀렉트(change)
  → JS가 현재 URL에 ?lang=en 추가 후 재요청
    → LocaleChangeInterceptor.preHandle 이 lang=en 읽음
      → SessionLocaleResolver 가 세션 Locale = en 으로 변경
        → LocaleContextHolder 에 en 세팅 (이 요청 동안 유지)
          → JSP:  <spring:message code="..."/>  → en 번역 출력
          → API:  msg.get("...")  →  MessageSource 가 en 값 반환
            → 이후 같은 세션 요청은 ?lang 없이도 en 유지
```

헤더의 전환 UI는 `common/header.jsp`의 `select#langSel`이며, 변경 시 JS가 `url.searchParams.set('lang', this.value)`로 재요청한다. 옵션 selected 상태는 `pageContext.response.locale.language`로 현재 언어와 비교한다.

코드 두 갈래의 사용 패턴:

```java
// (1) JSP — 뷰 문자열
//   <spring:message code="wallet.title"/>

// (2) API / 예외 — MessageUtil 주입 (ADR-0013)
result.put("message", msg.get("community.api.error.loginRequired"));
throw new IllegalStateException(
    msg.get("community.service.error.commentRateLimit",
            windowMinutes, maxCount));   // {0},{1} 치환
```

키 네이밍은 ADR-0013이 규약화했다: `{module}.api.error.{동작}`, `{module}.api.success.{동작}`, `{module}.service.error.{동작}`.

AI 응답도 같은 다국어 축을 탄다. `AssistantServiceImpl`은 `LANG_NAME_MAP`으로 `lang` 코드를 언어명으로 바꿔 `buildSystemPrompt(lang)`에 주입, 시스템 프롬프트 자체를 해당 언어로 구성한다(공통 챗봇은 구조화 JSON, 문의 답변 초안은 Claude Haiku 경로).

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨:** `MessageSource`·`SessionLocaleResolver`·`LocaleChangeInterceptor` 빈 구성, 약 20개 도메인 번들 × 4개 언어 `.properties`, `?lang=` 전환과 세션 유지, 헤더 언어 셀렉트, `MessageUtil` 기반 API/예외 메시지 i18n, AI 어시스턴트 언어별 시스템 프롬프트.
- **부분 적용(ADR-0013 단계적):** API/예외 메시지 i18n은 `community`·`report`·`inquiry`에 먼저 적용. 다른 모듈은 JSP는 4개국어지만 일부 백엔드 응답·`alert()`/`confirm()` 잔여 한국어가 남아 점진 확장 대상이다.
- **계획/외부 의존:** 동적 콘텐츠(사용자 입력·스팟 설명) 자동 번역은 Google Cloud Translation 연동·DB 번역 캐싱으로 다루지만, 정적 UI 4개국어와 달리 커버리지가 콘텐츠 의존적이다. 번역 누락 키는 `useCodeAsDefaultMessage`로 키 노출되며 자동 차단되지 않는다.

## 6. 면접 답변 3단계

1. **한 줄:** "사용자 노출 문자열을 키-값 언어팩으로 외부화하고, 요청마다 결정된 Locale로 번역을 골라 출력하는 Spring 표준 i18n을 ko/en/ja/zh 4개국어로 적용했습니다."
2. **설계 의도:** "`MessageSource`가 도메인별 번들을 읽고, `SessionLocaleResolver`가 선택 언어를 세션에 기억합니다. `?lang=` 파라미터를 `LocaleChangeInterceptor`가 받아 전환하므로, 새로고침이나 페이지 이동에도 언어가 유지됩니다."
3. **확장:** "ADR-0013에서 JSP를 넘어 컨트롤러 응답·서비스 예외 메시지까지 `MessageUtil`로 i18n을 넓혀, '화면은 영어인데 에러는 한국어'인 불일치를 제거했습니다. AI 어시스턴트도 언어 코드로 시스템 프롬프트를 바꿔 응답 언어를 맞춥니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. ResourceBundleMessageSource 대신 ReloadableResourceBundleMessageSource를 쓴 이유는?
`Reloadable~`은 클래스패스 밖 파일 경로와 캐시 갱신(reload)을 지원해 운영 중 메시지 교체에 유연하고, basename을 `classpath:`로도 지정할 수 있습니다. 기본 `ResourceBundleMessageSource`는 JDK `ResourceBundle` 기반이라 한 번 로드하면 캐시가 고정되는 제약이 있습니다.
:::

:::details Q2. SessionLocaleResolver와 AcceptHeaderLocaleResolver(브라우저 Accept-Language)의 차이는?
`AcceptHeader~`는 브라우저가 보낸 `Accept-Language`만 보고 Locale을 정해 **사용자가 직접 바꿀 수 없습니다**(stateless). `SessionLocaleResolver`는 선택을 세션에 저장해 **사용자가 토글하고 그 선택이 유지**됩니다. TripTogether는 헤더에서 언어를 고르는 UX라 세션 방식이 맞습니다. 다만 세션 단위라 같은 사용자가 다른 브라우저에서는 기본값(KOREAN)부터 시작합니다.
:::

:::details Q3. 번역 키가 한 언어에만 빠지면 어떻게 되나?
`setUseCodeAsDefaultMessage(true)` 때문에 예외 없이 키 코드 문자열이 그대로 출력됩니다. 깨짐은 막지만 사용자에게 키가 노출될 수 있어, 4개 언어 동시 작성을 규칙으로 강제하고 키 누락을 코드 리뷰/감사 문서로 잡는 보완이 필요합니다.
:::

:::details Q4. MessageUtil이 LocaleContextHolder에 의존하는데, 스케줄러나 비동기 작업에서 호출하면?
`LocaleContextHolder`는 요청 스레드에 묶인 Locale을 들고 있어, 요청 컨텍스트가 없는 스케줄러/배치에서는 기본 Locale(KOREAN)로 떨어집니다. 그런 경우 Locale을 명시적으로 인자로 넘기는 오버로드를 쓰거나, 알림 대상 사용자의 선호 언어를 따로 조회해 적용해야 합니다.
:::

:::details Q5. 도메인별로 번들을 쪼갠 이유와 비용은?
이점은 팀 협업입니다. 도메인 단위 모듈 구조와 정렬되어 머지 충돌이 줄고, 담당 영역의 키만 관리하면 됩니다. 비용은 `WebConfig`의 basename 목록을 새 모듈마다 추가해야 하고, 같은 의미의 공통 문구가 번들 간 중복될 수 있다는 점입니다. 공통 문구는 `common`/`header`/`footer` 번들로 모아 완화합니다.
:::

## 8. 직접 말해보기

다음을 소리 내어 60초로 설명해 보자.

1. `?lang=en` 한 번 클릭이 화면과 API 응답 언어를 동시에 바꾸는 과정을, `LocaleChangeInterceptor` → `SessionLocaleResolver` → `LocaleContextHolder` 순서로.
2. ADR-0013이 "JSP만 i18n"이던 상태에서 무엇을 더 풀었고, 왜 전체가 아닌 일부 모듈부터 시작했는지.
3. `useCodeAsDefaultMessage(true)`의 장점과 위험을 한 문장씩.

## 퀴즈

<QuizBox question="TripTogether에서 ?lang=en 요청 파라미터를 읽어 세션 Locale을 바꾸는 구성 요소는?" :choices="['SessionLocaleResolver', 'LocaleChangeInterceptor', 'MessageUtil', 'ReloadableResourceBundleMessageSource']" :answer="1" explanation="LocaleChangeInterceptor가 paramName=lang으로 등록되어 요청의 lang 값을 읽어 LocaleResolver의 Locale을 변경한다. 변경된 언어를 세션에 저장하는 것은 SessionLocaleResolver의 몫이다." />

<QuizBox question="setUseCodeAsDefaultMessage(true) 설정의 효과로 옳은 것은?" :choices="['번역이 없으면 NoSuchMessageException을 던진다', '번역이 없으면 한국어로 폴백한다', '번역이 없으면 키 코드 자체를 출력한다', '번역이 없으면 빈 문자열을 출력한다']" :answer="2" explanation="번역 누락 시 예외 대신 키 코드(예: community.detail.back)를 그대로 반환한다. 깨짐은 막지만 누락이 사용자에게 노출될 수 있다." />

<QuizBox question="ADR-0013이 i18n 적용 범위를 넓힌 핵심 지점은 무엇인가? (주관식)" explanation="JSP의 <spring:message>에 더해, 컨트롤러 응답 메시지(result.put)와 서비스 예외 메시지까지 MessageUtil로 i18n을 확장해 화면-API 간 언어 불일치를 제거했다. 단, community/report/inquiry부터 단계적으로 적용했다." />
