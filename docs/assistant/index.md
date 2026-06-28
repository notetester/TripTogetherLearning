---
title: "AI 어시스턴트·챗봇 개요"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["AI", "챗봇"]
---

# AI 어시스턴트·챗봇 개요

> TripTogether의 대화형 AI는 두 갈래다. 깊이 있는 멀티턴 여행 상담(GPT-4o-mini)과, 사이트 어디서나 떠 있는 네비게이션 챗봇(Gemini 2.5 Flash). 둘 다 외부 LLM을 직접 호출하면서, 그 앞단에 쿼터·의도분류·fast-path·모더레이션·URL 화이트리스트라는 운영 레이어를 두는 것이 이 도메인의 핵심이다.

## 1. 한 줄 정의

`/assistant`는 대화 히스토리를 기억하는 멀티턴 여행 도우미이고, 전역 챗봇 트립이는 사용자의 자연어를 구조화 JSON(메시지 + 사이트 링크 + 빠른답변)으로 바꿔 사이트를 안내하는 네비게이션 어시스턴트다.

## 2. 왜 이렇게 설계했나

- **목적이 다르면 모델·계층도 분리한다.** 긴 상담은 컨텍스트 윈도우와 멀티턴 품질이 중요해 OpenAI GPT-4o-mini로, 사이트 안내는 구조화 출력과 비용·속도가 중요해 Gemini 2.5 Flash로 갈랐다. 같은 LLM 하나로 다 하지 않는다.
- **LLM은 비싸고 느리고 신뢰할 수 없는 외부 의존성이다.** 그래서 호출 전후로 방어막을 둔다. 쿼터로 남용을 막고, 1차 의도분류로 부적절 질문은 본 호출 없이 차단하며, fast-path로 단순 안내는 LLM 자체를 생략한다.
- **LLM이 만든 링크를 그대로 믿지 않는다.** 챗봇이 응답에 링크를 넣지만, 서버가 화이트리스트로 검증해 존재하지 않는 경로나 `javascript:` 같은 위험 스킴은 버린다. AI 출력은 신뢰 경계 밖의 입력으로 취급한다.
- **DB 우선 운영.** 등급별 한도, 차단 규칙은 코드 상수가 아니라 DB(`CHATBOT_QUOTA` 등)에서 읽어 관리자가 무중단 조정한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 멀티턴 어시스턴트 | 네비게이션 챗봇 |
| --- | --- | --- |
| 모델 | OpenAI GPT-4o-mini | Google Gemini 2.5 Flash |
| 진입점 | `AssistantController` | `ChatbotController` |
| 서비스 | `AssistantServiceImpl` | `ChatbotService` |
| 보조 | `AssistantMapper` | `ChatbotQuotaService`, `IntentContextService`, `ChatbotFastPathService`, `ChatbotBlockService` |
| 주요 테이블 | `CHAT_POST`, `CHAT_COMMENT` | `CHATBOT_QUOTA`, 대화/메시지 테이블, `CHATBOT_BLOCK`, 링크클릭 로그 |

- 패키지 경로: 어시스턴트는 `org.triptogether.assistant.**`, 챗봇은 `org.triptogether.common.service.Chatbot*`. 챗봇이 common에 있는 이유는 전 페이지에서 떠 있는 전역 위젯이기 때문이다.
- 응답 구조 VO: `ChatbotRequestVO`(message, conversationId, currentPath) → `ChatbotResponseVO`(message, links[], quickReplies[], inappropriate). 의도는 `ChatIntentVO`.
- 같은 프로젝트의 또 다른 AI일정 생성기 `AiPlanGPTServiceImpl`(Structured Outputs)은 코스 도메인에 있고, 여기서는 대화형 AI만 다룬다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 멀티턴 어시스턴트 (`AssistantServiceImpl.chat`)

```text
사용자 메시지 + history(최대 20턴) + 언어(ko/en/ja/zh)
  → 언어별 system 프롬프트 생성(buildSystemPrompt)
  → OpenAI Chat Completions 호출(temperature 0.7)
  → 답변 추출
  → 로그인 시 CHAT_POST(없으면 생성) + CHAT_COMMENT(USER/ASSISTANT) 저장 (@Transactional)
  → history 갱신(20턴 초과분 앞에서 제거)
```

### 네비게이션 챗봇 (`ChatbotService.ask`) — 호출 전후 운영 레이어

```text
1. 차단 체크(IP+USER) → 차단이면 즉시 응답
2. 등급 쿼터 조회 → 현재 주기 사용량 한도 초과면 응답
3. 대화 조회/신규생성(대화 수 한도·소유권 체크)
4. 유저 메시지 저장
5. fast-path: 단순 네비면 LLM 생략하고 즉답
6. 1차 의도분류(classify) — 부적절이면 본 호출 생략(토큰 절감)
7. Gemini 본 호출(구조화 JSON 강제)
8. 링크 화이트리스트 검증 → 부적절 플래그 처리 → 저장 → 사용량 +1
```

핵심은 **5~6단계의 단축 경로**다. 모든 질문이 본 LLM 호출까지 가지 않는다. 단순 안내(fast-path)와 부적절 차단은 비싼 호출 이전에 끝낸다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- GPT-4o-mini 멀티턴 상담, 4개국어 프롬프트, 히스토리 DB 저장(`CHAT_POST`/`CHAT_COMMENT`)
- Gemini 구조화 JSON 챗봇, 의도분류, fast-path, 등급 쿼터, IP/유저 차단, URL 화이트리스트
- 관리자 모니터링(대화·사용량·차단) 연동
:::

:::warning 미흡 / 계획
- **AI 응답 품질의 정량 평가 체계가 없다.** 정확도·환각률을 수치로 측정하지 않는다(향후 과제).
- API 키는 환경변수/설정으로 주입하는 구조이며, 키가 없으면 안내 메시지로 graceful fail.
- 본 자료의 모든 키·호스트는 자리표시자(API_KEY, DB_HOST)다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** "대화형 AI를 두 갈래로 나눴습니다. 깊은 상담은 GPT-4o-mini 멀티턴, 사이트 안내는 Gemini 2.5 Flash 구조화 JSON 챗봇입니다."
2. **설계 이유:** "LLM은 비싸고 신뢰할 수 없는 외부 의존성이라, 호출 앞뒤로 쿼터·의도분류·fast-path·모더레이션·URL 화이트리스트라는 운영 레이어를 뒀습니다."
3. **결과:** "모든 질문이 본 LLM 호출까지 가지 않습니다. 단순 안내는 fast-path로, 부적절 질문은 1차 분류에서 끝내 비용과 위험을 동시에 줄였습니다."

## 7. 꼬리질문 + 모범답안

:::details 왜 어시스턴트는 GPT, 챗봇은 Gemini로 모델을 나눴나
긴 멀티턴 상담은 컨텍스트 유지·답변 품질이 중요해 GPT-4o-mini를 썼고, 사이트 안내는 구조화 JSON과 속도·비용이 핵심이라 Gemini 2.5 Flash를 택했습니다. 목적이 다른 두 작업에 같은 모델을 강제하지 않고 강점에 맞췄습니다.
:::

:::details LLM이 만든 링크를 어떻게 신뢰하나
신뢰하지 않습니다. 챗봇 응답의 모든 링크 URL을 서버가 화이트리스트 패턴으로 검증하고, javascript: data: file: 같은 위험 스킴과 경로 순회(..), protocol-relative(//)를 차단합니다. 통과 못 한 링크는 응답에서 버립니다. AI 출력을 외부 입력처럼 다룹니다.
:::

:::details 비용은 어떻게 줄였나
세 단계입니다. fast-path로 단순 네비 질문은 LLM 호출 자체를 생략하고, 1차 의도분류에서 부적절 판정이 나면 본 호출 없이 안전 응답을 돌려주며, 등급별 쿼터로 주기당 메시지 수를 제한합니다. 비싼 본 호출에 도달하는 트래픽 자체를 줄였습니다.
:::

:::details 등급별 쿼터는 하드코딩인가
아니요. `ChatbotQuotaService`가 `CHATBOT_QUOTA` 테이블에서 등급별 한도를 읽습니다. GUEST부터 상위 등급까지 주기당 메시지 수가 다르고, ADMIN/SUPERADMIN은 면제됩니다. 비로그인은 IP 기준으로 사용량을 집계합니다. 관리자가 무중단으로 한도를 조정할 수 있습니다.
:::

:::details 멀티턴 히스토리가 무한히 길어지면
어시스턴트는 history를 최대 20턴으로 제한하고 초과분을 앞에서 제거해 토큰·비용을 통제합니다. 영구 기록은 `CHAT_POST`/`CHAT_COMMENT`에 별도로 저장하므로 사용자는 과거 대화를 다시 열 수 있습니다. 즉 컨텍스트 윈도우와 영속 저장을 분리했습니다.
:::

## 8. 직접 말해보기

- 어시스턴트와 챗봇의 모델·목적·계층 차이를 30초로 설명해 보라.
- 사용자가 부적절한 질문을 던졌을 때 본 LLM 호출까지 가지 않는 이유를 단계로 말해 보라.
- 챗봇이 반환한 링크가 어떻게 검증되는지, 왜 그렇게 하는지 설명해 보라.

## 담당 · 핵심 기술 · 학습 순서

- **담당:** 이 도메인(AI 어시스턴트·챗봇)은 4인 공동개발 중 담당자 한 명이 맡았다. 코스의 AI일정 생성기, 탐색의 Gemini 추천, 문의의 Claude 초안 등 다른 AI는 각 도메인 담당자 소유다.
- **핵심 기술:** GPT-4o-mini 멀티턴 / Gemini 2.5 Flash 구조화 JSON / 등급 쿼터 / 의도분류 + fast-path / IP·유저 차단 / URL 화이트리스트.

권장 학습 순서:

1. [멀티턴 어시스턴트(GPT)](/assistant/multiturn-gpt)
2. [히스토리·DB 저장](/assistant/history-management)
3. [네비 챗봇(Gemini)](/assistant/chatbot-gemini)
4. [구조화 JSON 응답](/assistant/structured-json)
5. [의도 분류·Fast-Path](/assistant/intent-fastpath)
6. [등급별 쿼터](/assistant/quota-grade)
7. [차단·모더레이션](/assistant/block-moderation)
8. [URL 화이트리스트 보안](/assistant/url-whitelist)
9. [면접 플레이북](/assistant/interview-playbook)

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [AI 기능 전체](/ai/)

## 단골 면접 질문 5개

1. 대화형 AI를 왜 GPT와 Gemini 두 모델로 나눴나?
2. LLM 호출 비용·남용을 어떻게 통제하나? (쿼터·fast-path·의도분류)
3. LLM이 생성한 링크를 어떻게 안전하게 처리하나?
4. 멀티턴 대화의 컨텍스트는 어떻게 관리하고 어디에 저장하나?
5. AI 응답 품질을 어떻게 평가하나? (현재 한계와 향후 과제)

## 퀴즈

<QuizBox question="TripTogether에서 깊이 있는 멀티턴 여행 상담과 사이트 네비게이션 챗봇에 각각 쓰인 모델 조합으로 옳은 것은?" :choices="['둘 다 GPT-4o-mini', '상담은 GPT-4o-mini, 챗봇은 Gemini 2.5 Flash', '상담은 Gemini, 챗봇은 Claude Haiku', '둘 다 Gemini 2.5 Flash']" :answer="1" explanation="멀티턴 상담은 OpenAI GPT-4o-mini(AssistantServiceImpl), 전역 네비 챗봇은 Google Gemini 2.5 Flash(ChatbotService)로 목적에 맞게 모델을 분리했다." />

<QuizBox question="네비게이션 챗봇이 비싼 본 LLM 호출 전에 트래픽을 줄이는 두 단축 경로는?" :choices="['캐시와 페이지네이션', 'fast-path 즉답과 1차 의도분류 차단', 'CDN과 로드밸런서', 'JPA 지연로딩과 배치']" :answer="1" explanation="단순 네비 질문은 fast-path로 LLM을 생략하고, 1차 의도분류에서 부적절 판정이 나면 본 호출 없이 안전 응답을 반환한다." />

<QuizBox question="Gemini 챗봇 응답에 담긴 링크를 서버가 처리하는 방식으로 옳은 것은?" :choices="['모든 링크를 그대로 신뢰해 전달한다', '화이트리스트 패턴으로 검증하고 위험 스킴과 경로 순회는 차단한다', '외부 URL만 허용한다', '링크를 항상 제거한다']" :answer="1" explanation="ChatbotService는 허용 경로 화이트리스트로 링크를 검증하고 javascript data file 같은 위험 스킴, 경로 순회(점 두 개), protocol-relative(슬래시 두 개)를 차단해 통과하지 못한 링크를 버린다." />
