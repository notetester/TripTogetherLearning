---
title: "게시글 유형"
owner: B
domain: "커뮤니티·신고"
tags: ["게시글"]
---

# 게시글 유형

> 커뮤니티 게시글은 하나의 테이블 `COMMUNITY_POST`에 `post_type` 컬럼으로 review/photo/tip/question 4유형을 담고, 유형마다 다른 검증·UI·워크플로우를 적용한다.

## 1. 한 줄 정의

TripTogether 커뮤니티는 후기(review)·사진(photo)·꿀팁(tip)·질문(question) 4가지 글 유형을 하나의 게시글 모델로 통합 관리하고, 유형 값에 따라 작성 검증과 화면 동작을 분기한다.

## 2. 왜 이렇게 설계했나

여행 커뮤니티에 들어오는 글은 성격이 제각각이다. 다녀온 후기, 사진 위주 갤러리, 정보성 꿀팁, 답을 구하는 질문은 노출 방식과 필요한 데이터가 다르다. 그렇다고 유형별로 테이블을 4개 쪼개면 목록 조회·신고·좋아요·태그 같은 공통 기능을 매번 4번 구현해야 한다.

그래서 공통 속성(제목·본문·작성자·상태·좋아요·조회수)은 `COMMUNITY_POST` 한 테이블에 모으고, 유형만 `post_type` 컬럼으로 구분하는 단일 테이블 + 판별 컬럼 설계를 택했다. 유형 고유 속성(질문의 채택, 팁의 카테고리)은 nullable 컬럼이나 보조 테이블로 분리해, 공통 로직은 한 번만 짜고 유형별 차이만 코드에서 분기한다.

:::tip 단일 테이블의 트레이드오프
공통 기능 재사용이 쉬워지는 대신, 특정 유형에만 의미 있는 컬럼(`accepted_comment_id`, `is_solved`, `tip_category`)이 다른 유형 행에서는 NULL로 남는다. 의미 없는 NULL을 허용하는 대신 조인·중복 코드를 줄이는 선택이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 게시글 테이블 | `COMMUNITY_POST` | 4유형 공통 저장, `post_type`/`post_status`로 분기 |
| 작성 요청 DTO | `CommunityWriteDto` | `postType` 기본값 review, `tipCategory`/`tags`/`images` 바인딩 |
| 게시글 VO | `CommunityPostDto` | 조회 결과 매핑 (isSolved, acceptedCommentId 포함) |
| 서비스 | `CommunityServiceImpl` | 유형별 검증·INSERT 분기, 채택 처리 |
| 컨트롤러 | `CommunityController` | 글쓰기·상세·채택 엔드포인트 |
| 매퍼 | `CommunityMapper` (+ `CommunityMapper.xml`) | 유형 업데이트·채택 SQL |
| 댓글 테이블 | `COMMUNITY_COMMENT` | 질문 답변 후보, 채택 대상 |

핵심 컬럼만 추리면 다음과 같다.

```sql
-- COMMUNITY_POST (요약)
post_type    varchar(20) NOT NULL DEFAULT review   -- review/photo/tip/question
post_status  varchar(20) NOT NULL DEFAULT ACTIVE   -- ACTIVE/BLOCKED/DELETED
is_solved    tinyint     DEFAULT NULL              -- question 전용, NULL이면 비해당
accepted_comment_id bigint DEFAULT NULL            -- question 전용 채택 댓글
tip_category varchar(20) DEFAULT NULL              -- tip 전용
```

`post_type`과 `post_status` 모두 별도 인덱스(`idx_cpd_type`, `idx_cpd_status`)가 있어, 유형 탭 필터링과 상태 필터링이 함께 걸려도 빠르게 조회된다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4유형 비교

| 유형 | 핵심 제약 | 전용 데이터 | 화면 동작 |
| --- | --- | --- | --- |
| review | 일반 후기, 특별 제약 없음 | 없음 | 본문 1장 썸네일 |
| photo | 본문 이미지 3장 이상 강제 | 없음 | 목록에서 갤러리 3장 표시 |
| tip | 카테고리 지정 | `tip_category` (없으면 other) | 카테고리 뱃지 |
| question | 답변 채택 가능 | `is_solved`, `accepted_comment_id` | 해결/미해결 상태 + 채택 버튼 |

### photo는 왜 3장을 강제하나

photo 유형은 목록을 갤러리 카드로 보여주기 때문에, 대표 1장만으로는 갤러리 레이아웃이 깨진다. 그래서 작성·수정 시 본문 HTML 안의 `img` 태그를 jsoup로 파싱해 3장 미만이면 등록을 막는다.

```java
// CommunityServiceImpl.writePost (요약)
if ("photo".equals(postType)) {
    int totalImgs = Jsoup.parse(sanitizedContent).select("img[src]").size();
    if (totalImgs < 3) {
        throw new IllegalStateException(msg.get("community.service.error.photoMinImages"));
    }
}
```

목록 썸네일 저장 개수도 유형으로 분기한다. photo는 3장, 나머지는 1장만 `COMMUNITY_POST_IMAGE`에 보관한다(`thumbnailImageCount`가 photo면 3, 아니면 1 반환).

### question의 답변 채택(Q&A 분리)

질문 글은 일반 게시글과 다르게 "정답 채택"이라는 상태 전이를 가진다. 작성자가 댓글 하나를 채택하면 게시글 행이 갱신된다.

```sql
-- CommunityMapper.xml: acceptComment
UPDATE COMMUNITY_POST
SET accepted_comment_id = #{commentId},
    is_solved           = 1,
    solved_at           = NOW()
WHERE post_id = #{postId}
```

채택은 게시글 작성자 본인만 가능하다. `CommunityController.acceptComment`가 권한을 단계별 HTTP 상태로 분리한다.

| 상황 | 응답 |
| --- | --- |
| 비로그인 | 401 |
| 작성자 아님 | 403 (acceptOwnerOnly) |
| 정상 채택 | 200, is_solved = 1 |

question 글은 작성 시 `insertPostQuestion`으로 `is_solved`를 0으로 초기화해 미해결 상태로 시작한다. review/photo/tip 글은 `is_solved`가 NULL로 남아 채택 개념 자체가 비해당임을 데이터로 표현한다.

### 작성 전체 흐름

```text
글쓰기 요청(postType 포함)
  → 도배 방지(시간창 내 작성 수 체크)
  → 본문 XSS 정화(jsoup, ADR-0005)
  → photo면 이미지 3장 검증
  → COMMUNITY_POST INSERT
  → 지역/유형 업데이트(updatePostRegionType)
  → 이미지/태그 저장
  → tip이면 tip_category, question이면 is_solved 초기화
  → 보상 지급(rewardService)
```

전체가 `@Transactional`이라 중간 단계에서 예외가 나면 게시글·이미지·태그가 함께 롤백된다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 4유형 분기 작성·조회 | 구현됨 |
| photo 3장 강제 검증 | 구현됨 |
| question 채택(accepted_comment_id, is_solved) | 구현됨 |
| 작성자 전용 채택 권한(401/403 분리) | 구현됨 |
| tip 카테고리 저장 | 구현됨 (미지정 시 other) |
| 유형별 보상 지급 | 구현됨 |
| 유형별 정렬·추천 가중치 차등 | 계획 (현재 공통 정렬) |

:::warning post_type은 문자열 컬럼
`post_type`/`post_status`는 enum이 아니라 varchar라서, 서비스 코드의 문자열 비교(review/photo/tip/question)와 DB 값이 어긋나면 분기가 조용히 누락될 수 있다. 새 유형 추가 시 DB 기본값·서비스 분기·화면 3곳을 함께 고쳐야 한다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "커뮤니티 게시글은 단일 테이블 `COMMUNITY_POST`에 `post_type` 컬럼으로 review/photo/tip/question 4유형을 통합 저장하고, 유형마다 검증과 동작을 분기합니다."
2. **설계 이유**: "유형별 테이블 분리 대신 공통 속성을 한 테이블에 모아 목록·신고·좋아요·태그 같은 공통 기능을 한 번만 구현했고, 유형 고유 속성은 nullable 컬럼이나 보조 테이블로 분리했습니다."
3. **구체 근거**: "예를 들어 photo는 갤러리 표시를 위해 본문 이미지 3장 이상을 jsoup 파싱으로 강제하고, question은 작성자 본인만 댓글을 채택해 `accepted_comment_id`와 `is_solved`를 갱신하는 Q&A 워크플로우를 둡니다."

## 7. 꼬리질문 + 모범답안

:::details 유형마다 테이블을 나누지 않은 이유는?
공통 기능(목록 조회, 좋아요, 신고, 태그, 소프트삭제)이 4유형 모두에 동일하게 필요했기 때문이다. 테이블을 나누면 그 공통 로직을 유형 수만큼 중복 구현해야 한다. 단일 테이블 + `post_type` 판별 컬럼으로 공통 로직을 한 번만 짜고 차이만 분기해, NULL 컬럼 일부를 감수하는 대신 유지보수 비용을 줄였다.
:::

:::details photo 3장 검증을 프론트가 아니라 서버에서 하는 이유는?
프론트 검증은 우회 가능하기 때문이다. 본문 HTML은 어차피 서버에서 jsoup로 XSS 정화하므로, 같은 파싱 결과로 `img` 개수를 세어 3장 미만이면 `IllegalStateException`을 던진다. 갤러리 레이아웃 무결성을 데이터 진입 시점에서 보장한다.
:::

:::details review/photo/tip 글의 is_solved가 NULL인 이유는?
채택은 question에만 의미가 있다. 0(미해결)과 NULL(비해당)을 구분해, 질문이 아닌 글에는 채택 개념이 적용되지 않음을 데이터로 표현한다. question 글만 작성 시 `is_solved`를 0으로 초기화한다.
:::

:::details 채택 권한 위반을 401과 403으로 나눈 이유는?
401은 인증 자체가 없는 상태(비로그인), 403은 인증은 됐지만 권한이 없는 상태(작성자 아님)를 뜻한다. 클라이언트가 로그인 유도와 권한 안내를 다르게 처리할 수 있도록 의미를 분리했다. 신고 도메인의 상태 코드 분리 정책과도 일관된다.
:::

:::details 새 유형(예: poll 설문)을 추가하려면 어디를 고치나?
DB의 `post_type` 허용 값 인식, 서비스의 문자열 분기(검증·INSERT), 화면 표시 로직 세 곳을 함께 고쳐야 한다. `post_type`이 varchar라 컬럼 스키마 변경은 필요 없지만, 분기 누락 시 조용히 review처럼 처리될 수 있어 검증 분기와 기본값을 반드시 함께 확인해야 한다.
:::

## 8. 직접 말해보기

- 4유형을 하나의 테이블에 담은 설계의 장단점을 30초로 설명해 보라.
- photo의 3장 강제 검증이 서버 어느 계층에서, 어떤 라이브러리로 일어나는지 말해 보라.
- question의 채택이 `COMMUNITY_POST`의 어떤 컬럼을 어떻게 바꾸는지, 그리고 누가 채택할 수 있는지 설명해 보라.

더 보기: [댓글·대댓글·채택](/community/comments-replies) · [이미지 처리](/community/images) · [데이터 모델](/community/data-model) · [커뮤니티 개요](/community/)

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="COMMUNITY_POST 테이블에서 4가지 게시글 유형을 구분하는 컬럼은?" :choices="['post_status', 'post_type', 'tip_category', 'region']" :answer="1" explanation="post_type 컬럼이 review/photo/tip/question을 구분합니다. post_status는 ACTIVE/BLOCKED/DELETED 상태값입니다." />

<QuizBox question="photo 유형 게시글에 강제되는 조건은?" :choices="['본문 글자 수 100자 이상', '본문 이미지 3장 이상', '태그 3개 이상', '카테고리 필수 지정']" :answer="1" explanation="photo는 목록을 갤러리로 표시하기 때문에 본문 이미지 3장 이상을 jsoup 파싱으로 강제하며, 3장 미만이면 등록을 막습니다." />

<QuizBox question="question 유형에서 답변이 채택될 때 COMMUNITY_POST에 일어나는 변화로 옳은 것은?" :choices="['post_status가 BLOCKED로 바뀐다', 'accepted_comment_id가 채워지고 is_solved가 1이 된다', 'tip_category가 설정된다', '게시글이 소프트삭제된다']" :answer="1" explanation="acceptComment는 accepted_comment_id에 채택 댓글 ID를 넣고 is_solved를 1, solved_at을 현재 시각으로 갱신합니다. 채택은 게시글 작성자 본인만 가능합니다." />
