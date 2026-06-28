---
title: "등급별 쿼터"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["쿼터", "등급"]
---

# 등급별 쿼터

> 챗봇 호출 비용을 회원 등급에 비례해 분배하고, 비로그인까지 포함한 모든 사용자의 LLM 남용을 주기 단위로 차단하는 한도 시스템.

## 1. 한 줄 정의

등급별 쿼터는 사용자의 회원 등급에 따라 한 주기 안에 보낼 수 있는 챗봇 메시지 수와 동시 보유 대화 수에 상한을 두고, `ChatbotQuotaService`가 매 요청마다 사용량을 확인·증가시켜 한도 초과를 막는 정책이다.

## 2. 왜 이렇게 설계했나

챗봇은 외부 LLM(Google Gemini)을 호출하므로 호출마다 실제 비용과 지연이 발생한다. 제한이 없으면 한 사용자가 무한히 호출해 비용을 폭증시키거나 응답 속도를 떨어뜨릴 수 있다. 그래서 다음 원칙으로 설계했다.

- **등급에 비례한 자원 분배**: 활동/결제 등으로 등급이 높은 사용자에게 더 많은 호출을 허용한다. 게스트(비로그인)는 가장 좁게 제한한다.
- **비로그인도 식별·제한**: 비로그인은 계정이 없으므로 IP 주소를 식별자로 사용해 동일하게 한도를 적용한다.
- **DB 우선 정책**: 한도 수치를 코드에 박지 않고 `CHATBOT_GRADE_QUOTA` 테이블에 두어, 관리자가 코드 배포 없이 즉시 조정할 수 있게 했다.
- **주기(period) 기반 리셋**: 단순 일일 카운터가 아니라 주기 길이(1·2·3·7·30일 등)와 리셋 시각을 설정할 수 있게 해, 한도 정책을 유연하게 운영한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 한도 정책 서비스 | `ChatbotQuotaService` | 등급 해석, 한도 조회, 주기 시작 계산, 사용량 증감 |
| 매퍼 인터페이스 | `ChatbotQuotaMapper` | 한도/사용량 SQL 바인딩 (@Mapper) |
| 매퍼 XML | `chatbotQuotaMapper.xml` | upsert·차감 등 실제 쿼리 |
| 등급 한도 VO | `ChatbotQuotaVO` | `CHATBOT_GRADE_QUOTA` 매핑 |
| 사용량 VO | `ChatbotDailyUsageVO` | `CHATBOT_DAILY_USAGE` 매핑 |
| 호출 지점 | `ChatbotService` | 메시지 전송 흐름에서 한도 검사·증가 |
| 환급 지점 | `ChatbotController` | 대화 삭제 시 사용량 환급 |

테이블 컬럼 요약:

- `CHATBOT_GRADE_QUOTA`: `grade`(UNIQUE), `max_messages_per_period`(주기당 메시지 한도), `max_conversations`(동시 보유 대화 한도), `max_context_messages`(LLM에 보낼 최근 메시지 수), `period_days`, `reset_hour`, `reset_minute`, `quota_refund_enabled`.
- `CHATBOT_DAILY_USAGE`: `user_idx` 또는 `ip_address`, `period_start`(현재 주기 시작 시각), `message_count`. UNIQUE 제약이 `(user_idx, period_start)`와 `(ip_address, period_start)` 두 개로 걸려 있어 upsert의 키가 된다.

기본 정책값(관리자 수정 가능): 게스트 18 / 실버 60 / 골드 120 / 플래티넘 600 메시지 per 주기. 등급 체계는 `GUEST, BRONZE, SILVER, GOLD, DIAMOND, PLATINUM`이며, 로그인했지만 등급 정보가 비어 있으면 `BRONZE`로 처리한다.

## 4. 동작 원리 (흐름·표·작은 코드)

메시지 전송 1회의 한도 처리 흐름:

| 단계 | 처리 | 담당 |
| --- | --- | --- |
| 1 | 사용자 등급 해석 (비로그인은 GUEST) | `resolveGrade` |
| 2 | 등급에 맞는 한도 조회 (없으면 GUEST 폴백) | `getQuotaByGrade` |
| 3 | 관리자/슈퍼관리자면 검사 면제 | `isQuotaExempt` |
| 4 | 현재 주기 사용량 조회 후 한도 비교 | `getCurrentPeriodUsage` |
| 5 | 한도 도달 시 차단 응답 반환 | `quotaExceededResponse` |
| 6 | 통과 시 LLM 호출 후 사용량 +1 | `incrementUsage` |

핵심 검사 코드(추상화):

```java
String grade = quotaService.resolveGrade(loginUser);
ChatbotQuotaVO quota = quotaService.getQuotaByGrade(grade);
boolean exempt = quotaService.isQuotaExempt(loginUser);

if (!exempt && quota != null) {
    int usage = quotaService.getCurrentPeriodUsage(userIdx, ip, quota);
    if (usage >= quota.getMaxMessagesPerPeriod()) {
        return quotaExceededResponse(quota.getMaxMessagesPerPeriod());
    }
}
// ... LLM 호출 성공 후
quotaService.incrementUsage(userIdx, ip, quota);
```

**주기 시작 계산이 핵심이다.** 단순히 오늘 날짜를 쓰지 않고, 고정 앵커(2000-01-01의 리셋 시각)부터 `period_days * 24`시간 간격으로 현재 시각을 floor 해 현재 주기의 시작 시각을 구한다. 그 값이 `period_start`가 되고, 사용량 행의 식별 키가 된다. 주기가 바뀌면 키가 달라져 새 행이 생기므로, 별도의 스케줄러 없이 카운터가 자연스럽게 리셋된다.

**증가는 원자적 upsert로 처리한다.** 사용량 +1은 애플리케이션에서 조회 후 갱신하지 않고, DB의 `INSERT ... ON DUPLICATE KEY UPDATE message_count = message_count + 1`로 한 번에 처리해 동시 요청 경합을 방지한다.

**환급(refund)**: 사용자가 대화를 삭제하면 `quota_refund_enabled`가 켜진 등급에 한해, 그 주기 동안의 사용자 메시지 수만큼 `decreaseUsage`로 차감한다. 음수가 되지 않도록 SQL에서 `GREATEST(0, message_count - amount)`로 보호하고, 해당 주기 행이 없으면 아무 일도 하지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 등급별 한도 정책 테이블(`CHATBOT_GRADE_QUOTA`)과 관리자 편집(`updateQuota`).
- 주기 기반 사용량 집계, 원자적 upsert 증가, 음수 방지 차감.
- 비로그인 IP 기준 한도, 관리자/슈퍼관리자 면제.
- 한도 초과 시 차단 응답, 동시 대화 수 한도(`max_conversations`), 컨텍스트 길이 제한(`max_context_messages`).
- 대화 삭제 시 조건부 환급.
:::

:::warning 한계·주의
- 한도 수치는 DB에 시드 INSERT로 고정 커밋되어 있지 않고 운영 DB에서 관리·편집하는 정책값이다. 기본 정책은 게스트 18 / 실버 60 / 골드 120 / 플래티넘 600.
- 비로그인 식별이 IP 기반이라, 공유 IP(회사·학교 NAT) 뒤 사용자들은 한도를 공유하게 된다.
- `chatbotQuotaMapper.xml`의 upsert 주석에 `usage_date`, `anon_session_id` 같은 옛 이름이 남아 있으나 실제 컬럼은 `period_start`, `ip_address`다. 동작에는 영향이 없는 주석 불일치다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "챗봇은 외부 LLM을 호출하므로, 회원 등급별로 주기당 메시지 수와 동시 대화 수에 상한을 두어 비용과 남용을 통제하는 쿼터 시스템을 만들었습니다."
2. **설계 포인트**: "한도 수치는 코드가 아니라 `CHATBOT_GRADE_QUOTA` 테이블에 두어 관리자가 배포 없이 조정하고, 사용량은 주기 시작 시각을 키로 하는 `CHATBOT_DAILY_USAGE`에 원자적 upsert로 집계해 동시 요청 경합을 막았습니다."
3. **차별점**: "비로그인은 IP로 동일하게 제한하고, 주기 시작을 고정 앵커 기준으로 floor 계산해 스케줄러 없이 리셋되며, 대화 삭제 시에는 등급 설정에 따라 사용량을 환급합니다."

## 7. 꼬리질문 + 모범답안

:::details 사용량 증가를 왜 조회 후 갱신하지 않고 upsert로 했나
조회 후 갱신은 두 요청이 같은 카운터를 동시에 읽으면 한쪽 증가가 사라지는 lost update가 발생한다. `INSERT ... ON DUPLICATE KEY UPDATE message_count = message_count + 1`은 DB가 행 잠금 안에서 더하므로 동시 요청에도 카운트가 정확하다. UNIQUE 키가 `(user_idx, period_start)`와 `(ip_address, period_start)`로 걸려 있어 첫 요청은 INSERT, 이후는 UPDATE로 처리된다.
:::

:::details 한도는 매일 자정에 리셋되나
꼭 그렇지 않다. 주기 길이는 `period_days`로, 리셋 시각은 `reset_hour`·`reset_minute`로 설정한다. 서비스는 고정 앵커(2000-01-01의 리셋 시각)부터 주기 길이 단위로 현재 시각을 floor 해 현재 주기 시작을 구하고, 그 값을 `period_start` 키로 쓴다. 주기가 바뀌면 새 키의 새 행이 생기므로 카운터가 자연히 0부터 시작한다. 별도 리셋 배치는 없다.
:::

:::details 비로그인 사용자는 어떻게 식별하나
계정이 없으므로 IP 주소를 식별자로 쓴다. 사용량 행은 `user_idx`가 null이고 `ip_address`로 키를 잡으며, 조회·증가·차감 모두 로그인 여부에 따라 분기한다. 단점은 같은 IP를 공유하는 사용자들이 한도를 공유한다는 점이다.
:::

:::details 관리자도 한도가 적용되나
아니다. `isQuotaExempt`가 역할을 보고 ADMIN·SUPERADMIN이면 한도 검사와 사용량 증가를 모두 건너뛴다. 운영·점검 중 관리자가 한도에 막히지 않도록 한 예외다.
:::

:::details 대화를 삭제하면 한도가 돌아오나
등급의 `quota_refund_enabled`가 켜져 있을 때만 돌아온다. 삭제된 대화에서 현재 주기 동안 사용자가 보낸 메시지 수만큼 `decreaseUsage`로 차감하며, SQL에서 `GREATEST(0, ...)`로 음수를 막고 해당 주기 행이 없으면 아무 작업도 하지 않는다.
:::

## 8. 직접 말해보기

- 등급별 쿼터가 막으려는 문제와, 한도 수치를 DB에 둔 이유를 90초로 설명해보자.
- 사용량 +1을 upsert로 처리했을 때 동시 요청에서 어떤 버그를 막는지 말로 풀어보자.
- "스케줄러 없이 어떻게 한도가 리셋되나"라는 질문에 주기 시작 계산을 들어 답해보자.

## 퀴즈

<QuizBox question="등급별 쿼터에서 사용량 +1 을 INSERT ... ON DUPLICATE KEY UPDATE 로 처리한 가장 큰 이유는?" :choices="['SQL 코드가 짧아져서', '동시 요청에서 lost update 를 막아 카운트를 정확히 유지하려고', '비로그인 사용자를 차단하려고', '관리자 면제를 구현하려고']" :answer="1" explanation="조회 후 갱신은 동시 요청 시 한쪽 증가가 사라지는 lost update 가 생긴다. DB 잠금 안에서 더하는 upsert 로 이를 막는다." />

<QuizBox question="CHATBOT_DAILY_USAGE 에서 현재 주기 사용량 행을 식별하는 키로 쓰이는 컬럼은?" :choices="['message_count', 'quota_id', 'period_start 와 user_idx 또는 ip_address', 'updated_by']" :answer="2" explanation="UNIQUE 제약이 user_idx 와 period_start, ip_address 와 period_start 두 조합으로 걸려 있어 주기 시작 시각이 사용량 행의 키가 된다." />

<QuizBox question="관리자(ADMIN/SUPERADMIN)에게 쿼터는 어떻게 적용되나?" :choices="['게스트와 동일하게 적용된다', 'isQuotaExempt 로 한도 검사와 사용량 증가가 모두 면제된다', '플래티넘 한도가 적용된다', '한도가 절반으로 줄어든다']" :answer="1" explanation="isQuotaExempt 가 역할을 확인해 관리자/슈퍼관리자는 한도 검사와 증가를 모두 건너뛴다." />
