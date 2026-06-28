---
title: "탐색 필터"
owner: C
domain: "여행지 탐색·커머스"
tags: ["탐색", "필터"]
---

# 탐색 필터

> 여행지 목록 화면 하나를 7개 탭으로 분기시켜, 서버 정렬 5종과 사용자별 찜 목록, AJAX 기반 AI 추천을 한 진입점에서 처리한다.

## 1. 한 줄 정의

탐색 필터는 `GET /explore` 한 엔드포인트가 `tab` 파라미터(전체·지역별·테마별·평점순·좋아요순·찜한곳·AI추천)에 따라 서로 다른 조회 전략으로 분기해 `SPOT_TRAVEL` 목록을 정렬·필터링하는 기능이다.

## 2. 왜 이렇게 설계했나

- **단일 진입점, 다중 전략.** 탭마다 별도 URL을 만들지 않고 쿼리 파라미터 `tab` 하나로 분기하면, 검색어(`keyword`)·지역(`region`)·테마(`theme`)·페이지(`page`) 같은 공통 조건을 한 폼에서 그대로 유지한 채 탭만 갈아끼울 수 있다. JSP 한 화면에서 탭 전환 시 상태 손실이 없다.
- **정렬은 DB에, 개인화는 분리.** 평점순·좋아요순은 집계 정렬이라 SQL이 가장 빠르고 정확하다. 반면 찜 목록은 사용자 종속이고, AI 추천은 외부 LLM 호출이라 응답 시간이 들쭉날쭉하다. 그래서 정렬 5종은 동기 SQL로, 찜은 로그인 가드가 붙은 SQL로, AI 추천만 AJAX로 떼어내 첫 페이지 렌더를 막지 않게 했다.
- **DTO 한 개로 조건 운반.** 컨트롤러가 `ExploreSearchDto` 하나에 모든 조건을 담아 매퍼로 넘긴다. 조건이 늘어도 시그니처가 흔들리지 않고, MyBatis 동적 SQL에서 `<if>`로 골라 쓴다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 진입점 | `ExploreController#explore` | `tab` 값으로 서비스 메서드 분기, `explore/list` JSP 반환 |
| 조건 운반 | `ExploreSearchDto` | tab·keyword·region·theme·page·offset·loginUserIdx 보관 |
| 분기 로직 | `ExploreServiceImpl` | 탭별 매퍼 호출 + 태그 분리 + 찜/좋아요 상태 주입 + 번역 |
| 동적 SQL | `exploreMapper.xml` | tab별 정렬·필터 SQL(전체/평점/좋아요/찜) |
| AI 추천 | `RecommendController`, `RecommendService` | AJAX `GET /recommend/spots`, 체류로그 기반 개인화 |
| 핵심 테이블 | `SPOT_TRAVEL`, `SPOT_REVIEW`, `SPOT_LIKE`, `SPOT_FAVORITE`, `SPOT_TAG`, `SPOT_TAG_LIST` | 여행지·리뷰·좋아요·찜·태그 |

탭과 조회 메서드 대응은 다음과 같다.

| 탭(`tab`) | 의미 | 호출 메서드 | 정렬 기준 |
| --- | --- | --- | --- |
| all | 전체 | `getSpotList` | 평점 평균 → 리뷰 수 |
| region | 지역별 | `getSpotList`(region 조건 추가) | 평점 평균 → 리뷰 수 |
| theme | 테마별 | `getSpotList`(tag_name 조인) | 평점 평균 → 리뷰 수 |
| rating | 평점순 | `getRatingSpotList` | 평점 평균 → 리뷰 수 |
| likes | 좋아요순 | `getLikesSpotList` | 좋아요 수 → 평점 평균 |
| favorite | 찜한곳 | `getFavoriteSpotList` | 찜한 시각 최신순 |
| ai | AI추천 | (서버 빈 목록) → AJAX | 개인화 점수 |

:::tip
전체·지역별·테마별은 같은 `getSpotList` 한 메서드를 쓴다. 차이는 매퍼 동적 SQL의 `<if>` 분기뿐이다. region은 `st.region = #{region}` 등식, theme는 `SPOT_TAG_LIST`를 조인해 `tag_name = #{theme}`로 좁힌다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

컨트롤러 분기는 단순한 if 사슬이다.

```java
if ("rating".equals(tab))        spotList = service.getRatingSpotList(search);
else if ("likes".equals(tab))    spotList = service.getLikesSpotList(search);
else if ("favorite".equals(tab)) spotList = service.getFavoriteSpotList(search);
else if ("ai".equals(tab))       spotList = Collections.emptyList(); // AJAX가 채움
else                             spotList = service.getSpotList(search); // all/region/theme
```

기본 목록 SQL의 핵심은 소프트삭제 가드와 동적 조건이다.

```sql
WHERE COALESCE(st.spot_active, 0) = 0          -- 활성 여행지만
  AND ( st.name LIKE %keyword% OR st.region LIKE %keyword% OR st.address LIKE %keyword% )
  AND st.region = #{region}                    -- tab=region 일 때만
ORDER BY rating_avg_real DESC, review_count_real DESC
LIMIT #{pageSize} OFFSET #{offset}
```

- `spot_active = 0`이 활성 상태다(소프트삭제 패턴). 삭제된 여행지는 모든 탭에서 자동 제외된다.
- 정렬용 `rating_avg_real`·`like_count_real`은 `SPOT_REVIEW`·`SPOT_LIKE`를 상관 서브쿼리로 집계한 값이다. 캐시 컬럼이 아니라 조회 시점 실값이라 정확하다.
- 페이지 크기는 `ExploreSearchDto.pageSize = 12` 고정, `offset = (page - 1) * 12`을 `calcOffset()`이 계산한다.

목록을 받은 뒤 서비스가 세 가지 후처리를 한다.

1. `splitTags` — `GROUP_CONCAT`으로 콤마 묶인 태그 문자열을 `List<String>`으로 분리.
2. `applyUserActionState` — 로그인 사용자라면 카드마다 찜/좋아요 여부를 채워 하트 아이콘 상태를 맞춘다.
3. `translateExploreSpots` — 현재 로케일(ko/en/ja/zh)에 맞춰 텍스트를 번역.

찜 탭과 AI 탭의 로그인 가드 흐름은 다음과 같다.

```text
favorite 탭 → loginUserIdx == null 이면 즉시 빈 목록 + totalCount 0
ai 탭       → 서버는 빈 목록만 렌더 → JSP가 GET /recommend/spots AJAX 호출
            → 비로그인이면 { loggedIn:false } 반환
```

AI 추천(`ai` 탭)의 서버 측 3단 폴백(`RecommendService.getRecommendations`):

| 단계 | 동작 | 폴백 조건 |
| --- | --- | --- |
| 1. DB 캐시 | 저장된 추천 재사용 | 캐시 있으면 즉시 반환 |
| 2. Gemini | 최근 체류로그·관심 태그로 LLM 추천 생성 | 후보·결과 없으면 다음 단계 |
| 3. 트렌딩 | 요즘 뜨는 여행지 목록 | 항상 결과 보장 |

체류 시간은 `POST /recommend/view-log`(상세 페이지 이탈 시)로 쌓이고, 기록이 들어오면 `invalidateCache`로 캐시를 즉시 비워 다음 호출에서 Gemini를 재실행한다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨:** 7개 탭 전부 동작. 전체·지역별·테마별·평점순·좋아요순 정렬, 찜 목록 로그인 가드, 검색어 통합 LIKE(name/region/address), 자동완성(`GET /explore/suggest`, 최대 7건), 찜/좋아요 토글 AJAX, 소프트삭제 제외, 다국어 번역, 페이지네이션.
- **구현됨(AI):** AI 추천 탭의 DB캐시 → Gemini 2.5 Flash → 트렌딩 3단 폴백, 체류로그 기반 캐시 무효화.
- **한계/계획:** AI 추천 결과의 품질을 정량 평가하는 체계는 아직 없다(향후 과제). 화면 레이아웃은 JSP 데스크톱 기준이라 모바일 반응형은 후속 과제다. 정렬용 집계는 매 조회 서브쿼리라 데이터가 커지면 캐시 컬럼 도입을 고려할 수 있다.

## 6. 면접 답변 3단계

1. **한 줄:** "여행지 탐색은 GET /explore 한 엔드포인트가 tab 파라미터로 7개 탭으로 분기하고, 정렬은 DB에서, AI 추천만 AJAX로 분리해 처리합니다."
2. **설계 의도:** "정렬은 SQL이 가장 빠르고 정확하지만 AI 추천은 외부 LLM 호출이라 지연이 변동적입니다. 그래서 정렬 5종은 동기 SQL로 첫 화면을 즉시 렌더하고, AI 탭만 빈 목록으로 둔 뒤 별도 AJAX로 채워 렌더 차단을 막았습니다."
3. **세부:** "조건은 ExploreSearchDto 하나에 담아 MyBatis 동적 SQL의 if 분기로 region·theme를 좁히고, spot_active = 0으로 소프트삭제를 거르며, 찜과 AI는 로그인 가드를 둡니다. AI는 DB캐시 → Gemini → 트렌딩 3단 폴백으로 항상 결과를 보장합니다."

## 7. 꼬리질문 + 모범답안

:::details 탭마다 URL을 따로 두지 않고 tab 파라미터 하나로 분기한 이유는?
검색어·지역·테마·페이지 같은 공통 조건을 탭 전환 시에도 유지해야 하기 때문이다. 별도 URL이면 조건을 매번 다시 실어 보내야 하지만, 같은 폼에 tab만 바꾸면 나머지 조건이 그대로 따라간다. 서버도 ExploreSearchDto 하나로 모든 탭을 처리해 코드가 단순해진다.
:::

:::details 평점순 정렬은 어떻게 정확성을 보장하나? 캐시 컬럼을 쓰지 않나?
정렬 키 rating_avg_real·review_count_real을 SPOT_REVIEW에 대한 상관 서브쿼리로 조회 시점에 집계한다. 캐시 컬럼이 아니라 실값이라 리뷰가 막 달려도 즉시 반영된다. 단점은 데이터가 커지면 매 조회 집계 비용이 든다는 것이라, 규모가 커지면 캐시 컬럼 + 갱신 트리거로 전환을 고려한다.
:::

:::details AI 추천 탭은 왜 서버에서 빈 목록을 반환하나?
AI 추천은 Gemini 호출이라 응답 시간이 변동적이다. 서버 렌더에 묶으면 그 지연만큼 첫 화면이 늦어진다. 그래서 서버는 페이징 블록 없이 빈 목록만 렌더하고, JSP가 GET /recommend/spots를 AJAX로 호출해 비동기로 카드를 채운다. totalCount·totalPage도 0으로 둬 불필요한 페이징 UI를 막는다.
:::

:::details 비로그인 사용자가 찜 탭이나 AI 탭을 누르면?
찜 탭은 서비스가 loginUserIdx가 null이면 DB 조회 없이 빈 목록과 건수 0을 반환한다. AI 탭은 AJAX 응답이 loggedIn false로 내려가 화면에서 로그인 유도를 띄운다. 둘 다 예외 대신 빈 상태로 graceful하게 처리한다.
:::

:::details AI 추천 결과가 비거나 Gemini가 실패하면 화면이 빈 채로 남나?
아니다. getRecommendations는 3단 폴백이다. DB 캐시가 있으면 그걸, 없으면 Gemini 호출, 그래도 후보나 결과가 없으면 트렌딩(요즘 뜨는 여행지)을 반환한다. 트렌딩은 항상 결과가 있으므로 사용자는 어떤 경우에도 빈 화면을 보지 않는다.
:::

## 8. 직접 말해보기

- `GET /explore`가 7개 탭을 분기하는 방식을 tab 파라미터와 ExploreSearchDto를 들어 30초로 설명해보라.
- 평점순과 좋아요순의 정렬 키 차이, 그리고 그 값이 캐시가 아니라 실시간 집계인 이유를 말해보라.
- AI 추천 탭만 AJAX로 분리하고 3단 폴백을 둔 이유를, 렌더 성능과 외부 LLM 지연 관점에서 설명해보라.

더 넓은 맥락은 [여행지 탐색·커머스 도메인 개요](/explore/), [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 이어 볼 수 있다.

## 퀴즈

<QuizBox question="GET /explore에서 전체/지역별/테마별 탭을 처리하는 서비스 메서드는 무엇인가?" :choices="['세 탭이 각각 다른 전용 메서드를 호출한다', 'getSpotList 한 메서드를 공유하고 매퍼 동적 SQL의 if 분기로 구분한다', 'AJAX로 클라이언트가 직접 SQL을 만든다', 'getRatingSpotList가 모두 처리한다']" :answer="1" explanation="all, region, theme는 모두 getSpotList를 호출하고, 차이는 exploreMapper의 동적 if 분기(region 등식, theme 태그 조인)뿐이다." />

<QuizBox question="AI 추천 탭에서 Gemini 호출이 후보도 결과도 없을 때 최종적으로 무엇이 반환되는가?" :choices="['HTTP 500 오류', '빈 목록과 로그인 유도', '트렌딩 요즘 뜨는 여행지 목록', '평점순 목록']" :answer="2" explanation="getRecommendations는 DB캐시 → Gemini → 트렌딩 3단 폴백이며, 트렌딩은 항상 결과가 있어 빈 화면을 막는다." />

<QuizBox question="기본 목록 SQL이 삭제된 여행지를 제외하기 위해 사용하는 조건은?" :choices="['post_status = ACTIVE', 'COALESCE spot_active 값이 0인 행만', 'is_deleted = 1 인 행만', 'rating_avg가 0보다 큰 행만']" :answer="1" explanation="소프트삭제 패턴으로 spot_active 값이 0인 활성 여행지만 조회하며, 삭제분은 모든 탭에서 자동 제외된다." />
