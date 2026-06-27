# 모더레이션·거버넌스

> 신고·AI 독성은 약한 신호로만 다루고, 콘텐츠 삭제·계정 차단 같은 결정적 조치는 항상 사람(관리자)이 내린다. 자동화는 BLUR(점진적 가림)까지만 — 이것이 TripTogether 모더레이션의 한 줄 철학이다.

이 페이지는 특정 도메인 하나가 아니라 여러 모듈에 걸친 **흐름(flow)** 을 다룬다. 신고(report)·AI 독성 감지(perspective)·콘텐츠 가림(community/inquiry)·관리자 처리(admin)가 하나의 파이프라인으로 엮인다.

[도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

모더레이션·거버넌스는 **사용자 신고와 AI 독성 점수를 단일 큐(신고 게시판)로 모아, 콘텐츠를 자동으로 BLUR 처리하되 삭제·차단은 관리자 수동 판단으로만 수행하고, 모든 관리자 조치를 감사 로그로 남기는** Human-in-the-Loop 시스템이다.

## 2. 왜 이렇게 설계했나

핵심 결정은 ADR-0001에 박혀 있다. "신고 N회 누적 → 자동 차단"이라는 교과서 패턴을 **의도적으로 거부**했다.

- **False positive 비용이 비대칭이다.** 단순 불편·취향 차이만으로도 신고는 발생한다. 부당하게 차단된 사용자나 삭제된 콘텐츠는 신뢰 회복이 어렵다. 반면 BLUR는 클릭 한 번으로 펼쳐 볼 수 있어 되돌리기 쉽다.
- **신고 도배(brigading) 방어.** 여러 계정을 동원한 누적 신고로 정상 콘텐츠를 자동 삭제시키는 공격을 원천 차단한다. 누적은 BLUR까지만, 결정은 사람이 한다.
- **신고 게시판 = 관리자 판단 큐.** 신고 1건이라도 들어오면 무조건 INSERT되어, 관리자가 누적 횟수·사유·맥락을 보고 5가지 액션 중 하나를 직접 고른다.

AI 독성 감지(ADR-0010)도 같은 철학을 따른다. AI 점수는 자동 차단의 방아쇠가 아니라 **약한 시그널**이다. 독성이 감지되면 BLUR + 신고 큐 합류까지만 하고, 최종 판단은 사람에게 넘긴다.

:::tip 면접 어필 포인트
이 설계는 Reddit AutoModerator, Discord AutoMod, YouTube Trust and Safety, Stack Overflow 모더레이션 큐와 같은 업계 표준 패턴(Human-in-the-Loop Moderation)과 정확히 일치한다. "AI가 판단하니까 자동 차단하면 되지 않나"라는 질문에 "AI 신호의 false positive 비용을 인간 검토로 흡수한다"고 답할 수 있는 것이 핵심이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 레이어 | 구현체 | 역할 |
|---|---|---|
| 신고 접수 | `ReportController` `/report/**`, `ReportServiceImpl.submitReport()` | 게시글/댓글/리뷰/유저 신고, 중복 방지, 재활성화 |
| AI 독성 감지 | `PerspectiveService` (Google Perspective API) | 텍스트의 TOXICITY 점수 0.0~1.0, 비동기 호출 |
| 정책 외부화 | `ContentModerationPolicyVO`, `ModerationPolicyService` | 임계값을 DB에서 주입 (magic number 제거) |
| 콘텐츠 가림 | `CommunityServiceImpl.flagPostAsToxic()` / `flagCommentAsToxic()`, `InquiryServiceImpl.flagInquiryAsToxic()` | ai_flagged 세팅 + SYSTEM 봇 자동 신고 |
| 관리자 처리 | `AdminBlockServiceImpl`, `AdminCommunityServiceImpl` | BLUR 해제 / 글 삭제 / 유저 차단 / 기각 |
| 감사 로그 | `AdminActionAuditService.record()`, `ADMIN_ACTION_AUDIT` 테이블 | 모든 관리자 조치를 reason_code 기반으로 기록 |
| 도우미 챗봇 모니터링 | `AdminAssistantModerationServiceImpl`, `ADMIN_ASSISTANT_MODERATION` 테이블 | AI 도우미 대화 사후 독성 스캔 |

주요 테이블: `REPORT`(신고 큐), `COMMUNITY_POST.report_count` / `post_status` / `ai_flagged`, `CONTENT_MODERATION_POLICY`(단일 행 정책), `ADMIN_ACTION_AUDIT`(감사), `APPLICATION_RUNTIME_SETTING`(런타임 설정), `ADMIN_PERMISSION_GROUP` 계열(권한 그룹).

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 신고 누적 흐름 (사용자 신고)

```text
사용자 신고 → submitReport() → REPORT INSERT
   → updatePostReportCache() 로 report_count 증가
   → report_count >= reportThreshold(기본 3) 이면
   → 다음 페이지 로드 시 JSP 가 BLUR 오버레이 렌더링
   → 관리자가 신고 게시판에서 직접 판단
```

### 4-2. AI 독성 흐름 (비동기)

```java
// PerspectiveService — 글 등록 응답을 막지 않도록 @Async
@Async
public void checkAndFlagPostAsync(Long postId, String text) {
    if (isToxic(text)) {                 // 점수 >= 정책 임계값
        communityService.flagPostAsToxic(postId);  // ai_flagged=1 + SYSTEM 봇 자동 신고
    }
}
```

`flagPostAsToxic()`는 ai_flagged를 세팅하는 동시에 `SystemUser.BOT_USER_IDX`(SYSTEM 봇 계정)로 `submitReport()`를 호출한다. 즉 **AI 감지 콘텐츠도 사용자 신고와 동일한 신고 게시판 큐로 합류한다(DRY)**. 관리자는 신고 출처가 사람이든 AI든 하나의 화면에서 같은 방식으로 처리한다.

### 4-3. BLUR vs BLOCKED 상태 매트릭스 (ADR-0003)

| 상황 | post_status | report_count | 일반 사용자 | 관리자 모드 |
|---|---|---|---|---|
| 정상 | ACTIVE | 3 미만 | 정상 노출 | 정상 노출 |
| 신고 3회 누적 (자동) | ACTIVE 유지 | 3 이상 | BLUR 오버레이 | 정상 + 신고 배지 |
| 관리자 직접 차단 | BLOCKED | 무관 | 완전 숨김 | 차단 표시 + 해제 버튼 |
| 작성자 삭제 | DELETED | 무관 | 완전 숨김 | 감사 로그에만 존재 |

핵심: BLUR 렌더링 조건은 `report_count >= threshold AND 관리자모드 아님`이며 **post_status 조건이 없다**. 자동 처리(약한 신호 BLUR)와 관리자 결정(강한 신호 BLOCKED)은 표시 방식까지 분리된다. BLUR된 글은 status가 그대로 ACTIVE라는 점이 의도된 설계다.

### 4-4. 3-strike 누적 블러 (네이티브 광고)

커뮤니티 네이티브 광고(`AD_CAMPAIGN`)에는 별도로 누적 부정 신호가 3회 쌓이면 블러 처리되는 정책이 적용된다. 같은 "약한 신호 누적 → 가림" 원리의 변형이다.

### 4-5. 관리자 5가지 액션 (신고 게시판에서)

1. **BLUR 유지** — 관망
2. **BLUR 해제** — 오신고 판단 (`clearPostBlur`, report_count 리셋)
3. **글 삭제** — status를 DELETED로 (소프트 삭제, ADR-0008)
4. **유저 차단** — account_status를 BLOCKED로
5. **기각** — DISMISSED

모든 조치는 `AdminActionAuditService.record(actionType, actionDomain, actorUserIdx, targetType, targetId, reasonCode, ...)`로 `ADMIN_ACTION_AUDIT`에 기록된다. 표준 사유 코드(reason_code)를 쓰므로 사후 집계·필터가 가능하다.

### 4-6. 정책 외부화 (ADR-0009)

임계값은 코드 리터럴이 아니라 `CONTENT_MODERATION_POLICY` 단일 행에서 온다.

```java
double threshold = moderationPolicyService.getPolicy().getToxicityThreshold();
```

`ContentModerationPolicyVO`는 toxicityLevel(STRICT/NORMAL/LOOSE)을 Perspective threshold로 변환한다 — STRICT면 0.6, NORMAL이면 0.8, LOOSE면 0.9. reportThreshold(BLUR 임계 횟수), 도배 방지 윈도우/최대치도 같은 행에서 관리한다. 운영 중 DB UPDATE만으로 조정 가능하고, 코드의 숫자는 magic number가 아니라 정책 객체 조회 결과다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 구현 상태 정직 구분

**구현됨**
- 사용자 신고 접수·중복 방지·취소/재활성화·상태머신 (검토중 → 처리완료/반려/취소)
- HTTP 상태 코드 분리: 비로그인 401, 권한 없음 403, 미존재 404, 중복 409
- Perspective 독성 점수 비동기 호출 + ai_flagged + BLUR 풀스택 (게시글·댓글·문의 3모듈 동등 구현)
- SYSTEM 봇 자동 신고로 AI 감지 콘텐츠를 신고 큐에 합류 (DRY)
- BLUR vs BLOCKED 상태 분리, 관리자 5가지 액션
- 정책 외부화 (CONTENT_MODERATION_POLICY)
- 관리자 조치 감사 로그 (ADMIN_ACTION_AUDIT, reason_code 기반)
- 권한 그룹 (ADMIN_PERMISSION_GROUP 계열), 런타임 설정 (APPLICATION_RUNTIME_SETTING, value_type/is_secret + 변경 이력)
- AI 도우미 챗봇 대화 사후 독성 스캔 (ADMIN_ASSISTANT_MODERATION)

**한계·계획**
- Perspective 호출 실패 시 fail-safe로 점수 null 처리만 하고 **재시도 정책은 별도 없음** — ai_flagged가 갱신되지 않을 수 있다(ADR-0010 명시).
- AI 응답·감지 품질의 정량 평가 체계 부재 (향후 과제).
- BLUR UI는 JSP 데스크톱 레이아웃 기준 (반응형/모바일 최적화 향후).
:::

:::warning fail-safe의 함정
`PerspectiveService.isToxic()`은 API 호출 실패 시 false를 반환한다. 사용자 경험을 막지 않으려는 의도지만, 이는 곧 **외부 API가 죽으면 독성 필터가 조용히 통과 모드가 된다**는 뜻이다. 보안이 아니라 가용성을 우선한 트레이드오프임을 면접에서 명시할 수 있어야 한다.
:::

## 6. 면접 답변 3단계

**1단계 (한 문장):** TripTogether 모더레이션은 신고와 AI 독성을 약한 신호로만 다뤄 자동으로는 BLUR까지만 처리하고, 삭제·차단 같은 결정적 조치는 관리자가 수동으로 내리는 Human-in-the-Loop 구조입니다.

**2단계 (메커니즘):** 신고가 들어오면 신고 게시판이라는 단일 큐에 쌓이고 report_count가 누적 임계값을 넘으면 JSP가 BLUR 오버레이를 씌웁니다. AI 독성은 Google Perspective로 비동기 점수를 매겨 임계값을 넘으면 ai_flagged를 세우고, 동시에 SYSTEM 봇 이름으로 같은 신고 큐에 자동 등록해 사람 신고와 동일하게 처리되게 합니다. 관리자는 큐에서 유지·해제·삭제·차단·기각 중 하나를 고르고, 모든 조치는 reason_code 기반 감사 로그로 남습니다.

**3단계 (설계 의도):** 자동 차단을 의도적으로 안 한 이유는 false positive 비용이 비대칭이기 때문입니다. 부당 차단은 회복이 어렵지만 BLUR는 클릭으로 되돌릴 수 있고, 신고 도배 공격도 막힙니다. 임계값은 DB 정책 행으로 외부화해 재배포 없이 조정합니다.

## 7. 꼬리질문 + 모범답안

:::details Q1. 신고 N회면 자동 삭제하는 게 더 간단하지 않나요?
간단하지만 false positive 비용이 너무 큽니다. 단순 불편 신고나 여러 계정을 동원한 도배(brigading)로 정상 콘텐츠가 자동 삭제되면 신뢰 회복이 어렵습니다. 그래서 자동화는 되돌리기 쉬운 BLUR까지만 하고, 비가역적인 삭제·차단은 사람이 맥락을 보고 결정하게 했습니다. Reddit AutoMod, Discord AutoMod 등 업계 표준도 같은 경계를 그립니다.
:::

:::details Q2. AI가 독성을 감지했는데 왜 바로 안 가리고 신고 큐로 보내나요?
AI 점수도 false positive가 있어 약한 신호로 취급하기 때문입니다. ai_flagged로 BLUR는 즉시 적용하되, SYSTEM 봇 이름으로 사람 신고와 같은 큐에 넣어 관리자가 최종 판단하게 합니다. 이렇게 하면 사람 신고와 AI 신고를 별도 파이프라인으로 중복 구현할 필요가 없어 DRY하고, 관리자 화면도 하나로 통일됩니다.
:::

:::details Q3. BLUR인데 왜 status는 ACTIVE인가요? 버그 아닌가요?
의도된 설계입니다. BLUR(약한 신호 누적)와 BLOCKED(관리자 강한 결정)는 의미가 다릅니다. BLOCKED면 완전 숨김이라 BLUR 오버레이 개념 자체가 성립하지 않습니다. 그래서 BLUR는 status를 ACTIVE로 둔 채 report_count 조건만으로 렌더링하고, BLOCKED는 관리자 직접 차단 전용으로 분리했습니다. 초기에 두 개념을 합쳤다가 모순을 발견해 ADR-0003으로 정정한 이력이 있습니다.
:::

:::details Q4. Perspective API가 다운되면 어떻게 되나요?
isToxic이 false를 반환해 독성 검사를 건너뜁니다. 사용자 작성 응답을 막지 않으려는 fail-safe입니다. 다만 이건 가용성을 우선한 트레이드오프라, 외부 API 장애 시 필터가 조용히 통과 모드가 됩니다. 비동기 호출 실패 시 재시도 정책은 아직 없어 향후 과제로 남아 있습니다. 사용자 신고라는 두 번째 방어선이 있어 단일 실패점은 아닙니다.
:::

:::details Q5. 임계값이 코드에 안 보이는데 하드코딩인가요?
아닙니다. CONTENT_MODERATION_POLICY 단일 행에 외부화돼 있고 ModerationPolicyService로 주입됩니다. STRICT/NORMAL/LOOSE 같은 민감도 레벨이 실제 threshold로 변환되며, 도배 윈도우·BLUR 임계 횟수도 같은 행에서 관리합니다. 운영 중 DB UPDATE만으로 조정되고 재배포가 필요 없습니다. 코드의 숫자는 정책 객체 조회 결과라 magic number가 아닙니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 설명할 수 있으면 이 페이지를 이해한 것이다.

- "자동화는 BLUR까지, 삭제·차단은 사람"이라는 경계를 그은 이유 두 가지
- 사용자 신고와 AI 독성 신호가 어떻게 하나의 큐로 합쳐지는지 (SYSTEM 봇)
- BLUR와 BLOCKED가 상태 컬럼·표시 방식에서 어떻게 갈리는지
- 모더레이션 임계값을 코드가 아니라 DB에 둔 이유
- Perspective fail-safe가 가용성과 보안 사이 어떤 트레이드오프인지

## 퀴즈

<QuizBox question="TripTogether에서 신고가 누적 임계값을 넘었을 때 시스템이 자동으로 하는 처리는 무엇인가?" :choices="['게시글을 즉시 삭제한다', '작성자 계정을 자동 차단한다', '콘텐츠를 BLUR 처리하고 관리자 판단 큐에 올린다', '아무 처리도 하지 않는다']" :answer="2" explanation="ADR-0001에 따라 자동화는 BLUR까지만 한다. 삭제와 차단은 false positive 비용이 비대칭이라 관리자 수동 판단으로만 수행한다." />

<QuizBox question="AI 독성 감지(Perspective)로 ai_flagged가 세팅될 때 함께 일어나는 일은?" :choices="['해당 콘텐츠가 DB에서 영구 삭제된다', 'SYSTEM 봇 이름으로 신고 게시판에 자동 등록되어 사람 신고와 같은 큐로 합류한다', '작성자에게 경고 이메일만 발송된다', '관리자 권한 그룹이 자동 변경된다']" :answer="1" explanation="flagPostAsToxic은 ai_flagged 세팅과 동시에 SYSTEM 봇 계정으로 submitReport를 호출한다. AI 신호와 사용자 신호를 같은 큐로 통일해 중복 구현을 없앤 DRY 설계다." />

<QuizBox question="BLUR 처리된 게시글의 post_status 값으로 옳은 것은?" :choices="['BLOCKED 로 전환된다', 'DELETED 로 전환된다', 'ACTIVE 를 그대로 유지한다', 'PENDING 으로 바뀐다']" :answer="2" explanation="ADR-0003에 따라 BLUR는 약한 신호 누적이므로 status는 ACTIVE를 유지하고 report_count 조건만으로 렌더링한다. BLOCKED는 관리자 직접 차단 전용으로 완전 숨김을 의미한다." />
