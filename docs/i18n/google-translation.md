---
title: "Google 번역 API"
owner: C
domain: "다국어·공통"
tags: ["번역"]
---

# Google 번역 API

> 사용자가 입력한 동적 텍스트(여행지명, 게시글, 패키지 제목 등)를 현재 로케일 언어로 실시간 번역하고, 같은 원문은 다시 호출하지 않도록 DB에 캐싱한다.

## 1. 한 줄 정의

TripTogether의 다국어는 두 갈래다. **화면 고정 문구**는 메시지 번들(properties)이 담당하고, **DB에 저장된 동적 텍스트**는 Google Cloud Translation API v2로 번역해서 `SPOT_TEXT_TRANSLATION_CACHE` 테이블에 캐싱한다. 이 페이지는 후자, 즉 사용자 생성 콘텐츠의 실시간 번역을 다룬다.

지원 언어는 한국어(ko) 기준 원문에서 영어(en)/일본어(ja)/중국어(zh) 3개 타깃이다. 한국어 화면이면 번역을 건너뛰고 원문을 그대로 반환한다.

## 2. 왜 이렇게 설계했나

고정 문구와 동적 문구를 한 도구로 처리하지 않은 이유가 핵심이다.

- **고정 문구는 properties + MessageSource로 충분하다.** 버튼 라벨, 안내 메시지 같은 값은 번역가가 미리 정해서 번들에 넣으면 된다. 런타임 API 호출이 필요 없고 비용도 들지 않는다.
- **동적 문구는 미리 번역해 둘 수 없다.** 여행지명, 사용자가 쓴 후기, 판매자가 등록한 패키지 제목은 무한히 생성된다. 이건 런타임에 기계 번역으로 처리할 수밖에 없다.
- **그렇다고 매번 API를 호출하면 느리고 비싸다.** 같은 여행지 목록을 100명이 영어로 보면 같은 원문을 100번 번역하게 된다. 그래서 (원문 해시 + 타깃 언어)를 키로 DB 캐싱을 넣어, 처음 한 번만 외부 API를 호출하고 이후엔 DB에서 읽는다.
- **API 키가 없거나 호출이 실패해도 화면은 떠야 한다.** 번역은 부가 기능이지 필수 경로가 아니다. 그래서 모든 실패 분기에서 원문을 그대로 반환하는 안전한 폴백을 둔다.

:::tip 메시지 번들 vs 번역 캐시
같은 값이라도 성격이 다르면 다른 경로를 탄다. 추천 사유 중 태그유사, 취향반영 같은 고정 코드값은 먼저 메시지 번들로 번역을 시도하고, 거기에 없는 자유 문장만 번역 캐시로 넘긴다. 한두 글자짜리 커뮤니티 태그도 같은 패턴으로 기계 번역 품질 흔들림을 줄인다.
:::

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

런타임 번역과 관리자 번역 워크벤치 두 축으로 나뉜다.

| 구분 | 클래스 / 테이블 | 역할 |
| --- | --- | --- |
| 런타임 서비스 | `SpotTextTranslationService` | 동적 텍스트를 로케일에 맞게 번역, 캐시 조회·저장 |
| 캐시 VO | `SpotTextTranslationVO` | 캐시 한 행 매핑(원문, 해시, 타깃 언어, 번역문, provider) |
| 캐시 매퍼 | `SpotTextTranslationMapper` | `selectCache` / `upsertCache` |
| 캐시 테이블 | `SPOT_TEXT_TRANSLATION_CACHE` | (source_type, source_pk, field_name, source_text_hash, target_lang) 유니크 |
| 외부 호출 | `RestTemplate` + Google Translation v2 REST | translatedText 추출 후 HTML 언이스케이프 |
| 로케일 결정 | `SessionLocaleResolver` + `LocaleChangeInterceptor` | 기본 KOREAN, lang 파라미터로 전환 |
| 관리자 워크벤치 | `AdminTranslationServiceImpl` | 번역안 생성·수정 버전·복원, 원문 스냅샷, primary 지정 |
| 관리자 테이블 | `ADMIN_TRANSLATION`, `ADMIN_TRANSLATION_REVISION`, `ADMIN_TRANSLATION_SOURCE_SNAPSHOT` | 번역안/리비전/원문 스냅샷 |

API 키는 `gcp.translate.api.key` 프로퍼티로 주입하며 자리표시자로 표기한다(`API_KEY`). 엔드포인트는 `https://translation.googleapis.com/language/translate/v2?key=API_KEY` 형태다.

번역 대상 필드는 광범위하다. 여행지(name/region/address/description), 커뮤니티 게시글·댓글, 여행 코스 제목·방문 장소명, 패키지 제목·요약·반려 사유, 지갑 이력 상세 문구까지 `source_type` 상수로 구분해 같은 캐시 테이블을 공유한다.

## 4. 동작 원리(흐름·표·작은 코드)

런타임 번역의 핵심은 `translateText(sourceType, sourcePk, fieldName, sourceText, targetLang)` 하나다.

```text
컨트롤러가 model 채우기 직전 translateXxx(list) 호출
  └ getTargetLanguage(): 로케일이 en/ja/zh 아니면 null → 원문 그대로
  └ targetLang == ko 또는 키 없음 → 원문 그대로 (폴백)
  └ sourceTextHash = sha256(원문 trim)
  └ selectCache(type, pk, field, hash, lang)
       ├ 히트 → 캐시의 translatedText 반환  (외부 호출 없음)
       └ 미스 → Google v2 POST {q, target, format:text}
                 └ translatedText 언이스케이프
                 └ upsertCache(...)  → 다음부터 캐시 히트
```

키 설계가 캐싱의 전부다. 캐시 키는 `source_type + source_pk + field_name + source_text_hash + target_lang` 5개 컬럼 유니크다. 원문 자체가 아니라 SHA-256 해시를 키로 써서, 긴 후기 본문도 고정 길이(char 64)로 비교·인덱싱한다. 원문이 한 글자라도 바뀌면 해시가 달라져 자동으로 새 번역을 만든다.

중국어는 Google이 요구하는 `zh-CN`으로 정규화해서 보내고, 응답은 `HtmlUtils.htmlUnescape`로 정리한다. 호출이 실패하면 예외를 삼키고 원문을 그대로 캐시 없이 반환한다.

:::details 관리자 번역 워크벤치는 뭐가 다른가
런타임 캐시는 기계 번역을 그대로 저장하는 일회성 캐시다. 반면 `AdminTranslationServiceImpl`은 사람이 검수·교정하는 워크플로우다. 번역안(`ADMIN_TRANSLATION`)마다 버전(리비전)을 쌓고, 자동 번역(AUTO)·수동 번역(MANUAL)·교정(POST_EDIT)을 구분하며, 원문 스냅샷 해시로 원문이 바뀌면 outdated로 표시한다. 같은 언어쌍에서 대표 번역(primary) 하나를 지정하고, 과거 버전으로 복원(restore)할 수도 있다. 상태는 DRAFT/PUBLISHED 등으로 관리한다.
:::

## 5. 구현 상태(됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 동적 텍스트 실시간 번역 (Google v2 REST) | 구현됨 |
| 원문 해시 기반 DB 캐싱(SPOT_TEXT_TRANSLATION_CACHE) | 구현됨 |
| ko→en/ja/zh 3개 타깃, zh-CN 정규화 | 구현됨 |
| 키 없음·API 실패 시 원문 폴백 | 구현됨 |
| 메시지 번들 우선(추천 사유·고정 태그) 후 캐시 | 구현됨 |
| 관리자 번역 워크벤치(리비전·스냅샷·primary·복원) | 구현됨 |
| 캐시 만료(TTL)·자동 무효화 | 미구현(원문 변경 시 해시로만 갱신) |
| 번역 품질 정량 평가 | 미구현(향후 과제) |
| 배치 다건 번역(q 배열 1건씩 호출) | 현재는 항목별 단건 호출 |

:::warning 보안 표기
이 문서는 공개 저장소 기준이다. 실제 API 키, DB 호스트, 계정 정보는 절대 적지 않는다. 키는 `gcp.translate.api.key` 프로퍼티로 외부 주입하며, 예시에는 `API_KEY`, `DB_HOST` 같은 자리표시자만 사용한다.
:::

## 6. 면접 답변 3단계

1. **한 문장:** "고정 UI 문구는 메시지 번들로, 사용자 생성 동적 텍스트는 Google Cloud Translation API로 실시간 번역하고 원문 해시 기준으로 DB 캐싱했습니다."
2. **설계 이유:** "동적 콘텐츠는 미리 번역해 둘 수 없는데 매번 API를 호출하면 느리고 비싸서, 원문 SHA-256 해시와 타깃 언어를 키로 캐시를 두어 같은 원문은 한 번만 외부 호출하게 했습니다. 키가 없거나 호출이 실패해도 원문을 반환하는 폴백으로 화면 가용성을 지켰습니다."
3. **확장:** "관리자 쪽에는 기계 번역을 사람이 교정하는 워크벤치를 따로 두어, 번역안마다 버전을 쌓고 원문 스냅샷 해시로 원문이 바뀌면 outdated로 잡고 대표 번역을 지정합니다."

## 7. 꼬리질문+모범답안

**Q. 캐시 키를 원문 텍스트가 아니라 해시로 잡은 이유는?**
긴 후기 본문 같은 가변 길이 원문을 그대로 인덱스 키로 쓰면 비효율적입니다. SHA-256으로 고정 길이 char 64로 만들면 비교·인덱싱이 일정하고, 유니크 키와 조회 인덱스를 동일 길이로 설계할 수 있습니다.

**Q. 원문이 수정되면 캐시가 깨지지 않나요?**
원문이 바뀌면 해시가 달라져 캐시 미스가 나고 새 번역이 자동 생성됩니다. 오래된 번역은 단순히 다시 조회되지 않을 뿐입니다. 다만 명시적 TTL이나 옛 행 정리는 아직 없어서, 캐시 정리 배치가 향후 과제입니다.

**Q. 번역 API가 죽으면 사이트가 멈추나요?**
아니요. 번역은 부가 경로라 모든 실패 분기에서 원문을 반환합니다. 키가 비어 있으면 경고 로그만 남기고 원문, 호출 예외도 잡아서 원문으로 폴백합니다. 사용자는 번역 안 된 원문을 볼 뿐 화면은 정상 동작합니다.

**Q. 모든 텍스트를 다 기계 번역으로 보내나요?**
아닙니다. 추천 사유의 고정 코드값(태그유사, 취향반영)이나 자주 쓰는 짧은 커뮤니티 태그는 먼저 메시지 번들로 번역을 시도하고, 거기에 없는 자유 문장만 번역 API로 넘깁니다. 짧은 텍스트의 기계 번역 품질 흔들림을 줄이려는 의도입니다.

**Q. 런타임 캐시와 관리자 번역 테이블은 왜 분리했나요?**
런타임 캐시는 기계 번역을 그대로 저장하는 일회성 성능 캐시이고, 관리자 테이블은 사람이 검수·교정하며 버전과 원문 스냅샷, 대표 번역을 관리하는 워크플로우입니다. 책임이 달라서 테이블과 서비스를 나눴습니다.

## 8. 직접 말해보기

- 고정 문구와 동적 문구를 각각 어떤 경로로 번역하는지, 왜 나눴는지 30초로 설명해 보세요.
- 캐시 키 5개 컬럼을 나열하고, 해시를 쓰는 이유를 말해 보세요.
- 번역 API가 실패했을 때 어떤 폴백이 동작하는지 코드 흐름으로 설명해 보세요.
- 런타임 캐시와 관리자 워크벤치의 차이를 한 문장씩 대비해 보세요.

---

관련 문서: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="동적 텍스트 번역에서 캐시 미스가 났을 때 일어나는 일로 옳은 것은?" :choices="['빈 문자열을 반환한다', 'Google API를 호출하고 결과를 캐시에 저장한다', '항상 예외를 던진다', '한국어 원문을 강제로 영어로 바꾼다']" :answer="1" explanation="selectCache가 히트하지 않으면 Google Translation v2를 호출해 번역문을 받고 upsertCache로 저장한 뒤 반환합니다. 이후 같은 원문은 캐시 히트로 외부 호출이 생략됩니다." />

<QuizBox question="번역 캐시의 유니크 키를 구성하는 컬럼 조합으로 맞는 것은?" :choices="['source_type과 target_lang 두 개만', 'source_type, source_pk, field_name, source_text_hash, target_lang', 'cache_id 하나만', '원문 텍스트 전체와 언어 코드']" :answer="1" explanation="SPOT_TEXT_TRANSLATION_CACHE의 유니크 키는 source_type, source_pk, field_name, source_text_hash, target_lang 다섯 컬럼입니다. 원문은 텍스트 자체가 아니라 SHA-256 해시로 비교합니다." />

<QuizBox question="API 키가 비어 있거나 번역 호출이 실패하면 어떻게 동작하는가?" :choices="['화면 전체가 오류 페이지로 바뀐다', '원문을 그대로 반환해 화면은 정상 동작한다', '무한 재시도를 한다', '한국어로 강제 전환한다']" :answer="1" explanation="번역은 부가 경로이므로 키가 없으면 경고 로그만 남기고 원문을, 호출 예외도 잡아서 원문으로 폴백합니다. 사용자는 번역되지 않은 원문을 볼 뿐 화면 가용성은 유지됩니다." />
