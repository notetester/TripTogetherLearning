# 알림 SSE 흐름

> 도메인에서 발생한 이벤트가 DB에 영구 저장되고, 같은 사용자의 열린 모든 탭으로 Server-Sent Events로 실시간 푸시되는 단방향 알림 파이프라인.

이 페이지는 특정 한 사람의 작업이 아니라, TripTogether 4인 공동 개발에서 **여러 도메인이 공유하는 알림 공통 흐름**을 설명한다. 커뮤니티·신고·문의·리워드·결제 등 어느 모듈에서 이벤트가 나든, 모두 같은 진입점(`MyPageService.addNotification`)을 거쳐 같은 테이블에 쌓이고 같은 SSE 채널로 나간다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 한 줄 정의

특정 사용자에게 알릴 사건이 생기면 `FeedNotificationDto`를 만들어 `addNotification` 한 번 호출 → `MYPAGE_FEED_NOTIFICATION` 테이블에 INSERT 후, 그 사용자가 열어 둔 `SseEmitter` 목록으로 푸시해 헤더 토스트·알림 벨·마이페이지 피드를 갱신하는 흐름이다.

## 2. 왜 이렇게 설계했나

- **단방향 푸시면 충분하다.** 알림은 서버가 클라이언트로 보내기만 한다. 양방향 채널(WebSocket)은 필요 없어서, HTTP 위에서 그대로 동작하고 프록시·로드밸런서 친화적인 SSE를 택했다. 브라우저 `EventSource`가 끊김 시 **자동 재연결**까지 해 준다.
- **DB 저장과 실시간 푸시를 분리한다.** 알림은 사용자가 접속 중일 때만 의미가 있는 게 아니다. 오프라인 사용자도 다음 로그인 때 봐야 한다. 그래서 **DB 저장이 진실의 원천(source of truth)**이고, SSE 푸시는 "지금 보고 있는 화면을 즉시 갱신"하는 부가 채널이다.
- **호출부 단순화.** 각 도메인 서비스는 SSE의 존재를 몰라도 된다. DTO를 채워 `addNotification` 하나만 부르면, 저장·푸시·실패 처리는 공통 계층이 책임진다. 이 단일 진입점 덕분에 알림 정책(중복 방지, 메시지 포맷)을 한곳에서 통제한다.
- **다중 탭·다중 기기 대응.** 한 사용자가 PC와 노트북, 여러 탭을 동시에 열 수 있으므로 `userIdx → List<SseEmitter>` 구조로 모든 연결에 동시에 뿌린다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 역할 | 구현 |
| --- | --- |
| 이벤트 → 알림 진입점 | `MyPageService.addNotification(FeedNotificationDto)` (`MyPageServiceImpl`) |
| 알림 데이터 모델 | `FeedNotificationDto` (userIdx, sourceType, sourceId, message, targetUrl, isRead, createdAt) |
| 영속 저장 테이블 | `MYPAGE_FEED_NOTIFICATION` (PK notification_id, idx_user_unread 복합 인덱스) |
| 실시간 푸시 엔진 | `NotificationSseService` (`Map<Long, List<SseEmitter>>`) |
| SSE 구독 엔드포인트 | `NotificationSseController` `GET /sse/notifications` (text/event-stream) |
| 클릭 이동 경로 생성 | `NotificationUrlBuilder` (community/inquiry/report/levelup → 상대경로) |
| 헤더 벨 데이터 주입 | `NotificationInterceptor` (모든 페이지 postHandle, 안읽음 수 + 최근 5개) |
| 목록·읽음·삭제 REST | `NotificationController` `/api/notifications/**` |

`SseEmitter`는 Spring MVC가 제공하는 비동기 응답 객체로, 별도 메시징 브로커 없이 표준 스택만으로 구현했다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 전체 단계

```text
[도메인 이벤트]  예: 내 글에 좋아요/댓글, 신고 처리완료, 문의 답변, 레벨업, 환불
   │
   ▼  FeedNotificationDto 채우기 (userIdx, sourceType, sourceId, message, targetUrl)
MyPageService.addNotification(noti)
   │
   ├─(1) myPageMapper.insertNotification(noti)   → MYPAGE_FEED_NOTIFICATION INSERT  [진실의 원천]
   │
   └─(2) notificationSseService.sendTo(userIdx, noti)  → 열린 SseEmitter 전부에 push
            │  (try/catch: 푸시 실패해도 DB 저장은 이미 완료)
            ▼
   [브라우저 EventSource] notification 이벤트 수신
            │
            ├─ 헤더 알림 벨 토스트 + 안읽음 배지 +1
            └─ 마이페이지 피드 목록 갱신
```

### 호출부 패턴 (커뮤니티 좋아요 예시, 추상화)

```java
// 본인 글이 아닐 때만 알림 (자기 행동에 자기 알림 금지)
if (post != null && !post.getUserIdx().equals(actorUserIdx)) {
    FeedNotificationDto noti = new FeedNotificationDto();
    noti.setUserIdx(post.getUserIdx());          // 받을 사람 = 글쓴이
    noti.setSourceType("community");
    noti.setSourceId(postId);
    noti.setMessage("내 글에 좋아요가 달렸어요.");
    noti.setTargetUrl(NotificationUrlBuilder.community(postId));
    myPageService.addNotification(noti);          // 저장 + 푸시 한 번에
}
```

### 구독·푸시 핵심 (추상화)

```java
// 구독: 탭마다 emitter 1개. userIdx 키에 리스트로 누적
SseEmitter emitter = new SseEmitter(TIMEOUT_MS); // 30분
emitters.computeIfAbsent(userIdx, k -> new CopyOnWriteArrayList<>()).add(emitter);
emitter.onCompletion(remove); emitter.onTimeout(remove); emitter.onError(e -> remove.run());

// 푸시: 해당 유저의 모든 탭으로 전송, 실패한 연결은 complete()로 정리
for (SseEmitter e : emitters.getOrDefault(userIdx, List.of())) {
    try { e.send(SseEmitter.event().name("notification").data(noti)); }
    catch (IOException ex) { e.complete(); } // onCompletion 콜백이 리스트에서 제거
}
```

### 연결 수명·안정성 장치

| 장치 | 값/방식 | 목적 |
| --- | --- | --- |
| 타임아웃 | 30분 (`TIMEOUT_MS`) | 만료 시 브라우저가 자동 재연결 |
| 하트비트 | 30초 주기 `@Scheduled`, 주석 라인(`comment("ping")`) 전송 | 프록시·방화벽 idle timeout 회피 |
| 초기 이벤트 | 구독 직후 `connect` 이벤트 1건 | 프록시가 응답을 버퍼링하지 않도록 즉시 플러시 유도 |
| 프록시 헤더 | `X-Accel-Buffering: no`, `Cache-Control: no-cache` | Nginx 등이 스트림을 버퍼링하지 못하게 강제 |
| 연결 정리 | onCompletion/onTimeout/onError → 리스트에서 제거, 비면 키 삭제 | 메모리 누수 방지 |

### 헤더 벨과 피드의 데이터 소스

- **실시간(접속 중):** SSE `notification` 이벤트가 도착하면 클라이언트가 즉시 토스트·배지를 갱신한다.
- **페이지 진입(새로고침/이동):** `NotificationInterceptor`가 `postHandle`에서 로그인 사용자의 안읽음 개수와 최근 5개를 Model에 주입(`headerUnreadCount`, `headerRecentNotifications`)한다. 비로그인이거나 View가 없는 응답에는 주입하지 않는다.
- **목록·읽음·삭제:** `/api/notifications/recent|all|unread-count`, `POST /{id}/read`(읽음 + targetUrl 반환), `read-all`, `DELETE /{id}` 등. 읽음·삭제는 항상 본인 소유를 검증하고 아니면 403, 없으면 404를 돌려준다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 단일 진입점 `addNotification`(DB 저장 + SSE 푸시)과 다중 탭 푸시(`userIdx → List<SseEmitter>`)
- 30분 타임아웃·30초 하트비트·초기 connect 이벤트·프록시 버퍼링 차단 헤더
- 여러 도메인이 실제로 호출 중: 커뮤니티(좋아요/댓글/채택), 신고 처리 결과, 문의 답변, 리워드 레벨업, 결제·환불(WalletService), 관리자 모더레이션 등
- 헤더 벨 인터셉터 주입, 본인 소유 검증이 들어간 읽음/삭제 REST, `NotificationUrlBuilder` 경유 targetUrl 표준화
:::

:::warning 안전망·한계
- SSE 푸시는 `try/catch`로 감싸 **푸시가 실패해도 DB 저장은 보존**된다(`SSE 푸시 실패 (DB 저장은 완료)` 경고 로그). 오프라인 사용자도 다음 접속 때 인터셉터·REST로 알림을 본다.
- 단일 인스턴스 인메모리(`ConcurrentHashMap`) 레지스트리다. **다중 서버로 수평 확장하면** 서버 간 emitter 공유가 안 되므로 Redis Pub/Sub 등 외부 fan-out이 필요하다(현재 미적용).
- 모바일은 JSP 데스크톱 위주 레이아웃이라 알림 UI도 반응형/푸시 알림(웹푸시)은 향후 과제다.
:::

## 6. 면접 답변 3단계

1. **한 문장:** "도메인 이벤트가 나면 `addNotification` 한 번으로 알림을 DB에 저장하고, 같은 사용자의 열린 모든 탭으로 SSE 푸시하는 단방향 실시간 알림 흐름입니다."
2. **설계 의도:** "알림은 서버→클라이언트 단방향이라 WebSocket 대신 SSE로 충분했고, DB 저장을 진실의 원천으로 두어 오프라인 사용자도 다음 접속 때 보게 했습니다. 호출부는 SSE를 몰라도 되도록 단일 진입점으로 묶었습니다."
3. **차별점:** "다중 탭을 `userIdx → List<SseEmitter>`로 처리하고, 30분 타임아웃·30초 하트비트·프록시 버퍼링 차단 헤더로 연결 안정성을 확보했으며, 푸시 실패가 저장을 깨지 않도록 try/catch 안전망을 둔 점이 포인트입니다."

## 7. 꼬리질문 + 모범답안

:::details 왜 WebSocket이 아니라 SSE인가
알림은 서버가 클라이언트로 보내기만 하는 단방향 통신입니다. 양방향이 필요 없으니 SSE가 더 단순하고, HTTP 위에서 동작해 프록시·로드밸런서 친화적이며, 브라우저 EventSource가 끊김 시 자동 재연결까지 제공합니다. 채팅처럼 클라이언트가 빈번히 서버로 보내야 한다면 WebSocket을 고려했을 것입니다.
:::

:::details SSE 푸시가 실패하면 알림을 잃나
아닙니다. `addNotification`은 먼저 DB에 INSERT한 뒤 푸시합니다. 푸시는 try/catch로 감싸 실패해도 예외를 삼키고 경고만 남깁니다. DB가 진실의 원천이므로 사용자는 다음 페이지 진입 때 인터셉터가 주입하는 안읽음 수·최근 목록, 또는 알림 목록 REST로 동일한 알림을 받습니다.
:::

:::details 한 사용자가 여러 탭을 열면 중복 알림이 가지 않나
같은 알림 DTO를 그 사용자의 모든 열린 emitter로 보내는 건 의도된 동작입니다. 각 탭이 같은 토스트를 받아 화면이 일관되게 갱신됩니다. DB에는 알림이 한 건만 저장되므로 안읽음 개수가 부풀지 않습니다. 끊긴 탭의 emitter는 onCompletion/onError 콜백으로 리스트에서 제거됩니다.
:::

:::details 연결이 idle 상태로 끊기는 문제는 어떻게 막나
두 가지입니다. 30초마다 주석 라인 하트비트(`comment(ping)`)를 보내 프록시·방화벽의 idle timeout을 회피하고, 구독 직후 connect 이벤트를 즉시 보내 프록시가 응답을 버퍼링하지 않게 플러시를 유도합니다. 추가로 `X-Accel-Buffering: no`와 `Cache-Control: no-cache` 헤더로 Nginx류의 버퍼링을 막습니다. 그래도 끊기면 30분 타임아웃 후 EventSource가 자동 재연결합니다.
:::

:::details 서버를 여러 대로 늘리면 무엇이 깨지나
현재 emitter 레지스트리는 단일 인스턴스 인메모리 맵입니다. 사용자가 A 서버에 SSE 연결하고 알림 이벤트가 B 서버에서 발생하면 B에는 그 emitter가 없어 푸시가 안 됩니다. 해결책은 알림 발생 시 Redis Pub/Sub 같은 채널로 모든 인스턴스에 브로드캐스트하고, 각 인스턴스가 자기 emitter에만 전달하는 fan-out 구조입니다. 다만 DB 저장은 공유되므로 알림 자체가 유실되지는 않고, 실시간성만 일부 저하됩니다.
:::

## 8. 직접 말해보기

- 알림 하나가 만들어져 사용자 화면에 토스트로 뜨기까지의 단계를 호출부 → DB → SSE 순으로 1분 안에 설명해 보자.
- "왜 SSE 푸시를 try/catch로 감쌌나"라는 질문에 DB가 진실의 원천이라는 점을 들어 답해 보자.
- 다중 탭과 다중 서버를 각각 어떤 자료구조·기법으로 다루는지, 그리고 다중 서버에서 무엇이 부족한지 구분해 말해 보자.

## 퀴즈

<QuizBox question="TripTogether 알림 흐름에서 모든 도메인 이벤트가 공통으로 거치는 단일 진입점은 무엇인가?" :choices="['NotificationSseController.subscribe', 'MyPageService.addNotification', 'NotificationInterceptor.postHandle', 'NotificationController.recent']" :answer="1" explanation="각 도메인 서비스는 FeedNotificationDto를 채워 addNotification 한 번만 호출하고, DB 저장과 SSE 푸시는 이 공통 계층이 책임진다." />

<QuizBox question="SSE 푸시가 IOException 등으로 실패해도 알림이 유실되지 않는 근본 이유는?" :choices="['실패 시 푸시를 무한 재시도하기 때문', 'DB 저장이 먼저 끝난 진실의 원천이고 푸시는 부가 채널이라서', 'WebSocket으로 폴백하기 때문', '브라우저가 알림을 로컬에 캐시하기 때문']" :answer="1" explanation="addNotification은 먼저 MYPAGE_FEED_NOTIFICATION에 저장한 뒤 푸시한다. 푸시는 try/catch로 감싸 실패해도 경고만 남기며, 사용자는 다음 접속 때 인터셉터나 REST로 동일 알림을 본다." />

<QuizBox question="한 사용자의 여러 탭에 동시에 알림을 보내기 위해 NotificationSseService가 쓰는 자료구조는?" :choices="['userIdx 하나당 SseEmitter 하나', 'userIdx에서 SseEmitter 리스트로의 맵', '전역 SseEmitter 큐 하나', 'sourceType별 emitter 맵']" :answer="1" explanation="Map of Long to List of SseEmitter 구조로 한 사용자의 모든 열린 탭 emitter를 누적해 동시에 푸시하고, 끊긴 연결은 콜백으로 리스트에서 제거한다." />
