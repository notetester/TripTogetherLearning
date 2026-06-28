---
title: "모더레이션 파이프라인"
owner: A
domain: "관리자·운영"
tags: ["모더레이션"]
---

# 모더레이션 파이프라인

> 자동화는 약한 신호(BLUR)까지만, 삭제·차단 같은 결정적 액션은 사람이 판단한다. AI 독성 감지와 신고 누적을 같은 신고 큐로 모으고, 관리자가 최종 결정권을 쥐는 Human-in-the-Loop 구조다.

이 문서는 TripTogether 4인 공동 개발 중 관리자·운영 도메인에 속한 모더레이션 파이프라인을 다룬다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 운영 관점의 거버넌스 흐름은 [모더레이션·거버넌스](/flow/moderation-governance)에서 이어진다.

## 1. 한 줄 정의

사용자 콘텐츠(게시글·댓글·문의)의 위험 신호를 **AI 독성 감지**와 **신고 누적**이라는 두 입력으로 받아, 일반 사용자에게는 BLUR(가림)만 자동 적용하고, 모든 신호를 단일 신고 큐로 모아 **관리자가 최종 처분**하는 운영 파이프라인.

## 2. 왜 이렇게 설계했나

핵심 결정은 두 개의 ADR에 정리되어 있다.

- **ADR-0001 — 자동 차단 금지.** 교과서 패턴인 "신고 N회 누적 → 자동 삭제·차단"은 false positive 비용이 매우 크다. 단순 취향 차이나 신고 도배(brigading)만으로 정상 콘텐츠가 사라지면 신뢰 회복이 어렵다. 그래서 자동화의 경계를 BLUR까지로 긋고, 삭제·계정 차단·기각은 관리자 수동 판단으로 남겼다.
- **ADR-0010 — AI 모더레이션 풀 스택.** AI 독성 점수도 동일한 철학으로 다룬다. AI를 자동 차단에 직접 연결하지 않고 "약한 시그널"로 취급해, false positive를 인간 검토로 흡수한다.

설계 드라이버를 요약하면:

| 드라이버 | 적용 방식 |
| --- | --- |
| 응답 지연 회피 | 독성 검사는 글 저장 후 비동기 호출 |
| false positive 비용 최소화 | 자동 처리는 BLUR까지, 결정적 액션은 사람 |
| 운영 일관성(DRY) | AI 감지든 사용자 신고든 같은 신고 큐로 합류 |
| 관리자 결정권 보존 | BLUR 해제·삭제·차단·기각을 단건/일괄로 제공 |

:::tip 업계 레퍼런스
Reddit AutoModerator, Discord AutoMod, YouTube Trust and Safety, Stack Overflow 모더레이션 큐가 모두 같은 패턴이다. 자동화는 약한 신호 처리, 결정적 액션은 인간 검토.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 역할 | 클래스 / 테이블 |
| --- | --- |
| 독성 점수 산출 | `PerspectiveService` (Google Perspective API, TOXICITY 0~1) |
| 임계값 정책 | `ModerationPolicyServiceImpl` + `ContentModerationPolicyVO` (DB 단일 행, 캐시) |
| AI 플래그 세팅 + 자동 신고 | `CommunityServiceImpl.flagPostAsToxic` / `flagCommentAsToxic`, `InquiryServiceImpl.flagInquiryAsToxic` |
| 신고 큐 접수 | `ReportServiceImpl.submitReport` → REPORT 테이블 |
| 시스템 봇 주체 | `SystemUser.BOT_USER_IDX` (USERS user_role SYSTEM) |
| 신고 처분(단건) | `ReportServiceImpl.updateReportStatus` |
| 콘텐츠 일괄 처분 | `AdminCommunityServiceImpl.bulkBlockPosts` / `bulkDeletePosts` 등, `AdminCommunityController` bulk-action |
| 가림 상태 컬럼 | `COMMUNITY_POST.ai_flagged` / `report_count` / `post_status`, 댓글·문의 동일 패턴 |

독성 검사 자체는 `PerspectiveService.isToxic`에서 raw 점수를 정책 임계값과 비교한다. 정책은 `ContentModerationPolicyVO.toxicityLevel`을 임계값으로 환산한다(STRICT 0.6 / NORMAL 0.8 / LOOSE 0.9). API 키는 `perspective.api.key` 설정값으로 주입한다(공개 문서에서는 자리표시자 `API_KEY`로 표기).

## 4. 동작 원리 (흐름·표·작은 코드)

### 전체 흐름

```text
[사용자 작성 / 컨트롤러]
   -> 글 INSERT 후 PerspectiveService 비동기 호출 (@Async)
        -> isToxic(text): raw 점수 >= 정책 임계값 ?
              -> flagPostAsToxic(postId)
                    -> ai_flagged = 1
                    -> submitReport(post, postId, SYSTEM 봇, toxicity, ...)  // DRY: 기존 신고 큐 재사용
   [별도 경로] 사용자 신고 -> submitReport -> report_count 증가 -> 3회 누적 시 BLUR

[다음 페이지 로드]
   -> 일반 사용자: report_count >= 임계값 OR ai_flagged=1  -> BLUR 오버레이 + 클릭 펼침
   -> 관리자:   원본 노출 + 신고 배지 + 해제/처분 도구

[관리자 처분]
   -> 단건: updateReportStatus(RESOLVED / DISMISSED) + 신고자 알림
   -> 일괄: bulk-action(action=block|delete) -> post_status BLOCKED/DELETED
```

### 비동기 + fail-safe

독성 검사는 글 저장 응답을 막지 않도록 `@Async`로 돌린다. API가 1~5초 지연되거나 실패해도 사용자 경험은 영향받지 않는다.

```java
@Async
public void checkAndFlagPostAsync(Long postId, String text) {
    try {
        if (isToxic(text)) {
            communityService.flagPostAsToxic(postId);
        }
    } catch (Exception e) {
        // fail-safe: 검사 실패는 사용자 흐름을 막지 않음
    }
}
```

`isToxic`는 API 호출 실패 시 점수 null로 보고 false를 반환한다. 즉 검사가 불확실하면 가리지 않는 쪽(fail-open)으로 동작해, 정상 콘텐츠가 오류로 가려지는 것을 막는다.

### DRY: 두 입력을 하나의 큐로

AI 감지든 사용자 신고든 결국 `submitReport`로 들어가 REPORT 테이블에 INSERT된다. AI 감지는 신고 주체가 사람이 아니라 SYSTEM 봇 계정(`SystemUser.BOT_USER_IDX`)이고, 사유는 toxicity로 들어간다. 신고 처리 화면, 중복 방지, 상태 머신을 그대로 재사용한다.

### BLUR vs BLOCKED (ADR-0003)

가림은 두 가지 의미가 섞이지 않게 분리되어 있다.

| 상황 | post_status | report_count / ai_flagged | 일반 사용자 | 관리자 모드 |
| --- | --- | --- | --- | --- |
| 정상 | ACTIVE | 임계값 미만, ai_flagged 0 | 정상 노출 | 정상 노출 |
| 신고 3회 누적(자동) | ACTIVE 유지 | report_count 임계값 이상 | BLUR 오버레이 | 원본 + 신고 배지 |
| AI 독성 감지(자동) | ACTIVE 유지 | ai_flagged 1 | BLUR 오버레이 | 원본 + 신고 배지 |
| 관리자 직접 차단 | BLOCKED | 무관 | 완전 숨김 | 차단 표시 + 해제 |
| 작성자 삭제 | DELETED | 무관 | 완전 숨김 | 감사 로그에만 존재 |

핵심은 BLUR 렌더링 조건이 `report_count 임계값 이상 그리고 관리자 모드 아님`이고 post_status 조건이 없다는 점이다. 자동 처리는 ACTIVE를 유지한 채 BLUR만 입힌다. BLOCKED는 관리자 결정 전용이며 완전 숨김이다.

### 관리자 처분: 단건과 일괄

- **단건 신고 처분** — `updateReportStatus`가 REPORT.status를 RESOLVED(처리 완료) 또는 DISMISSED(반려)로 바꾸고, 신고자에게 FeedNotification으로 결과를 알린다(targetUrl 포함). 처리자(resolver_idx)와 처리 결과(resolve_action)도 기록한다.
- **콘텐츠 일괄 처분** — `AdminCommunityController`의 bulk-action 엔드포인트가 `action=block|delete`와 id 목록을 받아 게시글·댓글 status를 BLOCKED/DELETED로 일괄 전환한다.
- **오신고 정정** — 관리자가 false positive로 판단하면 BLUR을 해제(`clearPostBlur` 류)해 약한 신호를 되돌린다.

신고 상태 머신은 IN_REVIEW(검토 중)에서 시작해 RESOLVED / DISMISSED로 종결되고, 신고자 본인은 IN_REVIEW일 때만 수정·취소(CANCELLED)할 수 있다. 취소된 신고가 다시 들어오면 재활성화한다(ADR-0004 중복 방지와 결합).

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Perspective 비동기 독성 검사 + ai_flagged | 구현됨 (게시글·댓글·문의 동등) |
| SYSTEM 봇 자동 신고(DRY) | 구현됨 |
| 신고 누적 BLUR + 관리자 BLOCKED 분리 | 구현됨 (ADR-0003) |
| 단건 처분 + 신고자 알림 | 구현됨 |
| 일괄 처분 bulk-action | 구현됨 |
| 임계값 정책 외부화(DB 단일 행) | 구현됨 (ADR-0009) |
| 비동기 호출 실패 시 자동 재시도 | 미구현 (실패하면 ai_flagged 갱신 안 됨, 재시도 정책 별도 과제) |
| AI 독성 판정 품질 정량 평가 | 미구현 (false positive율 측정 체계 부재) |

:::warning 정직한 한계
독성 검사가 비동기라 호출이 실패하면 그 글은 ai_flagged가 0인 채 남는다. 재시도/백필 정책이 없는 것이 현재의 알려진 공백이다. 또한 임계값(NORMAL 0.8 등)은 경험적 값일 뿐, 실제 오탐률을 정량 평가한 결과는 아니다.
:::

## 6. 면접 답변 3단계

1. **한 문장.** TripTogether 모더레이션은 AI 독성 감지와 신고 누적을 두 입력으로 받아, 자동으로는 가림(BLUR)까지만 하고 삭제·차단은 관리자가 결정하는 Human-in-the-Loop 파이프라인입니다.
2. **설계 의도.** 자동 차단은 false positive 비용이 너무 커서, AI 점수도 신고도 "약한 신호"로만 다뤘습니다. 두 입력을 SYSTEM 봇 계정으로 같은 신고 큐(REPORT)에 합류시켜 처리 화면·중복 방지를 재사용한 게 DRY 포인트입니다.
3. **구현 디테일.** Perspective 호출은 글 저장 응답을 막지 않게 비동기로 돌리고, 실패하면 가리지 않는 fail-open으로 둡니다. 가림은 ACTIVE 유지 + BLUR, 관리자 차단은 BLOCKED 완전 숨김으로 의미를 분리했고, 처분은 단건과 bulk-action을 모두 지원합니다.

## 7. 꼬리질문 + 모범답안

:::details 신고 3회 누적이면 글을 자동 삭제하지 왜 BLUR만 하나요?
자동 삭제는 false positive 비용이 큽니다. 단순 취향 차이나 여러 계정을 동원한 신고 도배만으로 정상 콘텐츠가 사라지면 신뢰 회복이 어렵습니다. 그래서 자동화는 약한 신호인 BLUR까지만 적용하고, 삭제·차단은 신고 맥락(사유·설명·누적 횟수)을 본 관리자가 판단합니다. ADR-0001의 결정입니다.
:::

:::details AI가 독성으로 잘못 판정하면 어떻게 정정하나요?
AI 감지는 자동 차단이 아니라 BLUR + 신고 큐 합류로 끝납니다. 관리자가 큐에서 원본을 확인하고 false positive로 판단하면 BLUR을 해제합니다. AI의 오탐 비용을 인간 검토로 흡수하는 구조라, 잘못 판정해도 사용자에게 가는 피해가 가림 정도로 제한됩니다.
:::

:::details 독성 검사를 동기로 하지 않은 이유는?
Perspective API는 1~5초까지 지연될 수 있어 동기로 호출하면 글 작성 응답이 그만큼 느려집니다. 그래서 글을 먼저 저장하고 검사를 @Async로 돌립니다. 검사 결과는 다음 페이지 로드 때 ai_flagged로 반영됩니다. 호출이 실패해도 사용자 흐름은 막히지 않습니다.
:::

:::details BLUR과 BLOCKED는 뭐가 다른가요?
BLUR은 신고 누적이나 AI 감지로 인한 약한 신호입니다. post_status는 ACTIVE를 유지한 채 일반 사용자에게만 가림 오버레이를 씌우고, 클릭하면 펼쳐 봅니다. BLOCKED는 관리자가 직접 내린 강한 결정으로 status를 BLOCKED로 바꿔 목록에서 완전히 숨깁니다. 두 경로를 합치면 BLOCKED인데 BLUR 오버레이라는 모순이 생겨 ADR-0003에서 분리했습니다.
:::

:::details 같은 신고 큐를 쓴다는 게 운영에 어떤 이점이 있나요?
AI 감지든 사용자 신고든 REPORT 테이블 한 곳으로 모여, 관리자는 화면 하나에서 모든 위험 콘텐츠를 검토합니다. 중복 방지, 상태 머신, 신고자 알림, 단건/일괄 처분 로직을 두 입력이 공유하므로 코드가 중복되지 않습니다. AI 감지를 SYSTEM 봇이 올린 신고로 모델링한 게 그 핵심입니다.
:::

## 8. 직접 말해보기

- TripTogether 모더레이션이 자동 차단을 하지 않는 이유를 false positive 관점에서 30초로 설명해 보세요.
- AI 독성 감지가 SYSTEM 봇 신고로 같은 큐에 들어가는 흐름을, 비동기 호출과 ai_flagged 컬럼을 짚어 설명해 보세요.
- BLUR과 BLOCKED의 차이를 post_status와 report_count 두 컬럼으로 그려 보세요.

## 퀴즈

<QuizBox question="TripTogether 모더레이션에서 신고 3회 누적 또는 AI 독성 감지가 일반 사용자에게 미치는 자동 효과로 옳은 것은?" :choices="['게시글이 즉시 삭제된다', '작성자 계정이 자동 차단된다', 'post_status는 ACTIVE를 유지한 채 BLUR 오버레이만 적용된다', 'post_status가 BLOCKED로 바뀌어 완전히 숨겨진다']" :answer="2" explanation="ADR-0001과 ADR-0003에 따라 자동 처리는 약한 신호인 BLUR까지만이다. post_status는 ACTIVE를 유지하고 일반 사용자에게만 가림 오버레이를 씌운다. BLOCKED 완전 숨김은 관리자 직접 차단 전용이다." />

<QuizBox question="AI 독성 감지가 사용자 신고와 동일한 신고 큐로 합류하는 방식을 가장 잘 설명한 것은?" :choices="['별도의 AI 전용 테이블에 따로 저장된다', 'SYSTEM 봇 계정을 신고 주체로 해서 submitReport로 REPORT 테이블에 들어간다', '관리자에게 이메일로만 통보된다', 'ai_flagged 컬럼만 켜고 신고는 만들지 않는다']" :answer="1" explanation="flagPostAsToxic 등이 SystemUser BOT_USER_IDX를 주체로 submitReport를 호출해 기존 신고 큐를 재사용한다. DRY 설계라 중복 방지·상태 머신·처분 로직을 그대로 쓴다." />

<QuizBox question="Perspective 독성 검사를 비동기(@Async)로 두고 호출 실패 시 false를 반환하도록 한 이유로 가장 적절한 것은?" :choices="['API 비용을 줄이기 위해서', '글 저장 응답 지연을 피하고 검사 오류가 정상 콘텐츠를 가리지 않게 하기 위해서', 'Perspective가 동기 호출을 지원하지 않아서', '관리자 권한이 없으면 호출할 수 없어서']" :answer="1" explanation="Perspective는 1~5초 지연될 수 있어 동기 호출은 작성 응답을 느리게 한다. 그래서 비동기로 돌리고, 실패하면 가리지 않는 fail-open으로 처리해 오류가 정상 콘텐츠를 BLUR하는 것을 막는다." />
