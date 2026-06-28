---
title: "다국어·공통 인프라 개요"
owner: C
domain: "다국어·공통"
tags: ["i18n", "공통"]
---

# 다국어·공통 인프라 개요

> 모든 도메인이 똑같이 의존하는 횡단 관심사를 한곳에 모은 챕터다. 화면 문구를 4개국어로 바꾸는 i18n과, 로그인·권한·예외를 도메인마다 다시 짜지 않게 해주는 공통 인프라(인터셉터·AOP·리졸버)를 다룬다.

## 한눈에

TripTogether는 4명이 도메인을 수직 분담해 만든 국내 여행 올인원 플랫폼이다. 이 챕터는 특정 기능 도메인이 아니라 **여러 도메인이 공유하는 토대**를 묶는다. 크게 두 축이다.

- **다국어(i18n)**: 정적 화면 문구는 `MessageSource` + properties 번들로, 사용자가 입력한 동적 텍스트(여행지 설명·후기·게시글 등)는 Google Cloud Translation API로 번역한다. 지원 언어는 한국어·영어·일본어·중국어 4종.
- **공통 인프라**: 세션 인증 위에서 동작하는 인터셉터 체인, AOP 권한 검사(`@RequireLogin`/`@RequireAdmin`), `@LoginUser` 파라미터 자동 주입, 전역 예외 처리(`GlobalExceptionHandler`)를 제공한다.

| 항목 | 내용 |
| --- | --- |
| 패키지 | `org.triptogether.common`, `org.triptogether.config` |
| 핵심 빈 | `MessageSource`, `LocaleResolver`, `LocaleChangeInterceptor`, `MessageUtil` |
| 핵심 클래스 | `WebConfig`, `AuthorizationAspect`, `LoginUserArgumentResolver`, `GlobalExceptionHandler` |
| 동적 번역 | `AdminTranslationServiceImpl`(관리자 검수 번역), `SpotTextTranslationService`(런타임 번역) |
| 핵심 테이블 | `ADMIN_TRANSLATION`, `SPOT_TEXT_TRANSLATION`, `APPLICATION_RUNTIME_SETTING` |
| 담당 라벨 | C (익명 라벨 — [담당별 보기](/by-area/) 참고) |

## 담당과 경계

이 챕터는 모든 도메인이 함께 쓰는 공통 토대라, "누가 만들었나"보다 "어디까지가 공통이고 어디부터가 각 도메인 책임인가"라는 경계가 더 중요하다.

- **공통 인프라가 끝나는 지점**: 인터셉터·AOP가 인증·권한을 통과시키고 세션에서 `loginUser`(=`UsersVO`)를 꺼내 컨트롤러에 주입하면, 그 뒤 비즈니스 로직은 각 도메인 챕터가 책임진다. 인프라는 "출입 통제와 공통 부품"까지만 담당한다.
- **정적 문구 vs 동적 텍스트**: properties 번들에 적힌 라벨·버튼·안내문은 i18n이 직접 책임진다. 반대로 사용자가 작성한 글·후기·여행지 본문은 각 도메인의 데이터이고, 번역은 공통 번역 서비스가 **호출되어** 처리한다. 같은 다국어라도 책임 주체가 다르다.

:::tip 공통 영역 변경은 합의가 먼저
인터셉터 체인, 공통 예외 구조, 권한 어노테이션 같은 부품은 모든 도메인이 의존한다. 한 줄만 바꿔도 전 화면에 영향이 가므로, 학습용으로 읽는 것과 별개로 실제 수정은 팀 합의 대상이다.
:::

## 핵심 기술

| 기술 | 어디에 쓰나 | 구현 위치 |
| --- | --- | --- |
| **MessageSource** | 화면 정적 문구를 키로 조회해 현재 언어로 출력 | `ReloadableResourceBundleMessageSource` 빈 (`WebConfig`) |
| **properties 번들** | 도메인별 메시지 파일을 `_ko/_en/_ja/_zh` 4종으로 분리 | `resources/messages/*.properties` (admin·auth·community 등 22개 basename x 4언어) |
| **SessionLocaleResolver** | 사용자가 고른 언어를 세션에 저장(기본 한국어) | `localeResolver()` 빈 (`WebConfig`) |
| **LocaleChangeInterceptor** | `?lang=en` 같은 쿼리 파라미터로 언어 즉시 전환 | `localeChangeInterceptor()` 빈, 인터셉터 체인 1번 |
| **MessageUtil** | JSP 밖(서비스·컨트롤러)에서도 같은 키로 메시지 조회 | `common/util/MessageUtil` (ADR-0013) |
| **Google Cloud Translation v2** | 사용자 동적 텍스트 번역 + 캐싱 | `AdminTranslationServiceImpl`, `SpotTextTranslationService` |
| **인터셉터 체인** | locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification 순서 통제 | `WebConfig.addInterceptors` |
| **AOP 권한 검사** | `@RequireLogin`/`@RequireAdmin` 메서드 진입 직전 세션 권한 확인 | `AuthorizationAspect` (ADR-0011) |
| **@LoginUser 자동 주입** | 컨트롤러 파라미터에 세션 `loginUser`를 바로 꽂아줌 | `LoginUserArgumentResolver` (ADR-0011) |
| **전역 예외 처리** | 권한·검증 예외를 표준 응답으로 변환 | `GlobalExceptionHandler`, `BusinessException` 계열 |

### 정적 i18n이 도는 방식 (요약)

```text
사용자가 헤더에서 영어 선택
  → 링크에 ?lang=en
  → LocaleChangeInterceptor 가 파라미터를 읽어
  → SessionLocaleResolver 가 세션 locale = en 저장
  → 이후 요청은 LocaleContextHolder 의 locale 기준
  → JSP/서비스가 MessageSource 로 키 조회 → 영어 문구 출력
```

번역 키가 아직 특정 언어 파일에 없으면 `useCodeAsDefaultMessage=true` 설정 덕에 에러 대신 **키 자체**가 화면에 노출된다. 누락을 눈으로 잡기 쉽게 한 의도된 선택이다.

## 구현 상태 (됨 vs 계획)

| 기능 | 상태 | 메모 |
| --- | --- | --- |
| 정적 문구 4개국어 (`MessageSource`) | 구현됨 | 22개 도메인 번들 x 4언어, 세션 전환 동작 |
| `MessageUtil` 로 API 응답까지 i18n | 구현됨 | ADR-0013, JSP 밖 영역도 같은 키 사용 |
| AOP 권한 + `@LoginUser` 주입 | 구현됨 | ADR-0011, 인증 통과 후 컨트롤러는 non-null 가정 가능 |
| 동적 텍스트 Google 번역 + 캐싱 | 구현됨 | 해시 기반 중복 방지, DB 캐시 후 재사용 |
| 관리자 검수형 번역 (`ADMIN_TRANSLATION`) | 구현됨 | 리비전·복원 지원, 사람이 기계번역을 교정 |
| AI 응답 품질 정량 평가 | 계획 | 다국어 응답 품질을 수치로 측정하는 체계는 향후 과제 |
| 모바일 반응형 다국어 레이아웃 | 부분 | JSP 데스크톱 위주, 반응형은 향후 |

## 이 챕터 학습 순서

처음 보는 사람이라면 아래 순서를 권장한다. 정적 → 전환 → 동적 → 관리 순으로 추상화가 한 겹씩 올라간다.

1. [MessageSource·properties](/i18n/messagesource) — 정적 문구를 키로 관리하는 기본기. 가장 먼저 읽는다.
2. [LocaleResolver·언어전환](/i18n/locale-resolver) — 세션에 언어를 저장하고 `?lang=`으로 바꾸는 흐름.
3. [Google 번역 API](/i18n/google-translation) — 사용자 입력 같은 동적 텍스트를 기계 번역 + 캐싱하는 방식.
4. [DB 번역 관리](/i18n/db-translation) — 기계 번역을 사람이 교정·검수하는 관리자 워크플로우.
5. [면접 플레이북](/i18n/interview-playbook) — 위 내용을 면접 답변으로 묶는 마무리.

공통 인프라(인터셉터 체인·AOP·`@LoginUser`)의 더 깊은 설명은 [백엔드](/backend/) 챕터의 인터셉터·AOP·리졸버 페이지에서 이어진다. 전체 그림은 [도메인 전체 개요](/domains)와 [전체 흐름](/flow/)에서 확인한다.

## 단골 면접 질문 5개

:::details 1. 정적 문구 번역과 사용자 입력 번역을 왜 다른 방식으로 처리했나요?
정적 문구는 개발 시점에 키가 정해지고 양이 한정적이라 properties 번들로 미리 번역해 두는 게 빠르고 비용이 없습니다. 반면 후기·게시글 같은 동적 텍스트는 무엇이 들어올지 미리 알 수 없으니 런타임에 Google Cloud Translation을 호출하고, 같은 문장을 반복 번역하지 않도록 해시 기반으로 DB에 캐싱합니다. 성질이 다른 데이터라 전략을 분리했습니다.
:::

:::details 2. 언어 선택은 어떻게 유지되나요?
`?lang=en` 같은 파라미터를 `LocaleChangeInterceptor`가 가로채 `SessionLocaleResolver`에 저장합니다. 세션 기반이라 같은 브라우저 세션 동안 선택한 언어가 유지되고, 기본값은 한국어입니다. 이후 모든 요청은 `LocaleContextHolder`의 locale을 기준으로 `MessageSource`에서 문구를 꺼냅니다.
:::

:::details 3. 인터셉터와 AOP 권한 검사의 역할은 어떻게 나뉘나요?
인터셉터 체인은 요청이 컨트롤러에 닿기 전 단계에서 locale 설정, IP 차단, 활동 로그, 로그인 강제 같은 경로 단위 통제를 합니다. AOP(`AuthorizationAspect`)는 메서드 단위로 더 세밀하게, `@RequireLogin`/`@RequireAdmin`이 붙은 핸들러 진입 직전 세션 권한을 검사합니다. 굵은 통제는 인터셉터, 세분화된 권한은 AOP가 맡는 분담입니다.
:::

:::details 4. 컨트롤러에서 로그인 사용자 정보는 어떻게 받나요?
`@LoginUser UsersVO user` 파라미터를 선언하면 `LoginUserArgumentResolver`가 세션의 `loginUser`를 자동 주입합니다. 비로그인이면 null이 들어오지만, 같은 메서드에 `@RequireLogin`이 붙어 있으면 AOP가 먼저 차단하므로 본문에서는 non-null로 가정해도 안전합니다. 세션 꺼내는 보일러플레이트를 도메인마다 반복하지 않으려는 설계입니다.
:::

:::details 5. 번역 키가 빠졌을 때 화면은 어떻게 되나요?
`MessageSource`에 `useCodeAsDefaultMessage=true`를 켜 두어, 특정 언어 파일에 키가 없으면 예외를 던지지 않고 키 코드 자체를 그대로 보여줍니다. 사용자에게 어색하긴 해도 화면이 깨지지 않고, 개발자는 누락된 키를 즉시 눈으로 식별할 수 있습니다. 운영 중 점진적으로 번역을 채워 넣는 데 유리한 트레이드오프입니다.
:::

## 퀴즈

<QuizBox question="TripTogether에서 화면의 정적 문구를 4개국어로 번역하는 데 사용하는 스프링 메커니즘은 무엇인가?" :choices="['MessageSource와 properties 번들', 'Google Cloud Translation API', 'JPA 다국어 엔티티', 'CDN 캐시 변환']" :answer="0" explanation="정적 문구는 도메인별 properties 번들을 MessageSource가 현재 locale로 조회해 출력한다. Google 번역은 사용자 입력 같은 동적 텍스트용이다." />

<QuizBox question="사용자가 헤더에서 영어를 선택하면 그 선택을 저장하는 컴포넌트는 무엇인가?" :choices="['LocaleChangeInterceptor', 'SessionLocaleResolver', 'MessageUtil', 'GlobalExceptionHandler']" :answer="1" explanation="LocaleChangeInterceptor는 lang 파라미터를 읽어 전달만 하고, 실제 선택 언어를 세션에 저장해 유지하는 것은 SessionLocaleResolver다. 기본값은 한국어다." />

<QuizBox question="컨트롤러 파라미터에 @LoginUser를 붙였을 때 세션의 loginUser를 자동 주입하는 클래스는 무엇인가?" :choices="['AuthorizationAspect', 'NotificationInterceptor', 'LoginUserArgumentResolver', 'BCryptPasswordEncoder']" :answer="2" explanation="LoginUserArgumentResolver가 세션 loginUser를 파라미터에 주입한다. AuthorizationAspect는 권한 검사를, 주입 자체는 리졸버가 담당한다(ADR-0011)." />
