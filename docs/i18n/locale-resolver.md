---
title: "LocaleResolver·언어전환"
owner: C
domain: "다국어·공통"
tags: ["Locale"]
---

# LocaleResolver·언어전환

> 사용자의 언어를 어디에 저장하고(세션), 어떻게 바꾸며(요청 파라미터 lang), 기본값이 무엇인지(한국어)를 결정하는 다국어 인프라의 진입점.

이 문서는 [다국어·공통](/i18n/) 도메인의 한 챕터다. 메시지 번들 자체는 [MessageSource·properties](/i18n/messagesource)에서, DB 기반 동적 번역은 [DB 번역 관리](/i18n/db-translation)에서 다룬다. 여기서는 "현재 요청의 언어를 무엇으로 정할 것인가"라는 결정 로직만 본다.

## 1. 한 줄 정의

`LocaleResolver`는 들어온 HTTP 요청의 언어(Locale)를 결정하고 보관하는 전략 객체이고, `LocaleChangeInterceptor`는 요청 파라미터 `lang`을 보고 그 보관 값을 바꾸는 인터셉터다. TripTogether는 둘을 조합해 **세션 단위로 언어를 기억하고, URL에 lang을 붙여 언어를 전환**한다.

## 2. 왜 이렇게 설계했나

언어 결정 전략은 보통 세 가지 중 하나를 고른다. 각각 트레이드오프가 다르다.

| 전략 | Resolver | 저장 위치 | 특징 |
| --- | --- | --- | --- |
| 요청마다 헤더로 결정 | `AcceptHeaderLocaleResolver` | 저장 없음 | 브라우저 설정에 종속, 사용자가 못 바꿈 |
| 쿠키에 저장 | `CookieLocaleResolver` | 브라우저 쿠키 | 세션이 끝나도 유지, 비로그인 기기에 남음 |
| 세션에 저장 | `SessionLocaleResolver` | 서버 세션 | 한 번 고르면 그 세션 내내 유지, 로그아웃/만료 시 초기화 |

TripTogether는 **세션 인증 기반**(세션 속성 `loginUser`에 `UsersVO`를 저장)이라 이미 모든 사용자가 서버 세션을 가진다. 언어도 같은 세션에 얹으면 별도 저장소나 쿠키 정책 없이 "선택한 언어가 그 방문 동안 유지"되는 자연스러운 동작을 얻는다. 기본값을 한국어로 둔 이유는 국내 여행 플랫폼이라 1차 사용자가 한국어 화자이기 때문이다. 영어/일본어/중국어는 사용자가 명시적으로 전환할 때만 적용된다.

전환 수단으로 URL 파라미터 `lang`을 고른 이유는 단순함이다. 헤더 메뉴의 언어 링크를 `?lang=en` 형태로 만들기만 하면 별도 API나 자바스크립트 상태 관리 없이 GET 한 번으로 언어가 바뀐다. 인터셉터가 이 파라미터를 가로채 세션 값을 갱신하므로, 한 번 전환하면 이후 요청에는 `lang`이 없어도 세션에 남은 언어가 적용된다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

핵심은 `WebConfig`(`org.triptogether.config.WebConfig`)의 세 개 빈과 인터셉터 등록이다.

```java
// 1) 언어 보관 전략: 세션, 기본 한국어
@Bean
public LocaleResolver localeResolver() {
    SessionLocaleResolver localeResolver = new SessionLocaleResolver();
    localeResolver.setDefaultLocale(Locale.KOREAN);
    return localeResolver;
}

// 2) lang 파라미터 감지 인터셉터
@Bean
public LocaleChangeInterceptor localeChangeInterceptor() {
    LocaleChangeInterceptor interceptor = new LocaleChangeInterceptor();
    interceptor.setParamName("lang");   // ?lang=en, ?lang=ja ...
    return interceptor;
}
```

`localeChangeInterceptor`는 인터셉터 체인의 **맨 앞**에 등록된다. 언어가 가장 먼저 확정되어야 이후 인터셉터(IP 차단, 활동 로그, 알림 등)와 컨트롤러, 그리고 JSP 렌더링이 모두 같은 언어를 보기 때문이다. 정적 리소스 경로는 제외한다.

```java
registry.addInterceptor(localeChangeInterceptor())
        .addPathPatterns("/**")
        .excludePathPatterns(
                "/resources/**", "/upload/**", "/favicon.ico",
                "/error", "/css/**", "/js/**", "/images/**"
        );
```

확정된 Locale은 두 곳에서 소비된다.

- **JSP 정적 문구**: Spring Message Tag(`spring:message`)가 `MessageSource`(같은 `WebConfig`의 `messageSource` 빈, basename `header`/`footer`/`explore` 등 도메인별 번들)에서 현재 Locale에 맞는 `*_ko/_en/_ja/_zh.properties` 값을 꺼낸다.
- **Java 코드 메시지**: 컨트롤러/서비스에서 `messageSource.getMessage(code, args, locale)` 로 사용자 노출 문구를 해석한다.

특수 케이스로, **IP/지역 차단 화면**은 일반 전환 흐름을 거치지 않고 `IpBlockInterceptor`가 세션 Locale을 직접 덮어쓴다.

```java
// 차단 페이지를 방문자 지역 언어로 보여주기 위한 직접 세팅
request.getSession(true).setAttribute(
        SessionLocaleResolver.LOCALE_SESSION_ATTRIBUTE_NAME,
        Locale.forLanguageTag(pageLang));
```

즉 차단 결정 시점에 추정한 `pageLang`을 세션 Locale 키에 직접 넣어, 차단 안내가 방문자가 읽을 수 있는 언어로 뜨도록 한다.

## 4. 동작 원리 (흐름·표·작은 코드)

요청이 들어와 언어가 확정되는 순서.

```text
요청  /explore?lang=en
  │
  ▼
LocaleChangeInterceptor.preHandle
  └ 파라미터 lang=en 감지
      └ localeResolver.setLocale(req, res, Locale.ENGLISH)   // 세션에 en 저장
  │
  ▼
이후 인터셉터(ipBlock→activityLog→login→...) · 컨트롤러 · JSP
  └ LocaleContextHolder / spring:message 가 세션의 en 을 읽어 영어 렌더링
  │
다음 요청  /community   (lang 없음)
  └ 세션에 en 이 남아 있으므로 계속 영어
```

핵심 규칙을 표로 정리하면 다음과 같다.

| 상황 | 적용 언어 | 근거 |
| --- | --- | --- |
| 첫 방문, lang 없음 | 한국어(KOREAN) | `setDefaultLocale(Locale.KOREAN)` |
| URL에 lang=en | 영어 + 세션 저장 | `LocaleChangeInterceptor` |
| 이후 lang 없는 요청 | 직전 세션 언어 유지 | `SessionLocaleResolver` |
| 세션 만료/로그아웃 후 재시작 | 다시 한국어 | 세션 초기화 |
| 지역 차단 페이지 | 추정 지역 언어 | `IpBlockInterceptor` 직접 세팅 |
| 지원하지 않는 lang 값 | 번들 없으면 키 자체 노출 | `setUseCodeAsDefaultMessage(true)` |

지원 언어는 `ko`, `en`, `ja`, `zh` 4개다. 메시지 번들(`messageSource`)이 이 네 suffix만 가지므로, 그 밖의 lang 값이 와도 매칭되는 properties가 없으면 메시지 코드 자체가 화면에 노출되어 누락을 빠르게 발견할 수 있다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `SessionLocaleResolver` 기본 한국어 | 구현됨 |
| `LocaleChangeInterceptor` lang 전환 | 구현됨 |
| 4개국어(ko/en/ja/zh) 정적 번들 연결 | 구현됨 |
| 차단 페이지 지역 언어 직접 세팅 | 구현됨 |
| 미번역 키 누락 노출(useCodeAsDefaultMessage) | 구현됨 |
| 로그인 사용자 선호 언어 영구 저장(프로필 컬럼) | 계획 — 현재는 세션 한정, 세션 만료 시 한국어로 초기화 |
| 쿠키 기반 장기 기억 | 미적용 — 세션 전략 단일 |
| URL 경로 기반 언어(예 /en/explore) | 미적용 — 쿼리 파라미터 방식만 |

세션 전략의 한계는 정직하게 짚어둘 만하다. 같은 사용자가 다시 접속하면 세션이 새로 시작되어 한국어로 돌아간다. 로그인 사용자의 선호 언어를 계정에 영구 저장하는 것은 향후 과제다.

## 6. 면접 답변 3단계

1. **한 문장**: "언어는 세션에 저장하고, URL에 lang 파라미터를 붙여 전환하며, 기본값은 한국어입니다."
2. **설계 의도**: "이미 세션 인증을 쓰니 언어도 같은 세션에 얹어 별도 저장소 없이 방문 동안 유지되게 했고, 전환은 헤더 링크에 lang을 붙이는 GET 한 번으로 끝나도록 단순화했습니다. 인터셉터 체인 맨 앞에 두어 이후 모든 인터셉터와 JSP가 같은 언어를 보게 했습니다."
3. **한계 인정**: "선호 언어가 세션 한정이라 재접속하면 한국어로 초기화됩니다. 로그인 사용자라면 계정에 선호 언어를 저장하는 게 다음 개선점입니다."

## 7. 꼬리질문 + 모범답안

:::details Q. 왜 쿠키가 아니라 세션에 언어를 저장했나요?
프로젝트가 세션 기반 인증이라 모든 사용자가 이미 서버 세션을 갖습니다. 언어도 같은 세션에 얹으면 추가 저장소나 쿠키 만료/도메인 정책 없이 방문 동안 유지됩니다. 대신 세션이 끝나면 기본값으로 돌아가는 단점이 있어, 영구 기억이 필요하면 계정 컬럼이나 쿠키 전략으로 보강해야 합니다.
:::

:::details Q. LocaleChangeInterceptor를 인터셉터 체인 맨 앞에 둔 이유는?
언어가 가장 먼저 확정되어야 합니다. 뒤따르는 IP 차단, 활동 로그, 알림 인터셉터와 컨트롤러, JSP 렌더링이 모두 현재 Locale을 읽기 때문에, lang 처리를 나중에 하면 같은 요청 안에서 일부는 이전 언어로 렌더링되는 불일치가 생길 수 있습니다.
:::

:::details Q. 지원하지 않는 lang 값(예 lang=fr)이 오면 어떻게 되나요?
인터셉터는 세션 Locale을 fr로 바꾸지만, 메시지 번들에 fr suffix 파일이 없습니다. messageSource가 useCodeAsDefaultMessage true로 설정되어 있어, 매칭되는 번역이 없으면 예외 대신 메시지 코드 자체가 화면에 노출됩니다. 운영 중 미번역 키를 눈으로 잡아낼 수 있어 디버깅에 유리합니다. 지원 언어는 ko/en/ja/zh 4개입니다.
:::

:::details Q. 차단 페이지는 왜 일반 전환 흐름을 안 쓰나요?
차단된 방문자는 lang을 직접 붙일 기회가 없고, 차단 결정은 IP/지역으로 먼저 이뤄집니다. 그래서 IpBlockInterceptor가 추정한 지역 언어를 SessionLocaleResolver의 세션 키에 직접 넣어, 안내 문구를 방문자가 읽을 수 있는 언어로 띄웁니다. 일반 흐름의 LocaleChangeInterceptor보다 앞이나 별도 시점에서 작동하는 예외 처리입니다.
:::

:::details Q. JSP에서 언어가 적용되는 마지막 단계는 어디인가요?
JSP의 Spring Message Tag가 렌더링 시 현재 Locale을 읽어 도메인별 properties 번들에서 해당 언어 값을 꺼냅니다. 즉 인터셉터가 세션에 언어를 정하고, MessageSource가 그 언어의 번들을 고르며, 태그가 최종 문자열로 출력합니다. 결정-보관-소비가 분리되어 있습니다.
:::

## 8. 직접 말해보기

- 사용자가 헤더에서 영어를 누른 순간부터 화면이 영어로 뜨기까지, 거쳐 가는 객체를 순서대로 말해보기 (인터셉터 → Resolver → 세션 → MessageSource → JSP 태그).
- "왜 기본값이 한국어인가"와 "왜 세션 전략인가"를 각각 한 문장으로 구분해 설명해보기.
- 세션 전략의 한계 하나와 그 개선안을 30초 안에 말해보기.

## 퀴즈

<QuizBox question="TripTogether에서 사용자의 현재 언어를 보관하는 전략과 기본 언어로 옳은 것은?" :choices="['쿠키 저장, 기본 영어', '세션 저장(SessionLocaleResolver), 기본 한국어', 'Accept-Language 헤더, 기본값 없음', 'DB 프로필 컬럼, 기본 일본어']" :answer="1" explanation="WebConfig에서 SessionLocaleResolver를 쓰고 setDefaultLocale로 KOREAN을 기본값으로 둔다. 언어는 서버 세션에 저장된다." />

<QuizBox question="URL의 lang 파라미터를 감지해 세션 언어를 바꾸는 컴포넌트와 그 등록 위치로 옳은 것은?" :choices="['LocaleChangeInterceptor, 인터셉터 체인 맨 앞', 'LoginInterceptor, 체인 맨 뒤', 'GlobalExceptionHandler, 컨트롤러 이후', 'NotificationInterceptor, 정적 리소스 단계']" :answer="0" explanation="LocaleChangeInterceptor가 paramName lang을 감지하며, 이후 모든 인터셉터와 JSP가 같은 언어를 보도록 체인 맨 앞에 등록된다." />

<QuizBox question="지원하지 않는 lang 값이 들어와 번역 번들이 없을 때의 동작으로 옳은 것은?" :choices="['요청이 500 에러로 실패한다', '자동으로 영어 번들로 폴백한다', 'useCodeAsDefaultMessage가 true라 메시지 코드 자체가 화면에 노출된다', '세션이 강제로 초기화된다']" :answer="2" explanation="messageSource는 setUseCodeAsDefaultMessage(true)로 설정되어, 매칭되는 번역이 없으면 예외 대신 키를 그대로 보여줘 미번역 누락을 쉽게 발견하게 한다." />
