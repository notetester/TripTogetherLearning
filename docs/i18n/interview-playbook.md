---
title: "다국어·공통 면접 플레이북"
owner: C
domain: "다국어·공통"
tags: ["면접"]
---

# 다국어·공통 면접 플레이북

> 정적 문구는 properties 번들, 동적 문구는 외부 번역 API + DB 캐시 — 두 경로를 명확히 나눈 4개국어(ko/en/ja/zh) 국제화 설계를 1분과 3분 버전으로 말한다.

이 페이지는 다국어(i18n)와 공통 인프라 도메인을 면접에서 설명하기 위한 플레이북이다. 개념 자체는 [MessageSource·properties](/i18n/messagesource), [LocaleResolver·언어전환](/i18n/locale-resolver), [Google 번역 API](/i18n/google-translation), [DB 번역 관리](/i18n/db-translation)에서 다루므로, 여기서는 "어떻게 말할지"와 "왜 그렇게 설계했는지"에 집중한다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 1분 / 3분 버전

:::tip 1분 버전 (엘리베이터 피치)
TripTogether는 국내 여행 올인원 플랫폼이고, 4개국어(한국어/영어/일본어/중국어)를 지원합니다. 핵심 설계는 텍스트를 두 종류로 나눈 겁니다. 버튼 라벨이나 안내 문구처럼 정해진 정적 텍스트는 도메인별 properties 메시지 번들로 처리하고, 사용자가 쓴 후기나 코스 제목처럼 런타임에 생기는 동적 텍스트는 Google Cloud Translation API로 번역한 뒤 DB에 캐시합니다. 언어는 세션 기반 LocaleResolver로 유지하고, 헤더에서 lang 파라미터를 바꾸면 LocaleChangeInterceptor가 세션 로케일을 갱신합니다. JSP 화면뿐 아니라 JSON API 응답 메시지까지 같은 번들로 일관되게 다국어 처리한 점이 특징입니다.
:::

:::details 3분 버전 (설계 의도까지)
국제화를 정적/동적 두 트랙으로 분리한 게 핵심 결정입니다.

첫째, 정적 트랙은 스프링 표준 MessageSource입니다. ReloadableResourceBundleMessageSource 빈에 admin, auth, community, courses, explore, inquiry 등 도메인별 basename을 약 20개 등록했고, 각 basename은 ko/en/ja/zh suffix 파일을 자동으로 읽습니다. 도메인별로 파일을 쪼갠 이유는 4인 공동개발이라 각자 담당 영역의 번역 파일만 건드리게 해서 머지 충돌을 줄이려는 의도입니다. useCodeAsDefaultMessage를 켜서, 번역 키가 누락돼도 예외 대신 키 코드 자체를 화면에 보여주게 했습니다. 운영 중 빈 화면이 뜨는 사고를 막고 누락 키를 바로 눈으로 찾기 위해서입니다.

둘째, 동적 트랙은 SpotTextTranslationService입니다. 사용자가 입력한 여행지명, 후기, 코스 제목, 패키지 설명 같은 건 번들에 미리 넣을 수 없습니다. 이건 원문을 SHA-256 해시로 만들어 SPOT_TEXT_TRANSLATION_CACHE 테이블에서 먼저 조회하고, 캐시 미스일 때만 Google Translation을 호출한 뒤 결과를 upsert로 저장합니다. 같은 문장은 한 번만 번역해 비용과 지연을 줄이는 read-through 캐시입니다.

셋째, 로케일 전달은 SessionLocaleResolver입니다. 기본 로케일은 한국어이고, 헤더의 언어 토글이 lang 파라미터를 붙이면 LocaleChangeInterceptor가 세션에 저장합니다. 서비스/컨트롤러 어디서든 LocaleContextHolder로 현재 로케일을 읽고, MessageUtil 헬퍼로 API 응답 메시지까지 같은 번들에서 꺼내 4개 언어를 일관되게 맞췄습니다. 이건 ADR-0013으로 결정을 문서화했습니다.

정직하게는, AI가 생성한 자유 문장이나 추천 사유는 기계 번역 품질이 흔들릴 수 있어 자주 쓰는 고정값은 번들로 먼저 처리하고 나머지만 API에 맡기는 식으로 보완했습니다.
:::

## 2. 왜 이렇게 설계했나 (기술 선택 근거)

이 도메인 면접의 핵심은 "왜 이 선택을 했나"에 답하는 것이다. 세 가지 결정을 정리한다.

| 결정 | 대안 | 선택 이유 |
| --- | --- | --- |
| properties 번들 + DB 캐시 병행 | 모든 텍스트를 한 방식으로 | 정적 문구는 양이 정해져 있어 파일이 빠르고 무료, 동적 문구는 런타임 생성이라 파일로 못 담음 |
| useCodeAsDefaultMessage 켜기 | 끄기(누락 시 예외) | 운영 중 빈 화면 사고 방지, 누락 키를 키 코드 그대로 노출해 즉시 발견 |
| 세션 기반 LocaleResolver | Accept-Language 헤더 / 쿠키 | 사용자가 명시적으로 고른 언어를 같은 세션 동안 일관되게 유지 |

### 왜 properties와 DB 번역을 병행하나
텍스트의 출처가 다르기 때문이다. 메뉴명, 버튼, 검증 에러 같은 정적 문구는 개발 시점에 양이 확정되므로 번들 파일에 미리 넣으면 호출 비용이 0이고 빌드에 포함된다. 반면 후기 본문, 코스 제목, 패키지 설명, 지갑 변동 이력 문구는 사용자가 런타임에 만들어내므로 파일로 담을 방법이 없다. 그래서 동적 문구만 외부 API로 번역하고, 같은 문장을 반복 번역하지 않도록 DB에 캐시한다. 정적은 파일, 동적은 캐시 — 비용과 신선도를 출처에 맞게 다르게 다룬 것이다.

### 왜 useCodeAsDefaultMessage인가
4개국어 곱하기 약 20개 도메인 번들이면 키 누락이 통계적으로 반드시 생긴다. 이 옵션을 끄면 누락 키 조회 시 NoSuchMessageException이 터져 페이지 전체가 깨질 수 있다. 켜두면 예외 대신 키 코드(예: community.api.error.loginRequired)가 화면에 그대로 노출돼, 사고는 막고 어떤 키가 비었는지 한눈에 보인다. 안전망과 디버깅 편의를 동시에 챙긴 선택이다.

### 왜 세션 로케일인가
Accept-Language 헤더만 쓰면 브라우저 설정에 끌려가 사용자가 직접 고른 언어를 무시하게 된다. 세션 로케일은 사용자가 헤더에서 한 번 영어를 고르면 그 세션 내내 영어를 우선한다. lang 파라미터로 전환하는 순간만 인터셉터가 개입하고, 이후 요청은 세션 값을 따른다. 명시적 선택을 존중하는 UX를 위한 결정이다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 실제 클래스 / 테이블 | 역할 |
| --- | --- | --- |
| 정적 메시지 소스 | `WebConfig.messageSource()` (ReloadableResourceBundleMessageSource) | 도메인별 약 20개 basename, ko/en/ja/zh 자동 로드 |
| 메시지 조회 헬퍼 | `MessageUtil` | LocaleContextHolder 기준 번들 조회, placeholder 치환 |
| 로케일 저장 | `SessionLocaleResolver` (기본 KOREAN) | 사용자가 고른 언어를 세션에 유지 |
| 언어 전환 | `LocaleChangeInterceptor` (paramName lang) | ?lang=en 요청 시 세션 로케일 변경 |
| 동적 텍스트 번역 | `SpotTextTranslationService` | Google Cloud Translation v2 호출 + 캐시 |
| 번역 캐시 | `SPOT_TEXT_TRANSLATION_CACHE` 테이블 | source_text_hash 키로 read-through 캐시 |
| 관리자 번역 관리 | `AdminTranslationService` / `ADMIN_TRANSLATION` 외 | 번역본 버전 관리, 리비전, 소스 스냅샷 |

번들 등록은 `WebConfig`에서 한다.

```java
messageSource.setBasenames(
    "classpath:messages/admin", "classpath:messages/auth",
    "classpath:messages/community", "classpath:messages/courses",
    "classpath:messages/explore", "classpath:messages/inquiry"
    // ... 약 20개 도메인 번들
);
messageSource.setDefaultEncoding("UTF-8");
messageSource.setUseCodeAsDefaultMessage(true); // 누락 키는 코드 그대로 노출
```

## 4. 동작 원리 (흐름·표·작은 코드)

언어 전환부터 화면 렌더까지의 흐름이다.

```text
헤더 언어 토글 (?lang=en)
   │
   ▼
LocaleChangeInterceptor ──▶ SessionLocaleResolver 세션에 en 저장
   │
   ▼
컨트롤러/서비스에서 LocaleContextHolder.getLocale() = en
   │
   ├─ 정적 문구  ─▶ MessageUtil.get(키) ─▶ properties 번들 (community_en 등)
   │
   └─ 동적 문구  ─▶ SpotTextTranslationService.translateText(...)
                       │
                       ▼
                  SHA-256(원문) 해시로 SPOT_TEXT_TRANSLATION_CACHE 조회
                       │
              hit ◀────┴────▶ miss → Google Translation 호출 → upsert 저장
```

동적 번역의 read-through 캐시 로직을 추상화하면 다음과 같다.

```java
String hash = sha256(원문.trim());
var cached = mapper.selectCache(sourceType, pk, field, hash, targetLang);
if (cached != null) return cached.getTranslatedText();   // 캐시 히트
String translated = requestTranslation(원문, targetLang); // Google 호출
mapper.upsertCache(...);                                  // 결과 저장
return translated;
```

핵심 가드 동작 정리:

| 상황 | 동작 |
| --- | --- |
| 현재 로케일이 ko | 동적 번역 건너뛰고 원문 그대로 반환 |
| 번역 API 키 미설정 | 경고 로그 후 원문 반환 (화면은 깨지지 않음) |
| 외부 API 호출 실패 | 예외를 잡고 원문 반환 (graceful degradation) |
| 번역 키 누락 (정적) | 키 코드 자체를 노출 (useCodeAsDefaultMessage) |

이 표가 보여주듯, 모든 실패 경로는 "원문이라도 보여준다"로 수렴한다. 다국어가 부가 기능이지 장애 지점이 되지 않게 한 설계다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현된 것
- 4개국어(ko/en/ja/zh) properties 번들, 도메인별 약 20개 basename — 구현됨
- useCodeAsDefaultMessage 누락 키 안전망 — 구현됨
- SessionLocaleResolver + LocaleChangeInterceptor 세션 언어 전환 — 구현됨
- MessageUtil로 JSON API 응답 메시지까지 i18n 일관 적용 (ADR-0013) — 구현됨
- 동적 텍스트 Google Cloud Translation + SHA-256 해시 기반 DB 캐시 — 구현됨
- 관리자 번역 관리(ADMIN_TRANSLATION 버전/리비전/스냅샷) — 구현됨
:::

:::warning 한계 / 계획
- 번역 API 키가 비어 있으면 동적 번역은 동작하지 않고 원문으로 폴백한다 (운영 환경 키 주입 전제)
- 기계 번역이라 후기/AI 자유 문장의 번역 품질은 사람 검수 수준은 아니다 — 자주 쓰는 고정값만 번들로 우선 처리해 부분 보완
- AI 응답·번역 품질의 정량 평가 체계는 부재(향후 과제)
- 화면 레이아웃은 JSP 데스크톱 위주이며 모바일 반응형/SPA는 향후 과제
:::

## 6. 면접 답변 3단계

면접에서 i18n 질문이 나오면 다음 3단계로 답하면 막힘이 없다.

1. **무엇을 했나** — 4개국어를 정적/동적 두 트랙으로 나눠 지원했다. 정적은 properties 번들, 동적은 외부 번역 API + DB 캐시.
2. **왜 그렇게 했나** — 텍스트 출처가 다르기 때문이다. 정해진 문구는 파일이 빠르고 공짜, 사용자 생성 문구는 파일에 못 담아 캐시 전략이 필요하다.
3. **어떤 트레이드오프가 있었나** — 외부 API 의존과 비용이 생기지만, 해시 기반 캐시로 반복 호출을 없애고 키 미설정/호출 실패 시 원문 폴백으로 장애 전파를 막았다.

## 7. 꼬리질문 + 모범답안

:::details Q1. properties 번들을 도메인별로 약 20개로 쪼갠 이유는?
4인 공동개발이라 각자 담당 도메인의 번역 파일만 수정하게 해서 머지 충돌을 줄이려는 의도입니다. 하나의 거대한 messages.properties로 두면 여러 명이 같은 파일을 동시에 건드려 충돌이 잦아집니다. basename을 admin, community, courses처럼 도메인 단위로 나누면 책임 경계가 파일 경계와 일치합니다.
:::

:::details Q2. useCodeAsDefaultMessage를 끄면 어떤 일이 생기나?
번역 키가 번들에 없을 때 조회하면 NoSuchMessageException이 발생합니다. JSP 렌더 도중 이게 터지면 페이지 전체가 에러로 깨집니다. 4개국어 곱하기 20개 번들 규모에서는 키 누락이 거의 필연이라, 옵션을 켜서 예외 대신 키 코드를 그대로 노출하게 했습니다. 사고는 막고 누락 키도 화면에서 바로 식별됩니다.
:::

:::details Q3. 동적 텍스트 번역에 SHA-256 해시를 쓴 이유는?
같은 원문을 반복 번역하지 않으려면 캐시 키가 필요한데, 원문 전체를 인덱스 키로 쓰면 길이가 길고 인덱싱이 비효율적입니다. 그래서 원문을 trim해 SHA-256으로 고정 길이 해시를 만들고, source_type, source_pk, field_name, target_lang과 함께 캐시를 조회합니다. 같은 문장이면 항상 같은 해시라 read-through 캐시가 정확히 동작합니다.
:::

:::details Q4. 번역 API가 죽으면 화면도 죽나?
아니요. translateText는 호출 실패 시 예외를 잡고 원문을 그대로 반환합니다. API 키가 비어 있어도 경고 로그만 남기고 원문으로 폴백합니다. 현재 로케일이 한국어면 아예 번역을 건너뜁니다. 모든 실패 경로가 원문 노출로 수렴하므로, 다국어 기능이 본문 표시를 가로막지 않습니다.
:::

:::details Q5. JSP 화면 말고 JSON API 응답도 다국어가 되나?
됩니다. MessageUtil이 LocaleContextHolder 기준으로 같은 메시지 번들에서 문구를 꺼내므로, 컨트롤러가 반환하는 JSON 에러 메시지나 안내 문구도 현재 로케일에 맞게 나옵니다. JSP만 다국어이고 API는 한국어로 남는 불일치를 막으려고 이 결정을 ADR-0013으로 문서화했습니다.
:::

:::details Q6. AI가 만든 자유 문장이나 추천 사유는 어떻게 번역하나?
기계 번역은 짧은 태그나 자유 문장에서 품질이 흔들릴 수 있어, 자주 등장하는 고정값은 메시지 번들로 먼저 매핑하고 나머지만 번역 API에 맡깁니다. 예를 들어 추천 사유의 고정 코드값은 recommend.reason 키로 번들에서 꺼내고, AI가 만든 문장만 일반 번역 캐시를 탑니다. 품질이 중요한 부분은 사람이 통제하고 나머지는 자동화한 절충입니다.
:::

## 8. 직접 말해보기

아래를 소리 내어 답해보고, 막히는 부분이 곧 약점이다.

- 정적 트랙과 동적 트랙의 경계를 한 문장으로 정의하면? (어떤 텍스트가 어디로 가나)
- 사용자가 헤더에서 영어를 골랐을 때, 다음 요청부터 영어가 유지되는 이유를 인터셉터와 리졸버 관점에서 설명하라.
- 번역 캐시가 없다고 가정하면 어떤 비용이 늘어나는가? 해시 키가 그걸 어떻게 막는가?
- 면접관이 모바일 다국어를 물으면 어디까지 됐고 무엇이 계획인지 정직하게 구분해서 답하라.

## 퀴즈

<QuizBox question="정적 메뉴/버튼 문구와 사용자가 작성한 후기 본문을 각각 다른 방식으로 번역한 가장 큰 이유는?" :choices="['둘 다 같은 번들로 처리하는 것이 빠르기 때문', '텍스트의 출처가 달라서 정적은 파일에 담기고 동적은 런타임 생성이라 캐시가 필요하기 때문', 'JSP가 동적 텍스트를 지원하지 않기 때문', '세션 로케일이 정적 문구만 인식하기 때문']" :answer="1" explanation="정적 문구는 개발 시점에 양이 확정돼 properties 번들에 미리 담을 수 있고, 동적 문구는 사용자가 런타임에 만들어 파일로 담을 수 없으므로 외부 번역 API와 DB 캐시를 쓴다." />

<QuizBox question="useCodeAsDefaultMessage 옵션을 켜두면 번역 키가 번들에 없을 때 어떻게 동작하나?" :choices="['NoSuchMessageException을 던져 페이지가 깨진다', '예외 대신 키 코드 자체를 화면에 노출한다', '자동으로 영어 번역을 채운다', '해당 요청을 한국어로 강제 전환한다']" :answer="1" explanation="옵션을 켜면 누락 키 조회 시 예외 대신 키 코드를 그대로 반환해 운영 중 빈 화면 사고를 막고 누락 키를 바로 식별할 수 있다." />

<QuizBox question="동적 텍스트 번역에서 SPOT_TEXT_TRANSLATION_CACHE를 조회할 때 캐시 키로 사용하는 원문 가공 방식은?" :choices="['원문을 그대로 인덱스 키로 사용', '원문을 SHA-256 해시로 변환해 고정 길이 키로 사용', '원문의 첫 50자만 잘라 사용', 'UUID를 매번 새로 생성해 사용']" :answer="1" explanation="원문을 trim한 뒤 SHA-256으로 고정 길이 해시를 만들고 source_type, field_name, target_lang 등과 함께 조회해 같은 문장의 반복 번역을 막는다." />
