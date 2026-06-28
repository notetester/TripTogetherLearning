---
title: "의도 분류·Fast-Path"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["의도분류", "FastPath"]
---

# 의도 분류·Fast-Path

> 네비 챗봇은 LLM에 닿기 전에 두 겹의 게이트를 둔다. 규칙 기반 Fast-Path가 단순 요청을 즉답하고, 1차 의도 분류가 메시지를 카테고리로 쪼개 부적절 요청은 본 호출 없이 막는다. 둘 다 목적은 같다 — 토큰과 지연을 아끼면서 답변 정확도를 올린다.

## 1. 한 줄 정의

사용자 메시지가 메인 LLM 호출에 도달하기 전, `ChatbotFastPathService`(규칙 기반 즉답)와 `IntentContextService.classify`(경량 LLM 의도 분류)가 차례로 걸러내는 **2단계 전처리 게이트**다.

## 2. 왜 이렇게 설계했나

네비게이션 챗봇 트래픽의 상당수는 패턴이 뻔하다. 로그인 페이지로 보내줘, 커뮤니티 어디야, 안녕 같은 짧은 요청에 매번 `gemini-2.5-flash` 본 호출(시스템 프롬프트 + 멀티턴 히스토리 + 실시간 후보 데이터까지 동봉, `maxOutputTokens=1024`)을 태우는 것은 낭비다.

설계 의도는 세 가지다.

- **비용·지연 절감**: 단순 요청은 LLM을 아예 건너뛰고(Fast-Path), 복잡한 요청도 본 호출 전에 의도를 미리 파악해 불필요한 컨텍스트를 줄인다.
- **정확도 향상**: 의도 분류로 메시지를 `EXPLORE / COURSES / PACKAGES / COMMUNITY`로 나눈 뒤, 그 키워드로 DB를 조회해 **실시간 후보 데이터**를 본 호출 프롬프트에 주입한다. 환각 대신 실제 존재하는 spotIdx·planId·postId를 쥐어준다.
- **안전 단락(short-circuit)**: 욕설·잡담·개인정보 요구는 분류 단계에서 `INAPPROPRIATE`로 잡아, 본 LLM 호출 없이 안전 응답으로 끝낸다. 토큰을 한 번 더 아끼면서 가드레일도 앞당긴다.

:::tip 두 단계의 역할이 다르다
Fast-Path는 **결정적(deterministic)** — 키워드 `contains` 매칭이라 LLM이 0회. 의도 분류는 **확률적이되 경량** — Gemini를 짧게(`temperature=0`, `maxOutputTokens=256`) 호출하고, 실패하면 규칙 기반으로 떨어진다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 클래스 / 위치 | 역할 |
| --- | --- | --- |
| Fast-Path 즉답 | `ChatbotFastPathService.resolveOrNull` | 15자 이하 단순 네비 요청을 LLM 없이 즉답 |
| 1차 의도 분류 | `IntentContextService.classify` | Gemini 경량 호출로 의도·키워드 추출, 실패 시 규칙 fallback |
| 분류 결과 VO | `ChatIntentVO` | intent(6종 상수) + keywords + relatedTerms |
| 컨텍스트 빌더 | `IntentContextService.buildContextSection` | 키워드로 DB 조회 후 프롬프트 섹션 생성 |
| 오케스트레이터 | `ChatbotService.ask` | Fast-Path → 분류 → 부적절 단락 → 본 호출 순서 제어 |
| 응답 모델 | `ChatbotResponseVO` | message / links / quickReplies / inappropriate |

분류·즉답 모두 `common` 모듈에 있고, DB 조회는 도메인 매퍼(`ExploreMapper.searchSpotsByKeywords`, `TravelPlanMapper.searchPlansByKeywords`, `TravelPackageMapper.searchPackagesByKeywords`, `CommunityMapper.searchPostsByKeywords`)를 통해 모듈 경계를 넘지 않고 위임한다. 메시지·링크 라벨은 전부 `messages/chatbot_*.properties`에서 로드해 다국어를 지원한다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 전체 순서 (`ChatbotService.ask`)

```text
요청 → 차단 체크 → 등급 쿼터 → 대화 조회/생성 → 유저 메시지 저장
   ├─ [5.5] Fast-Path 매칭?  ── yes ─→ 즉답 저장 후 반환 (LLM 0회)
   │                            no
   ├─ [6.5] 의도 분류 classify (경량 Gemini, 실패 시 규칙)
   ├─ [6.6] intent == INAPPROPRIATE?  ── yes ─→ 안전 응답 반환 (본 호출 생략)
   │                                     no
   └─ [7] 본 Gemini 호출 (분류 의도 + 실시간 후보 데이터 주입)
```

### Fast-Path — 결정적 키워드 매칭

15자 초과면 즉시 통과시킨다(복합 의도는 LLM 몫). 로그인 여부에 따라 분기하고, 한국어·영어·일본어·중국어 키워드를 함께 본다.

```java
// ChatbotFastPathService
String m = userMessage.trim().toLowerCase().replaceAll("\\s+", " ");
if (m.isEmpty() || m.length() > MAX_LEN) return null;   // MAX_LEN = 15
if (m.contains(로그인) || m.contains(login) || m.contains(sign in)) {
    return loggedIn ? 마이페이지_안내 : 로그인_회원가입_링크;
}
// 홈 / 커뮤니티 / 탐색 / 코스 / 패키지 / AI도우미 / 마이페이지 / 문의 / 인사 ...
return null;   // 매칭 실패 → 기존 LLM 파이프라인으로
```

매칭되면 `ChatbotResponseVO`를 직접 만들어 반환하므로 토큰 소모가 0이다. `null`을 반환하면 그대로 다음 단계로 흘러간다.

### 의도 분류 — 경량 LLM + 규칙 fallback

분류 전용 시스템 프롬프트는 매우 짧고 결정적이다. JSON만 출력하도록 강제하고, 6개 카테고리로 라벨링한다.

| intent | 의미 | 예시 |
| --- | --- | --- |
| EXPLORE | 여행지 자체 탐색 | 도쿄 가볼 만한 곳 |
| COURSES | 일정·코스·루트 | 부산 2박3일 코스 |
| PACKAGES | 판매 상품·가격·예약 | 제주 패키지 얼마야 |
| COMMUNITY | 후기·팁·유저 경험 | 오사카 후기 보여줘 |
| GENERIC | 그 외 여행 관련 일반 | 사이트 이용법 |
| INAPPROPRIATE | 욕설·잡담·개인정보 요구 | 주식·정치·연예인 |

키워드는 **한국어로 정규화**하도록 지시한다 — DB 원본 언어가 한국어라 Paris는 파리로, Kyoto는 교토로 바꿔야 LIKE 매칭이 된다. 호출은 `temperature=0`으로 결정성을 높이고, 동일 메시지는 `ConcurrentHashMap` 캐시(TTL 60초, 상한 500건)로 재분류를 막는다.

분류 호출이 실패·타임아웃하면 예외를 삼키고 규칙 기반으로 떨어진다 — 불용어 사전(`STOPWORDS`)으로 토큰을 거른 뒤 intent는 `GENERIC`으로 둔다. 챗봇이 죽지 않는다.

### 부적절 단락 — 토큰 절감의 핵심

```java
ChatIntentVO intent = intentContextService.classify(request.getMessage());
if (intent.isInappropriate()) {
    conversationService.markInappropriate(userMsg.getMessageId());
    return finalizeAndRespond(... safetyBlockedResponse() ...);  // 본 호출 생략
}
```

분류 단계에서 이미 부적절로 판정되면, 1024토큰짜리 본 호출을 띄우지 않고 `chatbot.resp.safetyBlocked` 메시지로 끝낸다. 메시지는 DB에 `is_inappropriate`로 마킹되어 관리자 모니터링에 잡힌다.

### 컨텍스트 주입 — 분류가 정확도에 기여하는 부분

분류가 GENERIC/INAPPROPRIATE를 넘기면, 키워드+관련어를 합쳐(`combineKeywords`, 최대 8개) 4개 도메인 매퍼를 안전 조회한다. 각 조회는 try-catch로 감싸 일부 실패해도 빈 리스트로 진행한다. 매칭된 후보(spotIdx·planId·packageIdx·postId)는 본 호출 시스템 프롬프트의 실시간 후보 데이터 섹션으로 들어가, LLM이 **실재하는 id로만** 링크를 만들도록 유도한다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Fast-Path 키워드 즉답 (다국어 일부) | 구현됨 |
| 경량 Gemini 의도 분류 + 규칙 fallback | 구현됨 |
| 분류 결과 60초 캐시 | 구현됨 |
| INAPPROPRIATE 부적절 단락 (본 호출 생략) | 구현됨 |
| 의도 키워드 기반 실시간 후보 데이터 주입 | 구현됨 |
| EXPLORE 시 관련 패키지 링크 자동 부착 | 구현됨 |
| 분류 정확도 정량 평가 체계 | 미구현 (향후 과제) |

:::warning 분류는 LLM 판단이라 100%가 아니다
Fast-Path는 키워드가 빠르되 동음이의·오타에 약하고, 의도 분류는 모델 응답이라 오분류 가능성이 남는다. 그래서 두 단계 어느 쪽도 단독으로 사용자에게 직접 노출되는 결정을 내리지 않는다 — Fast-Path는 안내 링크만, 분류는 본 호출 프롬프트를 보강할 뿐이다. INAPPROPRIATE 단락만 사용자 응답을 바꾸는데, 이 경우 보수적으로(차단 쪽으로) 동작한다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: 챗봇은 LLM 본 호출 앞에 Fast-Path와 의도 분류 두 단계를 둬서, 단순 요청은 즉답하고 부적절 요청은 본 호출 없이 막습니다.
2. **메커니즘**: Fast-Path는 15자 이하 메시지를 키워드 매칭으로 즉답해 토큰을 0으로 만들고, 의도 분류는 경량 Gemini로 메시지를 6개 카테고리와 한국어 키워드로 쪼갭니다. INAPPROPRIATE면 본 호출을 생략하고, 나머지는 키워드로 DB를 조회해 실재하는 후보 데이터를 본 프롬프트에 주입합니다.
3. **트레이드오프**: 분류용 LLM 호출이 한 번 더 늘지만 `temperature=0`·256토큰·60초 캐시로 비용을 억제했고, 실패 시 규칙 기반으로 떨어져 가용성을 지킵니다. 그 대가로 본 호출 토큰을 아끼고 환각 링크를 줄였습니다.

## 7. 꼬리질문 + 모범답안

:::details 분류 호출 자체가 비용인데 왜 LLM을 또 쓰나
규칙만으로는 EXPLORE와 COURSES, PACKAGES를 안정적으로 가르기 어렵습니다. 분류 호출은 256토큰·temperature 0로 매우 가볍고 60초 캐시가 있어 비용이 작은 반면, 본 호출 프롬프트를 의도에 맞게 좁히고 부적절 요청을 단락시켜 1024토큰 본 호출을 통째로 절약하므로 순비용이 줄어듭니다. 그리고 실패하면 규칙 fallback이라 다운사이드가 제한적입니다.
:::

:::details Fast-Path와 의도 분류가 충돌하면
충돌하지 않습니다. Fast-Path가 먼저 실행되고 매칭되면 즉시 반환하므로 분류 단계까지 가지 않습니다. 분류는 Fast-Path가 null을 반환한 메시지, 즉 단순 네비가 아닌 복합 요청에 대해서만 돌아갑니다. 두 단계는 직렬이고 책임이 겹치지 않습니다.
:::

:::details 키워드를 왜 한국어로 정규화하나
사이트 DB 원본 텍스트가 한국어라 매퍼가 한국어 컬럼에 LIKE 검색을 겁니다. 사용자가 Paris나 東京로 물어도 키워드가 파리·도쿄로 정규화돼야 후보가 매칭됩니다. 분류 시스템 프롬프트에 도시명·관광지명을 한국어 표기로 바꾸라고 명시했습니다.
:::

:::details 분류가 오분류하면 사용자 경험이 깨지지 않나
대부분의 경우 깨지지 않습니다. 분류 결과는 본 호출 프롬프트에 후보 데이터를 더 넣을지 말지를 결정할 뿐, 최종 응답은 본 LLM이 만듭니다. 후보가 비면 일반 list 페이지 링크로 폴백하도록 프롬프트에 지시했습니다. 다만 INAPPROPRIATE 오분류는 정상 질문을 막을 수 있어, 이 카테고리만 기준을 보수적으로 좁게 잡았습니다.
:::

:::details 분류 캐시를 ConcurrentHashMap으로 둔 이유와 한계
단일 인스턴스에서 동일 메시지의 60초 내 재분류만 막으면 충분하다고 봤고, 외부 캐시 의존성을 늘리지 않으려 했습니다. 상한 500건 초과 시 전체 clear라 정교하진 않습니다. 다중 인스턴스로 스케일아웃하면 인스턴스별 캐시라 적중률이 떨어지므로, 그 시점엔 분산 캐시로 교체하는 것이 맞습니다.
:::

## 8. 직접 말해보기

- Fast-Path와 의도 분류의 목적이 같은가 다른가, 한 문장으로 구분해 설명해 보세요.
- 사용자가 영어로 도쿄를 물었을 때 후보 데이터가 매칭되는 전체 경로를 키워드 정규화 관점에서 짚어 보세요.
- INAPPROPRIATE 단락이 토큰을 아끼는 동시에 위험을 줄이는 이유를 한 호흡에 말해 보세요.

더 보기: [AI 어시스턴트·챗봇 개요](/assistant/) · [네비 챗봇(Gemini)](/assistant/chatbot-gemini) · [구조화 JSON 응답](/assistant/structured-json) · [등급별 쿼터](/assistant/quota-grade) · [URL 화이트리스트 보안](/assistant/url-whitelist) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="ChatbotFastPathService가 LLM 호출 없이 즉답하는 대상 메시지의 기준은?" :choices="['길이 15자 이하의 단순 네비게이션 요청', '모든 로그인 사용자 요청', '욕설이 포함된 모든 요청', '길이 100자 이상의 긴 요청']" :answer="0" explanation="MAX_LEN 15자 이하의 짧은 네비 요청만 키워드 매칭으로 즉답하고, 그보다 길거나 복합 의도면 null을 반환해 LLM 파이프라인으로 넘긴다." />

<QuizBox question="의도 분류 결과가 INAPPROPRIATE일 때 ChatbotService가 하는 동작은?" :choices="['본 Gemini 호출을 그대로 진행한다', '본 호출을 생략하고 안전 응답을 반환하며 메시지를 부적절로 마킹한다', '사용자를 즉시 차단한다', '대화를 삭제한다']" :answer="1" explanation="분류 단계에서 부적절로 판정되면 1024토큰짜리 본 호출을 생략하고 safetyBlockedResponse를 반환하며, 메시지를 is_inappropriate로 마킹해 모니터링에 노출한다. 토큰 절감과 가드레일을 동시에 얻는다." />

<QuizBox question="의도 분류가 키워드를 한국어로 정규화하도록 지시하는 이유는?" :choices="['응답 속도를 높이려고', '사이트 DB 원본 언어가 한국어라 LIKE 검색 매칭을 위해', '토큰을 줄이려고', '다국어 응답을 막으려고']" :answer="1" explanation="DB 원본 텍스트가 한국어이고 매퍼가 한국어 컬럼에 LIKE 검색을 걸기 때문에, Paris는 파리, Tokyo는 도쿄로 정규화해야 후보 데이터가 매칭된다." />
