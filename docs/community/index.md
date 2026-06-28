---
title: "커뮤니티·신고 개요"
owner: B
domain: "커뮤니티·신고"
tags: ["커뮤니티"]
---

# 커뮤니티·신고 개요

> 여행 후기·사진·팁·질문을 한 게시판에서 다루고, 신고 누적과 AI 모더레이션으로 자율 정화되는 사용자 생성 콘텐츠(UGC) 도메인.

TripTogether는 국내 여행 올인원 플랫폼(탐색 → 계획 → 예약 → 공유)이고, 그중 **공유** 단계를 책임지는 것이 커뮤니티·신고 도메인이다. 사용자가 직접 글을 쓰는 영역이므로 콘텐츠 품질과 안전(욕설·스팸·음란물 차단)이 핵심 과제다. 이 페이지는 도메인 전체 지도이고, 세부 개념은 아래 학습 순서의 링크에서 다룬다.

## 1. 이 도메인은 무엇을 하나

하나의 통합 게시판에서 네 가지 글 유형을 다룬다. `COMMUNITY_POST.post_type` 컬럼 하나로 분기한다.

| 유형(post_type) | 용도 | 유형 전용 컬럼 |
| --- | --- | --- |
| review | 여행 후기 | (없음) |
| photo | 사진 중심 글 | 이미지(`COMMUNITY_POST_IMAGE`) |
| tip | 여행 팁 | `tip_category` |
| question | 질문 게시판 | `is_solved`, `accepted_comment_id` |

여기에 댓글·대댓글(`parent_comment_id`), 좋아요(`like_count` 캐시 컬럼), 태그(`COMMUNITY_TAG` + 공출현 관계), 이미지(Cloudinary 업로드), 네이티브 광고(`AD_CAMPAIGN`), 그리고 이 모든 콘텐츠를 감시하는 신고·모더레이션 파이프라인이 붙는다.

## 2. 담당과 협업 맥락

TripTogether는 4인이 도메인을 수직 분담해 만든 팀 프로젝트다. 이 챕터(`owner: B`)는 커뮤니티·신고 도메인을 다루지만, 콘텐츠 안전은 단일 모듈로 끝나지 않고 다른 모듈과 맞물린다.

- **공통 엔진 의존**: XSS 정화(jsoup, ADR-0005), 소프트삭제 패턴(ADR-0008), 권한 AOP(`AuthorizationAspect`, `@LoginUser`, ADR-0011)는 도메인 공통 인프라를 그대로 쓴다.
- **모더레이션 연계**: AI 독성 판정(Google Perspective API)과 관리자 승인 흐름은 admin 도메인의 모더레이션 큐(`ADMIN_ASSISTANT_MODERATION`, ADR-0010)와 연결된다.
- **알림 연계**: 신고 처리·BLUR 전환 시 작성자에게 가는 알림은 myPage/notification 도메인의 피드 알림을 호출한다.

즉 커뮤니티는 "글을 만드는 곳"이지만, 그 글의 안전은 공통 인프라 + admin + notification과 함께 완성된다. 도메인 경계는 [도메인 전체 개요](/domains)와 [전체 흐름](/flow/)에서 확인할 수 있다.

## 3. 핵심 기술 5가지

면접에서 이 도메인을 설명할 때 반드시 짚어야 할 다섯 가지다.

:::tip 한눈에 보기
게시글 유형 분기 → 태그 공출현 그래프 → Cloudinary 이미지 → Perspective AI 모더레이션 → 신고 누적 BLUR. 이 다섯 가지가 UGC 도메인의 골격이다.
:::

### (1) 게시글 유형(post_type) 단일 테이블 분기

별도 테이블을 만들지 않고 `COMMUNITY_POST` 한 테이블에 `post_type` 컬럼으로 review/photo/tip/question을 구분한다. question 전용 컬럼(`is_solved`, `accepted_comment_id`)과 tip 전용 컬럼(`tip_category`)은 NULL 허용으로 공존시킨다. 목록·검색은 `idx_cpd_type` 인덱스로 유형 필터를 빠르게 처리한다.

### (2) 태그 공출현 그래프

태그는 `COMMUNITY_TAG`(태그 사전) + `COMMUNITY_POST_TAG`(글-태그 연결) + `COMMUNITY_TAG_RELATION`(태그끼리 함께 쓰인 횟수)로 구성된다. `TAG_RELATION`은 두 태그를 작은 ID·큰 ID로 정규화해 저장하고 `co_count`로 공출현 횟수를 누적한다. 같은 글에 자주 함께 달린 태그를 추천하는 그래프 기반 연관 태그 기능의 토대다.

### (3) Cloudinary 이미지 저장 (ADR-0007)

이미지 원본을 DB나 서버 디스크에 두지 않고 외부 CDN(Cloudinary)에 올리고 URL만 `COMMUNITY_POST_IMAGE`에 저장한다. photo 유형이 아닌 글에도 본문 이미지가 들어갈 수 있고, 외부 이미지(Pixabay)는 24시간 캐싱 fallback으로 보완한다.

### (4) Perspective AI 모더레이션 (ADR-0010)

작성 시 Google Perspective API가 본문의 독성(TOXICITY 0~1)을 평가하고, 임계값을 넘으면 `ai_flagged` 플래그를 세운다. 사람 신고가 없어도 AI가 선제적으로 의심 콘텐츠를 표시하는 풀 스택 파이프라인이다. 단, AI 판정만으로 자동 차단하지는 않는다(어드민 판단 큐로 보냄).

### (5) 신고 누적 BLUR 정책 (ADR-0001 / ADR-0003)

같은 글에 서로 다른 사용자의 신고가 `report_count >= 3`이 되면 글을 **삭제하지 않고** 흐림(BLUR) 오버레이로 표시한다. status는 `ACTIVE`를 유지한다. 완전 차단(`BLOCKED`)은 어드민만 결정한다. "자동 처리는 약한 신호 → 점진적 공개, 강한 결정은 사람"이라는 철학이 정책으로 명문화돼 있다.

:::warning 흔한 오해 — 3회 신고면 차단?
3회 누적은 **자동 차단이 아니라 BLUR 오버레이**다. 사용자가 클릭하면 본문이 공개되고, status는 `ACTIVE`로 남는다. `BLOCKED`(완전 숨김)은 오직 어드민이 직접 차단할 때만 된다. ADR-0003가 이 둘을 의도적으로 분리했다.
:::

## 4. 동작 원리 — 글 한 편의 일생

작성부터 신고·정화까지 한 글이 거치는 흐름이다.

```text
작성 요청
  → @RequireLogin AOP 권한 검증
  → 작성 빈도 제한(스팸 방지, 최근 N분 내 작성 수 확인)
  → jsoup XSS 정화(ADR-0005, 허용 태그 화이트리스트)
  → Perspective 독성 평가 → 임계 초과면 ai_flagged=1
  → COMMUNITY_POST INSERT + 태그/이미지 연결 + 공출현 co_count 갱신
운영 중
  → 좋아요/댓글: like_count·comment_count 캐시 컬럼 갱신(ADR-0006)
  → 신고 접수: REPORT INSERT (uq_report 유니크로 1인 1신고)
  → report_count >= 3 → BLUR 오버레이(status=ACTIVE 유지), 작성자 알림
정리
  → 작성자 삭제: post_status=DELETED (소프트삭제, ADR-0008)
  → 어드민 차단: post_status=BLOCKED (완전 숨김 + 해제 가능)
```

신고 자체의 상태머신은 별도다. `REPORT.status`는 `IN_REVIEW`(검토중) → `RESOLVED`(처리완료) / `DISMISSED`(반려)로 가고, 신고자 본인은 `CANCELLED`로 취소할 수 있다. 취소 후 같은 대상을 재신고하면 `CANCELLED` 행을 되살린다(ADR-0004의 중복 방지 3중 방어).

## 5. 구현 상태 (됨 vs 계획)

| 항목 | 상태 |
| --- | --- |
| 게시글 4유형 / 댓글·대댓글 / 질문 채택 | 구현됨 |
| 태그 사전 + 공출현 그래프(co_count) | 구현됨 |
| Cloudinary 이미지 + Pixabay 24h fallback | 구현됨 |
| Perspective 독성 평가 + ai_flagged | 구현됨 |
| 신고 누적 BLUR + 어드민 BLOCKED 분리 | 구현됨 |
| 좋아요·댓글 수 캐시 컬럼 + 정합성 재조정 | 구현됨(ADR-0006 스케줄러) |
| 네이티브 광고(AD_CAMPAIGN) CRUD·트래킹 | 구현됨 |
| AI 응답·모더레이션 품질 정량 평가 | 미구현(향후 과제) |
| 모바일 반응형 레이아웃 | 미구현(JSP 데스크톱 위주) |

핵심 기능은 대부분 동작한다. 정량 평가 체계 부재와 데스크톱 위주 레이아웃이 알려진 한계다.

## 6. 권장 학습 순서

이 도메인을 처음 본다면 아래 순서로 읽기를 권한다(상세 페이지는 각 챕터에서).

1. **게시글 유형과 단일 테이블 설계** — `post_type` 분기와 유형 전용 컬럼의 트레이드오프
2. **댓글·대댓글과 질문 채택** — `parent_comment_id` 자기참조, question의 `accepted_comment_id`
3. **태그 공출현 그래프** — `COMMUNITY_TAG_RELATION`과 `co_count` 누적
4. **이미지 파이프라인** — Cloudinary 업로드(ADR-0007)와 Pixabay 캐싱 fallback
5. **AI 모더레이션** — Perspective 독성 + `ai_flagged`(ADR-0010)
6. **신고와 BLUR/BLOCKED 정책** — ADR-0001 / 0003 / 0004 / 0008의 결합
7. **캐시 컬럼 정합성** — `like_count`·`comment_count` 캐시와 재조정 스케줄러(ADR-0006)

허브 링크: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 7. 단골 면접 질문 5개

이 도메인을 설명할 때 거의 항상 나오는 질문이다. 각 답의 핵심만 적었다.

1. **네 가지 글 유형을 왜 한 테이블에 넣었나?**
   유형 간 공통 필드(제목·본문·작성자·통계)가 90%라 단일 테이블 + `post_type` 분기가 조인 없이 목록·검색을 단순화한다. 유형 전용 컬럼은 NULL 허용으로 공존시키고, 인덱스(`idx_cpd_type`)로 필터 성능을 확보했다.

2. **신고가 3번 쌓이면 글이 사라지나?**
   아니다. `report_count >= 3`이면 BLUR 오버레이만 씌우고 status는 `ACTIVE`로 둔다. 완전 차단(`BLOCKED`)은 어드민만 결정한다. 자동 처리는 약한 신호이므로 점진적 공개, 강한 결정은 사람이 한다는 ADR-0003 원칙이다.

3. **AI 모더레이션과 사람 신고는 어떻게 다른가?**
   Perspective가 작성 시점에 선제적으로 `ai_flagged`를 세우고, 사람 신고는 운영 중 `report_count`를 누적한다. 둘 다 자동 차단하지 않고 어드민 큐로 모은다(ADR-0010, ADR-0001).

4. **좋아요 수를 매번 COUNT 쿼리로 세지 않는 이유는?**
   조회가 압도적으로 많은 통계라 `like_count`·`comment_count`를 캐시 컬럼으로 두고 증감 시 갱신한다. 누락·드리프트는 재조정 스케줄러가 주기적으로 실제 값과 맞춘다(ADR-0006).

5. **중복 신고는 어떻게 막나?**
   `REPORT`의 `uq_report(user_idx, target_type, target_id)` 유니크 + 서비스 사전 SELECT + INSERT 사이 race에 대비한 최후 보루, 그리고 취소(`CANCELLED`) 행 재활성화까지 3중으로 방어한다(ADR-0004).

## 8. 직접 말해보기

다음 문장을 막힘없이 1분 안에 말할 수 있으면 이 도메인을 이해한 것이다.

- "TripTogether 커뮤니티는 review·photo·tip·question 네 유형을 `post_type` 한 컬럼으로 분기하는 단일 테이블 게시판이고, 콘텐츠 안전은 Perspective AI 선제 플래그와 사용자 신고 누적 BLUR로 이중화돼 있습니다."
- "신고 3회는 자동 차단이 아니라 BLUR 오버레이입니다. 약한 신호는 점진적 공개, 강한 결정인 BLOCKED는 어드민만 합니다. 이 분리가 ADR-0003에 명문화돼 있습니다."
- "좋아요·댓글 수는 캐시 컬럼으로 빠르게 읽고, 드리프트는 재조정 스케줄러가 정합성을 맞춥니다."

## 퀴즈

<QuizBox question="커뮤니티 게시글에 서로 다른 사용자의 신고가 3회 누적되면 어떻게 되나요?" :choices="['post_status가 즉시 BLOCKED로 바뀌어 완전 숨김', 'status는 ACTIVE를 유지하고 BLUR 오버레이만 표시', '글이 DELETED로 소프트삭제됨', '작성자 계정이 자동 정지됨']" :answer="1" explanation="ADR-0003 정책에 따라 report_count가 3 이상이면 BLUR 오버레이만 씌우고 post_status는 ACTIVE로 유지합니다. 완전 차단(BLOCKED)은 어드민만 결정합니다." />

<QuizBox question="네 가지 글 유형(review, photo, tip, question)을 구분하는 방식으로 맞는 것은?" :choices="['유형마다 별도 테이블 4개를 만든다', 'COMMUNITY_POST 단일 테이블에 post_type 컬럼으로 분기한다', 'post_status 컬럼 값으로 구분한다', '태그 테이블의 카테고리로만 구분한다']" :answer="1" explanation="공통 필드 비중이 커서 단일 테이블 COMMUNITY_POST에 post_type으로 분기하고, 유형 전용 컬럼은 NULL 허용으로 공존시킵니다." />

<QuizBox question="좋아요 수를 like_count 캐시 컬럼으로 관리하고 별도 스케줄러로 재조정하는 주된 이유는 무엇인가요?" explanation="조회가 매우 많은 통계라 매번 COUNT 집계 쿼리를 돌리면 비용이 큽니다. 그래서 증감 시 캐시 컬럼을 갱신해 빠르게 읽고, 누락이나 드리프트는 재조정 스케줄러로 실제 값과 주기적으로 맞춥니다(ADR-0006)." />
