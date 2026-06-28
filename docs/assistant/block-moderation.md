---
title: "차단·모더레이션"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["차단", "모더레이션"]
---

# 차단·모더레이션

> AI 챗봇/도우미의 악용을 막는 두 축: 입력 단계의 즉시 차단(ChatbotBlockService)과 출력 이후의 독성 감사(is_inappropriate·Perspective TOXICITY). 모든 메시지는 영구 기록되어 관리자 검토 대상이 된다.

이 페이지는 TripTogether의 AI 어시스턴트·챗봇 모듈에서 "사용자가 부적절하게 굴 때 무슨 일이 일어나는가"를 다룬다. 차단(누구를 막을 것인가)과 모더레이션(무엇이 부적절했는가를 판정·기록)은 별개의 책임이며, 코드상으로도 분리되어 있다.

## 1. 한 줄 정의

차단은 IP 또는 사용자 단위로 챗봇 접근 자체를 막는 게이트이고, 모더레이션은 오간 메시지의 독성을 판정해 영구 기록하고 관리자에게 노출하는 감사 절차다.

## 2. 왜 이렇게 설계했나

AI 챗봇은 무한 입력 표면이다. 욕설·잡담·개인정보 요구·프롬프트 인젝션이 들어오면 토큰만 낭비되고 위험은 누적된다. 설계 의도는 세 가지다.

- **선차단, 후판정 분리.** 이미 악용이 확인된 IP/USER는 LLM을 부르기도 전에 막아 비용과 위험을 0으로 만든다. 반면 처음 보는 메시지는 일단 응답하되 부적절 여부를 표시·기록해 사후 추적이 가능하게 한다.
- **기존 차단 시스템과의 격리.** 사이트 전역 차단(USER_BLOCKLIST·BLOCKED_IP)을 건드리면 다른 도메인에 부작용이 번진다. 그래서 챗봇 전용 `CHATBOT_BLOCK` 테이블과 `ChatbotBlockService`를 별도로 두어 책임을 좁혔다.
- **무수정 모듈 우회.** 도우미(assistant) 모듈은 다른 담당자 소유라 응답 경로에 검사 코드를 끼워 넣을 수 없다. 그래서 도우미 쪽은 응답 흐름을 건드리지 않고, 스케줄러가 사후에 메시지를 스캔하는 방식을 택했다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

두 개의 독립 파이프라인이 있고, 모더레이션 경로가 모듈마다 다르다는 점이 핵심이다.

| 책임 | 클래스 | 테이블 | 판정 주체 |
| --- | --- | --- | --- |
| 챗봇 전용 차단 | `ChatbotBlockService` / `ChatbotBlockMapper` | `CHATBOT_BLOCK` | 관리자 수동 |
| 챗봇(common) 독성 표시 | `ChatbotService` / `ConversationService.markInappropriate` | `CHATBOT_MESSAGE.is_inappropriate` | LLM 자체 판정 + 사전 의도분류 |
| 도우미(assistant) 독성 판정 | `AdminAssistantModerationScheduler` / `AdminAssistantModerationServiceImpl` | `ADMIN_ASSISTANT_MODERATION` | Perspective API TOXICITY |
| 독성 임계값 정책 | `ModerationPolicyService` / `ContentModerationPolicyVO` | (런타임 설정) | 관리자 설정값 |

`CHATBOT_BLOCK` 핵심 컬럼: `block_type`(USER 또는 IP enum), `block_value`(user_idx 문자열 또는 IP), `expires_at`(NULL이면 영구), `is_active`, `reason`, `blocked_by`(처리 관리자). `UNIQUE(is_active, block_type, block_value)` 제약으로 동일 대상 중복을 막고 재활성화를 단순화한다.

`CHATBOT_MESSAGE`는 conversation_id 단위로 user/assistant 메시지를 모두 보존하며 `is_inappropriate` 플래그를 가진다. `ADMIN_ASSISTANT_MODERATION`은 `chat_comment_idx`(CHAT_COMMENT FK, user 메시지 전용)에 1:1로 매달려 `toxicity_score`(decimal 0.000~1.000)와 `is_inappropriate`를 저장한다.

## 4. 동작 원리(흐름·표·작은 코드)

### 4-1. 입력 단계 차단 (모든 챗봇 요청의 1번 관문)

`ChatbotService`는 어떤 처리보다 먼저 차단을 확인한다.

```java
// ChatbotService — 1. 차단 체크 (LLM 호출 전)
if (blockService.isBlocked(ipAddress, userIdx)) {
    return blockedResponse();
}
```

`isBlocked`는 IP와 USER를 각각 조회하고, 매퍼는 만료를 SQL에서 직접 거른다.

```sql
-- chatbotBlockMapper.isBlocked
SELECT COUNT(*) > 0 FROM CHATBOT_BLOCK
WHERE block_type = #{blockType} AND block_value = #{blockValue}
  AND is_active = 1
  AND (expires_at IS NULL OR expires_at > NOW())
```

즉 `expires_at`이 지난 차단은 별도 배치 없이도 자동 무력화된다. 영구 차단은 `expires_at`을 NULL로 둔다. 등록은 `upsertBlock`이 `ON DUPLICATE KEY UPDATE`로 처리해, 이미 풀린 같은 대상이 다시 들어오면 재활성화·사유 갱신이 한 번에 된다.

### 4-2. 챗봇(common) 출력 단계 모더레이션

common 챗봇은 LLM이 직접 부적절 여부를 구조화 JSON으로 반환하고, 추가로 본 호출 전 사전 의도분류가 한 번 더 거른다.

| 단계 | 동작 | 결과 |
| --- | --- | --- |
| 사전 의도분류 | `IntentContextService.classify`가 inappropriate면 본 LLM 호출 생략 | 안전 응답 + `markInappropriate` |
| 본 호출 응답 | 응답 JSON의 inappropriate 플래그 true면 | 응답은 반환하되 `markInappropriate` |
| 기록 | `ConversationService.markInappropriate(messageId)` | `CHATBOT_MESSAGE.is_inappropriate = 1` |

부적절로 사전 분류되면 LLM 본 호출을 생략해 토큰을 아끼고 안전 응답으로 대체한다. 어느 경로든 **유저 메시지는 먼저 저장된 뒤 플래그가 찍힌다** — 기록이 먼저, 판정이 나중이다.

### 4-3. 도우미(assistant) 비동기 모더레이션

도우미 모듈은 응답 경로를 수정하지 않으므로, 스케줄러가 사후에 스캔한다.

```text
[1분 후 시작 → 이후 5분 간격 fixedDelay]
selectPendingUserCommentIds(50)   -- comment_role=USER & 아직 미판정
   └─ 각 건 200ms 간격으로
        PerspectiveService.getToxicityScore(content)   -- 0.0~1.0
        score >= toxicityThreshold ? inappropriate=true
        insertModeration(commentIdx, inappropriate, score)  -- 멱등(ON DUP KEY)
```

배치 한도 50건과 호출 간 200ms 대기는 Perspective API 쿼터 보호용이다. 빈 내용은 비독성으로 기록해 재스캔을 막고, 임계값(`toxicityThreshold`)은 `ModerationPolicyService` 정책에서 읽어 코드 상수가 아니라 설정으로 조정된다. 관리자 화면은 `selectInappropriateMessages`로 독성 메시지를 닉네임·원문과 조인해 보여준다.

## 5. 구현 상태(됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `CHATBOT_BLOCK` IP/USER 차단·만료·재활성화 | 구현됨 |
| LLM 호출 전 차단 게이트 | 구현됨 |
| common 챗봇 `is_inappropriate` 표시(사전분류+본호출) | 구현됨 |
| 도우미 Perspective 비동기 스캔 스케줄러 | 구현됨 |
| 독성 임계값 정책화(`ModerationPolicyService`) | 구현됨 |
| 차단 시 자동 신고/연계 차단 | 미구현(관리자 수동, ADR-0001 자동차단 금지 기조) |
| AI 응답 품질 정량평가 | 부재(향후 과제) |

:::warning
common 챗봇과 도우미는 모더레이션 방식이 다르다. 전자는 LLM 자체 판정 기반 `is_inappropriate`, 후자는 Perspective TOXICITY 점수 기반이다. 면접에서 "둘이 같은 거 아니냐"는 꼬리질문이 들어오면 이 차이를 정확히 짚어야 한다.
:::

## 6. 면접 답변 3단계

1. **한 줄.** "차단은 IP/USER 단위로 챗봇 접근을 막는 입력 게이트, 모더레이션은 메시지 독성을 판정·기록하는 사후 감사로 책임을 분리했습니다."
2. **설계 의도.** "이미 악용이 확인된 대상은 LLM 호출 전에 `ChatbotBlockService.isBlocked`로 차단해 비용을 0으로 만들고, 처음 보는 메시지는 일단 기록한 뒤 부적절 여부를 표시해 추적 가능하게 했습니다. 전역 차단과 섞이지 않게 `CHATBOT_BLOCK` 전용 테이블로 격리했습니다."
3. **구체화.** "도우미 모듈은 다른 담당 소유라 응답 경로를 못 건드려서, 스케줄러가 5분 간격으로 미판정 user 메시지를 Perspective로 스캔해 `ADMIN_ASSISTANT_MODERATION`에 점수와 함께 적재합니다. 임계값은 코드 상수가 아니라 정책 설정값으로 빼서 관리자가 조정합니다."

## 7. 꼬리질문+모범답안

:::details 만료된 차단을 비활성화하는 배치가 따로 있나요?
없습니다. `isBlocked` 쿼리가 `expires_at IS NULL OR expires_at > NOW()` 조건을 직접 검사하므로, 만료된 행은 `is_active`가 1이어도 조회에서 자연히 빠집니다. 별도 만료 배치 없이 SQL 시점 평가로 처리해 상태 불일치 위험을 없앴습니다.
:::

:::details 같은 IP를 두 번 차단하면 행이 중복되나요?
아니요. `UNIQUE(is_active, block_type, block_value)` 제약과 `upsertBlock`의 `ON DUPLICATE KEY UPDATE` 덕분에 같은 대상은 갱신됩니다. 해제 후 재차단이면 사유와 만료가 갱신되며 재활성화됩니다.
:::

:::details common 챗봇과 도우미의 모더레이션은 왜 구현이 다른가요?
판정 주체와 코드 접근성이 다르기 때문입니다. common 챗봇은 우리가 응답 경로를 소유하므로 LLM 응답의 inappropriate 플래그와 사전 의도분류를 인라인으로 박았습니다. 도우미는 무수정 모듈이라 응답 흐름에 끼어들 수 없어, 사후 스케줄러가 Perspective TOXICITY로 비동기 스캔하는 우회 설계를 썼습니다.
:::

:::details 부적절 메시지는 삭제되나요?
삭제하지 않습니다. user 메시지는 부적절로 판정돼도 `CHATBOT_MESSAGE` 또는 `CHAT_COMMENT`에 원문 그대로 남고, 플래그(`is_inappropriate`)나 점수만 추가됩니다. 영구 기록은 관리자 검토와 반복 악용자 식별의 근거가 됩니다.
:::

:::details 독성 임계값을 코드에 하드코딩하지 않은 이유는?
정책 변경 빈도가 높고 운영 중 미세 조정이 필요하기 때문입니다. `ModerationPolicyService.getPolicy().getToxicityThreshold()`로 빼서, 거짓양성이 많으면 재배포 없이 임계값을 올릴 수 있게 했습니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 말할 수 있으면 이 챕터를 이해한 것이다.

- 챗봇 요청이 들어와 차단 대상일 때, LLM 호출 전 어디서 막히는지 클래스·메서드명으로.
- `expires_at`이 NULL일 때와 과거 시각일 때 동작 차이.
- common 챗봇의 `is_inappropriate`와 도우미의 `ADMIN_ASSISTANT_MODERATION`이 각각 누구의 판정으로 채워지는지.
- 스케줄러가 한 번에 50건·200ms 간격으로 도는 이유.

허브로 돌아가기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="챗봇 요청에서 이미 차단된 IP나 USER는 어느 시점에 걸러지나요?" :choices="['LLM 응답을 받은 직후', 'LLM 호출 전 ChatbotService의 첫 관문에서', '스케줄러가 5분마다 스캔할 때', '관리자가 수동으로 확인할 때']" :answer="1" explanation="ChatbotService는 어떤 처리보다 먼저 blockService.isBlocked로 차단을 확인하고, 차단 대상이면 LLM을 부르지 않고 즉시 안전 응답을 반환합니다. 비용과 위험을 0으로 만드는 입력 게이트입니다." />

<QuizBox question="CHATBOT_BLOCK의 expires_at 값이 NULL이면 무엇을 의미하나요?" :choices="['차단이 즉시 만료됨', '영구 차단', '오류 상태', '관리자 승인 대기']" :answer="1" explanation="expires_at이 NULL이면 영구 차단입니다. isBlocked 쿼리는 expires_at IS NULL 또는 expires_at이 NOW보다 미래일 때 활성으로 보므로, NULL은 만료되지 않는 영구 차단으로 동작합니다." />

<QuizBox question="도우미(assistant) 모듈의 독성 모더레이션이 응답 경로 인라인이 아니라 비동기 스케줄러로 구현된 주된 이유는?" :choices="['Perspective API가 느려서', '도우미 모듈은 무수정 대상이라 응답 흐름에 검사 코드를 넣을 수 없어서', 'LLM 비용을 줄이려고', 'DB 부하를 줄이려고']" :answer="1" explanation="도우미 모듈은 다른 담당자 소유의 무수정 모듈이라 ask 응답 경로에 Perspective 검사를 직접 삽입할 수 없습니다. 그래서 스케줄러가 사후에 미판정 user 메시지를 스캔해 ADMIN_ASSISTANT_MODERATION에 적재하는 우회 방식을 씁니다." />
