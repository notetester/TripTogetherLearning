---
title: "히스토리·DB 저장"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["히스토리", "DB"]
---

# 히스토리·DB 저장

> 멀티턴 여행 도우미의 대화를 CHAT_POST(대화방) → CHAT_COMMENT(메시지) 2계층으로 영속화하고, 로그인 여부에 따라 DB와 세션을 다르게 다루는 설계.

## 1. 한 줄 정의

AI 어시스턴트의 대화 기록을 **대화방 1개 = CHAT_POST 한 행**, **메시지 1개 = CHAT_COMMENT 한 행**으로 저장하고, `comment_order`로 발화 순서를 보장하며, 로그인 사용자는 DB와 세션에 함께, 비로그인 사용자는 세션에만 기록하는 히스토리 관리 모듈이다.

## 2. 왜 이렇게 설계했나

멀티턴 챗봇은 직전 답변뿐 아니라 이전 대화 맥락을 모델에 다시 넣어야 자연스럽게 이어진다. 그래서 단순히 마지막 답변만 들고 있을 수 없고, 발화 단위를 순서대로 저장·복원할 구조가 필요하다.

- **2계층 분리**: 게시판의 글-댓글 모델을 그대로 빌려 대화방과 메시지를 나눴다. 한 사용자가 여러 대화 주제를 동시에 가질 수 있고, 각 주제는 독립적으로 제목·삭제·이어가기가 가능해야 하기 때문이다.
- **순서 보장**: AI 대화는 USER → ASSISTANT가 번갈아 나오므로 시간 정렬만으로는 같은 초에 들어온 발화의 순서가 흔들릴 수 있다. 그래서 별도 정수 컬럼 `comment_order`를 두고 `(chat_post_idx, comment_order)`에 UNIQUE 제약을 걸어 순서를 데이터 수준에서 강제한다.
- **로그인 분기**: 비로그인 사용자에게도 체험은 열어두되 DB는 더럽히지 않는다. 로그인 사용자만 영구 기록을 남기고, 비로그인은 세션 메모리로만 멀티턴을 유지한다.
- **소유권 분리**: 모든 조회·수정·삭제 쿼리에 `user_idx` 조건을 함께 넣어, 남의 대화방 번호를 알아도 접근하지 못하게 한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 구현체 |
| --- | --- |
| 컨트롤러 | `AssistantController` (`/assistant/**`) |
| 서비스 | `AssistantService` 인터페이스 + `AssistantServiceImpl` |
| 매퍼 | `AssistantMapper` (@Mapper) + `resources/mapper/AssistantMapper.xml` |
| VO | `ChatPostVO`, `ChatCommentVO` |
| 테이블 | `CHAT_POST`, `CHAT_COMMENT` |
| 모델 | OpenAI gpt-4o-mini (멀티턴 응답 생성) |

테이블 핵심 컬럼은 다음과 같다.

```sql
CHAT_POST (
  chat_post_idx  BIGINT PK AUTO_INCREMENT,
  user_idx       BIGINT NOT NULL,        -- USERS FK, ON DELETE CASCADE
  title          VARCHAR(200),           -- 자동 생성 제목
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
)

CHAT_COMMENT (
  chat_comment_idx BIGINT PK AUTO_INCREMENT,
  chat_post_idx    BIGINT NOT NULL,      -- CHAT_POST FK, ON DELETE CASCADE
  user_idx         BIGINT NOT NULL,
  comment_role     VARCHAR(10) NOT NULL, -- USER / ASSISTANT
  content          LONGTEXT NOT NULL,
  comment_order    INT NOT NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (chat_post_idx, comment_order)
)
```

`CHAT_COMMENT.chat_post_idx`는 `CHAT_POST`를 ON DELETE CASCADE로 참조한다. 즉 대화방이 지워지면 메시지도 DB 제약으로 함께 삭제된다(코드 레벨에서도 명시 삭제를 한 번 더 수행한다 — 5절 참고).

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 한 번의 chat 요청 처리 순서

`AssistantServiceImpl.chat(...)`는 `@Transactional`로 묶여 있고, 대략 다음 순서로 동작한다.

1. 입력 검증 (빈 메시지·API 키 미설정 시 즉시 실패 응답)
2. 전달받은 `history`에 이번 사용자 메시지를 붙여 system 프롬프트와 함께 모델 호출
3. 응답에서 assistant 메시지를 뽑아 `history`에 추가
4. `history` 길이가 `MAX_HISTORY`(20)를 넘으면 가장 오래된 항목부터 제거
5. 로그인(`userIdx != null`)이면 DB 저장, 비로그인이면 저장 건너뜀
6. 갱신된 `history`와 `chatPostIdx`를 결과로 반환 → 컨트롤러가 세션에 다시 저장

### 4-2. 대화방 생성과 순서 채번

로그인 사용자의 첫 메시지면 대화방이 없으므로 `CHAT_POST`를 새로 만든다. 이후 메시지 순서는 현재 대화방의 최대 순서를 조회해 +1, +2로 부여한다.

```java
// chatPostIdx가 없으면 새 대화방 생성, 제목은 첫 메시지로 자동 생성
if (currentChatPostIdx == null) {
    ChatPostVO post = ChatPostVO.builder()
        .user_idx(userIdx)
        .title(makeTitle(userMessage))
        .build();
    assistantMapper.insertChatPost(post);          // useGeneratedKeys로 PK 회수
    currentChatPostIdx = post.getChat_post_idx();
}

Integer maxOrder = assistantMapper.selectMaxCommentOrder(currentChatPostIdx);
int last = (maxOrder == null) ? 0 : maxOrder;      // 매퍼는 COALESCE(MAX, 0) 반환
// USER 먼저, ASSISTANT 다음 — 한 턴에 +1 / +2
assistantMapper.insertChatComment(userComment);    // comment_order = last + 1
assistantMapper.insertChatComment(assistantComment); // comment_order = last + 2
```

매퍼의 `selectMaxCommentOrder`는 `SELECT COALESCE(MAX(comment_order), 0)`이라 빈 대화방에서도 0을 돌려준다. USER가 홀수, ASSISTANT가 짝수 순서를 가져 한 턴이 항상 2씩 증가하는 구조다.

:::warning 동시성 한계
순서 채번이 SELECT MAX 후 INSERT 방식이라, 같은 대화방에 동시 요청이 들어오면 같은 `comment_order`가 계산될 수 있다. 이때는 `(chat_post_idx, comment_order)` UNIQUE 제약이 두 번째 INSERT를 막아 트랜잭션이 롤백된다. 즉 데이터는 깨지지 않지만 동시 입력은 한쪽이 실패한다. 단일 사용자가 자기 대화방에 순차 입력하는 실제 시나리오에서는 충돌이 사실상 없다.
:::

### 4-3. 제목 자동 생성

대화방 제목은 첫 사용자 메시지에서 만든다. 규칙은 단순하다.

```java
private String makeTitle(String userMessage) {
    String msg = (userMessage == null) ? "" : userMessage.trim();
    if (msg.isEmpty()) return "새 대화";
    return msg.length() > 20 ? msg.substring(0, 20) + "..." : msg;
}
```

20자를 넘으면 잘라서 말줄임을 붙인다. 별도 LLM 요약을 쓰지 않으므로 비용·지연이 없고, 제목은 사용자가 `updateChatPostTitle`로 나중에 직접 바꿀 수 있다.

### 4-4. 로그인 vs 비로그인 저장 전략

| 구분 | history(맥락) | DB 영속화 | 대화방 식별 |
| --- | --- | --- | --- |
| 로그인 | 세션 + DB(CHAT_COMMENT) 병행 | 함 | `currentChatPostIdx` 세션 + DB |
| 비로그인 | 세션(`chatHistory`)만 | 안 함 | 없음 (chatPostIdx = null) |

컨트롤러는 매 요청 후 `result.get("history")`를 세션 속성 `chatHistory`에 다시 넣고, 저장된 대화방이 있으면 `currentChatPostIdx`도 세션에 보관한다. 비로그인 사용자는 세션이 만료되면 맥락이 사라진다.

### 4-5. 히스토리 복원과 정리

- 좌측 목록: `selectRecentChatPosts`가 `user_idx` 기준 `created_at DESC LIMIT 10`으로 최근 10개 대화방을 뽑는다.
- 이어가기: `/assistant/history/{chatPostIdx}` 조회 시 `selectChatComments`가 `comment_order ASC`로 정렬해 USER/ASSISTANT 역할을 프론트가 쓰는 user/assistant로 변환해 세션 history를 복원한다.
- 삭제: `deleteChatPost`가 먼저 `deleteChatComments`로 메시지를 지우고 대화방을 지운다. 현재 보고 있던 대화방을 지우면 컨트롤러가 세션의 `chatHistory`와 `currentChatPostIdx`도 비운다.

조회·수정·삭제 매퍼 모두 WHERE 절에 `user_idx`(또는 CHAT_POST와 조인 후 `p.user_idx`)를 함께 걸어, 본인 대화방만 다루도록 막는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 2계층 영속화(CHAT_POST/CHAT_COMMENT), `comment_order` UNIQUE로 순서 보장
- 로그인 DB+세션 / 비로그인 세션-only 분기
- 첫 메시지 기반 제목 자동 생성, 제목 수동 변경, 대화방·메시지 삭제
- 최근 10개 대화방 목록, 대화 이어가기 복원
- `@Transactional` 하에 대화방 생성 + 두 메시지 삽입 원자 처리
- 모든 쿼리 `user_idx` 소유권 가드
:::

:::warning 한계·계획
- DB 삭제는 **하드 삭제**다. 이 모듈의 대화 기록은 다른 도메인의 소프트삭제(status/is_deleted) 정책과 달리 물리 삭제로 동작한다.
- 순서 채번이 SELECT MAX + INSERT라 고동시성에 취약(UNIQUE 제약으로 데이터 무결성은 보장).
- 맥락 압축은 길이 20 초과 시 **오래된 항목 단순 제거**뿐 — 요약 기반 압축은 없다.
- `MAX_HISTORY`(20)는 세션 history 길이 컷일 뿐, DB의 CHAT_COMMENT는 잘리지 않고 누적된다.
- AI 응답 품질·맥락 유지에 대한 정량 평가 체계는 없다(향후 과제).
:::

## 6. 면접 답변 3단계

1. **한 문장**: "AI 여행 도우미의 대화를 대화방(CHAT_POST)과 메시지(CHAT_COMMENT) 2계층으로 저장하고, comment_order로 발화 순서를 보장합니다."
2. **설계 의도**: "멀티턴은 이전 맥락을 모델에 다시 넣어야 하므로 발화 단위 영속화가 필요했고, 게시판의 글-댓글 모델을 빌려 한 사용자가 여러 대화 주제를 독립적으로 관리하게 했습니다. 로그인 사용자만 DB에 남기고 비로그인은 세션으로만 멀티턴을 유지합니다."
3. **트레이드오프**: "순서는 SELECT MAX 후 INSERT라 단순하지만 고동시성에는 약합니다. 대신 chat_post_idx와 comment_order에 UNIQUE 제약을 걸어 충돌 시 트랜잭션이 롤백되도록 무결성을 지켰습니다. 단일 사용자 순차 입력 패턴에선 충돌이 거의 없어 실용적 선택이었습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. comment_order는 왜 created_at으로 정렬하지 않고 별도 컬럼을 뒀나요?
같은 턴의 USER/ASSISTANT가 같은 초에 저장되면 datetime 정렬은 순서가 흔들릴 수 있습니다. 정수 순서 컬럼을 별도로 두고 `(chat_post_idx, comment_order)`에 UNIQUE를 걸면, 정렬 안정성과 중복 방지를 데이터 수준에서 동시에 보장할 수 있습니다.
:::

:::details Q2. 비로그인 사용자도 멀티턴이 되는데, 맥락은 어디에 있나요?
세션 속성 `chatHistory`에만 있습니다. 컨트롤러가 매 요청 후 갱신된 history를 세션에 다시 넣어 다음 호출에 전달합니다. DB에는 저장하지 않으므로 세션 만료 시 사라지고, 그래서 비로그인은 chatPostIdx가 항상 null입니다.
:::

:::details Q3. 대화가 길어지면 토큰이 무한히 늘지 않나요?
세션 history는 MAX_HISTORY 20을 넘으면 가장 오래된 항목부터 제거합니다. 그래서 모델에 넣는 맥락 길이가 상한을 가집니다. 다만 이건 요약이 아니라 단순 절단이라 오래된 맥락은 손실됩니다. 요약 기반 압축은 향후 과제입니다.
:::

:::details Q4. 남의 대화방 번호를 URL에 넣으면 조회되나요?
안 됩니다. 조회·수정·삭제 매퍼 모두 WHERE에 `user_idx`를 함께 겁니다. 예를 들어 `selectChatComments`는 CHAT_POST와 조인해 `p.user_idx = 세션 사용자`를 검사하므로, 소유자가 아니면 빈 결과가 나옵니다. 인가는 세션 로그인 사용자 기준으로 쿼리에 박혀 있습니다.
:::

:::details Q5. 대화방 삭제 시 메시지는 어떻게 정리되나요?
서비스가 `deleteChatComments`로 메시지를 먼저 지우고 `deleteChatPost`로 대화방을 지웁니다. 또한 FK가 ON DELETE CASCADE라 DB 차원에서도 안전망이 있습니다. 둘 다 하드 삭제이며, 현재 보던 대화방을 지우면 세션의 chatHistory와 currentChatPostIdx도 함께 비웁니다.
:::

## 8. 직접 말해보기

- CHAT_POST와 CHAT_COMMENT의 관계, 그리고 comment_order가 왜 필요한지 30초로 설명해 보세요.
- 로그인 사용자와 비로그인 사용자의 저장 경로가 어떻게 갈라지는지 표로 그려 보세요.
- 같은 대화방에 동시에 두 요청이 오면 어떤 일이 벌어지고, 왜 데이터가 깨지지 않는지 말해 보세요.
- 제목 자동 생성 로직과, 그걸 LLM 요약으로 하지 않은 이유를 설명해 보세요.

더 보기: [멀티턴 어시스턴트(GPT)](/assistant/multiturn-gpt) · [어시스턴트·챗봇 개요](/assistant/) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="CHAT_COMMENT 테이블에서 발화 순서를 데이터 수준으로 보장하는 장치는 무엇인가?" :choices="['created_at 단일 인덱스', 'chat_post_idx와 comment_order에 건 UNIQUE 제약', 'comment_role 컬럼의 CHECK 제약', '애플리케이션의 정렬 로직만으로 보장']" :answer="1" explanation="comment_order에 chat_post_idx와 묶인 UNIQUE 제약이 있어, 같은 대화방에서 같은 순서값이 두 번 들어가는 것을 DB가 막는다. 동시 INSERT 충돌 시 한쪽 트랜잭션이 롤백된다." />

<QuizBox question="비로그인 사용자의 대화 맥락은 어디에 보관되며 DB에는 어떻게 저장되는가?" :choices="['DB의 CHAT_POST에만 저장된다', '세션 chatHistory에만 보관되고 DB에는 저장되지 않는다', '로그인 사용자와 동일하게 DB와 세션에 모두 저장된다', '쿠키에 암호화되어 저장된다']" :answer="1" explanation="userIdx가 null이면 DB 저장을 건너뛰고 chatPostIdx도 null로 둔다. 맥락은 컨트롤러가 매 요청마다 갱신해 세션 속성 chatHistory로만 유지한다." />

<QuizBox question="세션 history 길이가 MAX_HISTORY 20을 초과할 때 모듈의 동작은?" :choices="['가장 오래된 항목부터 제거해 길이를 줄인다', '전체를 LLM으로 요약해 압축한다', 'DB의 CHAT_COMMENT까지 함께 삭제한다', '예외를 던지고 대화를 종료한다']" :answer="0" explanation="while 루프로 가장 오래된 항목을 앞에서부터 제거한다. 이는 단순 절단이며 요약 압축이 아니고, DB의 CHAT_COMMENT는 잘리지 않고 누적된다." />
