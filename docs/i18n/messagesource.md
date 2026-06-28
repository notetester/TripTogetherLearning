---
title: "MessageSource·properties"
owner: C
domain: "다국어·공통"
tags: ["MessageSource"]
---

# MessageSource·properties

> 도메인별로 쪼갠 `*_ko/en/ja/zh.properties` 번들을 하나의 `MessageSource` 빈으로 묶고, 누락된 키는 코드 그대로 노출해 빠르게 잡는다.

## 1. 한 줄 정의

`MessageSource`는 화면 문구와 API 메시지를 코드에 박지 않고, 도메인별 `.properties` 번들에서 현재 Locale에 맞는 텍스트를 조회해 주는 스프링 표준 i18n 컴포넌트다.

## 2. 왜 이렇게 설계했나

TripTogether는 한국어 기본에 영어·일본어·중국어까지 4개 언어를 지원하는 국내 여행 플랫폼이다. 문구를 JSP나 자바 코드에 직접 쓰면 언어가 늘 때마다 코드를 수정해야 하므로, 표현(텍스트)과 로직을 분리하는 것이 핵심 동기다.

- 단일 거대 번들 대신 `admin`, `auth`, `community`, `course`, `explore` 처럼 **도메인별 basename으로 분리**했다. 4인 공동 개발에서 각자 담당 도메인 번들만 만지면 되므로 머지 충돌이 줄고, 키 네임스페이스(예: `auth.common.errorPrefix`)가 도메인 단위로 깔끔하게 나뉜다.
- 화면(JSP)뿐 아니라 **API 응답 메시지까지 같은 번들에서 4개 언어로 일관 적용**하기로 했다(ADR-0013). 그래서 자바 레이어에서도 메시지를 꺼낼 헬퍼가 필요했다.
- 키를 아직 번역하지 못한 상태에서도 화면이 깨지지 않고, 어떤 키가 비었는지 바로 눈에 띄도록 **누락 키는 코드 자체를 노출**하는 정책을 택했다.

:::tip 번들 분리의 트레이드오프
basename을 잘게 쪼개면 협업·유지보수는 쉬워지지만, 새 도메인을 추가할 때 `setBasenames`에 등록을 잊으면 그 번들이 통째로 무시된다. 등록은 코드 한 줄이라 리뷰에서 놓치기 쉽다. 실제로 디스크에는 `common_*.properties`가 있지만 basename 목록에는 빠져 있어, 등록과 파일을 함께 검토해야 하는 구조적 약점이 있다.
:::

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 구성요소 | 실제 클래스/파일 | 역할 |
| --- | --- | --- |
| 메시지 빈 | `WebConfig.messageSource()` → `ReloadableResourceBundleMessageSource` | 번들 로딩·인코딩·폴백 정책 |
| 번들 파일 | `src/main/resources/messages/{도메인}_{언어}.properties` | 키=값 텍스트 저장소 |
| 자바 조회 헬퍼 | `common/util/MessageUtil` | Service·Controller에서 키로 메시지 조회 |
| JSP 출력 | `spring:message` 태그 (`spring` taglib) | 뷰에서 키를 현재 Locale 문구로 렌더 |
| Locale 결정 | `SessionLocaleResolver`, `LocaleChangeInterceptor` (별도 페이지) | 현재 요청 언어 판단 |

번들은 도메인별로 4개 언어 파일이 한 세트다. 예를 들어 `auth`는 `auth_ko.properties`·`auth_en.properties`·`auth_ja.properties`·`auth_zh.properties`로 구성되고, 키는 도메인 점표기법으로 통일한다.

```properties
# auth_ko.properties
auth.common.errorPrefix=오류
auth.common.password.show=보기
```

`WebConfig`에 등록된 basename은 도메인 모듈 단위로 약 20여 개다.

```java
messageSource.setBasenames(
    "classpath:messages/admin",
    "classpath:messages/auth",
    "classpath:messages/community",
    "classpath:messages/course",
    "classpath:messages/courses",   // course / courses 두 번들이 별도로 공존
    "classpath:messages/explore",
    "classpath:messages/inquiry",
    "classpath:messages/report"
    // ... header / footer / home / mypage / package / shop / wallet / security 등
);
messageSource.setDefaultEncoding("UTF-8");
messageSource.setUseCodeAsDefaultMessage(true);
```

## 4. 동작 원리(흐름·표·작은 코드)

키 하나가 화면 문구가 되기까지의 경로는 두 갈래다. 어느 쪽이든 **현재 Locale + 키 → 번들 조회**라는 핵심은 같다.

```text
[JSP 경로]
요청(?lang=en) → LocaleChangeInterceptor → 세션 Locale=en
  → spring:message code=auth.common.errorPrefix
    → MessageSource.getMessage(code, args, Locale)
      → auth_en.properties 에서 값 반환

[자바/API 경로]
Service → MessageUtil.get(code)
  → LocaleContextHolder.getLocale() 로 현재 Locale 획득
    → MessageSource.getMessage(...) → 동일 번들에서 값 반환
```

JSP는 Spring taglib의 `spring:message`를 쓴다. 출력 직접 렌더와, 변수에 담아 자바스크립트로 넘기는 두 패턴이 함께 쓰인다.

```jsp
<%@ taglib prefix="spring" uri="http://www.springframework.org/tags" %>

<!-- 화면에 바로 출력 -->
<spring:message code="inquiry.write.title"/>

<!-- 변수에 담아 JS로 안전하게 전달 (javaScriptEscape 로 따옴표 등 이스케이프) -->
<spring:message var="msgFail" code="inquiry.write.fail" javaScriptEscape="true"/>
```

자바 레이어에서는 `MessageUtil`이 `LocaleContextHolder`로 현재 요청 Locale을 읽어 조회한다. `{0}`, `{1}` 플레이스홀더가 있는 메시지는 가변 인자 오버로드를 쓴다.

```java
// 단순 조회
String prefix = messageUtil.get("community.api.error.loginRequired");
// placeholder 치환
String msg = messageUtil.get("wallet.charge.limit.exceeded", limit);
```

핵심 폴백 동작인 `setUseCodeAsDefaultMessage(true)`의 의미를 표로 정리하면 다음과 같다.

| 상황 | 기본 MessageSource | 본 설정(useCodeAsDefaultMessage=true) |
| --- | --- | --- |
| 키 있음 | 번역 값 반환 | 번역 값 반환 |
| 키 없음 | `NoSuchMessageException` 발생 | **키 코드 문자열 그대로 반환** |

즉 번역을 빠뜨려도 화면은 죽지 않고 `auth.common.errorPrefix` 같은 점표기 키가 그대로 노출되므로, QA가 화면만 봐도 누락 키를 식별할 수 있다.

## 5. 구현 상태(됨 vs Mock/계획)

:::details 구현된 것
- 도메인별 basename 분리 + 4개 언어(`ko/en/ja/zh`) 번들 로딩 — 구현됨
- `MessageUtil` 기반 자바/API 레이어 메시지 i18n (ADR-0013) — 구현됨
- `spring:message` JSP 출력 + `javaScriptEscape` 패턴 — 구현됨(다수 뷰 적용)
- 누락 키 코드 노출 폴백(`useCodeAsDefaultMessage`) — 구현됨
:::

:::warning 정리되지 않은 부분(정직 구분)
- `course`와 `courses` 두 번들이 동시에 등록돼 있어 네이밍이 중복·혼동 소지가 있다.
- `common_*.properties` 파일은 디스크에 존재하나 `setBasenames`에 **등록되지 않아** 사실상 로딩되지 않는다(등록 누락 가능성).
- 본 페이지가 다루는 화면/메시지 i18n과 별개로, 동적 콘텐츠(스팟 텍스트 등)는 Google Cloud Translation으로 번역하며 DB 캐싱한다 — 이는 별도 페이지 주제다.
- 키 누락을 빌드 시점에 막는 자동 검증(언어 간 키 정합성 체크)은 부재. 코드 노출 폴백에 의존한 수동 확인 방식이다.
:::

:::tip 포인트 정정
설계 토론에서 종종 "i18n:getMessage 커스텀 태그"로 언급되지만, 실제 구현은 스프링 표준 `spring:message` 태그를 사용한다. 면접에서는 **표준 컴포넌트(`MessageSource` + `spring:message`)를 일관되게 채택했다**고 말하는 편이 정확하다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "화면과 API 문구를 코드에서 분리해, 도메인별 `.properties` 번들로 4개 언어를 관리하고 현재 Locale에 맞춰 꺼내 씁니다. 스프링 `MessageSource`가 그 중심입니다."
2. **설계 의도**: "단일 번들 대신 `auth`·`community`·`explore`처럼 도메인 basename으로 쪼개 4인 협업의 머지 충돌을 줄였고, JSP의 `spring:message`뿐 아니라 자바 레이어에서도 `MessageUtil`로 같은 번들을 조회해 API 메시지까지 일관되게 다국어화했습니다(ADR-0013)."
3. **운영 디테일**: "`useCodeAsDefaultMessage`를 켜서 번역을 빠뜨려도 화면이 죽지 않고 키 코드가 그대로 보이게 했습니다. 누락을 화면에서 바로 식별할 수 있어 QA 비용을 낮췄습니다."

## 7. 꼬리질문+모범답안

:::details 왜 번들을 도메인별로 쪼갰나? 하나로 합치면 안 되나
하나로 합치면 키 충돌·머지 충돌이 잦고, 어떤 키가 어느 화면 것인지 추적이 어렵다. 도메인 basename 분리는 네임스페이스를 코드 구조와 일치시켜 4인 공동 개발에서 각자 담당 번들만 만지게 한다. 단점은 새 번들 등록을 `setBasenames`에서 빠뜨릴 수 있다는 점이라, 등록과 파일을 함께 리뷰한다.
:::

:::details useCodeAsDefaultMessage를 켜면 위험하지 않나
프로덕션에서 사용자에게 점표기 키가 노출될 수 있다는 게 단점이다. 다만 예외로 페이지가 통째로 깨지는 것보다 낫다고 판단했고, 키 코드가 곧 누락 신호라 개발·QA 단계에서 결손을 빠르게 잡을 수 있다. 더 엄격히 하려면 빌드 시 언어 간 키 정합성 검증을 추가하는 게 다음 과제다.
:::

:::details 자바 코드에서는 현재 언어를 어떻게 아나
`MessageUtil`이 `LocaleContextHolder.getLocale()`로 요청별 Locale을 읽는다. 이 값은 `SessionLocaleResolver`가 세션에 저장한 언어이고, 요청에 `lang` 파라미터가 오면 `LocaleChangeInterceptor`가 세션 Locale을 갱신한다. 즉 JSP와 자바가 같은 Locale 소스를 공유한다.
:::

:::details placeholder가 들어간 메시지는 어떻게 처리하나
번들 값에 `{0}`, `{1}` 형태로 자리표시자를 두고, `MessageUtil.get(code, args...)` 가변 인자 오버로드로 치환값을 넘긴다. 내부적으로 `MessageSource.getMessage(code, args, locale)`가 `MessageFormat`으로 채운다.
:::

:::details JSP에서 spring:message 값을 자바스크립트로 넘길 때 주의점은
문구에 따옴표나 줄바꿈이 들어가면 JS 문자열이 깨지거나 인젝션 위험이 생긴다. 그래서 `javaScriptEscape="true"` 속성으로 이스케이프한 뒤 변수(`var`)에 담아 스크립트로 전달한다. 화면 직접 출력과 JS 전달을 구분해 쓰는 이유다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 60초로 답해 보자.

- TripTogether가 문구를 코드에서 분리한 이유와, 그 분리를 도메인 단위로 한 이유를 각각 말해 보라.
- `useCodeAsDefaultMessage`가 켜진 상태에서 번역이 빠진 키가 있으면 화면과 운영에 각각 어떤 일이 벌어지는지 설명하라.
- JSP의 `spring:message`와 자바의 `MessageUtil`이 같은 메시지 소스를 공유한다는 것을 흐름으로 설명하라.

## 퀴즈

<QuizBox question="TripTogether의 MessageSource에서 setUseCodeAsDefaultMessage(true)가 하는 일은 무엇인가?" :choices="['번역 키가 없으면 예외를 던진다','번역 키가 없으면 키 코드 문자열을 그대로 반환한다','기본 언어를 영어로 바꾼다','번역 파일을 자동 생성한다']" :answer="1" explanation="키 누락 시 예외 대신 키 코드 자체를 노출해, 화면이 깨지지 않으면서 누락된 키를 바로 식별하게 한다." />

<QuizBox question="번들을 admin, auth, community처럼 도메인별 basename으로 분리한 주된 이점은?" :choices="['로딩 속도가 무조건 빨라진다','4인 공동 개발에서 도메인별로 나눠 머지 충돌과 키 충돌을 줄인다','언어 수를 자동으로 늘려준다','DB 접속이 필요 없어진다']" :answer="1" explanation="네임스페이스를 코드 구조와 일치시켜 담당 도메인 번들만 만지게 하므로 협업 충돌이 줄어든다. 다만 새 번들 등록을 빠뜨릴 위험은 남는다." />

<QuizBox question="자바 서비스 레이어에서 현재 요청 언어에 맞는 메시지를 꺼낼 때 사용하는 것은?" :choices="['spring:message JSP 태그','MessageUtil이 LocaleContextHolder로 현재 Locale을 읽어 MessageSource를 조회','DB의 번역 테이블을 직접 SELECT','브라우저 쿠키를 직접 파싱']" :answer="1" explanation="JSP는 spring:message, 자바 레이어는 MessageUtil이 LocaleContextHolder.getLocale 기준으로 같은 MessageSource를 조회한다. ADR-0013에 따라 API 메시지까지 일관 적용한다." />
