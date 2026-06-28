---
title: "독성 감지 (Perspective)"
owner: B
domain: "커뮤니티·신고"
tags: ["Perspective", "모더레이션"]
---

# 독성 감지 (Perspective)

> 사용자가 쓴 글·댓글·문의를 Google Perspective API로 검사해 독성으로 판정되면 `ai_flagged=1`로 표시하고, 일반 사용자에게는 가려서(BLUR) 보여주되 차단은 관리자 손에 남긴다.

이 페이지는 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)의 하위 챕터다. 핵심 설계 근거는 ADR-0010(AI 모더레이션 풀 스택 파이프라인)이다.

## 1. 한 줄 정의

독성 감지는 사용자 입력의 혐오·욕설·비방 정도를 Google Perspective API의 TOXICITY 점수(0.0~1.0)로 측정해, 정책 임계값을 넘으면 콘텐츠에 AI 플래그를 달아 약한 시그널로 다루는 모더레이션 레이어다.

## 2. 왜 이렇게 설계했나

핵심은 AI 판정을 자동 차단에 직접 연결하지 않는다는 철학이다. ADR-0010은 세 가지 선택지를 비교했다.

| 옵션 | 호출 방식 | 차단 방식 | 문제 |
| --- | --- | --- | --- |
| A | 동기 | 자동 차단 | 작성 응답 지연 + 오탐 즉시 차단 |
| B | 비동기 | 자동 차단 | 지연은 해결, 오탐 차단 비용은 잔존 |
| C(선택) | 비동기 | 플래그 + BLUR + 관리자 해제 | 지연 0 + 오탐을 사람이 흡수 |

선택 근거는 두 가지다.

- 응답 지연 회피. Perspective 호출은 1~5초가 걸릴 수 있어 글 등록 응답을 막으면 안 된다. 그래서 등록은 즉시 끝내고 검사는 비동기로 돌린다.
- 오탐(false positive) 비용 흡수. AI는 정상 글을 독성으로 오판할 수 있다. 자동 차단 대신 BLUR(가림)로 점진 공개하고, 최종 판단은 관리자에게 남긴다.

이 방향은 신고 자동 차단을 금지한 ADR-0001의 Human-in-the-Loop 원칙을 AI 시그널에도 똑같이 적용한 것이다.

:::tip 자주 헷갈리는 점
GROUNDING이나 표면적 설명에서 임계 초과 시 등록 차단이라고 읽기 쉽지만, 실제 코드는 등록을 막지 않는다. 먼저 저장하고 사후에 비동기로 `ai_flagged`만 세팅한다. 옵션 A·B는 ADR-0010에서 명시적으로 기각됐다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 | 실제 식별자 |
| --- | --- |
| API 호출 서비스 | `org.triptogether.perspective.PerspectiveService` |
| 외부 엔드포인트 | Perspective commentanalyzer v1alpha1 comments:analyze |
| HTTP 클라이언트 | Spring `RestTemplate` (POST JSON) |
| 임계값 정책 | `ModerationPolicyService` + `ContentModerationPolicyVO` |
| 정책 테이블 | `CONTENT_MODERATION_POLICY` (단일 행, toxicity_level enum) |
| 콘텐츠 플래그 컬럼 | community_post / community_comment / inquiry_post 의 `ai_flagged` |
| 게시글·댓글 플래그 | `CommunityServiceImpl.flagPostAsToxic` / `flagCommentAsToxic` |
| 문의 플래그 | `InquiryServiceImpl.flagInquiryAsToxic` |
| AI 도우미 메시지 검사 | `AdminAssistantModerationServiceImpl` + `ADMIN_ASSISTANT_MODERATION` |

요청 바디는 검사 텍스트, 언어 ko, 요청 속성 TOXICITY 세 가지로 구성하고, 응답의 attributeScores TOXICITY summaryScore value를 점수로 읽는다.

```java
// PerspectiveService 발췌 (추상화)
public boolean isToxic(String text) {
    Double score = getToxicityScore(text);   // 실패 시 null
    if (score == null) return false;          // fail-safe: 검사 건너뜀
    double threshold = moderationPolicyService.getPolicy().getToxicityThreshold();
    return score >= threshold;
}
```

`getToxicityScore`는 빈 텍스트나 API 실패 시 null을 돌려주고, `isToxic`은 null이면 false로 처리한다. 즉 외부 API 장애가 글쓰기 자체를 막지 않는다(fail-safe).

## 4. 동작 원리 (흐름·표·작은 코드)

작성 시점이 아니라 등록 직후 비동기 검사다. 컨트롤러는 글을 저장한 뒤 `@Async` 메서드를 호출하고 바로 응답을 반환한다.

```text
[컨트롤러] 글/댓글/문의 INSERT
   -> 즉시 응답 반환
   -> checkAndFlagPostAsync(id, text)   // @Async, 별도 스레드
        -> isToxic(text)?
             yes -> flagPostAsToxic(id)  // ai_flagged=1
[다음 페이지 로드] SELECT 결과에 ai_flagged 포함
   ├ 일반 사용자 -> JSP isBlurred=true -> BLUR 오버레이 + 펼침
   └ 관리자      -> 원문 + 배지 + 가림 해제 버튼
[관리자 클릭] clearPostBlur -> ai_flagged=0
```

임계값은 정책 테이블의 `toxicity_level` enum을 점수로 환산한다.

| toxicity_level | 임계값 | 의미 |
| --- | --- | --- |
| STRICT | 0.6 | 민감하게 더 많이 잡음 |
| NORMAL(기본) | 0.8 | 표준 |
| LOOSE | 0.9 | 확실한 것만 잡음 |

플래그가 달릴 때 단순히 컬럼만 바꾸지 않는다. `flagPostAsToxic`은 트랜잭션 안에서 SYSTEM 봇 계정 이름으로 신고를 자동 등록해 관리자 신고 게시판에 합류시키고, 처음 가려지는 경우 작성자에게 가림 알림(FeedNotification)을 보낸다. 이미 신고 누적으로 가려져 있던 글이면 중복 알림을 보내지 않는다.

AI 도우미 채팅은 경로가 다르다. 작성 즉시 검사가 아니라 `AdminAssistantModerationServiceImpl`이 대기 중 user 메시지를 배치로 훑어 `getToxicityScore`로 점수를 받고, `ADMIN_ASSISTANT_MODERATION` 테이블에 `is_inappropriate`와 `toxicity_score`(decimal 4,3)로 저장해 관리자 모니터링에 쓴다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 구현 완료
- 커뮤니티 게시글·댓글, 문의 본문의 비동기 독성 검사와 `ai_flagged` 플래그
- 정책 테이블 기반 STRICT/NORMAL/LOOSE 임계값 외부화(ADR-0009)
- 일반 사용자 BLUR + 관리자 원문 노출 + 가림 해제(clearBlur)
- 독성 감지 시 SYSTEM 봇 자동 신고 + 작성자 알림
- AI 도우미 메시지 배치 검사 결과 저장
:::

:::warning 한계 / 향후 과제
- 비동기 호출이 실패하면 `ai_flagged`가 갱신되지 않는다. 자동 재시도 정책은 별도 과제다.
- 검사 언어가 ko로 고정되어 있어 다국어 입력의 정확도는 검증 대상이다.
- AI 응답·판정 품질의 정량 평가 체계는 아직 없다(프로젝트 전체 공통 한계).
- BLUR UI는 JSP/JS까지 봐야 전체 흐름이 보이므로, 코드만으로는 미구현으로 오해되기 쉽다(ADR-0010이 이를 명시).
:::

## 6. 면접 답변 3단계

1. 한 문장. 사용자 입력을 Perspective API로 검사해 독성 점수가 정책 임계값을 넘으면 `ai_flagged`로 표시하고, 일반 사용자에게는 가리되 차단은 관리자에게 맡기는 모더레이션 레이어를 만들었다.
2. 설계 이유. 동기 자동 차단은 응답 지연과 오탐 차단 비용이 커서, ADR-0010에서 비동기 검사 + BLUR + 관리자 해제를 선택했다. AI를 약한 시그널로 다루는 Human-in-the-Loop 원칙이다.
3. 구체 근거. `PerspectiveService.isToxic`이 `CONTENT_MODERATION_POLICY`의 임계값과 비교하고, `@Async` 콜백이 `flagPostAsToxic`을 호출해 ai_flagged 세팅 + SYSTEM 봇 자동 신고 + 작성자 알림까지 한 트랜잭션으로 처리한다. API 실패 시 false로 떨어지는 fail-safe도 넣었다.

## 7. 꼬리질문 + 모범답안

:::details 동기로 검사하면 안 되나요
Perspective 호출은 1~5초가 걸릴 수 있어 글 등록 응답을 그만큼 지연시킨다. 그래서 등록은 즉시 끝내고 검사를 `@Async`로 분리했다. 사용자 입장에서 작성 지연은 0이다.
:::

:::details 왜 감지 즉시 차단하지 않나요
AI는 정상 글을 독성으로 오판할 수 있다. 자동 차단하면 오탐이 그대로 차단으로 이어진다. 대신 일반 사용자에게만 가리고(BLUR) 관리자가 원문을 보고 해제할 수 있게 해 오탐 비용을 사람이 흡수한다. 신고 자동 차단을 금지한 ADR-0001과 같은 철학이다.
:::

:::details API 키가 죽거나 호출이 실패하면 어떻게 되나요
`getToxicityScore`가 null을 반환하고 `isToxic`은 false로 처리한다. 검사를 건너뛸 뿐 글쓰기 자체는 정상 동작한다. 외부 의존성 장애가 핵심 기능을 막지 않게 한 fail-safe 설계다. 다만 그 글은 플래그가 안 달리므로, 실패 재시도는 향후 과제로 남겨 두었다.
:::

:::details 임계값은 어떻게 조정하나요
하드코딩하지 않고 `CONTENT_MODERATION_POLICY` 단일 행에 toxicity_level enum으로 두었다. STRICT는 0.6, NORMAL은 0.8, LOOSE는 0.9로 환산된다. 관리자가 정책만 바꾸면 코드 배포 없이 민감도를 조정할 수 있다(ADR-0009 정책 외부화).
:::

:::details 게시글, 댓글, 문의 세 곳을 어떻게 일관되게 처리하나요
세 모듈 모두 같은 패턴이다. 각자 `ai_flagged` 컬럼을 두고, flagXxxAsToxic으로 세팅, clearXxxBlur로 해제, JSP에서 isBlurred 분기로 렌더링한다. 동일 패턴이라 학습 곡선이 낮고 재사용성이 높다.
:::

## 8. 직접 말해보기

- 동기 자동 차단(옵션 A) 대신 비동기 + BLUR(옵션 C)를 고른 이유를 오탐 비용과 응답 지연 두 축으로 30초 안에 설명해 보자.
- `ai_flagged` 플래그 하나가 DB, 서비스, JSP, 관리자 액션 네 레이어에서 어떻게 같은 신호로 쓰이는지 흐름으로 말해 보자.
- Perspective API가 다운됐을 때 시스템이 어떻게 동작하고, 그 선택의 트레이드오프가 무엇인지 설명해 보자.

## 퀴즈

<QuizBox question="독성으로 판정된 게시글에 대한 실제 동작으로 가장 정확한 것은?" :choices="['등록 자체를 동기적으로 차단한다', '비동기로 ai_flagged를 1로 세팅하고 일반 사용자에게 BLUR 처리한다', '작성자 계정을 자동 정지한다', '댓글만 검사하고 게시글은 검사하지 않는다']" :answer="1" explanation="ADR-0010은 동기 자동 차단을 기각하고, 등록은 즉시 끝낸 뒤 @Async 콜백으로 ai_flagged=1을 세팅해 일반 사용자에게만 가려 보여주는 옵션 C를 선택했다." />

<QuizBox question="Perspective API 호출이 실패했을 때 isToxic의 동작은?" :choices="['예외를 던져 글쓰기를 막는다', 'true를 반환해 무조건 가린다', 'false를 반환해 검사를 건너뛴다', '동기로 재시도를 무한 반복한다']" :answer="2" explanation="getToxicityScore가 null을 반환하면 isToxic은 false로 처리한다. 외부 API 장애가 핵심 기능을 막지 않도록 한 fail-safe 설계다." />

<QuizBox question="CONTENT_MODERATION_POLICY의 toxicity_level이 STRICT일 때 적용되는 독성 임계값은?" :choices="['0.6', '0.8', '0.9', '1.0']" :answer="0" explanation="STRICT는 0.6, NORMAL은 0.8, LOOSE는 0.9로 환산된다. 값이 낮을수록 더 민감하게 잡는다. 정책은 코드가 아니라 테이블에서 관리한다." />
