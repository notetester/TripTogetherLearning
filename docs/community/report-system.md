---
title: "신고 상태머신"
owner: B
domain: "커뮤니티·신고"
tags: ["신고", "상태머신"]
---

# 신고 상태머신

> 신고 한 건은 단순 INSERT가 아니라, 중복 방지·재활성화·상태 전이·자동 알림·시스템 자동신고까지 하나의 도메인으로 묶인 상태머신이다.

## 1. 한 줄 정의

게시글/댓글/리뷰/유저를 대상으로 한 신고를 `target_type`+`target_id`로 식별하고, `IN_REVIEW → RESOLVED / DISMISSED` 상태 전이와 사용자 취소(`CANCELLED`)를 관리하며, 같은 사용자의 중복 신고를 3중으로 방어하는 모더레이션 큐다.

## 2. 왜 이렇게 설계했나

핵심 결정은 **자동화의 경계를 어디에 긋느냐**다. 신고 N회 누적 시 콘텐츠를 자동 삭제하고 유저를 자동 차단하는 교과서 패턴은 운영 부담이 작지만, 단순 불편·취향 차이로도 신고가 발생하므로 오신고(false positive) 비용이 매우 크다. 부당하게 차단된 사용자나 콘텐츠는 신뢰 회복이 어렵고, 여러 계정을 동원한 도배 신고(brigading) 공격에도 취약하다.

그래서 ADR-0001은 **Human-in-the-Loop Moderation**을 택했다. 자동화는 약한 신호(3회 누적 또는 AI 독성 감지 시 BLUR 가림)까지만 수행하고, 글 삭제·유저 차단 같은 결정적 액션은 모두 관리자 판단에 맡긴다. 이 구조에서 신고 게시판은 단순 기록이 아니라 **관리자 판단 큐(Admin Decision Queue)** 로 동작한다.

:::tip 신고 게시판 = 판단 큐
신고가 1건이라도 들어오면 무조건 큐에 INSERT된다. BLUR 처리된 글도, AI가 감지한 글도 모두 같은 큐에 쌓인다. 관리자는 각 건마다 BLUR 유지 / BLUR 해제 / 글 삭제 / 유저 차단 / 기각 중 하나를 직접 고른다. 자동 차단이 없는 것은 누락이 아니라 ADR-0001의 의도된 설계다.
:::

두 번째 결정은 **중복 방지의 신뢰성**이다. 누적 신고 횟수가 BLUR 트리거이자 관리자 판단 근거이므로, 같은 사람이 같은 대상을 여러 번 신고해 카운트를 부풀리면 안 된다. 그래서 ADR-0004는 단일 수단이 아니라 3중 방어를 채택했다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 계층 | 구현체 | 책임 |
| --- | --- | --- |
| Controller | `ReportController` (`/report/**`) | 신고 접수/수정/취소/삭제/상태변경, HTTP 상태코드 분리 |
| Service | `ReportService` / `ReportServiceImpl` | 트랜잭션, 중복 판별, 재활성화, 상태 전이, 알림 발송 |
| Mapper | `ReportMapper` + `ReportMapper.xml` | `INSERT IGNORE`, 사전 SELECT, 상태 UPDATE |
| VO | `ReportDto`, `ReportSearchDto`, `ReportStatsDto` | DB 매핑·검색조건·대시보드 통계 |
| 테이블 | `REPORT` | `UNIQUE KEY uq_report (user_idx, target_type, target_id)` |

`REPORT` 테이블의 핵심 컬럼은 `target_type`(POST / COMMENT / REPLY / USER), `target_id`(대상 PK), `status`(기본값 IN_REVIEW), `resolver_idx`(처리한 관리자), `resolve_action`(처리 결과 텍스트), 그리고 유저 신고의 출처를 가리키는 `source_type`/`source_id`다. 유저를 신고할 때는 어느 글이나 댓글에서 신고가 시작됐는지를 `source_type`/`source_id`에 남겨 관리자가 맥락을 복원할 수 있게 한다.

ReportController는 auth 모듈의 VO를 직접 import하지 않고 리플렉션으로 세션 속성 `loginUser`에서 `getUserIdx`/`getUserRole`을 꺼낸다. 담당 도메인 간 컴파일 의존성을 줄이기 위한 선택이다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 상태 전이표

| 현재 상태 | 이벤트 | 다음 상태 | 주체 |
| --- | --- | --- | --- |
| (없음) | 신고 접수 | `IN_REVIEW` | 사용자 / 시스템 |
| `IN_REVIEW` | 신고 취소 | `CANCELLED` | 본인 |
| `CANCELLED` | 같은 대상 재신고 | `IN_REVIEW` (재활성화) | 본인 |
| `IN_REVIEW` | 처리 완료 | `RESOLVED` | 관리자 |
| `IN_REVIEW` | 반려 | `DISMISSED` | 관리자 |
| `RESOLVED` / `DISMISSED` | 처리 복원 | `IN_REVIEW` | 관리자 |

수정·취소는 `IN_REVIEW`일 때만 허용된다. 관리자가 이미 처리한(`RESOLVED`/`DISMISSED`) 신고를 본인이 되돌릴 수는 없다.

### 중복 방지 3중 방어 (ADR-0004)

```text
Layer 1  DB UNIQUE uq_report (user_idx, target_type, target_id)
         → 어떤 경로의 INSERT든 같은 조합은 두 번째부터 차단

Layer 2  서비스 사전 SELECT (selectReportByUserAndTarget)
         → 기존 신고가 있으면 친절한 응답으로 분기

Layer 3  CANCELLED 재활성화 (reactivateCancelledReport)
         → 취소했던 신고를 UPDATE로 되살림 (UNIQUE 위반 없음)
```

`submitReport`의 분기는 이렇게 동작한다.

```text
existing = selectReportByUserAndTarget(userIdx, targetType, targetId)
if existing != null:
    if existing.status == CANCELLED:  reactivate → return true
    else:                             return false   // 중복 거부
try:
    insertReport(...)                 // INSERT IGNORE
catch DataIntegrityViolationException:
    return false                      // 사전 SELECT 와 INSERT 사이 race 차단
```

마지막 `try/catch`가 중요하다. 사전 SELECT와 INSERT 사이에 다른 트랜잭션이 끼어드는 race condition이 발생해도, DB UNIQUE 제약이 예외를 던지고 그것을 중복으로 흡수한다. 별도 rate limit 없이도 같은 대상 도배 신고가 원천 차단되는 부수 효과가 있다.

### HTTP 상태코드 분리

신고 접수·수정·취소·삭제 API는 실패 원인을 HTTP 코드로 구분해 응답한다.

| 코드 | 의미 | 발생 위치 |
| --- | --- | --- |
| 401 | 비로그인 | 모든 변경 API 진입부 |
| 403 | 권한 없음 (타인 신고 수정/삭제, 비관리자 상태변경) | edit/delete/cancel/status |
| 404 | 신고 없음 | edit/delete/cancel |
| 409 | 중복 신고 (이미 접수됨) | 접수 API, `submitReport` false |

400은 잘못된 `target_type`, 자기 자신 신고, `IN_REVIEW`가 아닌 상태에서의 수정/취소, 허용되지 않은 상태값에 쓰인다. 단순히 전부 500으로 떨어뜨리지 않고 의미별로 코드를 나눈 것이 이 API의 특징이다.

### 처리 시 자동 알림 (FeedNotification)

관리자가 상태를 `RESOLVED` 또는 `DISMISSED`로 바꾸면, `ReportServiceImpl.updateReportStatus`가 같은 트랜잭션 안에서 신고자에게 피드 알림을 발송한다.

```text
notification.sourceType = report
notification.sourceId   = reportId
notification.message    = 접수하신 신고가 처리/반려되었습니다.
notification.targetUrl  = NotificationUrlBuilder.report()
myPageService.addNotification(notification)
```

신고 도메인이 알림 테이블을 직접 건드리지 않고 myPage 모듈의 `addNotification`을 호출하는 크로스모듈 패턴이다. 알림 인프라는 myPage가 소유하고, 신고는 이벤트만 넘긴다.

### SYSTEM 자동신고의 DRY

AI 독성 감지(Perspective)나 신고 누적으로 콘텐츠를 가릴 때, 커뮤니티 모듈은 **별도 자동신고 경로를 새로 만들지 않는다.** `CommunityServiceImpl`이 사람이 쓰는 것과 똑같은 `reportService.submitReport(...)`를 호출하되, 신고자만 시스템 봇 계정(`SystemUser.BOT_USER_IDX`)으로, 사유를 `toxicity`로 넘긴다.

```text
reportService.submitReport("post", postId,
        SystemUser.BOT_USER_IDX, "toxicity", "AI 민감도 분석 감지", null, null);
```

덕분에 시스템 신고도 사람 신고와 동일한 3중 중복 방어를 그대로 탄다. 같은 글이 사람과 봇 양쪽에서 신고돼도 UNIQUE 제약 위에서 한 행으로 정리되고, 통계·목록·상태 전이 로직이 분기 없이 재사용된다. 이것이 DRY의 핵심으로, 자동화 경로를 위한 중복 코드가 없다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: 4종 대상(post/comment/review/user) 신고 접수, 3중 중복 방어, CANCELLED 재활성화, `IN_REVIEW → RESOLVED/DISMISSED` 상태 전이와 처리 복원, HTTP 401/403/404/409 분리, 처리 시 FeedNotification 자동 발송, SYSTEM 봇 자동신고의 DRY 재사용, 관리자 대시보드 통계(`ReportStatsDto`).
- 주의(용어 혼선): 일부 Javadoc 주석에는 `PENDING`이라는 단어가 남아 있으나, 실제 SQL과 런타임 상태값은 `IN_REVIEW`다. 신규 INSERT와 재활성화 모두 `IN_REVIEW`로 들어간다.
- 계획/한계: 신고 처리 자동화는 의도적으로 BLUR까지만이며 결정적 액션은 수동이다. AI 감지 품질에 대한 정량 평가 체계는 아직 없다(향후 과제).

## 6. 면접 답변 3단계

:::details 30초 / 2분 / 5분 버전
**30초** — 신고는 게시글·댓글·리뷰·유저를 `target_type`과 `target_id`로 식별하는 상태머신입니다. `IN_REVIEW`로 들어와 관리자가 `RESOLVED`나 `DISMISSED`로 처리하고, 본인은 `CANCELLED`로 취소할 수 있습니다. 같은 사람의 중복 신고는 DB UNIQUE 제약으로 막습니다.

**2분** — 핵심 설계 결정이 두 가지입니다. 첫째, 자동 차단을 하지 않습니다. 신고 누적은 콘텐츠 가림(BLUR)까지만 자동화하고 삭제·차단은 관리자가 판단합니다. 오신고 비용이 크기 때문에 Human-in-the-Loop를 택했고, 신고 게시판이 관리자 판단 큐 역할을 합니다. 둘째, 중복 방지를 3중으로 합니다. DB UNIQUE 제약, 서비스의 사전 SELECT, 그리고 취소한 신고를 되살리는 재활성화 분기입니다. 사전 SELECT와 INSERT 사이 race condition은 INSERT 시 던져지는 무결성 예외를 잡아 중복으로 처리합니다.

**5분** — (2분 내용에 더해) 신고 실패 원인을 HTTP 401/403/404/409로 구분합니다. 관리자가 처리하면 같은 트랜잭션에서 신고자에게 피드 알림을 보내는데, 신고 모듈이 알림 테이블을 직접 건드리지 않고 myPage의 addNotification을 호출하는 크로스모듈 구조입니다. 그리고 AI 독성 감지로 자동 가림할 때도 별도 코드를 만들지 않고 사람이 쓰는 submitReport를 시스템 봇 계정으로 그대로 호출합니다. 자동 신고도 동일한 중복 방어와 통계 로직을 재사용하는 DRY 설계입니다.
:::

## 7. 꼬리질문 + 모범답안

:::details 사전 SELECT로 중복을 막는데 DB UNIQUE 제약이 왜 또 필요한가요
사전 SELECT는 친절한 응답을 위한 것이고, 동시성 보장은 못 합니다. 두 요청이 거의 동시에 SELECT를 통과한 뒤 둘 다 INSERT하면 중복 행이 생깁니다. DB UNIQUE가 그 race condition의 최후 방어선이고, INSERT 시 던져지는 무결성 예외를 잡아 false로 처리합니다. 즉 UNIQUE는 정확성, 사전 SELECT는 UX 담당입니다.
:::

:::details CANCELLED 재신고를 새 INSERT로 처리하면 안 되나요
안 됩니다. `uq_report (user_idx, target_type, target_id)` 조합이 이미 존재하므로 새 INSERT는 UNIQUE 위반입니다. 그래서 새 행을 만들지 않고 기존 행을 UPDATE로 되살립니다. 행이 1건으로 유지돼 누적 카운트의 신뢰성도 지켜집니다.
:::

:::details 신고 3회 누적 시 글을 자동 삭제하지 않는 이유는 무엇인가요
오신고 비용 때문입니다. 단순 불편·취향 차이로도 신고가 발생하고 여러 계정 동원 도배 공격도 가능합니다. 정상 콘텐츠가 자동 삭제되면 사용자 신뢰 회복이 어렵습니다. 그래서 자동화는 BLUR 가림까지만 하고, 삭제·차단은 신고 컨텍스트를 본 관리자가 판단합니다. Reddit AutoModerator나 Discord AutoMod 같은 업계 표준과 동일한 Human-in-the-Loop 패턴입니다.
:::

:::details 시스템 자동신고와 사람 신고를 같은 메서드로 처리하면 위험하지 않나요
오히려 안전합니다. 같은 submitReport를 타기 때문에 자동신고도 3중 중복 방어를 그대로 받습니다. 사람과 봇이 같은 글을 신고해도 UNIQUE 제약 위에서 한 행으로 정리됩니다. 봇은 신고자 user_idx만 시스템 계정으로 다를 뿐이라 통계·목록·상태 전이가 분기 없이 재사용되고, 자동화 전용 중복 코드가 사라집니다.
:::

:::details 처리 알림을 같은 트랜잭션에서 보내는데 알림 발송이 실패하면 상태 변경이 롤백되나요
updateReportStatus는 트랜잭션이고 알림 발송이 그 안에 있어, addNotification이 예외를 던지면 상태 변경도 함께 롤백됩니다. 상태 전이와 알림의 원자성은 보장되지만, 알림은 부가 작업이므로 본 처리의 실패로 이어지지 않게 분리하는 것이 더 견고한 방향일 수 있습니다. 알림 인프라 자체는 myPage가 소유하므로 신고 모듈은 이벤트만 위임합니다.
:::

## 8. 직접 말해보기

다음 질문에 1~2분으로 답해보자.

1. 신고 한 건이 접수돼 관리자가 반려할 때까지의 상태 전이를 순서대로 설명하라.
2. 같은 사용자가 같은 글을 두 번 신고하면 어느 방어 계층에서, 왜 막히는지 설명하라.
3. 신고 실패를 401/403/404/409로 나눈 이유를, 각 코드가 의미하는 상황과 함께 설명하라.
4. AI 독성 감지 자동신고가 사람 신고와 코드를 공유하는 것이 왜 안전하고 DRY인지 설명하라.

## 퀴즈

<QuizBox question="REPORT 테이블에서 같은 사용자의 중복 신고를 DB 레벨에서 막는 UNIQUE 키 조합은 무엇인가" :choices="['report_id 단일', 'user_idx, target_type, target_id', 'target_id, status', 'user_idx, created_at']" :answer="1" explanation="uq_report는 user_idx, target_type, target_id 세 컬럼 조합으로, 같은 사용자가 같은 대상을 두 번 신고하는 것을 DB 레벨에서 차단한다. 이것이 3중 방어의 최후 보루다." />

<QuizBox question="사용자가 취소했던 신고와 같은 대상을 다시 신고하면 시스템은 어떻게 처리하는가" :choices="['새 행을 INSERT 한다', '기존 행을 IN_REVIEW 로 재활성화 UPDATE 한다', '중복으로 거부한다', '관리자 승인 후 복원한다']" :answer="1" explanation="CANCELLED 상태면 새 INSERT 대신 reactivateCancelledReport 로 기존 행을 IN_REVIEW 로 되살린다. 새 INSERT 는 UNIQUE 제약을 위반하므로 UPDATE 방식을 쓴다." />

<QuizBox question="ADR-0001 에 따라 신고 누적 시 자동화가 수행하는 범위로 옳은 것은" :choices="['글 자동 삭제와 유저 자동 차단', '콘텐츠 BLUR 가림까지만, 삭제와 차단은 관리자 수동 판단', '아무 자동 처리도 없음', '신고자 자동 보상 지급']" :answer="1" explanation="오신고 비용을 줄이기 위해 자동화는 BLUR 가림까지만 하고, 글 삭제와 유저 차단 같은 결정적 액션은 관리자가 판단하는 Human-in-the-Loop 패턴을 택했다." />
