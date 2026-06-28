---
title: "AI 도우미·챗봇 면접 플레이북"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["면접"]
---

# AI 도우미·챗봇 면접 플레이북

> 이 페이지는 TripTogether의 대화형 AI(멀티턴 어시스턴트 + 네비게이션 챗봇)를 면접에서 1분·3분·꼬리질문까지 막힘없이 설명하기 위한 대본이다. 모델 두 개를 왜 갈랐는지, 비싼 LLM 호출을 어떻게 줄였는지, AI 출력의 링크를 왜 신뢰하지 않는지 — 이 세 축으로 답을 짠다.

## 1. 한 줄 정의

대화형 AI를 두 갈래로 나눴다. 깊은 여행 상담은 OpenAI GPT-4o-mini 멀티턴(`AssistantServiceImpl`), 사이트 어디서나 떠 있는 안내 챗봇은 Google Gemini 2.5 Flash 구조화 JSON(`ChatbotService`). 두 호출 모두 앞뒤에 쿼터·의도분류·fast-path·모더레이션·URL 화이트리스트라는 운영 레이어를 둔다.

## 2. 왜 이렇게 설계했나 (면접에서 가장 자주 파고드는 지점)

면접관이 듣고 싶은 것은 "AI를 붙였다"가 아니라 "AI라는 비싸고 불안정한 외부 의존성을 어떻게 길들였나"다. 네 가지 설계 결정을 이유와 함께 말한다.

- **왜 모델을 둘로 나눴나.** 긴 상담은 멀티턴 맥락 유지와 답변 품질이 핵심이라 GPT-4o-mini로, 사이트 안내는 구조화 JSON 출력과 속도·비용이 핵심이라 Gemini 2.5 Flash로 갈랐다. 하나의 모델로 두 작업을 강제하지 않고 각 작업의 제약에 맞췄다.
- **왜 fast-path인가.** 사용자 질문의 상당수는 커뮤니티 어디예요, 로그인 같은 단순 네비게이션이다. 이런 것까지 LLM에 보내면 돈과 지연만 늘어난다. `ChatbotFastPathService`가 15자 이하 짧은 요청을 키워드로 매칭해 LLM 호출 없이 즉답한다.
- **왜 구조화 JSON인가.** 챗봇 응답은 화면에 그냥 텍스트로 뿌리는 게 아니라 메시지 + 링크 버튼 + 빠른답변 칩으로 렌더링된다. 자유 텍스트를 파싱하는 대신 Gemini의 `responseMimeType=application/json`으로 JSON을 강제해, 프론트가 안정적으로 UI를 그릴 수 있게 했다.
- **왜 URL 화이트리스트인가.** LLM은 존재하지 않는 경로나 위험한 스킴을 링크로 만들어 낼 수 있다. AI 출력을 신뢰 경계 밖의 입력으로 취급해, 서버가 허용 경로 패턴으로 검증하고 통과 못 한 링크는 버린다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 멀티턴 어시스턴트 | 네비게이션 챗봇 |
| --- | --- | --- |
| 모델 | OpenAI GPT-4o-mini | Google Gemini 2.5 Flash |
| 진입점 | `AssistantController` (`/assistant`) | `ChatbotController` |
| 서비스 | `AssistantServiceImpl` | `ChatbotService.ask` |
| 보조 서비스 | `AssistantMapper` | `ChatbotQuotaService`, `IntentContextService`, `ChatbotFastPathService`, `ChatbotBlockService`, `ConversationService` |
| 주요 테이블 | `CHAT_POST`, `CHAT_COMMENT` | `CHATBOT_QUOTA`, 대화/메시지 테이블, `CHATBOT_BLOCK`, 링크클릭 로그 |
| 패키지 | `org.triptogether.assistant.**` | `org.triptogether.common.service.Chatbot*` |

- 챗봇이 `common`에 있는 이유: 전 페이지에서 떠 있는 전역 위젯이기 때문. 어시스턴트는 `/assistant` 전용 화면이라 별도 도메인 패키지다.
- 외부 호출은 둘 다 `RestTemplate` + Gson 직렬화/`JsonParser` 파싱. 키는 `@Value`로 `openai.api.key` / `gemini.api.key`에서 주입한다.
- 같은 프로젝트에는 코스 도메인의 AI 일정 생성기(GPT Structured Outputs), 탐색의 Gemini 추천, 문의의 Claude Haiku 초안 등 다른 AI도 있지만, 이 도메인은 대화형 AI만 다룬다.

## 4. 동작 원리 — 챗봇 `ask` 파이프라인 (핵심 암기 대상)

면접에서 "비싼 LLM 호출을 어떻게 줄였나"를 물으면 이 12단계 중 단축 경로(5.5·6.6)를 짚는다.

```text
ChatbotService.ask(request, loginUser, anonSessionId, ipAddress)
 1. 차단 체크(IP + USER)          → 차단이면 즉시 blockedResponse
 2. 등급 쿼터 조회(resolveGrade)
 3. 주기 사용량 한도 체크          → 초과면 quotaExceededResponse
 4. 대화 조회/신규생성(소유권·대화수 한도)
 5. 유저 메시지 저장
 5.5 fast-path 매칭               → 히트면 LLM 생략하고 즉답  ← 단축 1
 6. 최근 N개 히스토리 로드
 6.5 1차 의도분류(classify)        → 의도·키워드 추출(쿼터 미소모)
 6.6 분류 결과 부적절이면 본 호출 생략 → safetyBlockedResponse  ← 단축 2
 7. Gemini 본 호출(구조화 JSON 강제)
 7.5 EXPLORE 의도면 관련 패키지 링크 자동 부착
 8. 응답 부적절 플래그 처리
 9. assistant 메시지 저장
 10. 대화 활동 시각 touch
 11. 사용량 +1 (면제자 제외, 비로그인은 IP 기준)
 12. conversationId / messageId 부착해 반환
```

:::tip 왜 `ask`에 @Transactional을 안 걸었나
외부 Gemini 호출이 끝날 때까지 DB 커넥션을 잡고 있으면 커넥션 풀이 고갈된다. 그래서 `ask` 전체에는 트랜잭션을 걸지 않고, 메시지 저장·사용량 증가 같은 짧은 DB 작업만 각 내부 서비스가 자체 트랜잭션으로 처리한다. 어시스턴트 쪽 `chat`은 외부 호출 + 짧은 저장이 한 묶음이라 메서드 단위 `@Transactional`을 쓴다 — 같은 원칙(긴 외부 호출 동안 DB를 점유하지 않기)을 두 모듈이 반대 방향으로 적용한 셈이다.
:::

### 멀티턴 어시스턴트 한 턴

```text
사용자 메시지 + history(최대 20턴) + 언어(ko/en/ja/zh)
  → buildSystemPrompt(lang): 언어별 system 프롬프트
  → messages = system + history + 신규 user
  → OpenAI Chat Completions 호출(temperature 0.7)
  → 응답 추출 → history에 추가 → MAX_HISTORY 초과분 앞에서 제거
  → 로그인 시 CHAT_POST(없으면 생성) + CHAT_COMMENT(USER/ASSISTANT) 저장
```

핵심: 모델은 무상태다. 맥락은 서버가 세션(비로그인)·DB(로그인)에 보관했다가 매 호출 `messages` 배열로 다시 넣는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- GPT-4o-mini 멀티턴 상담, 4개국어 시스템 프롬프트, 히스토리 DB 저장(`CHAT_POST`/`CHAT_COMMENT`), `MAX_HISTORY=20` 슬라이딩
- Gemini 구조화 JSON 챗봇, 1차 의도분류(+규칙 기반 fallback, 60초 캐시), fast-path 즉답, 등급 쿼터(DB 주입), IP·유저 차단, URL 화이트리스트
- 실시간 후보 데이터 주입(`IntentContextService.buildContextSection`): 키워드로 여행지·코스·패키지·게시글을 DB 조회해 프롬프트에 끼워 넣어 실제 존재하는 id로만 링크 생성
:::

:::warning 미흡 / 계획
- AI 응답 품질의 정량 평가 체계가 없다. 정확도·환각률을 수치로 측정하지 않는다(향후 과제).
- 멀티턴 어시스턴트는 단건 응답이라 타이핑 스트리밍이 없다.
- 키는 설정/환경변수로 주입하는 구조이며, 본 자료의 모든 키·호스트는 자리표시자(API_KEY, DB_HOST)다.
:::

:::warning 코드 정직성 메모
현재 `AssistantServiceImpl`에는 주입 키 대신 클래스에 박힌 테스트 키로 Bearer 헤더를 세팅하는 부분이 남아 있고, 키 공백 가드 분기와 실제 호출이 보는 키가 어긋나 있다. 키 외부화·일원화는 운영 전 정리 대상이며, 학습 페이지에는 실제 키 값을 절대 싣지 않는다. 면접에서 이 점을 먼저 솔직히 언급하면 보안 감수성을 보여 줄 수 있다.
:::

## 6. 면접 답변 3단계

### 1분 버전

"TripTogether의 대화형 AI는 두 갈래입니다. 깊은 여행 상담은 GPT-4o-mini 멀티턴 어시스턴트, 사이트 안내는 Gemini 2.5 Flash 구조화 JSON 챗봇입니다. LLM은 비싸고 느리고 신뢰할 수 없는 외부 의존성이라, 호출 앞뒤로 쿼터·의도분류·fast-path·모더레이션·URL 화이트리스트라는 운영 레이어를 뒀습니다. 그 결과 모든 질문이 본 LLM 호출까지 가지 않습니다."

### 3분 버전 (한 단계씩 펼치기)

1. **모델 분리.** "긴 상담은 멀티턴 맥락이, 사이트 안내는 구조화 출력과 속도가 중요해 GPT와 Gemini로 갈랐습니다. 챗봇 응답은 메시지·링크·빠른답변으로 렌더링되니 Gemini에 JSON을 강제했습니다."
2. **비용 통제.** "단순 네비 질문은 fast-path로 LLM을 생략하고, 1차 의도분류에서 부적절 판정이 나면 본 호출 없이 안전 응답을 돌립니다. 등급별 쿼터로 주기당 메시지 수도 제한합니다. 비싼 본 호출에 도달하는 트래픽 자체를 줄인 겁니다."
3. **안전.** "AI가 만든 링크는 서버가 화이트리스트로 검증하고, javascript data file 같은 위험 스킴과 경로 순회는 차단합니다. 또 실시간 DB 후보를 프롬프트에 주입해 존재하지 않는 id 링크를 만들지 못하게 했습니다."

## 7. 예상 질문 + 모범답안 (12개)

:::details 1. 왜 어시스턴트는 GPT, 챗봇은 Gemini로 모델을 나눴나
긴 멀티턴 상담은 맥락 유지와 답변 품질이 중요해 GPT-4o-mini를, 사이트 안내는 구조화 JSON과 속도·비용이 중요해 Gemini 2.5 Flash를 택했습니다. 목적이 다른 두 작업에 같은 모델을 강제하지 않고 각 강점에 맞췄습니다. 둘 다 RestTemplate로 호출하고 Gson으로 직렬화·파싱하는 구조라 클라이언트 코드 패턴은 비슷합니다.
:::

:::details 2. 비싼 LLM 호출을 어떻게 줄였나
세 단계입니다. 첫째 fast-path: 15자 이하 단순 네비 질문은 키워드 매칭으로 LLM 없이 즉답합니다. 둘째 1차 의도분류: 부적절 판정이면 본 호출을 생략하고 안전 응답을 돌립니다. 셋째 등급별 쿼터: 주기당 메시지 수를 제한합니다. 핵심은 비싼 본 호출에 도달하는 트래픽 자체를 줄였다는 점입니다.
:::

:::details 3. 의도분류도 LLM을 쓰는데 그건 비싸지 않나
분류는 Gemini를 매우 짧게(temperature 0, maxOutputTokens 256) 호출해 intent·keywords·relatedTerms만 받습니다. 본 응답 생성보다 훨씬 가볍고, 동일 메시지는 60초간 캐시해 중복 분류를 막습니다. 게다가 호출이 실패하면 규칙 기반 토큰화·불용어 제거 fallback으로 키워드를 뽑아 본 호출은 계속 진행되므로, 분류 단계가 단일 실패점이 되지 않습니다.
:::

:::details 4. LLM이 만든 링크를 어떻게 신뢰하나
신뢰하지 않습니다. 챗봇 응답의 모든 링크 url을 서버가 허용 경로 화이트리스트 정규식으로 검증하고, 위험 스킴(javascript data file vbscript), 경로 순회(점 두 개), protocol-relative(슬래시 두 개), 슬래시로 시작하지 않는 외부 url을 차단합니다. 통과 못 한 링크는 응답에서 버립니다. 추가로 비로그인 사용자에게는 마이페이지 링크를 제거합니다. AI 출력을 외부 입력처럼 다룹니다.
:::

:::details 5. 챗봇이 존재하지 않는 여행지나 코스를 추천하면 어떻게 막나
환각 링크를 막으려고 실시간 후보 데이터를 프롬프트에 주입합니다. IntentContextService가 분류된 키워드로 여행지·코스·패키지·게시글을 DB에서 조회해, 실제 id와 함께 후보 목록을 시스템 프롬프트에 넣고 존재하는 id만 쓰라고 지시합니다. 그래도 모델이 잘못된 경로를 만들면 마지막에 URL 화이트리스트가 한 번 더 걸러 냅니다. 프롬프트 주입과 출력 검증을 이중으로 둔 겁니다.
:::

:::details 6. 등급별 쿼터는 하드코딩인가
아니요. ChatbotQuotaService가 CHATBOT_QUOTA 테이블에서 등급별 한도(주기당 메시지 수, 동시 대화 수, 컨텍스트 메시지 수)를 읽습니다. 비로그인은 GUEST, 등급 정보가 없으면 BRONZE로 폴백하고, ADMIN·SUPERADMIN은 면제입니다. 관리자가 무중단으로 한도를 조정할 수 있습니다.
:::

:::details 7. 비로그인 사용자의 사용량은 무엇을 기준으로 세나
비로그인은 IP 주소를 키로 사용량을 집계합니다. 로그인 사용자는 userIdx 기준입니다. 주기 시작 시각은 고정 앵커에서 periodDays 간격으로 내림 계산해, 사용자별로 같은 주기 경계를 공유하면서도 매 요청마다 새로 계산하지 않게 했습니다.
:::

:::details 8. 멀티턴 대화가 무한히 길어지면 토큰 비용은
어시스턴트는 history를 최대 20턴으로 제한하고 초과분을 앞에서 제거하는 슬라이딩 윈도우로 토큰·지연을 통제합니다. 챗봇도 쿼터의 컨텍스트 메시지 수만큼만 최근 히스토리를 로드합니다. 영구 기록은 CHAT_POST·CHAT_COMMENT나 대화/메시지 테이블에 따로 저장하므로, 컨텍스트 윈도우와 영속 저장을 분리한 구조입니다.
:::

:::details 9. GPT는 상태가 없는데 어떻게 이전 대화를 기억하나
모델은 무상태입니다. 기억하는 것은 서버입니다. 직전까지의 대화를 세션(비로그인)이나 DB(로그인)에 보관했다가, 다음 호출 때 system 메시지 뒤에 history를 messages 배열로 다시 붙입니다. 모델은 매번 전체 맥락을 처음 보지만 사용자에게는 대화가 이어지는 것처럼 보입니다.
:::

:::details 10. 다국어 응답은 번역인가
번역이 아닙니다. 어시스턴트는 시스템 프롬프트에서 응답 언어 자체를 모델에 지시해(Always respond in ...) 모델이 그 언어로 직접 생성합니다. 챗봇은 사용자 메시지 언어를 자동 감지해 message·quickReplies·label을 같은 언어로 쓰되 url은 원본 경로를 유지합니다. 기계번역 후처리보다 품질이 높습니다.
:::

:::details 11. Gemini 호출이 실패하거나 안전 필터에 걸리면 사용자는 뭘 보나
응답에 candidates가 없거나 파싱이 깨지면 fallbackResponse를, 안전 필터로 content가 비면 safetyBlockedResponse를 돌립니다. 두 경우 모두 미리 정의한 안전한 링크와 빠른답변이 담긴 정상 형태의 JSON이라 프론트 렌더링이 깨지지 않습니다. 메시지 문자열은 properties에서 로드해 다국어로 나갑니다.
:::

:::details 12. AI 응답 품질은 어떻게 평가하나 (한계 질문)
지금은 정량 평가 체계가 없습니다. 정확도나 환각률을 수치로 측정하지 않고, 프롬프트 규칙·후보 데이터 주입·출력 검증으로 품질을 통제하는 수준입니다. 향후 과제로는 응답 샘플에 대한 정답·환각 라벨링과 회귀 테스트, 부적절 분류의 정밀도·재현율 측정을 두고 있습니다. 한계를 인지하고 있다는 점을 명확히 말하는 게 중요합니다.
:::

## 8. 직접 말해보기

- 챗봇 `ask` 12단계에서 본 LLM 호출(7단계)에 도달하기 전에 응답이 끝날 수 있는 모든 경우를 단계 번호로 말해 보라.
- 모델을 GPT와 Gemini로 나눈 이유를, 두 작업의 제약(맥락 유지 vs 구조화 출력)을 들어 30초로 설명해 보라.
- 챗봇이 반환한 링크가 화이트리스트·위험 스킴·경로 순회 검사를 어떻게 통과하는지, 그리고 그 앞단에서 프롬프트가 어떻게 환각 링크를 줄이는지 이중 방어로 설명해 보라.

## 더 깊이 보기

- [AI 어시스턴트·챗봇 개요](/assistant/)
- [멀티턴 어시스턴트(GPT)](/assistant/multiturn-gpt) · [히스토리·DB 저장](/assistant/history-management)
- [네비 챗봇(Gemini)](/assistant/chatbot-gemini) · [구조화 JSON 응답](/assistant/structured-json)
- [의도 분류·Fast-Path](/assistant/intent-fastpath) · [등급별 쿼터](/assistant/quota-grade)
- [차단·모더레이션](/assistant/block-moderation) · [URL 화이트리스트 보안](/assistant/url-whitelist)

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [AI 기능 전체](/ai/)

## 퀴즈

<QuizBox question="네비게이션 챗봇 ask 파이프라인에서 비싼 본 LLM 호출 전에 응답을 끝낼 수 있는 두 단축 경로는?" :choices="['차단 체크와 대화 생성', 'fast-path 즉답과 1차 의도분류 부적절 차단', '쿼터 증가와 활동시각 갱신', '히스토리 로드와 패키지 링크 부착']" :answer="1" explanation="fast-path는 단순 네비 질문을 LLM 없이 즉답하고, 1차 의도분류에서 부적절 판정이 나면 본 호출을 생략하고 안전 응답을 반환한다." />

<QuizBox question="챗봇 응답의 링크를 서버가 처리하는 방식으로 옳은 것은?" :choices="['모든 링크를 그대로 신뢰한다', '화이트리스트로 검증하고 위험 스킴과 경로 순회는 차단하며 통과 못 한 링크는 버린다', '외부 url만 허용한다', '링크를 항상 제거한다']" :answer="1" explanation="ChatbotService는 허용 경로 화이트리스트로 링크를 검증하고 javascript data file 같은 위험 스킴, 경로 순회, protocol-relative를 차단해 통과하지 못한 링크를 버린다." />

<QuizBox question="등급별 쿼터와 한도가 저장되는 위치로 옳은 것은?" :choices="['자바 코드 상수에 하드코딩', 'CHATBOT_QUOTA 테이블에서 조회하고 ADMIN과 SUPERADMIN은 면제', 'application.properties 파일', '세션 속성']" :answer="1" explanation="ChatbotQuotaService가 CHATBOT_QUOTA 테이블에서 등급별 한도를 읽으며 비로그인은 GUEST로 폴백하고 ADMIN과 SUPERADMIN은 쿼터가 면제된다." />
