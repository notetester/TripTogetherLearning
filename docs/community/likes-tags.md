---
title: "좋아요·태그"
owner: B
domain: "커뮤니티·신고"
tags: ["좋아요", "태그"]
---

# 좋아요·태그

> 좋아요는 UNIQUE 제약으로 중복을 막고 캐시 컬럼으로 빠르게 읽으며, 태그는 공출현(co-occurrence) 횟수를 누적해 연관 글을 추천한다.

## 1. 한 줄 정의

좋아요는 한 유저가 한 글(또는 댓글)에 한 번만 누를 수 있는 토글이고, 태그는 글에 붙는 자유 키워드이며, 같은 글에 함께 등장한 태그 쌍의 빈도를 쌓아 연관 글 추천에 쓰는 약한 추천 신호다.

## 2. 왜 이렇게 설계했나

세 가지 결정이 이 페이지의 뼈대다.

- **중복 방지를 DB 제약으로 강제한다.** 좋아요는 동시 클릭과 더블탭이 흔하다. 애플리케이션 코드의 조회 후 삽입만으로는 경합에서 두 번 들어갈 수 있으므로, 테이블에 (대상, 유저) UNIQUE 키를 두고 DB가 마지막 방어선이 되게 했다.
- **개수는 캐시 컬럼으로 읽는다.** 목록 화면은 글마다 좋아요 수를 보여준다. 매번 COUNT를 돌리면 N+1과 풀스캔이 생기므로, 게시글 행에 like_count 정수 컬럼을 두고 토글마다 +1 / -1 한다. 읽기는 컬럼 한 개로 끝난다.
- **추천은 무거운 ML 없이 공출현으로 근사한다.** 외부 추천 엔진 없이, 사람들이 같은 글에 함께 붙인 태그는 의미적으로 가깝다는 가정을 이용한다. 태그 쌍의 공출현 횟수만 누적하면 SQL JOIN 한 번으로 연관 글을 뽑을 수 있다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 | 실제 이름 |
| --- | --- |
| 게시글 좋아요 테이블 | `COMMUNITY_POST_LIKE` (UNIQUE `uq_comm_like` = post_id + user_idx) |
| 댓글 좋아요 테이블 | `COMMUNITY_COMMENT_LIKE` (UNIQUE `uq_comment_like` = comment_id + user_idx) |
| 좋아요 수 캐시 | `COMMUNITY_POST.like_count`, `COMMUNITY_COMMENT.like_count` |
| 태그 사전 | `COMMUNITY_TAG` (tag_name UNIQUE, use_count) |
| 글-태그 연결 | `COMMUNITY_POST_TAG` (UNIQUE post_id + tag_id) |
| 태그 공출현 | `COMMUNITY_TAG_RELATION` (tag_id_a, tag_id_b, co_count) |
| 서비스 | `CommunityServiceImpl.toggleLike / toggleCommentLike / updateTagRelation` |
| 매퍼 | `CommunityMapper` + `CommunityMapper.xml` |
| 정합성 안전망 | `CommunityCacheReconcileScheduler` (매일 04:30 KST 일괄 정정) |
| 진입점 | `CommunityController` POST /community/{postId}/like, POST /community/comment/{commentId}/like (둘 다 @RequireLogin) |

좋아요 토글은 `@Transactional`이라 행 삽입/삭제와 캐시 증감이 한 트랜잭션으로 묶인다.

## 4. 동작 원리 (흐름·표·작은 코드)

**좋아요 토글** — 현재 상태를 읽고 반대로 뒤집는다.

```java
@Transactional
public boolean toggleLike(Long postId, Long userIdx) {
    if (isLiked(postId, userIdx)) {        // COUNT(*) > 0
        deleteLike(postId, userIdx);
        decreaseLikeCount(postId);          // GREATEST(like_count - 1, 0)
        return false;                       // 취소됨
    }
    insertLike(postId, userIdx);            // INSERT IGNORE (UNIQUE 충돌 무시)
    increaseLikeCount(postId);              // like_count + 1
    // 본인 글이 아니면 피드 알림 + 리워드 지급
    return true;                            // 좋아요됨
}
```

방어선이 두 겹이다. INSERT는 `INSERT IGNORE`라 동시 요청이 UNIQUE 키에 부딪혀도 예외 대신 무시되고, 감소는 `GREATEST(like_count - 1, 0)`이라 캐시가 음수로 내려가지 않는다.

**태그 공출현 누적** — 글 저장/수정 시 그 글의 태그를 모든 쌍으로 만들어 +1 한다.

```java
public void updateTagRelation(Long postId) {
    List<Long> tagIds = selectTagIdList(postId);
    if (tagIds == null || tagIds.size() < 2) return;   // 1개 이하면 쌍 없음
    for (int i = 0; i < tagIds.size(); i++)
        for (int j = i + 1; j < tagIds.size(); j++)
            upsertTagRelation(tagIds.get(i), tagIds.get(j));
}
```

핵심은 쌍의 정규화다. 같은 (도쿄, 오사카)와 (오사카, 도쿄)가 두 행으로 갈라지면 안 되므로, UPSERT에서 작은 ID를 tag_id_a, 큰 ID를 tag_id_b로 강제한다.

```sql
INSERT INTO COMMUNITY_TAG_RELATION (tag_id_a, tag_id_b, co_count, updated_at)
VALUES (LEAST(?, ?), GREATEST(?, ?), 1, NOW())
ON DUPLICATE KEY UPDATE co_count = co_count + 1, updated_at = NOW();
```

태그 자체도 같은 패턴이다. `COMMUNITY_TAG`는 tag_name UNIQUE에 ON DUPLICATE KEY UPDATE use_count = use_count + 1로 등록과 인기 카운트를 한 번에 처리한다.

**연관 글 추천** — 내 글의 태그와 공출현 점수가 높은 태그를 가진 다른 글을 뽑는다.

```sql
SELECT cp.*, SUM(ctr.co_count) AS total_co_count
FROM COMMUNITY_POST cp
JOIN COMMUNITY_POST_TAG cpt_other ON cp.post_id = cpt_other.post_id
JOIN COMMUNITY_POST_TAG cpt_mine  ON cpt_mine.post_id = ?
JOIN COMMUNITY_TAG_RELATION ctr
  ON (ctr.tag_id_a = cpt_mine.tag_id AND ctr.tag_id_b = cpt_other.tag_id)
  OR (ctr.tag_id_b = cpt_mine.tag_id AND ctr.tag_id_a = cpt_other.tag_id)
WHERE cp.post_status = ACTIVE AND cp.post_id != ?
GROUP BY cp.post_id
ORDER BY total_co_count DESC, cp.like_count DESC, cp.created_at DESC
LIMIT 3;
```

정규화로 한쪽 순서만 저장했으므로 JOIN 조건에서 a/b 양방향을 모두 매칭한다. 동점이면 좋아요 수, 그다음 최신순으로 가른다.

| 키 보장 | 무엇을 막나 |
| --- | --- |
| `uq_comm_like` post_id + user_idx | 한 유저의 같은 글 중복 좋아요 |
| `uq_post_tag` post_id + tag_id | 한 글에 같은 태그 두 번 |
| `uq_tag_relation` tag_id_a + tag_id_b | 같은 태그 쌍 행 분열 (LEAST/GREATEST 정규화 전제) |

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
좋아요 토글(게시글·댓글), UNIQUE 중복 방지, like_count 캐시 증감, 좋아요 시 피드 알림과 리워드 지급, 태그 UPSERT와 use_count, 공출현 누적, 연관 글 추천 SQL, 캐시 어긋남을 매일 04:30 KST 실제 행 수로 맞추는 `CommunityCacheReconcileScheduler` — 모두 동작한다.
:::

:::warning 한계·계획
태그 추천은 공출현 빈도 기반의 약한 신호이고 ML 임베딩 기반 의미 유사도는 아니다. 좋아요에는 가중치·시간 감쇠가 없어 단순 합산이다. 캐시 정정은 일배치라 그 사이에는 짧게 어긋날 수 있다(eventually consistent). 태그 추천 품질의 정량 평가 체계는 없다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: 좋아요는 UNIQUE 제약으로 중복을 막고 캐시 컬럼으로 빠르게 읽으며, 태그는 함께 등장한 빈도를 쌓아 연관 글을 추천합니다.
2. **설계 이유**: 동시 클릭 경합을 코드가 아니라 DB UNIQUE 키로 막아 정확성을 보장했고, 목록의 좋아요 수는 매번 COUNT 대신 캐시 정수 컬럼을 읽어 성능을 확보했습니다. 추천은 외부 엔진 없이 태그 공출현 횟수만으로 근사했습니다.
3. **트레이드오프 인지**: 캐시는 어긋날 수 있어 매일 새벽 실제 행 수로 정정하는 스케줄러를 두었고, 공출현 추천은 가벼운 대신 의미적 정밀도는 ML 방식보다 낮다는 점을 인정합니다.

## 7. 꼬리질문 + 모범답안

:::details 좋아요 더블클릭이 동시에 들어오면 like_count가 2 올라가지 않나요?
삽입은 (post_id, user_idx) UNIQUE 키에 INSERT IGNORE라 둘 중 하나는 무시되어 행은 하나만 남습니다. 다만 캐시 증가는 트랜잭션 안에서 두 번 호출될 여지가 있어 짧게 어긋날 수 있는데, 매일 04:30 KST `CommunityCacheReconcileScheduler`가 실제 행 수와 맞춰 정정합니다.
:::

:::details like_count 캐시를 두지 않고 매번 COUNT 하면 안 되나요?
정확하지만 목록 화면은 글마다 좋아요 수가 필요해 COUNT가 글 수만큼 늘어납니다. 캐시 컬럼은 읽기를 정수 한 개로 줄여 목록 쿼리를 단순하게 만듭니다. 대가는 정합성 관리이고, 그래서 일배치 정정 안전망을 둡니다.
:::

:::details 태그 쌍을 (작은ID, 큰ID)로 정규화하지 않으면 무슨 일이 생기나요?
같은 두 태그가 순서만 바꿔 (A, B)와 (B, A) 두 행으로 갈라집니다. 공출현 횟수가 두 곳에 흩어져 추천 점수가 절반으로 보이고 UNIQUE 키도 무력화됩니다. 그래서 UPSERT에서 LEAST를 tag_id_a, GREATEST를 tag_id_b로 강제하고 추천 JOIN은 양방향을 모두 매칭합니다.
:::

:::details 연관 글 추천에서 동점 글은 어떻게 정렬하나요?
공출현 합계 total_co_count 내림차순이 1순위이고, 같으면 like_count 내림차순, 그래도 같으면 최신순입니다. 인기와 신선도를 보조 기준으로 써서 같은 점수 안에서 더 볼 만한 글이 위로 옵니다.
:::

:::details 댓글 좋아요는 게시글 좋아요와 구조가 같나요?
같은 패턴입니다. `COMMUNITY_COMMENT_LIKE`가 comment_id + user_idx UNIQUE를 갖고, `COMMUNITY_COMMENT.like_count` 캐시를 토글마다 증감합니다. 차이는 댓글 채택·대댓글 흐름과 엮인다는 점이고 중복 방지와 캐시 동기화 원리는 동일합니다.
:::

## 8. 직접 말해보기

- 좋아요 중복을 막는 방어선이 왜 두 겹(UNIQUE 키 + INSERT IGNORE)인지 30초로 설명해 보라.
- like_count 캐시가 실제 행 수와 어긋나는 시나리오 하나와, 시스템이 어떻게 복구하는지 말해 보라.
- 태그 쌍 정규화(LEAST/GREATEST)가 없을 때 추천 점수가 어떻게 망가지는지 예를 들어 설명해 보라.

## 퀴즈

<QuizBox question="COMMUNITY_POST_LIKE의 UNIQUE 키 uq_comm_like는 어떤 컬럼 조합인가?" :choices="['like_id 단독', 'post_id + user_idx', 'post_id + created_at', 'user_idx 단독']" :answer="1" explanation="post_id와 user_idx의 조합 UNIQUE로 한 유저가 같은 글에 두 번 좋아요하는 것을 DB 차원에서 막는다." />

<QuizBox question="목록 화면에서 글마다 COUNT를 돌리지 않고 좋아요 수를 빠르게 읽기 위해 사용하는 것은?" :choices="['매번 서브쿼리 COUNT', 'COMMUNITY_POST의 like_count 캐시 컬럼', '레디스 전용 카운터', '프런트 로컬스토리지']" :answer="1" explanation="게시글 행의 like_count 정수 컬럼을 토글마다 증감하고 읽기는 컬럼 한 개로 끝낸다. 어긋남은 일배치 스케줄러가 정정한다." />

<QuizBox question="COMMUNITY_TAG_RELATION에서 같은 태그 쌍이 두 행으로 갈라지지 않게 하는 방법은?" :choices="['삽입 순서를 신뢰한다', 'LEAST를 tag_id_a, GREATEST를 tag_id_b로 정규화', 'co_count로 정렬', '태그명을 알파벳순 문자열로 저장']" :answer="1" explanation="작은 ID를 tag_id_a, 큰 ID를 tag_id_b로 강제하면 순서가 달라도 같은 쌍은 한 행에 모여 co_count가 정확히 누적된다." />
