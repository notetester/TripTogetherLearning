---
title: "커뮤니티 면접 플레이북"
owner: B
domain: "커뮤니티·신고"
tags: ["면접"]
---

# 커뮤니티 면접 플레이북

> 커뮤니티·신고 도메인을 1분/3분으로 압축해 말하고, "왜 캐시 컬럼 / 왜 Perspective / 왜 3-스트라이크 BLUR / 왜 태그 공출현"을 근거와 함께 방어하며, 꼬리질문 10여 개를 미리 막는 한 장.

## 1. 한 줄 정의

이 페이지는 **커뮤니티 도메인을 면접에서 말로 풀어내기 위한 대본**이다. 새 기능 설명이 아니라, [개요](/community/)부터 [신고 상태머신](/community/report-system)까지 흩어진 내용을 면접 길이(1분/3분)와 질문 유형별로 재배열했다. 핵심은 "사용자가 직접 글을 쓰는 영역(UGC)에서 품질·안전·성능을 어떻게 함께 잡았나"다.

## 2. 왜 이렇게 설계했나 (말하기 전에 잡아둘 큰 그림)

면접에서 커뮤니티는 "게시판 만들었습니다"로 가면 진다. 채점자는 **선택의 이유**를 듣고 싶어 한다. TripTogether 커뮤니티는 네 가지 설계 결정으로 요약되고, 플레이북 전체가 이 넷을 변주한다.

| 결정 | 무엇을 골랐나 | 한 줄 이유 |
| --- | --- | --- |
| 통계 읽기 | 매번 COUNT가 아니라 **캐시 컬럼**(`like_count`, `comment_count`) | 목록 화면은 조회가 압도적으로 많다. 정수 한 개로 읽는다 |
| 콘텐츠 안전 | 자동 차단이 아니라 **AI 선제 플래그 + 신고 누적 BLUR + 사람 결정** | 오탐 비용을 사람이 흡수하고, 강한 결정은 어드민이 한다 |
| 독성 판정 | 자체 룰이 아니라 **Google Perspective API**(TOXICITY 0~1, 비동기) | 검증된 모델을 약한 시그널로만 쓰고, 응답은 안 막는다 |
| 추천 | ML 임베딩이 아니라 **태그 공출현(co-occurrence)** | 외부 엔진 없이 SQL JOIN 한 번으로 연관 글을 근사한다 |

여기에 공통 인프라 결정이 붙는다. XSS는 **jsoup Safelist 서버측 정화**(ADR-0005), 삭제는 **소프트삭제**(ADR-0008), 권한은 **AOP**(`@RequireLogin`/`@LoginUser`, ADR-0011)로 도메인 공통 패턴을 그대로 쓴다.

:::tip 한 문장으로 묶으면
"읽기는 캐시로 빠르게, 안전은 AI가 선제 플래그하고 사람이 최종 결정하며, 추천은 태그 공출현으로 가볍게." 이 한 문장이 네 결정을 다 담는다.
:::

## 3. 1분 / 3분 대본

### 1분 버전 (엘리베이터)

> "TripTogether 커뮤니티는 review·photo·tip·question 네 유형을 `COMMUNITY_POST` 한 테이블의 `post_type` 컬럼으로 분기하는 통합 게시판입니다. 사용자가 직접 글을 쓰는 영역이라 안전이 핵심인데, 두 축으로 잡았습니다. 하나는 작성 직후 Google Perspective API가 비동기로 독성을 검사해 임계값을 넘으면 `ai_flagged`를 세우는 AI 선제 플래그이고, 다른 하나는 서로 다른 사용자의 신고가 3회 누적되면 글을 삭제하지 않고 가려서(BLUR) 보여주는 신고 누적 정책입니다. 둘 다 자동 차단하지 않고 어드민 판단 큐로 모읍니다. 성능 면에서는 좋아요·댓글 수를 매번 COUNT하지 않고 캐시 컬럼으로 읽고, 어긋남은 새벽 배치가 정정합니다."

### 3분 버전 (구조 + 근거)

1분 버전을 말한 뒤, 아래 네 갈래로 살을 붙인다.

1. **글 한 편의 일생** — 작성은 `@RequireLogin` AOP → 작성 빈도 제한(도배 방지) → jsoup XSS 정화 → `COMMUNITY_POST` INSERT + 태그/이미지 연결 → 작성 직후 비동기 Perspective 검사 순이다. 운영 중에는 좋아요·댓글이 캐시 컬럼을 증감하고, 신고가 쌓이면 BLUR로 전환되며, 정리는 작성자 소프트삭제(`post_status=DELETED`)와 어드민 차단(`BLOCKED`)으로 갈린다.
2. **BLUR vs BLOCKED 분리(ADR-0003)** — 신고 3회 누적이나 AI 플래그는 **BLUR**(가림 오버레이, status는 ACTIVE 유지)일 뿐 차단이 아니다. 완전 숨김인 **BLOCKED**는 오직 어드민만 결정한다. "약한 신호는 점진적 공개, 강한 결정은 사람"이라는 철학을 정책으로 명문화했다.
3. **신고 자체의 상태머신** — `REPORT.status`는 `IN_REVIEW`(검토중) → `RESOLVED`(처리완료)/`DISMISSED`(반려)로 가고, 신고자 본인은 `CANCELLED`로 취소한다. 중복 신고는 DB UNIQUE + 사전 SELECT + race 대비 예외 처리의 3중으로 막고, 취소된 행은 재신고 시 되살린다(ADR-0004).
4. **캐시와 정합성(ADR-0006)** — `like_count`·`comment_count`는 캐시 컬럼이라 토글마다 증감한다. 동시 클릭이나 비정상 흐름으로 실제 행 수와 어긋날 수 있어, `CommunityCacheReconcileScheduler`가 매일 새벽 실제 값으로 정정하는 안전망을 둔다(eventually consistent).

## 4. 동작 원리 (말로 쓰기 좋은 표·흐름)

### 글 한 편의 일생 (이 흐름 하나면 라이프사이클 질문은 다 막힌다)

```text
작성 요청
  → @RequireLogin AOP 권한 검증
  → 작성 빈도 제한(최근 N분 내 작성 수, ContentModerationPolicy)
  → jsoup Safelist XSS 정화(본문은 화이트리스트, 댓글은 태그 전부 제거)
  → COMMUNITY_POST INSERT + 태그 UPSERT + 이미지 + 공출현 co_count 갱신
  → (작성 직후) @Async Perspective 검사 → 초과 시 ai_flagged=1 + SYSTEM 봇 자동 신고
운영 중
  → 좋아요/댓글: like_count·comment_count 캐시 증감(ADR-0006)
  → 신고 접수: REPORT INSERT (UNIQUE로 1인 1신고)
  → report_count >= 임계(기본 3) → BLUR(status=ACTIVE 유지) + 작성자 알림
정리
  → 작성자 삭제: post_status=DELETED (소프트삭제, ADR-0008)
  → 어드민 차단: post_status=BLOCKED (완전 숨김, 해제 가능)
```

### 자동 처리의 천장과 사람의 영역 (이 표가 BLUR/BLOCKED 질문을 끝낸다)

| 트리거 | 자동으로 일어나는 일 | 누가 최종 결정 |
| --- | --- | --- |
| 신고 3회 누적 | BLUR 오버레이, status ACTIVE 유지, 작성자 알림 | 어드민(해제/BLOCKED) |
| Perspective 독성 판정 | `ai_flagged=1`, BLUR, SYSTEM 봇 자동 신고 | 어드민(`clearPostBlur`/BLOCKED) |
| 어드민 차단 | — | 어드민만 `post_status=BLOCKED` |
| 작성자 삭제 | `post_status=DELETED` 소프트삭제 | 작성자 본인 |

핵심은 자동 처리가 **BLUR라는 천장에서 멈춘다**는 것이다(ADR-0001). 계정 정지나 완전 차단처럼 사용자에게 손해가 큰 결정은 코드가 자동으로 하지 않는다.

### 신고 상태머신 (한 호흡에)

```text
신고 접수      → IN_REVIEW (검토중)
어드민 처리    → RESOLVED (처리완료, 신고자에게 알림)
어드민 반려    → DISMISSED (반려, 신고자에게 알림)
신고자 취소    → CANCELLED (본인만, 재신고 시 같은 행 재활성화)
```

중복 신고 3중 방어(ADR-0004): ① `REPORT`의 (user_idx, target_type, target_id) UNIQUE, ② 서비스의 사전 SELECT로 기존 신고 확인, ③ 사전 SELECT와 INSERT 사이 race에 대비해 `DataIntegrityViolationException`을 잡아 중복으로 처리. 취소(`CANCELLED`)된 행이 있으면 INSERT 대신 재활성화한다.

### 좋아요 토글 (방어선이 두 겹)

```java
@Transactional
public boolean toggleLike(Long postId, Long userIdx) {
    if (isLiked(postId, userIdx)) {
        deleteLike(postId, userIdx);
        decreaseLikeCount(postId);   // GREATEST(like_count - 1, 0)
        return false;                // 취소됨
    }
    insertLike(postId, userIdx);     // (post_id, user_idx) UNIQUE
    increaseLikeCount(postId);       // like_count + 1
    // 본인 글이 아니면 피드 알림 + 리워드 지급
    return true;                     // 좋아요됨
}
```

UNIQUE 키가 동시 클릭의 중복 행을 막고, 감소는 `GREATEST(..., 0)`으로 음수를 막는다. 짧은 캐시 드리프트는 새벽 배치(`CommunityCacheReconcileScheduler`)가 실제 행 수로 정정한다.

## 5. 구현 상태 (면접에서 정직하게 선 긋기)

| 항목 | 상태 | 면접에서 이렇게 말한다 |
| --- | --- | --- |
| 게시글 4유형 / 댓글·대댓글 / 질문 채택 | 구현됨 | "단일 테이블 + post_type 분기로 다 동작합니다" |
| 좋아요·댓글 캐시 + 새벽 정합성 배치 | 구현됨 | "읽기는 캐시, 어긋남은 일배치로 맞춥니다" |
| 태그 사전 + 공출현 co_count + 연관 글 추천 | 구현됨 | "외부 엔진 없이 공출현으로 근사합니다" |
| Cloudinary 이미지 + Pixabay 24h fallback | 구현됨 | "원본은 CDN, DB엔 URL만 둡니다" |
| Perspective 독성 + ai_flagged(비동기) | 구현됨 | "검증된 모델을 약한 시그널로만 씁니다" |
| 신고 누적 BLUR + 어드민 BLOCKED 분리 | 구현됨 | "자동은 BLUR가 천장, 차단은 사람입니다" |
| 신고 상태머신 + 중복 방지 3중 방어 | 구현됨 | "DB UNIQUE까지 최후 보루로 둡니다" |
| 네이티브 광고(AD_CAMPAIGN) CRUD·트래킹 | 구현됨 | "광고도 콘텐츠 흐름에 자연스럽게 끼웁니다" |
| AI 판정·추천 품질 정량 평가 | 미구현 | "정량 평가 체계는 향후 과제로 인정합니다" |
| Perspective 비동기 실패 시 재시도 | 미구현 | "실패하면 플래그를 건너뛰는 fail-safe, 재시도는 과제입니다" |
| 모바일 반응형 레이아웃 | 미구현 | "JSP 데스크톱 위주라 반응형은 향후입니다" |

:::tip 정직함이 점수다
"AI가 욕설을 다 막나요?"에 "네"라고 답하면 다음 꼬리질문에서 무너진다. **선제 플래그는 약한 시그널, 차단은 어드민**이라고 먼저 선을 그으면 오히려 오탐 비용을 다루는 설계 의도를 설명할 기회가 된다.
:::

:::warning 공개 자료 보안 원칙
이 문서는 공개 저장소에 있으므로 실제 키·DB 호스트·내부 IP·계정·실명은 담지 않는다. 설정값은 API_KEY, DB_HOST 같은 자리표시자로만 말한다. 모델명(Perspective)·기술명·클래스명·테이블명은 공개해도 무방하다.
:::

## 6. 면접 답변 3단계 (질문 받으면 이 틀로)

어떤 커뮤니티 질문이든 **결정 → 이유 → 한계**의 3단계로 답하면 일관성이 생긴다.

1. **결정**: 무엇을 골랐는지 한 문장. (예: "좋아요 수는 캐시 컬럼으로 읽습니다.")
2. **이유**: 프로젝트 제약과 묶어서. (예: "목록 화면은 글마다 좋아요 수가 필요해 매번 COUNT면 글 수만큼 쿼리가 늘어납니다.")
3. **한계/대안**: 트레이드오프를 인정. (예: "대가는 정합성 관리라, 새벽 배치로 실제 행 수와 맞추는 안전망을 뒀습니다.")

## 7. 꼬리질문 + 모범답안

:::details Q1. 신고가 3번 쌓이면 글이 삭제되나요?
아닙니다. `report_count`가 임계(기본 3)에 도달하면 글을 **BLUR**(가림 오버레이)로만 표시하고 `post_status`는 ACTIVE로 유지합니다. 사용자가 클릭하면 본문이 펼쳐집니다. 완전 숨김인 BLOCKED는 오직 어드민이 직접 차단할 때만 됩니다. ADR-0003가 이 둘을 의도적으로 분리했습니다. 자동 처리는 약한 신호이므로 점진적 공개, 강한 결정은 사람이 한다는 원칙입니다.
:::

:::details Q2. AI 모더레이션과 사람 신고는 어떻게 다른가요?
적용 시점과 신호원이 다릅니다. Perspective는 작성 직후 비동기로 본문을 검사해 임계 초과 시 `ai_flagged`를 세우는 선제적 신호이고, 사람 신고는 운영 중에 `report_count`를 누적하는 사후 신호입니다. 그런데 결과는 같은 곳으로 모입니다. AI 플래그도 SYSTEM 봇 계정 이름으로 신고를 자동 등록해 어드민 신고 게시판에 합류시키고, 둘 다 자동 차단하지 않고 어드민 판단 큐로 보냅니다(ADR-0010, ADR-0001).
:::

:::details Q3. 좋아요 수를 매번 COUNT 쿼리로 세지 않는 이유는요?
목록 화면은 글마다 좋아요 수를 보여줘서, 매번 COUNT를 돌리면 쿼리가 글 수만큼 늘어납니다. 그래서 `COMMUNITY_POST.like_count` 정수 컬럼에 캐시하고 토글마다 +1/-1 해 읽기를 컬럼 하나로 끝냅니다. 대가는 정합성 관리인데, 동시 클릭 등으로 캐시가 실제 행 수와 어긋날 수 있어 `CommunityCacheReconcileScheduler`가 매일 새벽 실제 값으로 정정합니다. 짧게 어긋나도 결국 맞춰지는 eventually consistent 구조입니다(ADR-0006).
:::

:::details Q4. 좋아요 더블클릭이 동시에 들어오면 like_count가 2 올라가지 않나요?
좋아요 행은 (post_id, user_idx) UNIQUE라 동시 삽입 중 하나는 충돌로 무시되어 행은 하나만 남습니다. 다만 캐시 증가가 트랜잭션 경합으로 짧게 어긋날 여지는 있어, 새벽 정합성 배치가 실제 행 수와 맞춥니다. 감소도 `GREATEST(like_count - 1, 0)`이라 캐시가 음수로 내려가지 않습니다. 정확성은 DB 제약으로, 성능은 캐시로 분리한 셈입니다.
:::

:::details Q5. 왜 자체 욕설 필터 대신 Perspective API를 썼나요?
욕설·혐오 판정은 언어 모델 수준의 맥락 이해가 필요해서, 검증된 외부 모델(Google Perspective)을 쓰는 게 자체 단어 사전보다 정확합니다. 다만 외부 모델도 오판하므로, 점수(TOXICITY 0~1)를 그대로 차단에 연결하지 않고 임계값을 넘으면 `ai_flagged`만 세우는 약한 시그널로 다룹니다. 임계값은 코드가 아니라 `CONTENT_MODERATION_POLICY` 테이블의 enum으로 외부화해(ADR-0009) 배포 없이 민감도를 조정합니다.
:::

:::details Q6. Perspective 호출이 1~5초 걸리면 글쓰기가 느려지지 않나요?
그래서 검사를 동기로 두지 않았습니다. 글은 즉시 INSERT하고 응답을 반환한 뒤, `@Async`로 별도 스레드에서 독성을 검사해 플래그만 사후에 세웁니다. 사용자 체감 작성 지연은 0입니다. 호출이 실패하면 점수가 null이 되어 검사를 건너뛰는 fail-safe라, 외부 API 장애가 글쓰기 자체를 막지 않습니다. 대신 그 글은 플래그가 안 달리므로 실패 재시도는 향후 과제로 남겼습니다(ADR-0010).
:::

:::details Q7. 중복 신고는 어떻게 막나요?
3중으로 막습니다. 첫째 `REPORT`에 (user_idx, target_type, target_id) UNIQUE 키, 둘째 서비스에서 사전 SELECT로 기존 신고를 확인, 셋째 사전 SELECT와 INSERT 사이 race에 대비해 `DataIntegrityViolationException`을 잡아 중복으로 처리합니다. 애플리케이션 검사만 믿지 않고 DB 제약을 최후 보루로 둔 겁니다. 그리고 취소(CANCELLED)된 신고가 있으면 새 행을 만들지 않고 그 행을 재활성화합니다(ADR-0004).
:::

:::details Q8. 태그 추천에 머신러닝을 쓰나요?
아닙니다. 외부 추천 엔진이나 임베딩 없이, 같은 글에 함께 달린 태그는 의미적으로 가깝다는 가정으로 공출현 횟수만 누적합니다. 글 저장 시 그 글의 태그를 모든 쌍으로 만들어 `COMMUNITY_TAG_RELATION`의 co_count를 +1 합니다. 핵심은 쌍 정규화인데, 작은 ID를 tag_id_a, 큰 ID를 tag_id_b로 강제해 같은 두 태그가 순서만 바꿔 두 행으로 갈라지는 걸 막습니다. 추천은 이 점수로 SQL JOIN 한 번이면 됩니다. 가벼운 대신 의미적 정밀도는 ML 방식보다 낮다는 한계는 인정합니다.
:::

:::details Q9. 네 가지 글 유형을 왜 한 테이블에 넣었나요?
유형 간 공통 필드(제목·본문·작성자·통계)가 대부분이라 단일 테이블 + `post_type` 분기가 목록·검색을 조인 없이 단순하게 합니다. 유형 전용 컬럼은 NULL 허용으로 공존시키고(question은 채택 댓글, tip은 카테고리), 유형 필터는 인덱스로 처리합니다. 별도 테이블 4개로 쪼개면 통합 목록·검색·신고·BLUR 로직을 네 번 작성해야 하는데, 그 비용이 단일 테이블의 NULL 컬럼 비용보다 큽니다.
:::

:::details Q10. 이미지를 DB에 저장하지 않은 이유는요?
이미지 원본을 DB나 서버 디스크에 두면 용량과 백업·전송 비용이 커집니다. 그래서 Cloudinary(외부 CDN)에 올리고 `COMMUNITY_POST_IMAGE`에는 URL만 저장합니다(ADR-0007). 이미지가 아예 없는 글에는 Pixabay에서 지역 기반 이미지를 자동 배정하고, 외부 이미지는 24시간 캐싱 fallback으로 보완합니다. 본문 inline 이미지는 별도 폴더에 올려 본문에서 빠진 이미지를 정리 스케줄러가 선별 삭제할 수 있게 했습니다.
:::

:::details Q11. XSS는 어떻게 막나요? 댓글과 본문 처리가 다른가요?
다릅니다. 본문은 리치 에디터라 서식이 필요해서, jsoup Safelist 화이트리스트로 허용 태그·속성만 남기고 `<script>`·on* 핸들러·javascript: URL을 서버에서 제거합니다. 댓글은 plain text 입력이라 `Safelist.none()`으로 모든 태그를 제거하고 개행만 보존합니다. 클라이언트 검증이 아니라 서버측 정화라는 점이 핵심입니다(ADR-0005). 신뢰 경계는 항상 서버에 둡니다.
:::

:::details Q12. 좋아요·댓글·BLUR 같은 상태 변화를 작성자가 어떻게 아나요?
크로스모듈 알림으로 처리합니다. 좋아요·댓글·대댓글이 달리거나 글이 BLUR로 전환되거나 어드민이 차단·해제하면, `myPageService.addNotification`으로 myPage/notification 도메인에 피드 알림을 만들고 `targetUrl`로 해당 글·댓글 앵커까지 연결합니다. 본인이 본인 글에 한 행동은 알림을 보내지 않고, 대댓글은 글 작성자와 부모 댓글 작성자가 같으면 중복 알림을 막습니다. 커뮤니티가 알림 도메인을 호출하는 단방향 의존입니다.
:::

## 8. 직접 말해보기

아래를 소리 내어 답해 보고, 막히면 해당 챕터로 돌아간다.

1. (1분) 커뮤니티 도메인 전체를 60초로 설명해 보라. post_type·캐시·Perspective·BLUR·공출현이 한 번씩 등장하는가?
2. 신고 3회 누적과 어드민 BLOCKED가 어떻게 다른지, 그 분리가 왜 의도적인지 설명하라. → [3-스트라이크 블러](/community/three-strike-blur)
3. like_count 캐시가 실제 행 수와 어긋나는 시나리오 하나와 복구 방법을 말하라. → [좋아요·태그](/community/likes-tags)
4. Perspective를 동기가 아니라 비동기로 둔 이유를 응답 지연과 오탐 두 축으로 설명하라. → [독성 감지](/community/toxicity-perspective)
5. 중복 신고 3중 방어를 DB·서비스·예외 세 층으로 나눠 말하라. → [신고 상태머신](/community/report-system)
6. 태그 쌍 정규화(작은 ID, 큰 ID)가 없으면 추천 점수가 어떻게 망가지는지 예로 설명하라. → [좋아요·태그](/community/likes-tags)

## 허브로 돌아가기

- [커뮤니티·신고 개요](/community/)
- [도메인 전체 개요](/domains)
- [담당별 보기](/by-area/)
- [전체 흐름](/flow/) · 그중 [모더레이션·거버넌스](/flow/moderation-governance)

## 퀴즈

<QuizBox question="면접에서 좋아요 수를 like_count 캐시 컬럼으로 읽는 이유로 가장 적절한 것은?" :choices="['캐시가 COUNT보다 항상 더 정확해서', '목록 화면은 글마다 좋아요 수가 필요해 매번 COUNT면 쿼리가 글 수만큼 늘어나서', '좋아요 중복을 막기 위해서', 'DB UNIQUE 제약을 대신하기 위해서']" :answer="1" explanation="정확성이 아니라 성능 때문이다. 목록은 글마다 좋아요 수가 필요해 매번 COUNT면 쿼리가 글 수만큼 늘어난다. 캐시 컬럼으로 읽기를 정수 하나로 줄이고, 어긋남은 새벽 배치가 정정한다(ADR-0006)." />

<QuizBox question="서로 다른 사용자의 신고가 임계(기본 3회) 누적된 게시글에 일어나는 실제 동작은?" :choices="['post_status가 즉시 BLOCKED로 바뀌어 완전 숨김', 'post_status는 ACTIVE를 유지하고 BLUR 오버레이만 표시', '글이 DELETED로 소프트삭제됨', '작성자 계정이 자동 정지됨']" :answer="1" explanation="ADR-0003에 따라 누적 신고는 BLUR 오버레이일 뿐 차단이 아니다. post_status는 ACTIVE로 유지되고, 완전 숨김인 BLOCKED는 어드민만 결정한다. 자동 처리는 BLUR가 천장이다(ADR-0001)." />

<QuizBox question="Perspective 독성 검사를 동기가 아니라 @Async 비동기로 둔 핵심 이유는?" :choices="['비동기가 더 정확한 점수를 주어서', 'API 호출이 1~5초 걸릴 수 있어 글 등록 응답을 막지 않으려고', '동기로는 ai_flagged를 세울 수 없어서', '관리자만 동기 검사를 쓸 수 있어서']" :answer="1" explanation="Perspective 호출은 1~5초가 걸릴 수 있어 동기로 두면 글쓰기 응답이 그만큼 지연된다. 글은 즉시 저장·응답하고 검사는 @Async로 분리해 사용자 체감 지연을 0으로 만든다. 실패 시 false로 떨어지는 fail-safe도 함께 둔다." />
