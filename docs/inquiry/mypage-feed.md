---
title: "마이페이지 피드·크로스모듈"
owner: B
domain: "문의·알림·마이페이지"
tags: ["마이페이지", "크로스모듈"]
---

# 마이페이지 피드·크로스모듈 알림

> 커뮤니티·문의·신고·리워드 등 서로 다른 도메인에서 발생한 사건을 하나의 알림 피드로 모으고, 읽음 상태와 이동 경로를 단일 테이블로 관리하는 구조.

## 1. 한 줄 정의

마이페이지 피드 알림은 여러 도메인이 공통으로 호출하는 `MyPageService.addNotification`을 통해 `MYPAGE_FEED_NOTIFICATION` 한 테이블에 적재되고, `is_read`(읽음)와 `target_url`(클릭 시 이동 경로)로 사용자에게 노출되는 크로스모듈 알림 허브다.

## 2. 왜 이렇게 설계했나

TripTogether는 네 명이 도메인을 수직 분담해 만든 프로젝트라, 알림을 발생시키는 곳(커뮤니티 좋아요, 문의 답변, 신고 처리, 레벨업)과 알림을 보여주는 곳(마이페이지·헤더 벨)이 서로 다른 모듈에 흩어진다. 각 모듈이 제각각 알림 테이블과 화면을 만들면 중복과 불일치가 생긴다.

그래서 알림의 **저장과 표현은 마이페이지 도메인이 단독으로 소유**하고, 다른 도메인은 발생 사실만 `addNotification` 한 번으로 넘긴다.

- **단일 진입점:** 발신 도메인은 알림 테이블 스키마나 SSE 푸시를 몰라도 된다. `FeedNotificationDto`만 채워 호출한다.
- **단일 스키마:** 모든 알림이 같은 컬럼(`source_type`, `source_id`, `message`, `target_url`, `is_read`)을 공유해, 헤더 벨과 마이페이지 목록이 한 쿼리로 동작한다.
- **표현 책임 분리:** 이동 경로 규칙은 `NotificationUrlBuilder` 한 곳에 모아, 발신 도메인이 URL 형식을 직접 조립하지 않게 했다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 알림 DTO | `FeedNotificationDto` | userIdx, sourceType, sourceId, message, targetUrl, isRead |
| 크로스모듈 진입점 | `MyPageService.addNotification` / `MyPageServiceImpl` | DB 저장 후 SSE 푸시 |
| 경로 빌더 | `NotificationUrlBuilder` | community/inquiry/report/levelup 별 상대경로 생성 |
| 실시간 푸시 | `NotificationSseService` | userIdx 별 SseEmitter 목록 관리 |
| 헤더 주입 | `NotificationInterceptor` | 모든 페이지 Model에 안읽음 수·최근 5개 주입 |
| 사용자 API | `NotificationController` (`/api/notifications`) | 읽음·삭제·전체조회 |
| 영속화 | `MyPageMapper` + `MyPageMapper.xml` | MYPAGE_FEED_NOTIFICATION CRUD |
| 테이블 | `MYPAGE_FEED_NOTIFICATION` | notification_id PK, idx_user_unread 인덱스 |

테이블 핵심 컬럼(자리표시자 없이 실제 정의):

```sql
notification_id  bigint PK AUTO_INCREMENT
user_idx         bigint        -- 알림 받을 사람
source_type      varchar(20)   -- community / inquiry / report / levelup
source_id        bigint        -- post_id / inquiry_id / report_id ...
message          varchar(200)
target_url       varchar(255)  -- contextPath 제외 상대경로
is_read          tinyint       -- 0 안읽음, 1 읽음
created_at       datetime DEFAULT CURRENT_TIMESTAMP
KEY idx_user_unread (user_idx, is_read, created_at DESC)
```

`idx_user_unread` 복합 인덱스가 안읽음 개수 집계와 최신순 조회를 동시에 받쳐 준다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 크로스모듈 등록 패턴

발신 도메인은 어디서든 동일한 5줄 패턴을 쓴다. 예를 들어 커뮤니티 좋아요 처리부:

```java
FeedNotificationDto noti = new FeedNotificationDto();
noti.setUserIdx(post.getUserIdx());          // 받는 사람 (글 작성자)
noti.setSourceType("community");
noti.setSourceId(postId);
noti.setMessage("내 글에 좋아요가 달렸어요.");
noti.setTargetUrl(NotificationUrlBuilder.community(postId));
myPageService.addNotification(noti);
```

문의 답변(`InquiryController`)은 `sourceType=inquiry`, 신고 처리(`ReportServiceImpl`)는 `sourceType=report`, 레벨업(`RewardServiceImpl`)은 `sourceType=levelup`으로 같은 메서드를 호출한다. 호출부는 SSE도 테이블도 모른다.

### 4-2. 자기 자신 알림 방지

발신부에서 받는 사람과 행위자가 같으면 알림을 만들지 않는다. 커뮤니티 좋아요는 다음 가드를 둔다.

```java
if (post != null && !post.getUserIdx().equals(userIdx)) {
    // 본인 글이 아닐 때만 알림 생성
}
```

### 4-3. 저장 후 푸시 (DB 우선 안전망)

`addNotification` 내부는 **DB 저장을 먼저 확정하고**, 그다음 SSE 푸시를 시도한다. 푸시가 실패해도 알림은 이미 저장돼 있어, 다음 페이지 로드나 헤더 폴링에서 복구된다.

```java
myPageMapper.insertNotification(notification);   // 1) 영속화 (안전망)
try {
    notificationSseService.sendTo(userIdx, notification); // 2) 실시간 푸시
} catch (Exception e) {
    log.warn("SSE 푸시 실패 (DB 저장은 완료)");      // 푸시 실패는 무시
}
```

### 4-4. 표현·소비 경로

| 화면 | 데이터 출처 | 비고 |
| --- | --- | --- |
| 헤더 벨 배지/드롭다운 | `NotificationInterceptor`가 Model에 주입 | 안읽음 수 + 최근 5개 |
| 마이페이지 카드 그리드 | `MyPageService.getAllNotifications` | 무제한 전체 목록 |
| 실시간 토스트 | `EventSource('/sse/notifications')` | SSE name=notification |

### 4-5. 읽음 처리와 이동

알림 클릭 시 `POST /api/notifications/{id}/read`가 본인 소유를 확인한 뒤 `is_read=1`로 바꾸고 `target_url`을 응답한다. 프런트는 그 경로로 이동한다. 소유자가 아니면 403, 없으면 404로 분리한다.

```text
클릭 → /{id}/read → 소유 검증 → is_read=1 → targetUrl 반환 → 이동
```

`target_url`은 contextPath(`/TripTogether`)를 제외한 상대경로라, 배포 경로가 바뀌어도 저장값을 고칠 필요가 없다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: 크로스모듈 `addNotification` 단일 진입점, `MYPAGE_FEED_NOTIFICATION` 단일 테이블, 읽음/안읽음·개별·전체 삭제, 헤더 인터셉터 주입, SSE 실시간 푸시, 자기 알림 방지, 본인 소유 검증(401/403/404).
- 구현됨: `NotificationUrlBuilder`로 community/inquiry/report/levelup 경로 일원화, 레벨업 미읽음 팝업용 별도 조회.
- 한계/계획: 알림 수신 ON/OFF 같은 사용자별 알림 설정 UI는 없다. 오래된 알림 자동 정리(보존 기간) 배치도 없다. SSE는 단일 서버 인메모리(`ConcurrentHashMap`) 기반이라 다중 인스턴스 수평 확장 시 공유 브로커가 추가로 필요하다.
- 비고: 모바일은 JSP 데스크톱 레이아웃 위주이며, 알림 피드도 데스크톱 카드 그리드 기준으로 설계됐다.

## 6. 면접 답변 3단계

1. **한 줄:** 여러 도메인의 알림을 하나의 진입점과 한 테이블로 모은 크로스모듈 알림 허브를 만들었습니다.
2. **설계 의도:** 알림을 만드는 도메인과 보여주는 도메인이 다르기 때문에, 저장·표현은 마이페이지가 소유하고 발신 측은 DTO 하나만 넘기게 해 중복과 스키마 불일치를 없앴습니다.
3. **구체화:** `addNotification`이 DB 저장을 먼저 확정한 뒤 SSE 푸시를 시도하므로 실시간 전달이 실패해도 알림은 보존되고, 클릭 시 저장된 상대경로 target_url로 이동하며 본인 소유만 읽음 처리됩니다.

## 7. 꼬리질문 + 모범답안

:::details 알림 테이블을 도메인마다 따로 두지 않고 하나로 합친 이유는?
헤더 벨과 마이페이지 목록이 출처와 무관하게 한 쿼리로 동작해야 했습니다. source_type 컬럼으로 출처를 구분하면 표현 코드는 단일화하면서도 출처별 분기가 가능합니다. 도메인마다 테이블을 두면 합산·정렬을 위해 매번 UNION이 필요해집니다.
:::

:::details SSE 푸시가 실패하면 알림을 잃지 않나요?
잃지 않습니다. addNotification은 insertNotification으로 DB에 먼저 저장하고, 그 후 sendTo를 try-catch로 감싸 호출합니다. 푸시 실패는 로그만 남기고 삼키므로, 사용자가 다음에 페이지를 열거나 헤더가 갱신될 때 저장된 알림이 그대로 노출됩니다. DB가 1차 진실원본, SSE는 즉시성 향상용입니다.
:::

:::details target_url을 상대경로로 저장한 이유는?
target_url에는 contextPath를 뺀 상대경로만 저장합니다. 배포 컨텍스트 경로가 바뀌어도 저장값을 수정할 필요가 없고, 프런트가 앞에 contextPath만 붙이면 됩니다. 또 경로 조립 규칙을 NotificationUrlBuilder 한 곳에 모아 발신 도메인이 URL 형식을 직접 알지 않게 했습니다.
:::

:::details 같은 사람이 여러 탭을 열어두면 알림은 어떻게 처리되나요?
NotificationSseService는 userIdx를 키로 SseEmitter의 리스트를 들고 있어 한 사용자의 여러 탭을 모두 추적합니다. sendTo는 그 리스트의 모든 emitter에 같은 이벤트를 보냅니다. 연결이 끊긴 emitter는 onCompletion·onTimeout·onError 콜백에서 리스트에서 제거됩니다. 또 30초 주기 하트비트로 프록시 idle 타임아웃을 회피합니다.
:::

:::details 남의 알림을 읽음 처리하거나 지울 수는 없나요?
없습니다. NotificationController의 읽음·삭제 API는 먼저 알림을 조회해 noti.getUserIdx가 세션 로그인 사용자와 같은지 검사합니다. 다르면 403, 알림 자체가 없으면 404, 비로그인은 401로 상태코드를 분리해 응답합니다.
:::

## 8. 직접 말해보기

- 커뮤니티 좋아요부터 마이페이지 토스트까지, addNotification 한 번이 어떤 단계를 거치는지 순서대로 설명해 보세요.
- DB 저장과 SSE 푸시의 순서를 바꾸면 어떤 문제가 생기는지 말해 보세요.
- 알림을 도메인별 테이블로 쪼갰을 때 생기는 비용을, source_type 단일 테이블과 비교해 설명해 보세요.

관련 문서: [SSE 실시간 알림](/inquiry/sse-notification) · [알림 인터셉터·토스트](/inquiry/notification-interceptor) · [SSE 용어](/glossary/sse) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="크로스모듈 알림에서 다른 도메인(커뮤니티·문의·신고 등)이 공통으로 호출하는 단일 진입점 메서드는?" :choices="['MyPageService.addNotification', 'NotificationController.recent', 'NotificationSseService.subscribe', 'NotificationInterceptor.postHandle']" :answer="0" explanation="발신 도메인은 FeedNotificationDto만 채워 MyPageService.addNotification을 호출하면 됩니다. 테이블 스키마와 SSE 푸시는 마이페이지 도메인 내부에서 처리합니다." />

<QuizBox question="addNotification 내부에서 DB 저장과 SSE 푸시의 실행 순서와 그 이유로 옳은 것은?" :choices="['먼저 SSE 푸시, 실패 시 DB 저장 생략', 'DB 저장을 먼저 확정하고 SSE 푸시는 실패해도 무시', '둘을 같은 트랜잭션으로 묶어 함께 롤백', 'SSE 푸시 성공해야만 DB 저장']" :answer="1" explanation="DB가 1차 진실원본입니다. insertNotification으로 먼저 저장한 뒤 sendTo를 try-catch로 감싸므로 푸시 실패는 로그만 남기고 알림은 보존됩니다." />

<QuizBox question="MYPAGE_FEED_NOTIFICATION의 target_url 컬럼에 저장되는 값에 대한 설명으로 옳은 것은?" :choices="['절대 URL과 도메인을 포함한 전체 주소', 'contextPath를 제외한 상대경로', 'AJAX 응답 JSON 전체', 'is_read 값과 동일한 플래그']" :answer="1" explanation="target_url은 contextPath(TripTogether)를 뺀 상대경로만 저장합니다. 경로 조립 규칙은 NotificationUrlBuilder가 일원화합니다." />
