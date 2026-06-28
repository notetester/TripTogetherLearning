---
title: "네비 챗봇 (Gemini)"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["Gemini", "챗봇"]
---

# 네비 챗봇 (Gemini)

> 사이트 전체를 안내하는 상주 챗봇 트립이. Gemini 2.5 Flash가 사용자 의도를 구조화 JSON으로 응답하면, 서버가 링크를 화이트리스트로 검증해 안전한 네비게이션 버튼으로 변환한다.

이 페이지는 TripTogether의 도메인 챕터다. 전체 지도는 [도메인 전체 개요](/domains), 담당별 묶음은 [담당별 보기](/by-area/), 요청-응답 큰 그림은 [전체 흐름](/flow/)을 참고하라.

## 1. 한 줄 정의

네비 챗봇은 모든 페이지 우하단에 떠 있는 사이트 안내 봇 트립이로, Gemini 2.5 Flash를 호출해 "어디로 가면 되는지"를 메시지 더하기 링크 버튼 더하기 빠른 답변 칩의 구조화 JSON으로 돌려주는 기능이다.

여행 일정을 길게 대화로 짜주는 여행 도우미(OpenAI 기반 assistant)와는 별개다. 챗봇은 짧게 안내하고 링크를 던지는 데 집중한다.

## 2. 왜 이렇게 설계했나

- 자유 텍스트 답변만 주는 챗봇은 사용자를 결국 직접 메뉴를 찾게 만든다. 그래서 응답을 항상 message 더하기 links 더하기 quickReplies 구조로 강제해, 답을 읽는 즉시 클릭으로 이동할 수 있게 했다.
- LLM이 만든 URL을 그대로 믿으면 위험하다. 환각으로 없는 경로를 만들거나, 최악의 경우 javascript: 같은 위험 스킴을 끼울 수 있다. 그래서 서버가 화이트리스트 정규식으로 모든 링크를 사후 검증하고, 통과 못 한 링크는 조용히 버린다.
- 비용과 지연을 줄이려고 LLM을 무조건 부르지 않는다. 홈으로 가줘 같은 단순 요청은 fast-path가 LLM 없이 즉답하고, 부적절 메시지는 사전 분류 단계에서 걸러 본 호출을 생략한다.
- 비로그인 사용자도 써야 한다. 로그인은 세션 속성 loginUser로 판별하고, 비로그인은 HTTP 세션 ID를 익명 키로 써서 대화 소유권과 사용량을 추적한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

핵심은 common 모듈에 모여 있다.

| 구성 | 클래스 / 자원 | 역할 |
| --- | --- | --- |
| 진입점 | `ChatbotController` (`/chatbot/ask` 등) | 세션에서 loginUser·익명세션·IP 추출 후 서비스 위임 |
| 오케스트레이터 | `ChatbotService` | 12단계 처리 흐름, Gemini 본 호출, 링크 검증 |
| 빠른 경로 | `ChatbotFastPathService` | 15자 이하 단순 네비 요청 LLM 없이 즉답 |
| 의도 분류·컨텍스트 | `IntentContextService` | Gemini로 1차 의도 분류, DB 후보를 프롬프트에 주입 |
| 한도 | `ChatbotQuotaService` | 등급별 주기 한도 조회·사용량 증감 |
| 차단 | `ChatbotBlockService` | IP·유저 차단 여부 판정 |
| 응답 VO | `ChatbotResponseVO` (내부 `SiteLink`) | message·links·quickReplies·inappropriate |
| 의도 VO | `ChatIntentVO` | intent·keywords·relatedTerms |

DB 테이블은 모두 CHATBOT 접두어를 쓴다.

| 테이블 | 용도 |
| --- | --- |
| `CHATBOT_CONVERSATION` | 대화 단위, 소프트삭제 is_deleted |
| `CHATBOT_MESSAGE` | user·assistant 메시지, 부적절 플래그 |
| `CHATBOT_GRADE_QUOTA` | 등급별 한도, 주기·리셋시각 설정 |
| `CHATBOT_DAILY_USAGE` | 주기별 사용량 카운트 |
| `CHATBOT_LINK_CLICK` | 챗봇 제시 링크 클릭 이력 |
| `CHATBOT_BLOCK` | IP·유저 차단 목록 |

모델은 Gemini 2.5 Flash 한 종류를 두 번 쓴다. 한 번은 가벼운 의도 분류(temperature 0), 한 번은 안내 본 호출(temperature 0.7). 두 호출 모두 응답 MIME 타입을 application/json으로 강제한다.

## 4. 동작 원리 (흐름·표·작은 코드)

`ChatbotService.ask`의 처리 순서를 따라가면 다음과 같다.

1. 차단 체크 — IP 또는 유저가 차단됐으면 안내 응답 반환
2. 등급 해석·한도 조회 — 비로그인은 GUEST, 로그인은 member_grade
3. 주기 사용량 한도 체크 — 초과 시 안내 응답
4. 대화 조회 또는 신규 생성 — 신규면 대화 수 한도도 확인, 소유권 검증
5. 유저 메시지 저장
6. fast-path 시도 — 단순 네비면 여기서 즉답하고 종료
7. 최근 N개 히스토리 로드 (등급별 max_context_messages)
8. 1차 분류 — Gemini로 의도·키워드 추출 (쿼터 미소모)
9. 부적절 판정이면 본 호출 생략, 안전 응답
10. Gemini 본 호출 — 시스템 프롬프트에 사이트맵·로그인상태·현재 페이지·DB 후보 주입
11. 응답 파싱·링크 화이트리스트 검증·저장
12. 사용량 증가, conversationId·messageId 부착 후 반환

시스템 프롬프트는 정적 사이트맵 표(홈·탐색·코스·도우미·커뮤니티 등 경로 목록)와 응답 JSON 규칙을 고정 텍스트로 담고, 매 호출마다 `buildSystemPrompt`가 실시간 컨텍스트를 덧붙인다.

```text
[고정] 트립이 페르소나 + 사이트맵 표 + 응답 JSON 스키마 규칙
[동적] 로그인 상태: 로그인 중 / 비로그인
[동적] 현재 페이지: 여행지 탐색  (currentPath를 한글 이름으로 변환)
[동적] 실시간 후보 데이터: spotIdx·planId·postId 목록 (의도 분류로 DB 조회)
```

Gemini가 돌려주는 구조화 JSON은 이렇게 생겼다.

```json
{
  "message": "부산 여행이라면 해운대와 감천문화마을 추천드려요!",
  "links": [
    { "label": "해운대 보기", "url": "/detail/42", "icon": "📍" }
  ],
  "quickReplies": ["부산 2박3일 코스", "근처 맛집"],
  "inappropriate": false
}
```

서버는 이 links를 그대로 쓰지 않는다. `isAllowedInternalUrl`이 모든 url을 다음 기준으로 검사한다.

- 슬래시로 시작하는 내부 경로만 허용. 외부 URL·프로토콜 상대 경로(슬래시 두 개 시작)는 거부
- javascript:·data:·file:·vbscript: 위험 스킴 차단
- 점 두 개 경로 순회 차단
- `ALLOWED_URL_PATTERNS` 정규식 목록 중 하나에 정확히 매칭돼야 통과 (예: /detail/숫자, /courses/detail, /community/숫자)

여기에 더해, 비로그인 사용자에게는 /mypage 링크를 따로 제거한다. 통과한 링크만 화면 버튼이 된다.

실시간 후보 주입은 환각 방지의 핵심이다. `IntentContextService`가 의도를 EXPLORE·COURSES·PACKAGES·COMMUNITY·GENERIC·INAPPROPRIATE 중 하나로 분류하고 키워드를 뽑은 뒤, 그 키워드로 ExploreMapper·TravelPlanMapper 등에서 실제 행을 조회해 spotIdx·planId 같은 진짜 id를 프롬프트에 넣는다. 프롬프트에는 존재하지 않는 id는 절대 만들지 마세요라는 지침이 명시돼 있어, LLM이 임의 번호를 지어낼 여지를 줄인다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현된 것
- Gemini 2.5 Flash 의도 분류 더하기 안내 본 호출 2단계 파이프라인
- 구조화 JSON 응답, 링크 화이트리스트·위험 스킴·경로순회 검증
- fast-path 즉답(15자 이하 단순 네비), 부적절 사전 차단
- 등급별 주기 한도·사용량 카운트·대화 소프트삭제 시 쿼터 환급
- 다국어 응답(사용자 메시지 언어 자동 감지), 한국어 외 로케일은 후보 텍스트 번역 캐시 경유
- 링크 클릭 이력 로깅(소유권 검증 후 기록), IP·유저 차단
:::

:::warning 한계·향후 과제
- 응답 품질을 수치로 평가하는 정량 체계가 없다. 부적절 판정은 LLM 자기 보고와 사전 분류에 의존한다.
- 화이트리스트는 코드 상수 배열이라, 새 라우트가 생기면 `ALLOWED_URL_PATTERNS`에 직접 추가해야 한다.
- 사용량·대화 한도의 구체적 수치는 `CHATBOT_GRADE_QUOTA` 행 데이터에 따라 달라진다. 등급별 일일 메시지 한도(예: 게스트·실버·골드·플래티넘 순으로 상향)는 운영 데이터로 설정하는 값이다.
- 모바일은 JSP 데스크톱 레이아웃 위주이며 챗봇 UI도 동일 제약을 받는다.
:::

## 6. 면접 답변 3단계

- 한 문장: 사이트 전역 안내 챗봇으로, Gemini 2.5 Flash가 구조화 JSON으로 답하면 서버가 링크를 화이트리스트로 검증해 안전한 네비게이션 버튼을 만든다.
- 한 단락: 응답을 자유 텍스트가 아니라 message 더하기 links 더하기 quickReplies 구조로 강제해 답을 읽는 즉시 이동할 수 있게 했고, LLM이 만든 URL은 정규식 화이트리스트와 위험 스킴·경로순회 검사로 사후 검증한다. 비용을 줄이려고 단순 네비는 fast-path가 LLM 없이 즉답하고, 부적절 메시지는 가벼운 분류 단계에서 본 호출을 생략한다. 환각 방지를 위해 의도 분류로 뽑은 키워드로 실제 DB 행을 조회해 진짜 id를 프롬프트에 주입한다.
- 깊이: 분류·안내 두 호출 모두 Gemini 2.5 Flash지만 분류는 temperature 0에 출력 토큰을 작게 잡아 결정적으로, 안내는 temperature 0.7로 자연스럽게 운용한다. Gemini 호출 동안 DB 커넥션을 잡지 않으려고 ask에는 일부러 트랜잭션을 걸지 않고, 대화 생성·사용량 증가 같은 내부 작업이 각자 트랜잭션을 갖는다. 안전 필터로 content가 비면 fallback·안전 응답으로 분기한다.

## 7. 꼬리질문 더하기 모범답안

:::details Q1. LLM이 잘못된 링크나 위험한 URL을 만들면 어떻게 막나요?
응답 파싱 시 모든 url을 isAllowedInternalUrl로 검사합니다. 슬래시로 시작하는 내부 경로만 허용하고, javascript:·data:·file: 같은 위험 스킴과 점 두 개 경로 순회, 프로토콜 상대 경로를 거부한 뒤 ALLOWED_URL_PATTERNS 정규식에 매칭돼야만 통과시킵니다. 통과 못 한 링크는 로그만 남기고 조용히 버려서, 사용자에게는 검증된 버튼만 노출됩니다.
:::

:::details Q2. 모든 질문에 LLM을 부르면 느리고 비싸지 않나요?
세 가지로 줄입니다. 첫째 fast-path: 홈으로·로그인 같은 15자 이하 단순 요청은 키워드 매칭으로 LLM 없이 즉답합니다. 둘째 사전 분류: 본 호출 전 가벼운 분류 호출에서 부적절로 판정되면 본 호출을 생략하고 안전 응답을 줍니다. 셋째 캐시: 동일 메시지 분류 결과를 60초간 캐시해 같은 질문의 반복 분류를 막습니다.
:::

:::details Q3. LLM이 없는 여행지 id를 지어내면요?
의도 분류로 뽑은 키워드로 실제 DB(여행지·코스·패키지·커뮤니티)를 조회해 진짜 id를 프롬프트의 실시간 후보 데이터 섹션에 넣고, 존재하지 않는 id는 만들지 말라고 명시합니다. 그래도 안전망으로 서버가 링크 url 형식을 화이트리스트로 다시 검증하므로, 형식이 어긋난 id는 버튼이 되지 못합니다.
:::

:::details Q4. 비로그인 사용자의 대화와 사용량은 어떻게 구분하나요?
로그인 유저는 userIdx로, 비로그인은 HTTP 세션 ID를 익명 키로 씁니다. 대화 소유권은 이 둘 중 하나로 검증하고, 사용량 카운트도 비로그인이면 IP 기준으로 집계합니다. 비로그인에게는 마이페이지 링크를 응답에서 제거하고 로그인·회원가입을 적극 권하도록 프롬프트와 코드 양쪽에서 처리합니다.
:::

:::details Q5. 다국어는 어떻게 처리하나요?
시스템 프롬프트에 사용자 메시지 언어를 감지해 같은 언어로 답하라는 규칙을 넣어, message·quickReplies·라벨을 사용자 언어로 생성합니다. url은 언어와 무관하게 원본 경로를 씁니다. DB 후보 텍스트(여행지명·설명)는 한국어가 원본이라, 로케일이 영어·일본어·중국어면 번역 캐시를 거쳐 프롬프트에 넣습니다.
:::

## 8. 직접 말해보기

- 트립이가 자유 텍스트 대신 구조화 JSON으로 답하는 이유를 30초 안에 설명해보라.
- Gemini가 만든 링크를 서버가 다시 검증하는 단계들을 순서대로 말해보라.
- fast-path·사전 분류·본 호출의 경계가 어디인지, 어떤 입력이 각각으로 가는지 예를 들어 설명해보라.
- 환각으로 없는 여행지 번호가 나오는 것을 막는 두 겹의 방어를 말해보라.

## 퀴즈

<QuizBox question="네비 챗봇이 사용하는 LLM 모델은 무엇인가?" :choices="['OpenAI GPT-4o-mini', 'Google Gemini 2.5 Flash', 'Anthropic Claude Haiku', 'Google Perspective API']" :answer="1" explanation="네비 챗봇 트립이는 의도 분류와 안내 본 호출 모두에 Gemini 2.5 Flash를 사용한다. GPT-4o-mini는 여행 도우미와 AI 일정 생성, Claude Haiku는 문의 답변 초안에 쓰인다." />

<QuizBox question="Gemini가 응답에 넣은 내부 링크를 서버가 처리하는 방식으로 옳은 것은?" :choices="['LLM이 만든 url을 그대로 버튼으로 노출한다', '화이트리스트 정규식과 위험 스킴 검사를 통과한 링크만 버튼으로 만든다', '모든 외부 URL을 새 창으로 연다', '링크는 항상 홈 경로로 고정된다']" :answer="1" explanation="isAllowedInternalUrl이 슬래시로 시작하는 내부 경로만 허용하고 위험 스킴과 경로 순회를 차단한 뒤, ALLOWED_URL_PATTERNS에 매칭되는 링크만 통과시킨다. 통과 못 한 링크는 버려진다." />

<QuizBox question="단순 네비게이션 요청을 LLM 호출 없이 즉답하는 구성 요소는?" :choices="['ChatbotQuotaService', 'ChatbotFastPathService', 'IntentContextService', 'ChatbotBlockService']" :answer="1" explanation="ChatbotFastPathService가 15자 이하의 단순 네비 요청을 키워드 매칭으로 즉답해 LLM 호출과 비용을 절약한다. 매칭되지 않으면 null을 반환해 기존 LLM 파이프라인으로 넘어간다." />
