---
title: "멀티턴 어시스턴트 (GPT)"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["GPT", "멀티턴"]
---

# 멀티턴 어시스턴트 (GPT)

> 사용자가 여행 상담을 던지면 직전 대화 맥락을 함께 묶어 GPT-4o-mini에 보내고, 응답을 받아 세션과 DB 두 곳에 저장하는 멀티턴 채팅 도우미다.

## 1. 한 줄 정의

멀티턴 어시스턴트는 사용자 메시지에 이전 대화 이력(`history`)과 언어별 시스템 프롬프트를 붙여 OpenAI Chat Completions API를 호출하고, 응답을 세션 + `CHAT_POST`/`CHAT_COMMENT` 테이블에 적재해 같은 맥락으로 대화를 이어 가는 여행 상담 기능이다.

## 2. 왜 이렇게 설계했나

여행 상담은 한 번의 질문으로 끝나지 않는다. 사용자가 부산 2박 3일을 묻고, 다음 줄에서 예산을 추가하고, 그다음 줄에서 동행을 바꾸는 식으로 맥락이 누적된다. 단발성 호출이라면 이전 답변을 모두 잊어버려 상담이 성립하지 않는다.

설계 결정의 핵심은 다음과 같다.

- **이력을 매 호출에 동봉**: 서버는 무상태처럼 보이지만, 대화 맥락은 세션과 DB에 보관했다가 다음 호출 때 `messages` 배열로 다시 모델에 넣는다. 모델 자체는 상태가 없으므로 맥락은 우리가 매번 다시 전달한다.
- **이력 길이 상한(`MAX_HISTORY = 20`)**: 대화가 길어질수록 토큰 비용과 지연이 커진다. 가장 오래된 메시지부터 잘라 최근 20개만 유지해 비용·응답 속도를 통제한다.
- **언어별 시스템 프롬프트**: 응답 자체를 사용자 언어로 생성한다(기계번역 후처리가 아님). `LANG_NAME_MAP`으로 언어 코드를 자연어 언어명으로 바꿔 프롬프트에 끼워 넣는다.
- **세션 + DB 2계층 저장**: 비로그인 사용자도 한 세션 안에서는 맥락을 이어 갈 수 있고(세션), 로그인 사용자는 대화가 영구 보관되어 나중에 다시 불러올 수 있다(DB).

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 구현체 | 역할 |
| --- | --- | --- |
| 컨트롤러 | `AssistantController` (`/assistant`) | 채팅 페이지, `/chat` 호출, 이력 조회·수정·삭제·리셋 |
| 서비스 인터페이스 | `AssistantService` | `chat`, 이력 조회/제목수정/삭제 시그니처 |
| 서비스 구현 | `AssistantServiceImpl` | 프롬프트 조립 + OpenAI 호출 + DB 저장 |
| 매퍼 | `AssistantMapper` (+ `AssistantMapper.xml`) | `CHAT_POST`/`CHAT_COMMENT` CRUD |
| VO | `ChatPostVO`, `ChatCommentVO` | 대화 세션 1건 + 메시지 N건 매핑 |
| 테이블 | `CHAT_POST`, `CHAT_COMMENT` | 대화방 메타 + 역할별 메시지 로그 |

모델은 기본 `gpt-4o-mini`이며 `https://api.openai.com/v1/chat/completions`를 `RestTemplate`으로 호출한다. 모델명과 API 키는 `@Value`로 `openai.model` / `openai.api.key`에서 주입받도록 설계되어 있다. 호출 본문은 Gson으로 직렬화하고, 응답은 `JsonParser`로 파싱해 첫 번째 `choices` 항목의 `message.content`를 답변으로 꺼낸다. 요청·응답 파라미터는 다음과 같다.

| 파라미터 | 값 | 의미 |
| --- | --- | --- |
| `model` | `gpt-4o-mini` | 비용 효율적인 멀티턴 상담용 모델 |
| `temperature` | `0.7` | 상담 톤에 적당한 다양성 |
| `messages` | system 1 + history N | 시스템 프롬프트 + 누적 대화 |
| 이력 상한 | `MAX_HISTORY = 20` | 초과 시 오래된 것부터 제거 |

## 4. 동작 원리 (흐름·표·작은 코드)

요청은 컨트롤러가 세션에서 맥락을 꺼내 서비스로 넘기고, 서비스가 모델 호출과 저장을 모두 담당한다.

```text
[assistant.jsp]
  POST /assistant/chat  { message, chatPostIdx? }
        |
        v
AssistantController.chat()
  - 세션 loginUser -> userIdx (없으면 null)
  - 세션 chatHistory, currentChatPostIdx 로드
  - LocaleContextHolder 로 현재 언어(lang) 추출
        |
        v
AssistantServiceImpl.chat(message, history, userIdx, chatPostIdx, lang)  @Transactional
  1) buildSystemPrompt(lang)         언어별 system 메시지
  2) requestMessages = system + history + 신규 user
  3) OpenAI /chat/completions 호출    temperature 0.7
  4) 응답 content 추출 -> assistant 메시지로 추가
  5) MAX_HISTORY 초과분 앞에서 제거
  6) userIdx 있으면 CHAT_POST/CHAT_COMMENT 저장
        |
        v
컨트롤러가 result.history -> 세션에 다시 저장
```

**시스템 프롬프트는 언어별로 동적 생성된다.** `LANG_NAME_MAP`은 ko/en/ja/zh 코드를 자연어 언어명으로 매핑하고, 미지원 언어는 한국어를 기본값으로 둔다.

```java
// 언어 코드 -> 자연어 언어명
"ko" -> "Korean (한국어)"
"en" -> "English"
"ja" -> "Japanese (日本語)"
"zh" -> "Chinese (中文)"

// 프롬프트 1번 규칙에 langName 주입
// "항상 %s 로 답변하세요. (Always respond in %s)"
```

프롬프트 본문은 한국어로 작성하되, 영어 지시(Always respond in ...)를 병기해 응답 언어만 동적으로 지정한다. 역할(여행지 추천·일정 초안·예산 안내), 거절 규칙(여행 무관 질문 거절), 가변 정보(가격·운영시간은 단정 금지)도 프롬프트에 명시되어 있다.

**DB 저장은 로그인 사용자에 한해 두 단계로 일어난다.**

| 단계 | 동작 | 비고 |
| --- | --- | --- |
| 신규 대화 | `chatPostIdx`가 null이면 `CHAT_POST` insert | 제목은 첫 메시지 앞 20자 |
| 순서 채번 | `selectMaxCommentOrder`로 마지막 순서 조회 | null이면 0 |
| user 저장 | `comment_role = USER`, order = last + 1 | 사용자 메시지 |
| assistant 저장 | `comment_role = ASSISTANT`, order = last + 2 | 모델 응답 |

`CHAT_COMMENT`에는 `(chat_post_idx, comment_order)` 유니크 키가 걸려 있어 같은 대화방 안에서 순서가 중복될 수 없다. user와 assistant를 한 번에 +1, +2로 채번하는 이유가 이 제약을 만족시키기 위해서다.

:::tip 비로그인은 왜 세션만 쓰나
`userIdx`가 null이면 `CHAT_POST`/`CHAT_COMMENT`에 아무것도 쓰지 않고 `chatPostIdx`를 null로 돌려준다. 대신 컨트롤러가 응답 `history`를 세션 속성 chatHistory에 저장하므로, 같은 브라우저 세션 동안에는 맥락이 유지되지만 영구 보관은 되지 않는다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 멀티턴 채팅 + 이력 동봉 | 구현됨 |
| `MAX_HISTORY = 20` 슬라이딩 | 구현됨 |
| 언어별 시스템 프롬프트(ko/en/ja/zh) | 구현됨 |
| 세션 맥락 유지(비로그인) | 구현됨 |
| `CHAT_POST`/`CHAT_COMMENT` DB 저장(로그인) | 구현됨 |
| 이력 조회·제목수정·삭제·리셋 | 구현됨 |
| 응답 스트리밍(타이핑 효과) | 미구현 (단건 응답) |
| 응답 품질 정량 평가 | 없음 (향후 과제) |

:::warning 코드 정직성 메모
현재 `AssistantServiceImpl`은 `@Value`로 주입되는 `openai.api.key` 대신 클래스 안에 박힌 테스트 키로 `Bearer` 헤더를 설정하고 있다. 키 외부화(주입 키 사용)는 운영 전 정리 대상이다. 학습 페이지에는 실제 키 값을 절대 싣지 않는다. 또한 키가 비어 있을 때의 가드 분기는 주입 키(`openAiApiKey`)를 보지만 실제 호출은 테스트 키를 쓰는 불일치가 있어, 이 부분도 정리 대상이다.
:::

## 6. 면접 답변 3단계

1. **무엇**: "여행 상담용 멀티턴 챗봇을 만들었습니다. 사용자 질문에 이전 대화 이력과 언어별 시스템 프롬프트를 붙여 GPT-4o-mini를 호출하고, 응답을 세션과 DB에 저장해 맥락을 이어 갑니다."
2. **어떻게**: "모델은 무상태라 맥락을 우리가 매 호출에 다시 넣습니다. 이력은 최근 20개만 유지해 비용과 지연을 통제하고, 응답 언어는 LANG_NAME_MAP으로 프롬프트에서 직접 지정합니다. 로그인 사용자 메시지는 CHAT_POST와 CHAT_COMMENT에 역할·순서와 함께 저장합니다."
3. **왜/효과**: "세션과 DB 2계층으로 나눠서 비로그인도 한 세션 안에서는 상담이 되고, 로그인 사용자는 대화가 영구 보관되어 나중에 다시 불러올 수 있게 했습니다."

## 7. 꼬리질문 + 모범답안

:::details GPT는 상태가 없는데 어떻게 이전 대화를 기억하나
모델 자체는 상태가 없습니다. 기억하는 것은 우리 서버입니다. 직전까지의 대화를 세션(비로그인)이나 DB(로그인)에 보관했다가, 다음 호출 때 system 메시지 뒤에 history 전체를 messages 배열로 다시 붙여 보냅니다. 모델은 매번 전체 맥락을 처음 보는 것처럼 받지만, 사용자 입장에서는 대화가 이어지는 것처럼 보입니다.
:::

:::details MAX_HISTORY를 20으로 둔 이유와 초과 시 동작은
대화가 길수록 토큰 비용과 응답 지연이 늘기 때문에 상한을 둡니다. 응답을 history에 추가한 뒤 크기가 20을 넘으면 리스트 앞(가장 오래된 메시지)부터 제거하는 슬라이딩 윈도우 방식입니다. 그래서 항상 최근 맥락만 모델에 전달됩니다. 다만 오래된 맥락이 잘리면 그 내용은 모델이 더는 참조하지 못한다는 한계가 있습니다.
:::

:::details 다국어 응답을 번역이 아니라 프롬프트로 처리한 이유는
응답을 한국어로 받아 기계번역하면 어색하거나 정보가 깎입니다. 대신 시스템 프롬프트에서 Always respond in English처럼 응답 언어 자체를 모델에 지시하면, 모델이 그 언어로 직접 생성해 품질이 더 높습니다. 언어 코드는 LocaleContextHolder에서 가져와 LANG_NAME_MAP으로 변환하고, 미지원 언어는 한국어로 폴백합니다.
:::

:::details 같은 대화방에서 메시지 순서가 꼬이지 않게 하는 장치는
CHAT_COMMENT에 chat_post_idx와 comment_order 조합 유니크 키가 있어 같은 방에서 순서가 중복될 수 없습니다. 저장 직전에 selectMaxCommentOrder로 마지막 순서를 조회하고, user 메시지에 last + 1, assistant 메시지에 last + 2를 부여해 한 턴이 항상 연속된 두 순서를 차지하게 합니다.
:::

:::details OpenAI 호출이 실패하면 사용자는 무엇을 보나
HTTP 상태 예외는 상태 코드를 포함한 안내 메시지로, 그 밖의 예외는 일시적 오류 안내 메시지로 변환해 돌려줍니다. 두 경우 모두 success를 false로, history는 호출 전 상태로 유지해 깨진 부분 대화가 남지 않게 합니다. chat 메서드 전체가 트랜잭션이라 DB 저장 도중 실패해도 그 턴의 insert가 롤백됩니다.
:::

## 8. 직접 말해보기

- 멀티턴 채팅 한 턴이 진행될 때 모델에 실제로 전달되는 messages 배열이 어떻게 구성되는지, system·history·신규 user 순서로 설명해 보라.
- `MAX_HISTORY = 20`이 막아 주는 문제(비용·지연)와 그 대가로 생기는 한계(오래된 맥락 손실)를 함께 말해 보라.
- 로그인 사용자와 비로그인 사용자의 대화 저장 경로가 어떻게 다른지, 세션과 `CHAT_POST`/`CHAT_COMMENT`를 들어 비교해 보라.

## 퀴즈

<QuizBox question="멀티턴 어시스턴트가 이전 대화 맥락을 유지하는 방식으로 옳은 것은?" :choices="['모델이 서버 상태를 기억한다', '매 호출마다 이전 history를 messages 배열로 다시 보낸다', 'DB 트리거가 자동으로 맥락을 주입한다', '쿠키에 전체 대화를 저장해 모델이 직접 읽는다']" :answer="1" explanation="모델은 무상태이므로 서버가 세션이나 DB에 보관한 이전 대화를 매 호출 messages 배열로 다시 전달해 맥락을 잇는다." />

<QuizBox question="MAX_HISTORY 값이 20을 넘으면 어떻게 동작하나?" :choices="['요청을 거부한다', '가장 오래된 메시지부터 제거해 최근 20개만 유지한다', '전체 이력을 비운다', '새 대화방을 자동 생성한다']" :answer="1" explanation="응답을 추가한 뒤 크기가 20을 초과하면 리스트 앞에서부터 제거하는 슬라이딩 윈도우로 토큰 비용과 지연을 통제한다." />

<QuizBox question="로그인 사용자의 한 턴이 CHAT_COMMENT에 저장될 때 순서 채번 방식으로 옳은 것은?" :choices="['user와 assistant에 같은 order를 준다', '마지막 order 기준 user는 +1, assistant는 +2를 준다', 'order 없이 created_at만 쓴다', '항상 1과 2로 고정한다']" :answer="1" explanation="selectMaxCommentOrder로 마지막 순서를 구한 뒤 user에 +1, assistant에 +2를 부여해 chat_post_idx와 comment_order 유니크 제약을 만족시킨다." />
