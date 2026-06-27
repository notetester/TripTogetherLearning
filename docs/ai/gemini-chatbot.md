# Gemini 챗봇·추천

> TripTogether는 Google Gemini 2.5 Flash 한 모델을 두 곳에 쓴다. 하나는 사이트 네비게이션 챗봇이고, 다른 하나는 여행지 개인화 추천이다. 둘 다 구조화 JSON을 받아내고, LLM 실패에 대비한 폴백 경로를 가진다.

## 1. 한 줄 정의

`gemini-2.5-flash` 모델을 `RestTemplate`으로 직접 호출해, (1) `common` 모듈의 사이트 안내 챗봇과 (2) `explore` 모듈의 여행지 추천을 구현한 기능이다. 챗봇은 의도 분류·fast-path·등급 쿼터·URL 화이트리스트를 거치고, 추천은 체류 로그와 태그 선호를 분석해 후보를 만든 뒤 LLM으로 정렬한다.

## 2. 왜 이렇게 설계했나

- **빠르고 저렴한 모델 선택**: 두 기능 모두 짧은 구조화 응답이 필요하고 호출 빈도가 높다. Flash 계열은 지연·비용 측면에서 이 패턴에 맞는다. (TripTogether는 어시스턴트에 GPT-4o-mini, 문의 초안에 Claude Haiku를 쓰는 다중 모델 전략을 취한다. [다중 AI 모델 통합](/ai/multi-model) 참고.)
- **LLM은 보조, 시스템이 주도**: 챗봇이 만든 링크 URL과 추천이 고른 `spot_idx`는 그대로 믿지 않는다. 챗봇은 화이트리스트로 URL을 검증하고, 추천은 실제 후보 집합에 있는 id만 저장한다. LLM 환각이 사용자에게 도달하지 못하게 하는 것이 핵심 설계 목표다.
- **토큰·쿼터 절감**: 단순 네비게이션("커뮤니티 어디야")은 LLM을 아예 호출하지 않는 fast-path로 처리한다. 부적절 메시지는 1차 분류 단계에서 걸러 본 호출을 생략한다.
- **항상 무언가는 답한다**: Gemini가 5xx를 던지거나 안전 필터로 본문이 비어도 챗봇은 폴백 응답을, 추천은 트렌딩 여행지를 반환한다. 빈 화면이 나오지 않는다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

### 챗봇 (common 모듈)

| 구성요소 | 클래스 | 역할 |
| --- | --- | --- |
| 오케스트레이션 | `ChatbotService` | 차단→쿼터→대화→fast-path→분류→Gemini→저장 12단계 |
| 1차 분류·컨텍스트 | `IntentContextService` | 의도 분류 LLM 호출 + 키워드로 DB 후보 조회 |
| 빠른 경로 | `ChatbotFastPathService` | 15자 이하 단순 요청을 LLM 없이 즉답 |
| 등급 쿼터 | `ChatbotQuotaService` | 등급별 주기 한도 조회·집계·증감 |
| 차단 | `ChatbotBlockService` | IP·유저 차단 여부 |
| 대화 영속 | `ConversationService` | 대화·메시지 저장, 소유권 체크 |
| 응답 VO | `ChatbotResponseVO`, `ChatIntentVO` | message/links/quickReplies/inappropriate |

테이블: `CHATBOT_CONVERSATION`, `CHATBOT_MESSAGE`, `CHATBOT_DAILY_USAGE`, `CHATBOT_GRADE_QUOTA`, `CHATBOT_BLOCK`, `CHATBOT_LINK_CLICK`.

### 추천 (explore 모듈)

| 구성요소 | 클래스 / 테이블 | 역할 |
| --- | --- | --- |
| 추천 서비스 | `RecommendService` | 캐시→Gemini→트렌딩 3단 폴백 |
| 후보·로그 조회 | `RecommendMapper`, `ExploreMapper` | 후보 spot, 체류 로그, 태그 조회 |
| 체류 로그 | `SPOT_VIEW_LOG` | userIdx·spotIdx·stay_seconds 기록 |
| 추천 캐시 | `SPOT_RECOMMEND` | 사용자별 추천 결과 캐시 |
| 후보·결과 VO | `CandidateSpotVO`, `RecommendVO`, `SpotViewLogVO` | 태그 매칭 점수·추천 사유 보유 |

엔드포인트는 `gemini-2.5-flash:generateContent` 한 곳이고, API 키는 `gemini.api.key` 프로퍼티로 주입된다(코드에서는 `API_KEY` 같은 자리표시자로 다룬다).

## 4. 동작 원리 (흐름·표·작은 코드)

### 챗봇 처리 파이프라인 (`ChatbotService.ask`)

```text
요청
 ├─ 1. 차단 체크(IP+USER)        → 차단이면 안내 응답
 ├─ 2. 등급 쿼터 조회
 ├─ 3. 주기 한도 초과?           → 초과면 한도 응답
 ├─ 4. 대화 조회/생성(소유권·대화 수 한도)
 ├─ 5. 유저 메시지 저장
 ├─ 5.5 fast-path 히트?          → LLM 생략, 즉답
 ├─ 6. 최근 N개 히스토리 로드
 ├─ 6.5 1차 분류(의도·키워드)    → 쿼터 미소모
 ├─ 6.6 INAPPROPRIATE?           → 본 호출 생략, 안전 응답
 ├─ 7. Gemini 본 호출(컨텍스트 주입)
 ├─ 7.5 EXPLORE면 관련 패키지 링크 자동 부착
 ├─ 8~10. inappropriate 플래그·assistant 메시지 저장·touch
 └─ 11. 쿼터 +1 (면제자 제외)
```

핵심은 **3겹의 LLM 절감 게이트**다. fast-path(키워드 매칭), 1차 분류(짧은 Gemini 호출, 쿼터 미소모), 본 호출. 부적절 판정이면 본 호출 전에 멈춘다.

### 구조화 JSON 강제

Gemini 호출 시 `responseMimeType`을 `application/json`으로 지정하고, 시스템 프롬프트로 응답 스키마를 못 박는다.

```json
{
  "message": "최대 3문장, 친근하고 간결",
  "links": [{ "label": "버튼", "url": "/explore", "icon": "이모지" }],
  "quickReplies": ["빠른 답변1", "빠른 답변2"],
  "inappropriate": false
}
```

응답 파싱 시 code fence를 제거하고, `candidates`·`content`·`parts` 누락을 각각 분기해 폴백 또는 안전 응답으로 떨어뜨린다. 안전 필터로 `content`가 비면 `safetyBlockedResponse`를 돌려준다.

### 의도 분류 → DB 후보 주입

1차 분류는 별도의 짧은 시스템 프롬프트(`temperature=0`)로 `intent`(EXPLORE/COURSES/PACKAGES/COMMUNITY/GENERIC/INAPPROPRIATE)와 `keywords`·`relatedTerms`를 뽑는다. 중요한 규칙: **키워드를 한국어로 정규화**한다(Paris→파리, 東京→도쿄). DB 원본이 한국어라 LIKE 검색이 매칭되게 하기 위함이다. 키워드로 spot·plan·package·post 후보를 조회해 본 프롬프트에 실시간 데이터로 주입한다. 동일 메시지는 60초 캐시된다.

### 추천 점수 계산 (`RecommendService`)

체류 로그에서 관심 태그를 가중치로 추출하고, 후보를 우선순위 점수로 재정렬한다.

```text
priority = currentOverlap × 1,000,000      // 현재 보는 여행지 태그와 직접 겹침
         + tagMatchScore  × 100,000        // 관심 태그 매칭 점수
         + profileWeight                   // 태그별 누적 관심 가중치
         - visitedFlag    × 10,000         // 이미 방문한 곳 감점
```

가중치 자체는 시스템이 계산하고, Gemini는 후보 집합 안에서 다양성을 고려해 3개를 고른다(`temperature=1.0`). 응답이 잘려도 완성된 JSON 객체만 추출하는 복구 로직이 있고, 후보에 없는 `spot_idx`는 저장 단계에서 버린다.

### URL 화이트리스트 보안

Gemini가 만든 모든 링크는 `isAllowedInternalUrl`을 통과해야 한다.

| 검사 | 동작 |
| --- | --- |
| 위험 스킴 (javascript: data: file: vbscript:) | 차단 |
| 슬래시로 시작 안 함 / protocol-relative 슬래시슬래시 | 차단 |
| 경로 순회 (점점) | 차단 |
| 정규식 화이트리스트 미매칭 | drop |
| 비로그인인데 마이페이지 링크 | drop |

신규 라우트를 추가하면 화이트리스트 배열에도 등록해야 챗봇이 그 링크를 제시할 수 있다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 챗봇 12단계 파이프라인, fast-path, 1차 분류, 등급 쿼터, IP·유저 차단, URL 화이트리스트가 모두 동작.
- 다국어 응답: 시스템 프롬프트가 사용자 메시지 언어를 감지해 message·quickReplies·label을 같은 언어로 생성. 후보 데이터는 로케일이 ko 외면 번역 캐시를 거침.
- 추천: 체류 로그 기반 관심 태그 추출, 태그 매칭 정렬, 캐시→Gemini→트렌딩 3단 폴백, 잘린 JSON 복구가 동작.
- 대화·메시지·사용량·링크 클릭을 DB에 저장(`CHATBOT_*` 테이블).
:::

:::warning 한계·계획
- **AI 응답 품질의 정량 평가 체계는 아직 없다.** 폴백·검증으로 안전선은 확보했지만 응답 적합도를 수치로 추적하진 않는다(향후 과제).
- 등급별 쿼터 수치는 `CHATBOT_GRADE_QUOTA` 테이블에서 관리자가 조정하는 값이다(코드 하드코딩 아님). 등급 체계는 GUEST/BRONZE/SILVER/GOLD/DIAMOND/PLATINUM.
- 추천의 Gemini 호출은 무상태 단발 호출(멀티턴 대화 아님). 멀티턴은 별도 GPT 어시스턴트가 담당.
:::

## 6. 면접 답변 3단계

1. **한 문장**: "Gemini 2.5 Flash로 사이트 안내 챗봇과 여행지 개인화 추천을 만들었고, 두 기능 모두 LLM 출력을 시스템이 검증하도록 설계했습니다."
2. **설계 의도**: "챗봇은 fast-path와 의도 분류로 불필요한 LLM 호출을 줄이고, 응답 링크는 URL 화이트리스트로 검증합니다. 추천은 체류 로그로 관심 태그를 뽑아 후보를 점수화한 뒤 LLM이 그 안에서 고르게 했습니다. LLM은 보조이고 결정권은 시스템이 갖습니다."
3. **트레이드오프**: "Flash로 비용·지연을 줄이는 대신 응답 품질을 정량 평가하는 체계는 아직 없어서, 폴백과 화이트리스트로 최악의 출력을 막는 방식으로 보완했습니다."

## 7. 꼬리질문 + 모범답안

:::details LLM이 만든 링크를 그대로 믿지 않는 이유는?
환각으로 존재하지 않는 경로나 위험 스킴(javascript: 등)을 만들 수 있기 때문입니다. `isAllowedInternalUrl`에서 위험 스킴·protocol-relative·경로 순회를 먼저 차단하고, 정규식 화이트리스트에 매칭되는 내부 경로만 통과시킵니다. 비로그인 사용자에게는 마이페이지 링크를 추가로 제거합니다.
:::

:::details 토큰·쿼터를 어떻게 절약했나요?
세 겹의 게이트로 막습니다. 15자 이하 단순 네비게이션은 키워드 매칭만으로 즉답하는 fast-path가 처리하고, 그다음 짧은 분류 호출(쿼터 미소모)로 의도를 뽑아 부적절 메시지는 본 호출 전에 안전 응답으로 끊습니다. 본 호출까지 도달하는 메시지만 쿼터를 1 소모합니다.
:::

:::details 추천에서 LLM 환각을 어떻게 막았나요?
Gemini에게는 미리 만든 후보 집합과 각 후보의 `spot_idx`만 보여주고 그 안에서만 고르라고 지시합니다. 저장 단계에서 후보에 없는 `spot_idx`는 버리고, 결과가 부족하면 트렌딩 폴백으로 채웁니다. 응답이 잘려도 완성된 JSON 객체만 파싱하는 복구 로직이 있습니다.
:::

:::details 외국어 사용자가 파리를 영어로 물으면 어떻게 매칭되나요?
1차 분류 프롬프트가 키워드를 한국어로 정규화합니다(Paris→파리, 東京→도쿄). DB 원본 텍스트가 한국어라 정규화 없이는 LIKE 검색이 비어버립니다. 응답 본문은 반대로 사용자 언어로 생성하고, 후보 데이터는 번역 캐시를 거쳐 보여줍니다.
:::

:::details Gemini가 5xx를 던지거나 안전 필터로 응답이 비면?
챗봇은 `fallbackResponse`(탐색·도우미·커뮤니티 링크가 붙은 안내)를 반환하고, 안전 필터로 `content`가 비면 `safetyBlockedResponse`를 반환합니다. 추천은 후보가 없거나 Gemini 결과가 비면 트렌딩 여행지로 폴백합니다. 어떤 경우에도 빈 화면이 나오지 않습니다.
:::

## 8. 직접 말해보기

- 챗봇이 사용자 메시지를 받고 응답을 돌려주기까지 12단계를 순서대로 말해보세요. 각 단계가 왜 그 위치에 있는지도.
- fast-path, 1차 분류, 본 호출 이 세 가지가 각각 무엇을 절약하는지 구분해 설명해보세요.
- 추천 우선순위 점수의 네 항목(현재 겹침·태그 매칭·프로필 가중치·방문 감점)을 왜 이 가중치 순서로 두었는지 말해보세요.
- LLM 출력의 신뢰 경계를 어디에 그었는지, 즉 무엇은 LLM에 맡기고 무엇은 시스템이 결정하는지 정리해보세요.

관련 문서: [다중 AI 모델 통합](/ai/multi-model) · [구조화 출력](/ai/structured-outputs) · [폴백 전략](/ai/fallback-strategy) · [의도 분류·Fast-Path](/assistant/intent-fastpath) · [등급별 쿼터](/assistant/quota-grade) · [URL 화이트리스트 보안](/assistant/url-whitelist) · [AI 추천(Gemini)](/explore/ai-recommendation-gemini) · [추천 캐시·폴백](/explore/recommendation-cache-fallback)

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether 챗봇이 단순 네비게이션 요청(예: 커뮤니티 어디야)을 처리하는 방식은?" :choices="['항상 Gemini 본 호출을 한다', '15자 이하면 fast-path가 LLM 없이 즉답한다', '관리자에게 전달한다', '무조건 차단한다']" :answer="1" explanation="ChatbotFastPathService가 15자 이하 단순 요청을 키워드 매칭으로 즉답해 LLM 호출과 쿼터 소모를 아낀다." />

<QuizBox question="Gemini가 응답에 넣은 내부 링크 URL을 검증하는 isAllowedInternalUrl이 차단하지 않는 것은?" :choices="['javascript 같은 위험 스킴', '점점이 들어간 경로 순회', '화이트리스트에 등록된 내부 경로', 'protocol-relative 슬래시슬래시 시작']" :answer="2" explanation="위험 스킴·경로 순회·protocol-relative는 모두 차단하고, 정규식 화이트리스트에 매칭되는 내부 경로만 통과시킨다." />

<QuizBox question="여행지 추천에서 LLM 환각으로 잘못된 spot_idx가 추천돼도 사용자에게 도달하지 못하는 이유는?" :choices="['Gemini가 절대 틀리지 않아서', '후보 집합에 없는 spot_idx는 저장 단계에서 버리고 부족하면 트렌딩으로 채워서', '추천 기능이 Mock이라서', '관리자가 매번 검수해서']" :answer="1" explanation="RecommendService는 미리 만든 후보의 spot_idx만 유효로 인정하고, 결과가 부족하면 트렌딩 폴백으로 정확히 3개를 채운다." />
