---
title: "3-스트라이크 블러"
owner: B
domain: "커뮤니티·신고"
tags: ["신고", "블러"]
---

# 3-스트라이크 블러

> 신고가 임계치(기본 3건) 이상 쌓인 콘텐츠는 자동으로 흐려 보이게 하고, 클릭하면 본인 판단으로 펼쳐 본다. 결정적 차단(완전 숨김)은 사람(관리자)만 한다.

이 페이지는 TripTogether 커뮤니티 도메인의 신고 처리 정책 중 하나를 다룬다. 같은 신고 흐름의 다른 측면은 [신고 처리 시스템](/community/report-system)과 [커뮤니티 도메인](/community/)에서 함께 본다. 전체 그림은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 확인한다.

## 1. 한 줄 정의

게시글·댓글의 누적 신고 수가 정책 임계치(기본 3) 이상이 되면, 일반 사용자에게는 본문을 블러 오버레이로 가리고 클릭 시에만 펼쳐 보여주는 점진적 공개(progressive disclosure) 모더레이션 장치다. 콘텐츠 상태는 그대로 ACTIVE로 두고, 관리자가 직접 내린 차단(BLOCKED)과는 표시 방식이 완전히 다르다.

## 2. 왜 이렇게 설계했나

신고 시스템의 흔한 교과서 패턴은 신고 N회 누적 시 콘텐츠 삭제와 작성자 자동 차단이다. 운영 부담은 적지만, 단순 불편이나 취향 차이로도 신고가 발생하므로 오신고(false positive) 비용이 매우 크다. 부당하게 가려지거나 삭제된 콘텐츠와 사용자는 신뢰 회복이 어렵고, 여러 계정을 동원한 신고 도배(brigading)에도 취약하다.

그래서 이 프로젝트는 자동화의 경계를 약한 신호까지로만 긋는 Human-in-the-Loop 모더레이션을 택했다(ADR-0001). 핵심 분리는 두 가지다.

- 자동 처리는 블러까지만. 누적 신고는 약한 신호이므로 완전 숨김 대신 점진적 공개로 사용자 판단을 존중한다.
- 결정적 액션(삭제·작성자 차단·완전 숨김)은 관리자가 신고 내용을 보고 직접 결정한다. 신고 게시판이 곧 관리자의 판단 큐(Admin Decision Queue) 역할을 한다.

:::tip 블러(BLUR)와 차단(BLOCKED)은 의미가 다르다
- 블러: 신고 누적이라는 약한 신호 → 가리되 펼쳐 볼 수 있음(상태는 ACTIVE 유지)
- 차단: 관리자의 강한 결정 → 리스트에서 아예 제거(완전 숨김, post_status = BLOCKED)

초기 설계에는 신고 3회에 BLOCKED 전환과 블러 표시를 합쳐 둔 모순이 있었으나(ADR-0003), BLOCKED면 자동으로 숨겨져야 하므로 블러 오버레이라는 개념 자체가 성립하지 않아 두 경로를 명확히 분리했다.
:::

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 구성 | 위치 | 역할 |
| --- | --- | --- |
| `CommunityServiceImpl.updatePostReportCache()` | community/service | 게시글 신고 캐시 +1, 블러 진입 시점 알림 |
| `CommunityServiceImpl.updateCommentReportCache()` | community/service | 댓글 신고 캐시 +1, 동일 처리 |
| `CommunityServiceImpl.clearPostBlur()` / `clearCommentBlur()` | community/service | 관리자 오신고 판정 시 블러 해제 |
| `CommunityServiceImpl.blockPost()` / `blockComment()` | community/service | 관리자 직접 차단(BLOCKED 전환) |
| `CommunityMapper.xml` | resources/mapper | increasePostReportCount, clearPostBlur, blockPost 등 SQL |
| `ModerationPolicyService.getPolicy().getReportThreshold()` | moderation 정책 | 블러 임계치(기본 3)를 정책에서 주입 |

테이블·컬럼은 다음을 쓴다.

- `COMMUNITY_POST` / `COMMUNITY_COMMENT`의 `report_count`(신고 수 캐시), `post_status` / `comment_status`(ACTIVE / BLOCKED / DELETED), `ai_flagged`(AI 독성 감지 플래그)
- `REPORT` 테이블: 신고 원본. `source_type`(예: COMMUNITY), `source_id`(컨텍스트 ID), `reason`(사유 카테고리), `status`(IN_REVIEW / RESOLVED / DISMISSED)

표시 결정에는 단일 컬럼이 아니라 `post_status`와 `report_count` 두 컬럼 조합을 함께 본다. 임계치는 코드 상수가 아니라 모더레이션 정책에서 주입되므로 운영 중 조정 가능하다.

## 4. 동작 원리(흐름·표·작은 코드)

신고 한 건이 들어오면 무조건 신고 게시판(REPORT)에 INSERT되고, 동시에 대상 콘텐츠의 `report_count`가 1 증가한다. 캐시 갱신 메서드는 증가 전후로 블러 여부가 바뀌는 순간을 감지해, 처음 블러로 진입할 때만 작성자에게 알림을 보낸다.

```text
신고 접수
  └ REPORT INSERT (source_type, source_id, reason, status=IN_REVIEW)
  └ updatePostReportCache(postId)
       wasBlurred  = (report_count >= threshold) OR ai_flagged
       report_count += 1
       nowBlurred  = (report_count+1 >= threshold) OR ai_flagged
       if (!wasBlurred && nowBlurred) -> 작성자에게 블러 알림
```

블러는 신고 누적뿐 아니라 AI 독성 감지(`ai_flagged`)로도 진입한다. 두 경로는 사실상 같은 블러 표시를 공유하되 오버레이 문구만 다르다.

렌더링 조건은 화면(JSP)에서 다음 한 줄로 평가한다. 관리자 모드에서는 절대 블러를 걸지 않는다.

```jsp
report_count >= reportThreshold  AND  NOT isAdminMode   (post_status 조건 없음)
```

| 상황 | post_status | report_count | 일반 사용자 표시 | 관리자 모드 표시 |
| --- | --- | --- | --- | --- |
| 정상 | ACTIVE | 임계치 미만 | 정상 노출 | 정상 노출 |
| 신고 누적(자동) | ACTIVE 유지 | 임계치 이상 | 블러 오버레이, 클릭 시 펼침 | 정상 노출 + 신고 배지 |
| 관리자 직접 차단 | BLOCKED | 무관 | 완전 숨김(리스트 제거) | 차단 표시 + 해제 버튼 |
| 작성자 삭제 | DELETED | 무관 | 완전 숨김 | 감사 로그에만 존재 |

사용자 인터랙션은 단순하다. 본문이 흐려진 상태에서 오버레이를 클릭하면 블러가 벗겨지고 본문이 공개되며, 볼지 여부는 사용자가 자기 책임으로 결정한다.

:::details 블러 해제와 차단의 SQL 차이
관리자가 오신고로 판단해 블러를 풀면 신고 수와 AI 플래그를 0으로 리셋한다. 반면 직접 차단은 상태 컬럼만 BLOCKED로 바꾼다. 신고 수를 0으로 만들지 않는다.

```sql
-- clearPostBlur: 블러 해제(오신고 판정)
UPDATE COMMUNITY_POST SET ai_flagged = 0, report_count = 0 WHERE post_id = ?;

-- blockPost: 관리자 직접 차단(완전 숨김)
UPDATE COMMUNITY_POST SET post_status = BLOCKED, updated_at = NOW() WHERE post_id = ?;
```

리스트 조회는 일반 사용자에게 post_status = ACTIVE만, 관리자 모드에서 post_status IN (ACTIVE, BLOCKED)을 노출한다. DELETED는 어느 쪽에도 나오지 않는다.
:::

## 5. 구현 상태(됨 vs Mock/계획)

- 구현됨: 신고 누적 캐시(`report_count`) 갱신, 임계치 기반 블러 렌더링, 클릭 시 펼침 UX, 첫 블러 진입 시 작성자 알림, AI 독성(`ai_flagged`) 동시 진입, 관리자 블러 해제·직접 차단(BLOCKED)·해제(unblock), 신고 게시판 INSERT.
- 정책화됨: 임계치는 하드코딩이 아니라 모더레이션 정책에서 주입되어 운영 중 조정 가능(기본값 3).
- 한계: 신고 가중치나 신뢰도 점수 없이 단순 카운트 기반이라, 다계정 도배에 대한 정량 방어는 중복 신고 방지(ADR-0004)에 의존한다. 신고가 정확한지에 대한 자동 품질 평가 체계는 없고 관리자 판단에 맡긴다.

## 6. 면접 답변 3단계

1. 한 줄: 신고가 기본 3건 이상 쌓이면 콘텐츠를 자동으로 블러 처리하고 클릭 시 펼쳐 보게 하는 점진적 공개 장치입니다. 완전 차단은 관리자만 합니다.
2. 설계 이유: 누적 신고는 단순 불편으로도 발생하는 약한 신호라 자동 삭제는 오신고 비용이 큽니다. 그래서 자동화는 블러까지, 결정적 액션은 사람이 판단하는 Human-in-the-Loop로 분리했습니다.
3. 구현 핵심: report_count 캐시를 증가시키고 임계치 이상이면 화면에서 블러를 걸되 post_status는 ACTIVE로 둡니다. 관리자 차단은 별도로 post_status를 BLOCKED로 바꿔 완전 숨김 처리합니다. 두 경로는 표시 방식이 완전히 다릅니다.

## 7. 꼬리질문+모범답안

:::details 신고 3회에 왜 글을 삭제하지 않나요
누적 신고는 약한 신호라 오신고 비용이 큽니다. 단순 취향 차이나 다계정 도배로도 카운트가 오를 수 있어, 자동 삭제는 정상 콘텐츠를 부당하게 제거할 위험이 큽니다. 그래서 자동 처리는 블러까지만 하고 삭제·차단은 관리자가 신고 사유와 누적 횟수를 보고 직접 결정합니다.
:::

:::details 블러와 차단(BLOCKED)은 어떻게 다른가요
블러는 상태를 ACTIVE로 둔 채 화면에서만 가리고 클릭하면 펼쳐집니다. 약한 신호에 대한 점진적 공개입니다. 차단은 관리자의 강한 결정으로 post_status를 BLOCKED로 바꿔 리스트에서 아예 제거합니다. BLOCKED는 완전 숨김이라 블러 오버레이라는 개념 자체가 적용되지 않습니다.
:::

:::details 표시 여부를 단일 컬럼으로 못 정하나요
못 정합니다. 블러는 report_count가 임계치 이상이고 관리자 모드가 아닐 때 post_status는 ACTIVE인 케이스이고, 완전 숨김은 post_status가 BLOCKED인 케이스입니다. 두 컬럼 조합을 함께 봐야 합니다. 대신 의미가 명확히 분리돼 상태 케이스가 단순합니다.
:::

:::details 임계치 3은 하드코딩인가요
아닙니다. 모더레이션 정책 서비스에서 reportThreshold를 주입받아 비교하므로 운영 중 조정할 수 있습니다. 기본값이 3일 뿐입니다.
:::

:::details AI 독성 감지와 신고 누적은 어떤 관계인가요
둘 다 같은 블러 표시로 들어갑니다. report_count가 임계치 이상이거나 ai_flagged가 켜지면 블러가 걸립니다. 다만 오버레이 문구가 달라 사용자에게 사유를 구분해 보여줍니다. 둘 다 자동 처리는 블러까지이고 이후는 관리자 판단입니다.
:::

## 8. 직접 말해보기

- 같은 신고 누적인데 글을 삭제하지 않고 블러만 거는 이유를 오신고 비용 관점에서 한 문장으로 설명해 보세요.
- 블러와 BLOCKED를 표시 방식과 상태 컬럼 기준으로 비교해 말해 보세요.
- 신고가 처음 임계치에 도달하는 순간을 코드가 어떻게 감지하는지(wasBlurred / nowBlurred) 설명해 보세요.

## 퀴즈

<QuizBox question="게시글 신고가 기본 임계치(3) 이상 누적되면 어떻게 처리되나요?" :choices="['post_status가 BLOCKED로 바뀌고 리스트에서 사라진다', 'post_status는 ACTIVE로 유지되고 일반 사용자에게 블러 오버레이로 표시된다', '작성자 계정이 자동 차단된다', '게시글이 즉시 DELETED 처리된다']" :answer="1" explanation="누적 신고는 약한 신호이므로 자동 처리는 블러까지다. 상태는 ACTIVE로 두고 화면에서만 가린 뒤 클릭 시 펼친다. BLOCKED 전환과 차단은 관리자만 한다." />

<QuizBox question="블러(BLUR)와 관리자 직접 차단(BLOCKED)의 핵심 차이로 옳은 것은?" :choices="['둘 다 콘텐츠를 완전 숨김 처리한다', '블러는 클릭 시 펼침이 가능하지만 BLOCKED는 리스트에서 완전 숨김된다', 'BLOCKED는 report_count를 0으로 리셋한다', '블러는 관리자만 걸 수 있다']" :answer="1" explanation="블러는 ACTIVE 상태로 가리고 클릭하면 펼쳐지는 점진적 공개다. BLOCKED는 관리자의 강한 결정으로 리스트에서 제거되는 완전 숨김이다." />

<QuizBox question="일반 사용자 화면에서 블러가 걸리는 조건으로 가장 정확한 것은?" :choices="['post_status = BLOCKED 이면 블러', 'report_count가 임계치 이상이고 관리자 모드가 아니면 블러 (post_status 조건 없음)', 'report_count가 1 이상이면 무조건 블러', 'ai_flagged 일 때만 블러']" :answer="1" explanation="렌더링 조건은 report_count가 임계치 이상이고 관리자 모드가 아닌 경우다. post_status 조건은 없으며 ACTIVE 상태에서 블러가 결정된다. AI 독성(ai_flagged)도 같은 블러로 진입하는 또 다른 경로다." />
