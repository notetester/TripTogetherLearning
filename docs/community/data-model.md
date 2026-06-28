---
title: "커뮤니티 데이터 모델"
owner: B
domain: "커뮤니티·신고"
tags: ["데이터모델"]
---

# 커뮤니티 데이터 모델

> 게시글 한 테이블 + 댓글·이미지·좋아요·태그 위성 테이블로 짜인 UGC 스키마. 캐시 컬럼과 소프트삭제로 읽기 성능과 안전을 동시에 잡는다.

## 1. 한 줄 정의

커뮤니티 데이터 모델은 `COMMUNITY_POST`를 중심에 두고 댓글(`COMMUNITY_COMMENT`)·이미지(`COMMUNITY_POST_IMAGE`)·좋아요(`COMMUNITY_POST_LIKE`, `COMMUNITY_COMMENT_LIKE`)·태그(`COMMUNITY_TAG`, `COMMUNITY_POST_TAG`, `COMMUNITY_TAG_RELATION`) 위성 테이블이 1:N으로 매달린 관계형 스키마다.

## 2. 왜 이렇게 설계했나

UGC(사용자 생성 콘텐츠)는 쓰기보다 읽기가 압도적으로 많다. 목록·상세 화면이 매번 좋아요 수와 댓글 수를 집계하면 비싸진다. 그래서 세 가지 설계 원칙을 적용했다.

- **단일 테이블 + 유형 분기**: review/photo/tip/question을 별도 테이블로 쪼개지 않고 `COMMUNITY_POST.post_type` 한 컬럼으로 구분한다. 목록·검색·페이징 쿼리를 한 테이블에서 끝내고, 유형 전용 컬럼은 NULL 허용으로 공존시킨다.
- **캐시 컬럼(denormalization)**: `like_count`, `comment_count`, `view_count`, `report_count`를 게시글 행에 직접 들고 있어 목록 화면이 집계 쿼리(`COUNT(*)`) 없이 행 하나만 읽으면 된다. 정답은 별도 좋아요·댓글 테이블에 있고, 캐시 컬럼은 그 사본이다.
- **소프트삭제(ADR-0008)**: 물리 삭제 대신 `post_status`, `comment_status`로 상태를 바꾼다. 신고·감사·복구 요구가 잦은 UGC에서 데이터를 지우지 않고 숨긴다. 이 때문에 거의 모든 외래키가 `ON DELETE RESTRICT`로 묶여 부모 행의 물리 삭제 자체를 막는다.

:::tip 캐시 컬럼의 트레이드오프
캐시 컬럼은 빠른 대신 정답과 어긋날 수 있다(좋아요 동시 클릭, 중간 실패). TripTogether는 이를 받아들이고, 주기적으로 실제 테이블과 캐시를 맞추는 `CommunityCacheReconcileScheduler`로 정합성을 보정한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

MyBatis 4계층(controller → service → mapper → vo)으로 구현된다. JPA는 쓰지 않고 `@Mapper` 인터페이스 + XML 매퍼로 SQL을 직접 관리한다.

| 테이블 | 역할 | 대표 컬럼 | 매핑 VO |
| --- | --- | --- | --- |
| COMMUNITY_POST | 게시글 본체 | post_id, post_type, post_status, like_count, comment_count | CommunityPostDto |
| COMMUNITY_COMMENT | 댓글·대댓글 | comment_id, parent_comment_id, comment_status, like_count | CommunityCommentDto |
| COMMUNITY_POST_IMAGE | 게시글 이미지 N장 | image_id, sort_order, is_auto | CommunityPostImageDto |
| COMMUNITY_POST_LIKE | 게시글 좋아요(정답) | like_id, post_id, user_idx | (매퍼 직접) |
| COMMUNITY_COMMENT_LIKE | 댓글 좋아요(정답) | like_id, comment_id, user_idx | (매퍼 직접) |
| COMMUNITY_TAG | 태그 사전 | tag_id, tag_name, use_count | (매퍼 직접) |
| COMMUNITY_POST_TAG | 글-태그 연결 | post_id, tag_id | (매퍼 직접) |
| COMMUNITY_TAG_RELATION | 태그 공출현 | tag_id_a, tag_id_b, co_count | (매퍼 직접) |

핵심 클래스: `CommunityController`, `CommunityService`/`CommunityServiceImpl`, `CommunityMapper`(@Mapper), 그리고 캐시 보정·이미지 비동기 처리를 맡는 `CommunityCacheReconcileScheduler`, `CommunityImageScheduler`.

작성·검색 요청은 `CommunityWriteDto`, `CommunitySearchDto`로 받고, 응답은 `CommunityPostDto`(대표 이미지 thumbUrl을 sort_order=1 행에서 JOIN)로 내려준다. 모든 응답은 도메인 공통 envelope를 통해 나간다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 ER 관계

```text
USERS (user_idx)
  │ 1:N
  ├── COMMUNITY_POST (post_id)
  │     │ 1:N
  │     ├── COMMUNITY_COMMENT (comment_id, parent_comment_id→self)
  │     │     └── COMMUNITY_COMMENT_LIKE (uq: comment_id+user_idx)
  │     ├── COMMUNITY_POST_IMAGE (sort_order=1이 대표)
  │     ├── COMMUNITY_POST_LIKE (uq: post_id+user_idx)
  │     └── COMMUNITY_POST_TAG ──N:1── COMMUNITY_TAG (tag_id)
  │                                        │
  │                          COMMUNITY_TAG_RELATION (tag_id_a, tag_id_b, co_count)
```

### 4.2 핵심 컬럼 표

| 컬럼 | 테이블 | 의미 |
| --- | --- | --- |
| post_type | COMMUNITY_POST | review/photo/tip/question 유형 분기 |
| post_status | COMMUNITY_POST | ACTIVE/BLOCKED/DELETED 소프트삭제 상태 |
| like_count / comment_count | COMMUNITY_POST | 좋아요·댓글 수 캐시(목록 성능) |
| accepted_comment_id / is_solved | COMMUNITY_POST | question 유형 채택·해결 여부 |
| tip_category | COMMUNITY_POST | tip 유형 전용 카테고리 |
| ai_flagged | COMMUNITY_POST / COMMUNITY_COMMENT | AI 독성 의심 플래그(BLUR 오버레이 트리거) |
| parent_comment_id | COMMUNITY_COMMENT | NULL이면 일반 댓글, 값 있으면 대댓글 |
| sort_order / is_auto | COMMUNITY_POST_IMAGE | 1번이 대표, is_auto=1이면 Pixabay 자동 이미지 |
| co_count | COMMUNITY_TAG_RELATION | 두 태그가 같은 글에 함께 달린 누적 횟수 |

### 4.3 좋아요 일관성 (정답 테이블 + 캐시)

좋아요는 두 곳에 기록된다. 정답은 좋아요 테이블에, 사본은 게시글 캐시 컬럼에 있다. `COMMUNITY_POST_LIKE`의 `uq_comm_like (post_id, user_idx)` 유니크 제약이 한 사용자 1회 좋아요를 DB 차원에서 보장한다.

```sql
-- 좋아요 추가: 정답 1행 INSERT (중복은 유니크 제약이 막음)
INSERT INTO COMMUNITY_POST_LIKE (post_id, user_idx) VALUES (?, ?);
-- 같은 트랜잭션에서 캐시 컬럼 +1
UPDATE COMMUNITY_POST SET like_count = like_count + 1 WHERE post_id = ?;
```

### 4.4 태그 공출현 정규화

`COMMUNITY_TAG_RELATION`은 두 태그를 항상 작은 ID를 tag_id_a, 큰 ID를 tag_id_b로 정렬해 저장한다. 이렇게 하면 (A,B)와 (B,A)가 한 행으로 합쳐져 `uq_tag_relation (tag_id_a, tag_id_b)`로 중복 없이 `co_count`만 누적된다. 연관 태그 추천의 그래프 토대다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: 8개 테이블 전부 생성·운영, 유형 분기, 캐시 컬럼, 소프트삭제, 좋아요 유니크 제약, 태그 공출현 누적, 대표 이미지 JOIN, 캐시 보정 스케줄러(`CommunityCacheReconcileScheduler`), 이미지 비동기 스케줄러(`CommunityImageScheduler`).
- **부분/연계**: `ai_flagged`는 Perspective 독성 판정과 연동되지만 자동 차단은 하지 않고 어드민 큐로 보낸다(ADR-0010). 자세한 흐름은 [독성 감지](/community/toxicity-perspective) 참고.
- **계획/한계**: AI 모더레이션 정확도의 정량 평가 체계는 부재(향후 과제). 모바일은 JSP 데스크톱 레이아웃 위주라 반응형은 향후 과제. 태그 공출현 그래프를 활용한 본격 추천 UI는 데이터 토대까지만 구현된 상태다.

## 6. 면접 답변 3단계

1. **한 줄**: "게시글 한 테이블에 유형 분기 컬럼을 두고, 댓글·이미지·좋아요·태그를 위성 테이블로 1:N으로 붙인 UGC 스키마입니다."
2. **설계 의도**: "읽기가 많은 도메인이라 좋아요·댓글 수를 게시글 행에 캐시 컬럼으로 들고 목록 집계 쿼리를 없앴고, 신고·복구가 잦아 소프트삭제와 ON DELETE RESTRICT로 데이터를 지키게 했습니다."
3. **트레이드오프와 보정**: "캐시 컬럼은 정답과 어긋날 수 있어 좋아요 정답은 별도 테이블에 유니크 제약으로 두고, 주기적 보정 스케줄러로 캐시를 실제 값과 맞춥니다."

## 7. 꼬리질문 + 모범답안

:::details 유형마다 테이블을 안 나누고 단일 테이블로 한 이유는?
유형 간 컬럼 차이가 크지 않고(전용 컬럼은 tip_category, is_solved, accepted_comment_id 정도), 목록·검색·페이징을 유형 무관하게 한 쿼리로 처리하는 이득이 큽니다. 전용 컬럼은 NULL 허용으로 공존시키고 post_type 인덱스(idx_cpd_type)로 유형 필터를 빠르게 합니다. 컬럼 수가 더 늘면 그때 분리를 검토합니다.
:::

:::details like_count 캐시 컬럼과 실제 좋아요 수가 어긋나면?
좋아요 정답은 COMMUNITY_POST_LIKE에 user 단위 유니크 제약으로 보존됩니다. 캐시는 사본이라 동시성·중간 실패로 틀어질 수 있는데, CommunityCacheReconcileScheduler가 주기적으로 실제 테이블을 집계해 캐시 컬럼을 덮어써 정합성을 회복합니다. 화면은 빠른 캐시를, 정합성은 스케줄러가 책임지는 분리입니다.
:::

:::details 대댓글은 어떻게 표현했나?
COMMUNITY_COMMENT에 자기참조 컬럼 parent_comment_id를 둡니다. NULL이면 일반 댓글, 값이 있으면 그 댓글의 대댓글입니다. 부모-자식이 같은 테이블에 있어 한 번의 조회로 트리를 구성합니다. 부모 댓글 외래키는 ON DELETE CASCADE라 부모가 물리 삭제되면 자식도 함께 정리되지만, 운영상으로는 소프트삭제(comment_status=DELETED)를 씁니다.
:::

:::details 태그를 (A,B)/(B,A) 중복 없이 저장한 방법은?
COMMUNITY_TAG_RELATION에 항상 작은 ID를 tag_id_a, 큰 ID를 tag_id_b로 정렬해 넣습니다. uq_tag_relation 유니크 제약으로 한 쌍이 한 행이 되고, 같은 글에 또 함께 등장하면 co_count만 누적합니다. 방향 없는 공출현 그래프를 한 테이블로 정규화한 것입니다.
:::

:::details 외래키를 대부분 ON DELETE RESTRICT로 건 이유는?
소프트삭제 정책(ADR-0008)과 맞물립니다. 게시글이나 사용자를 물리 삭제하면 댓글·이미지·신고 이력이 함께 사라져 감사·복구가 불가능해집니다. RESTRICT로 부모 물리 삭제 자체를 막고, 삭제는 status 컬럼 전환으로만 처리해 데이터를 보존합니다.
:::

## 8. 직접 말해보기

- 좋아요 정답 테이블과 like_count 캐시 컬럼이 왜 둘 다 필요한지, 어긋남을 어떻게 보정하는지 2분 안에 설명해 보라.
- 단일 게시글 테이블에 review/photo/tip/question을 담는 설계의 장점과, 어떤 조건이면 테이블 분리를 고려할지 말해 보라.
- 태그 공출현(co_count)을 정규화한 방식과 그것이 연관 태그 추천에 어떻게 쓰이는지 설명해 보라.

관련 학습: [게시글 유형](/community/post-types) · [댓글·대댓글·채택](/community/comments-replies) · [좋아요·태그](/community/likes-tags) · [이미지(Cloudinary·Pixabay)](/community/images) · [신고 상태머신](/community/report-system)
허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="COMMUNITY_POST의 like_count, comment_count 같은 캐시 컬럼을 둔 가장 큰 이유는?" :choices="['데이터 무결성을 강제하려고', '목록 화면에서 매번 집계 쿼리를 돌리지 않고 행 하나만 읽기 위해', '좋아요를 여러 번 누르게 허용하려고', '소프트삭제를 구현하려고']" :answer="1" explanation="읽기가 많은 UGC에서 목록마다 COUNT를 돌리면 비싸므로, 좋아요·댓글 수를 게시글 행에 캐시 컬럼으로 들고 행 하나만 읽습니다. 정답은 별도 좋아요·댓글 테이블에 있고 캐시는 사본이라 스케줄러로 보정합니다." />

<QuizBox question="COMMUNITY_COMMENT에서 parent_comment_id가 NULL이라는 것은 무엇을 의미하나?" :choices="['삭제된 댓글이다', '관리자 댓글이다', '대댓글이 아니라 일반 댓글이다', 'AI가 차단한 댓글이다']" :answer="2" explanation="parent_comment_id는 자기참조 컬럼으로 NULL이면 일반 댓글, 값이 있으면 그 댓글에 달린 대댓글입니다. 부모와 자식이 같은 테이블에 있어 한 번의 조회로 트리를 구성합니다." />

<QuizBox question="COMMUNITY_TAG_RELATION에서 tag_id_a에는 작은 ID, tag_id_b에는 큰 ID를 넣도록 정규화한 목적은?" :choices="['두 태그 쌍의 방향 차이로 인한 중복 행을 없애고 co_count를 한 행에 누적하기 위해', '태그를 알파벳 순으로 정렬하려고', '외래키 제약을 피하려고', '태그 삭제를 빠르게 하려고']" :answer="0" explanation="방향 없는 공출현을 한 쌍 한 행으로 만들려고 작은 ID를 a, 큰 ID를 b로 정렬합니다. uq_tag_relation 유니크 제약과 결합해 같은 두 태그가 또 함께 등장하면 co_count만 누적됩니다." />
