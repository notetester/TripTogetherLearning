---
title: "댓글·대댓글·채택"
owner: B
domain: "커뮤니티·신고"
tags: ["댓글"]
---

# 댓글·대댓글·채택

> 단일 테이블 자기참조로 2단계 댓글을 표현하고, 질문글은 작성자 채택으로 베스트 답변을 고정하며, 모든 삭제는 소프트삭제로 처리한다.

이 페이지는 [커뮤니티·신고 도메인](/domains) 중 댓글 시스템을 다룬다. 전체 흐름은 [전체 흐름](/flow/), 담당자 단위 정리는 [담당별 보기](/by-area/)에서 볼 수 있다.

## 1. 한 줄 정의

`COMMUNITY_COMMENT` 한 테이블에서 `parent_comment_id` 자기참조로 댓글과 대댓글을 구분하고, 질문(question) 게시글은 작성자가 한 댓글을 채택해 베스트 답변으로 고정하는 기능이다.

## 2. 왜 이렇게 설계했나

- **단일 테이블 2단계 구조**: 댓글과 대댓글을 별도 테이블로 나누지 않고 한 테이블에 `parent_comment_id`(NULL이면 일반 댓글, 값이 있으면 대댓글)로 합쳤다. 무한 트리가 아니라 2단계만 허용하므로 재귀 조회가 필요 없고, 정렬·집계 쿼리가 단순해진다.
- **소프트삭제 일관성**: ADR-0008(소프트삭제)에 따라 삭제는 행을 지우지 않고 `comment_status`를 DELETED로 바꾼다. 신고·감사·통계가 사라진 데이터를 참조하지 못하는 사고를 막고, 댓글 수 캐시(`comment_count`)와의 정합성을 유지한다.
- **채택은 작성자 권한**: 질문 게시글의 베스트 답변 선정은 제품 의미상 글쓴이의 권한이라, 서버에서 작성자 본인만 채택하도록 강제한다.
- **AI 모더레이션은 비동기**: 댓글 등록 응답을 막지 않으려고, 독성 검사는 등록 직후 별도 스레드에서 돌리고 결과만 `ai_flagged`로 반영한다(ADR-0010).

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

TripTogether 공통 4계층(controller → service → mapper → vo)을 그대로 따른다.

| 계층 | 구현체 |
| --- | --- |
| Controller | `CommunityController` (`/community/**`) |
| Service | `CommunityService` 인터페이스 + `CommunityServiceImpl` |
| Mapper | `CommunityMapper` (`@Mapper`) + `resources/mapper/CommunityMapper.xml` |
| VO/DTO | `CommunityCommentDto` |
| 테이블 | `COMMUNITY_COMMENT`, `COMMUNITY_COMMENT_LIKE`, `COMMUNITY_POST` |
| 모더레이션 | `PerspectiveService` (Google Perspective API, TOXICITY) |

핵심 컬럼 (`COMMUNITY_COMMENT`):

| 컬럼 | 역할 |
| --- | --- |
| `comment_id` | PK |
| `post_id` | 소속 게시글 (COMMUNITY_POST FK) |
| `parent_comment_id` | 부모 댓글 FK. NULL이면 일반 댓글, 값이 있으면 대댓글 |
| `comment_status` | ACTIVE / BLOCKED / DELETED (소프트삭제 상태) |
| `like_count` | 좋아요 수 캐시 |
| `report_count` | 신고 수 |
| `ai_flagged` | 0 또는 1. 독성 감지 시 1 → BLUR 오버레이 |

채택 관련 컬럼은 댓글이 아니라 게시글(`COMMUNITY_POST`)에 있다: `accepted_comment_id`, `is_solved`, `solved_at`.

:::tip 자기참조 FK
`fk_comment_parent`는 `parent_comment_id`가 같은 테이블의 `comment_id`를 참조하고 `ON DELETE CASCADE`다. 다만 실제 삭제는 소프트삭제로 처리하므로 이 CASCADE는 하드삭제(예: 게시글 물리 정리) 시의 안전망 역할이다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

**엔드포인트**

| 동작 | 메서드·경로 | 권한 |
| --- | --- | --- |
| 댓글 등록 | POST `/community/{postId}/comment` | 로그인 |
| 대댓글 등록 | POST `/community/{postId}/comment/{commentId}/reply` | 로그인 |
| 댓글 삭제 | DELETE `/community/comment/{commentId}` | 작성자 |
| 채택 | POST `/community/{postId}/accept/{commentId}` | 게시글 작성자 |
| 댓글 목록 프래그먼트 | GET `/community/{postId}/comments?sort=` | 공개 |

**등록 흐름** (`addComment` / `addReply`)

1. 도배 방지: 최근 N분간 작성 수가 정책 한도(`commentWindowMinutes` / `commentMaxCount`)를 넘으면 예외.
2. 본문 정화: `sanitizeCommentText`로 XSS 제거(ADR-0005, jsoup).
3. INSERT 후 게시글의 `comment_count`(캐시) 증가.
4. 알림 발행: 게시글 작성자에게(댓글), 부모 댓글 작성자에게(대댓글). 단 자기 글·자기 댓글이면 중복 알림을 보내지 않는다.
5. `PerspectiveService.checkAndFlagCommentAsync`를 비동기 호출 → 독성 점수가 임계값 이상이면 `ai_flagged=1`.

**목록 조회·정렬** (`selectCommentList`)

소프트삭제된 행은 빠지도록 `comment_status IN (ACTIVE, BLOCKED)`로 거른다(DELETED 제외). 대댓글은 부모 바로 아래에 묶여 보여야 하므로 `COALESCE(parent_comment_id, comment_id)`로 스레드를 묶고 정렬한다.

```sql
-- 부모 그룹 단위로 묶은 뒤, 그룹 내부는 comment_id 오름차순
ORDER BY COALESCE(cc.parent_comment_id, cc.comment_id),
         cc.comment_id ASC
```

`sort=latest`는 그룹을 최신순(DESC), `sort=replies`는 대댓글 많은 순으로 그룹을 정렬한다.

**채택 흐름** (`acceptComment`)

```sql
UPDATE COMMUNITY_POST
SET accepted_comment_id = #{commentId},
    is_solved = 1,
    solved_at = NOW()
WHERE post_id = #{postId}
```

채택 상태는 댓글이 아니라 게시글에 기록된다. 컨트롤러는 SQL 실행 전에 로그인 여부(401)와 작성자 일치 여부(403)를 검사한다.

```java
if (!loginUserIdx.equals(post.getUserIdx())) {
    return ResponseEntity.status(403).body(result); // 작성자만 채택
}
```

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 댓글·대댓글 등록/삭제/좋아요 | 구현됨 |
| 2단계 대댓글(`parent_comment_id`) | 구현됨 (3단계 이상 미지원) |
| 질문 채택 + 작성자 권한 검사 | 구현됨 |
| 소프트삭제(`comment_status`) + 캐시 동기화 | 구현됨 |
| 도배 방지 레이트리밋 | 구현됨 |
| Perspective 독성 감지 → `ai_flagged` BLUR | 구현됨 (외부 API 키 필요) |
| 신고 누적 BLUR(3-strike) | 구현됨 |
| AI 모더레이션 정량 품질평가 | 계획 (향후 과제) |

:::warning 정직한 한계
대댓글은 2단계까지만 지원한다(대댓글의 대댓글 없음). `ai_flagged`는 콘텐츠를 BLUR로 가릴 뿐 자동 차단·삭제하지 않으며, 최종 차단/해제는 관리자 검토를 거친다(ADR-0001, ADR-0010). 모바일은 데스크톱 JSP 레이아웃 기준이다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: 댓글·대댓글을 한 테이블에서 `parent_comment_id` 자기참조로 표현하고, 질문글은 작성자가 한 댓글을 채택해 베스트 답변을 고정하는 기능을 만들었습니다.
2. **설계 근거**: 2단계만 허용하니 무한 트리 대신 단일 테이블이 단순했고, 삭제는 소프트삭제로 통일해 신고·통계·캐시 정합성을 지켰으며, 독성 검사는 응답을 막지 않도록 비동기로 분리했습니다.
3. **결과·한계**: 채택 권한 서버 강제, 소프트삭제 필터링, 캐시 카운트 동기화까지 일관되게 동작합니다. 다만 대댓글 깊이가 2단계로 제한되고 AI 플래그의 품질 정량평가는 아직 과제로 남아 있습니다.

## 7. 꼬리질문 + 모범답안

:::details 댓글을 왜 별도 reply 테이블로 안 나눴나요?
대댓글이 2단계로 제한되어 무한 트리 재귀가 필요 없습니다. 한 테이블에 `parent_comment_id`만 두면 정렬·카운트가 단일 쿼리로 끝나고, FK·인덱스도 한 곳에서 관리됩니다. 깊은 트리가 요구사항이었다면 path enumeration이나 closure table을 고려했을 겁니다.
:::

:::details 삭제했는데 목록에서 어떻게 사라지나요?
물리 삭제가 아니라 `comment_status`를 DELETED로 바꿉니다(ADR-0008). 목록 쿼리가 `comment_status IN (ACTIVE, BLOCKED)`로 필터링하므로 DELETED는 빠지고, 동시에 게시글의 `comment_count` 캐시를 감소시켜 화면 숫자와 맞춥니다.
:::

:::details 채택 정보를 왜 댓글이 아니라 게시글에 저장하나요?
한 질문에는 채택된 답변이 하나뿐이라, 게시글의 `accepted_comment_id` 한 컬럼이면 충분하고 조회도 빠릅니다. 댓글마다 채택 플래그를 두면 정합성을 보장하기 어렵습니다. 채택과 함께 `is_solved`, `solved_at`도 게시글에 같이 기록해 해결 상태를 일관되게 표현합니다.
:::

:::details 다른 사람이 채택 API를 직접 호출하면요?
컨트롤러가 SQL 실행 전에 로그인 세션(없으면 401)과 게시글 작성자 일치 여부(다르면 403)를 검사합니다. 클라이언트 UI에 버튼이 없어도 서버에서 막으므로 권한 우회가 되지 않습니다.
:::

:::details ai_flagged가 1이면 어떻게 되나요?
등록 직후 비동기 독성 검사에서 TOXICITY 점수가 임계값 이상이면 `ai_flagged=1`이 되고 화면에서 BLUR 오버레이로 가려집니다. 자동 삭제·차단은 하지 않고(ADR-0001), 신고 누적·관리자 검토를 거쳐 최종 차단/해제됩니다. 즉 AI는 1차 필터, 사람이 최종 결정입니다.
:::

## 8. 직접 말해보기

- 댓글과 대댓글을 한 테이블로 합친 이유와, 그게 가능한 전제(2단계 제한)를 30초로 설명해 보세요.
- 소프트삭제가 목록·캐시·신고에 동시에 주는 영향을 한 번에 말해 보세요.
- 채택 API의 401/403 분리와 작성자 권한 강제 지점을 코드 흐름으로 짚어 보세요.

## 퀴즈

<QuizBox question="COMMUNITY_COMMENT에서 일반 댓글과 대댓글을 구분하는 기준은 무엇인가?" :choices="['post_id 값', 'parent_comment_id 값이 NULL인지 여부', 'comment_status 값', 'ai_flagged 값']" :answer="1" explanation="parent_comment_id가 NULL이면 일반 댓글, 값이 있으면 그 부모에 달린 대댓글이다. 같은 테이블의 자기참조로 2단계를 표현한다." />

<QuizBox question="댓글 삭제 시 실제로 일어나는 일은?" :choices="['행을 DELETE 한다', 'comment_status를 DELETED로 바꾸고 댓글 수 캐시를 줄인다', 'parent_comment_id를 NULL로 만든다', 'ai_flagged를 1로 올린다']" :answer="1" explanation="ADR-0008 소프트삭제에 따라 행을 지우지 않고 comment_status를 DELETED로 변경하며, 게시글의 comment_count 캐시를 감소시켜 정합성을 맞춘다. 목록 쿼리는 DELETED를 제외한다." />

<QuizBox question="질문 게시글의 채택 정보가 저장되는 위치로 옳은 것은?" :choices="['COMMUNITY_COMMENT의 새 컬럼', 'COMMUNITY_POST의 accepted_comment_id 등 컬럼', 'COMMUNITY_COMMENT_LIKE 테이블', '세션 속성 loginUser']" :answer="1" explanation="채택은 게시글 단위로 하나뿐이라 COMMUNITY_POST의 accepted_comment_id, is_solved, solved_at에 기록한다. 작성자 본인만 채택할 수 있도록 서버에서 강제한다." />
