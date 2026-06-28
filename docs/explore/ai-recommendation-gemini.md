---
title: "AI 추천 (Gemini)"
owner: C
domain: "여행지 탐색·커머스"
tags: ["Gemini", "추천"]
---

# AI 추천 (Gemini)

> 사용자가 최근 본 여행지의 체류 시간과 태그 선호도를 분석해, Gemini 2.5 Flash가 후보 풀에서 맞춤 여행지 3곳을 골라 추천한다.

## 1. 한 줄 정의

여행지 탐색 도메인의 개인화 추천 기능이다. 최근 30건의 페이지 체류 로그를 모아 관심 태그 프로파일을 만들고, DB가 1차로 좁힌 후보 목록을 Gemini 2.5 Flash에 넘겨 새롭게 흥미를 느낄 만한 여행지 3개를 고르게 한다. 결과는 SPOT_RECOMMEND 테이블에 캐시한다.

## 2. 왜 이렇게 설계했나

- **명시적 선호 데이터가 없다.** 별점이나 찜만으로는 신호가 희박하다. 그래서 행동 신호인 페이지 체류 시간(stay_seconds)과 방문 빈도를 1차 신호로 쓴다. 오래 머문 여행지의 태그일수록 관심도가 높다고 본다.
- **LLM에 모든 후보를 다 주지 않는다.** 전체 여행지를 프롬프트에 넣으면 토큰이 폭발하고 환각도 늘어난다. 그래서 DB가 태그 일치 점수로 후보를 좁혀 상위 50건만 추리고, 그중 재정렬한 30건만 모델에 넘긴다. **선별은 DB, 최종 큐레이션은 LLM**이라는 역할 분리가 핵심이다.
- **LLM은 불안정하다.** 응답이 비거나 JSON이 깨지거나 후보 밖의 spot_idx를 만들어낼 수 있다. 그래서 모델 결과를 그대로 믿지 않고 후보 집합(FK 유효성)으로 검증하고, 부족하면 규칙 기반으로 채우고, 그래도 안 되면 트렌딩 폴백으로 떨어진다. **AI가 죽어도 화면은 항상 3칸이 채워진다.**

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 | 실제 이름 |
| --- | --- |
| 진입 컨트롤러 | `RecommendController` (`/recommend/view-log`, `/recommend/spots`) |
| 핵심 서비스 | `RecommendService` |
| 매퍼 | `RecommendMapper` + `recommendMapper.xml` |
| 후보 VO | `CandidateSpotVO` (spotIdx, tagsConcat, visitedFlag, tagMatchScore) |
| 추천 결과 VO | `RecommendVO` (recReason, recScore, tagMatchCount) |
| 체류 로그 VO | `SpotViewLogVO` (staySeconds, tagsConcat, visitCount) |
| 체류 로그 테이블 | `SPOT_VIEW_LOG` (stay_seconds, viewed_at) |
| 추천 캐시 테이블 | `SPOT_RECOMMEND` (rec_reason, rec_score, created_at) |
| 태그 매핑 | `SPOT_TAG`, `SPOT_TAG_LIST` (tag_name) |
| LLM | Google Gemini 2.5 Flash (`generativelanguage` REST, `gemini-2.5-flash:generateContent`) |
| HTTP | Spring `RestTemplate`, 응답 파싱은 Gson(`JsonParser`) |

API 키는 `@Value("${gemini.api.key}")`로 주입되며, 코드에는 `API_KEY` 자리표시자만 둔다.

## 4. 동작 원리 (흐름·표·작은 코드)

전체 파이프라인은 `RecommendService.getRecommendations(userIdx, currentSpotIdx)` 한 메서드에 모여 있다.

```text
1. 체류 로그 저장   POST /recommend/view-log → saveViewLog → 캐시 즉시 무효화
2. 추천 조회        GET  /recommend/spots
   ├ 캐시 확인       selectRecommendSpotsWithTagMatch (관심태그로 재정렬)
   ├ 관심 태그 추출  최근 30건 로그 → 체류시간+방문빈도 가중 → 상위 8개 태그
   ├ 후보 조회       selectCandidateSpots (DB가 tag_match_score로 1차 선별, 최대 50)
   ├ 재정렬          rerankCandidates → 상위 30건
   ├ Gemini 호출     callGemini → JSON 배열 파싱
   ├ 병합·보정       mergeWithTopCandidates → ensureExactRecommendationCount (항상 3건)
   └ 폴백            결과 0건이면 selectTrendingSpots (최근 7일 조회수 + 좋아요)
```

**관심 태그 가중치.** 단순 빈도가 아니라 체류 시간과 방문 횟수에 가중을 준다. `buildInterestProfile`에서 각 여행지의 태그마다 `체류초 + (방문횟수 * 180)`을 더해 누적하고, 상위 8개를 관심 태그로 뽑는다.

```java
int stayScore  = Math.max(1, totalStaySeconds);
int visitScore = Math.max(1, visitCount) * 180;   // 한 번 더 방문 = 약 3분 체류 가치
profile.merge(tag, stayScore + visitScore, Integer::sum);
```

**DB의 1차 선별.** `selectCandidateSpots`는 관심 태그와 겹치는 태그 수를 `FIND_IN_SET`으로 세어 tag_match_score를 만들고, 최근 30분 내 이미 추천된 여행지와 현재 보고 있는 여행지를 제외한 뒤 점수 내림차순으로 50건을 추린다. 동점이면 미방문 우선, 그다음 `RAND()`.

**우선순위 점수.** 모델에 넘기기 전 `computeCandidatePriority`가 가중치를 매겨 재정렬한다. 가중치 설계가 의도를 그대로 드러낸다.

| 신호 | 가중치 | 의미 |
| --- | --- | --- |
| 현재 보는 여행지와 태그 겹침 | × 1,000,000 | 지금 맥락이 가장 우선 |
| 관심 태그 일치 수(tag_match_score) | × 100,000 | 장기 취향 |
| 관심 프로파일 누적 가중 | × 1 | 미세 조정 |
| 이미 방문함(visitedFlag) | − 10,000 | 본 곳은 감점 |

**프롬프트와 출력 계약.** 시스템 지시는 관심 태그, 현재 여행지 태그, 후보 목록(spot_idx와 tag_match_score 포함), 최근 방문·이전 추천 금지 목록을 담아 구성하고, 출력은 다른 텍스트 없이 JSON 배열만 요청한다.

```json
[{"spot_idx": 142, "reason": "바다전망", "score": 8}]
```

`generationConfig`는 temperature 1.0, topP 0.95, maxOutputTokens 2048. 다양성을 위해 온도를 높게 둔다.

**깨진 JSON 방어.** 응답에서 코드펜스를 제거하고 첫 대괄호부터 잘라낸 뒤, `extractCompletedObjects`가 중괄호 깊이를 직접 세며 완성된 객체만 추출한다. 토큰 한도로 마지막 객체가 잘려도 앞쪽 완성분은 살린다.

**검증과 보정.** 모델이 후보 밖 spot_idx를 반환하면 `validIdx` 집합으로 걸러내고, 3건이 안 되면 `ensureExactRecommendationCount`가 상위 후보 → 트렌딩 순으로 채워 항상 정확히 3건을 보장한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 체류 로그 수집, 관심 태그 가중 추출, DB 1차 선별, Gemini 호출, JSON 파싱·검증, 3건 보정, 트렌딩 폴백까지 전 구간 동작한다.
- 캐시는 `SPOT_RECOMMEND`에 저장되며 5분 윈도로 조회한다. 다만 체류 로그를 새로 저장하면 컨트롤러가 `invalidateCache`로 즉시 비워, 다음 조회 때 Gemini를 다시 부른다. 즉 실효 캐시 수명은 다음 행동 전까지다.
- 추천 카드의 이름·지역·평점·리뷰수·좋아요수는 매퍼 서브쿼리로 실시간 집계한다.
:::

:::warning 한계·계획
- 추천 품질을 정량 평가하는 지표(클릭률·전환 추적)는 아직 없다. 효과 측정은 향후 과제다.
- 관심 태그가 비고 후보도 없는 신규 사용자는 사실상 트렌딩(인기) 추천을 받는다. 콜드스타트 개인화는 미흡하다.
- Gemini 호출은 동기식이라 응답 지연이 사용자 대기로 이어질 수 있다. 비동기·프리컴퓨트는 도입 전이다.
:::

## 6. 면접 답변 3단계

1. **한 문장.** "사용자의 여행지 페이지 체류 시간과 태그 선호를 분석해, Gemini 2.5 Flash가 후보 중 맞춤 여행지 3곳을 큐레이션하는 개인화 추천입니다."
2. **설계 핵심.** "후보 선별은 DB가, 최종 선택은 LLM이 맡는 2단 구조입니다. DB가 태그 일치 점수로 50건을 좁히고 30건만 모델에 넘겨 토큰과 환각을 줄였고, 모델 결과는 후보 집합으로 검증합니다."
3. **신뢰성.** "LLM은 실패할 수 있어서 응답이 비거나 깨지거나 후보 밖 ID를 내면 규칙 기반 보정과 트렌딩 폴백으로 떨어집니다. 그래서 AI가 죽어도 화면에는 항상 3칸이 채워집니다."

## 7. 꼬리질문 + 모범답안

:::details 전체 여행지를 그냥 Gemini에 다 주면 안 되나요
토큰 비용이 선형으로 늘고, 후보가 많을수록 모델이 존재하지 않는 spot_idx를 만들어낼 확률도 커집니다. DB가 태그 매칭으로 50건까지 좁히고 30건만 넘기면 비용과 환각을 동시에 줄이면서, 모델은 후보 안에서 다양성과 맥락만 판단하면 됩니다. 역할을 분리한 것입니다.
:::

:::details 체류 시간을 신뢰할 수 있나요. 탭만 켜두고 자리를 비울 수도 있는데요
그래서 `saveViewLog`에서 stay_seconds를 1초에서 3600초로 클램프해 비정상 값을 막습니다. 또 체류 시간 단독이 아니라 방문 빈도와 함께 가중합니다. 한 번 더 방문하면 약 3분 체류에 해당하는 점수를 더해, 우연히 오래 켜둔 한 건이 취향을 왜곡하지 못하게 균형을 잡았습니다.
:::

:::details Gemini가 JSON을 깨뜨려서 보내면 어떻게 되나요
응답에서 코드펜스를 벗기고 첫 대괄호부터 잘라낸 뒤, 중괄호 깊이를 직접 세며 완성된 객체만 추출합니다. 토큰 한도로 마지막 객체가 잘려도 앞쪽 완성분은 살립니다. 그래도 유효 결과가 0건이면 트렌딩 폴백으로 떨어져 화면은 비지 않습니다.
:::

:::details 같은 추천이 계속 반복되면 지루할 텐데요
세 군데서 막습니다. 첫째 후보 쿼리가 최근 30분 내 이미 추천된 여행지를 제외합니다. 둘째 프롬프트에 이전 추천 spot_idx와 최근 방문 목록을 절대 포함 금지로 명시합니다. 셋째 temperature를 1.0으로 높여 동률 후보 중 변화를 줍니다.
:::

:::details 캐시가 5분이라면서 왜 매번 Gemini를 부르나요
캐시 조회 윈도는 5분이 맞지만, 사용자가 새 여행지를 보고 체류 로그를 저장할 때마다 컨트롤러가 캐시를 즉시 무효화합니다. 행동이 바뀌면 추천도 바로 갱신되도록 한 의도적 선택입니다. 사용자가 가만히 있으면 5분 캐시가 그대로 적중합니다.
:::

## 8. 직접 말해보기

- 관심 태그를 단순 빈도가 아니라 체류 시간과 방문 빈도로 가중하는 이유를 30초로 설명해 보세요.
- "선별은 DB, 큐레이션은 LLM" 구조의 장점 두 가지를 후속 질문 없이 말해 보세요.
- Gemini 응답이 비었을 때부터 화면에 3칸이 채워지기까지의 폴백 단계를 순서대로 짚어 보세요.

관련 문서: [추천 캐시·폴백](/explore/recommendation-cache-fallback) · [탐색 필터](/explore/explore-filters) · [Gemini 챗봇·추천](/ai/gemini-chatbot) · [다중 AI 모델 통합](/ai/multi-model) · [폴백 전략](/ai/fallback-strategy)

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="이 추천 기능에서 후보를 1차로 좁히는 주체와, 최종 3곳을 고르는 주체를 옳게 짝지은 것은?" :choices="['DB가 좁히고 Gemini가 최종 선택', 'Gemini가 좁히고 DB가 최종 선택', '둘 다 Gemini가 처리', '둘 다 DB가 처리']" :answer="0" explanation="DB가 태그 일치 점수로 후보를 50건까지 좁히고 30건만 Gemini에 넘기면, 모델이 다양성과 맥락을 반영해 최종 3곳을 큐레이션한다. 선별은 DB, 큐레이션은 LLM이다." />

<QuizBox question="관심 태그 프로파일을 만들 때 사용하는 두 가지 행동 신호는?" :choices="['별점과 찜 수', '페이지 체류 시간과 방문 빈도', '결제 금액과 리뷰 수', '좋아요와 댓글 수']" :answer="1" explanation="buildInterestProfile은 각 태그에 체류초와 방문횟수 곱하기 180을 더해 누적한다. 명시적 선호 대신 행동 신호인 체류 시간과 방문 빈도를 1차 신호로 쓴다." />

<QuizBox question="Gemini 응답이 비거나 유효 추천이 0건일 때 화면에 최종적으로 채워지는 것은?" :choices="['빈 화면', '에러 메시지', '최근 7일 조회수와 좋아요 기준 트렌딩 여행지', '랜덤 여행지 3곳']" :answer="2" explanation="결과가 0건이면 selectTrendingSpots 폴백으로 떨어진다. 최근 7일 조회수와 좋아요 수가 높은 여행지를 보여줘 화면은 항상 3칸이 채워진다." />
