# SSE (Server-Sent Events)

> 서버가 HTTP 연결 하나를 열어둔 채 알림을 **단방향으로 밀어 보내는** 표준. TripTogether의 실시간 알림 벨이 이걸로 동작한다.

## 1. 한 줄 정의

SSE는 클라이언트가 한 번 연결한 `text/event-stream` HTTP 응답을 서버가 닫지 않고 유지하면서, 이벤트가 생길 때마다 텍스트 프레임을 흘려보내는 **서버→클라이언트 단방향 푸시** 기술이다. TripTogether에서는 댓글·좋아요·신고처리·레벨업 같은 사건을 사용자에게 즉시 띄우는 데 쓴다.

## 2. 왜 이렇게 설계했나

알림을 실시간으로 띄우는 방법은 크게 세 가지다.

| 방식 | 특징 | TripTogether 적합성 |
| --- | --- | --- |
| **폴링(polling)** | 클라이언트가 N초마다 `GET` | 단순하지만 빈 응답 낭비, 지연 |
| **WebSocket** | 양방향 풀듀플렉스, 별도 프로토콜(`ws://`) | 채팅처럼 양방향이 필요할 때 |
| **SSE** | 단방향 푸시, 순수 HTTP 위에서 동작 | 알림처럼 **서버→클라 한 방향**이면 충분 |

알림은 본질적으로 단방향이다. 사용자가 서버로 실시간 스트림을 보낼 일은 없고, 읽음 처리 같은 동작은 평범한 REST 호출로 충분하다. 그래서 WebSocket의 양방향·핸드셰이크 비용을 떠안을 이유가 없다.

SSE를 고른 핵심 근거:

- **순수 HTTP 위에서 동작** — JSP/embedded Tomcat·세션 인증·기존 인터셉터 체인을 그대로 재사용한다. 별도 핸들러나 프로토콜 업그레이드가 없다.
- **브라우저 표준 `EventSource`가 자동 재연결을 내장** — 연결이 끊겨도 브라우저가 기본 약 3초 간격으로 다시 붙는다. 재연결 로직을 직접 짤 필요가 없다.
- **세션 쿠키가 그대로 실린다** — `EventSource`는 같은 출처 요청에 쿠키를 자동 첨부하므로, `session.getAttribute("loginUser")` 인증을 추가 토큰 없이 쓴다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

myPage 모듈의 두 클래스가 핵심이다.

| 구성요소 | 위치 | 역할 |
| --- | --- | --- |
| `NotificationSseController` | `myPage/controller` | `GET /sse/notifications` 구독 엔드포인트, 세션 인증 |
| `NotificationSseService` | `myPage/service` | 연결 보관(`userIdx → List<SseEmitter>`), 푸시, 하트비트 |
| `SseEmitter` | Spring MVC 내장 | 열린 SSE 응답 1건을 추상화한 객체 |
| `MyPageServiceImpl#addNotification` | `myPage/service` | DB 저장 후 SSE 푸시(크로스모듈 진입점) |
| `NotificationInterceptor` | `config` | 모든 페이지 Model에 안읽음 개수 주입(폴백 표시) |
| `MYPAGE_FEED_NOTIFICATION` | DB 테이블 | 알림 영속 저장 |

DB 테이블 핵심 컬럼:

```sql
MYPAGE_FEED_NOTIFICATION (
  notification_id  BIGINT PK,
  user_idx         BIGINT,        -- 알림 받을 유저
  source_type      VARCHAR(20),   -- community / inquiry / plan ...
  source_id        BIGINT,        -- post_id / inquiry_id ...
  message          VARCHAR(200),
  target_url       VARCHAR(255),  -- 클릭 시 이동할 상대경로 (contextPath 제외)
  created_at       DATETIME,
  is_read          TINYINT        -- 0:안읽음 1:읽음
)
```

`source_type`/`source_id`로 어떤 모듈의 어떤 객체에서 발생한 알림인지 식별하고, `target_url`로 클릭 시 이동 경로를 들고 다닌다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 구독 — 브라우저가 연결을 연다

```js
// 컨텍스트 경로는 /TripTogether
const es = new EventSource('/TripTogether/sse/notifications');
es.addEventListener('notification', (e) => renderBell(JSON.parse(e.data)));
```

컨트롤러는 세션을 확인하고 프록시 버퍼링을 끈 뒤 `SseEmitter`를 반환한다.

```java
@GetMapping(value = "/notifications", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter subscribe(HttpSession session, HttpServletResponse response) {
    UsersVO user = (UsersVO) session.getAttribute("loginUser");
    if (user == null) { response.setStatus(401); return null; }
    response.setHeader("X-Accel-Buffering", "no"); // Nginx 등이 응답을 버퍼링하지 않도록
    response.setHeader("Cache-Control", "no-cache");
    return sseService.subscribe(user.getUserIdx());
}
```

### 4-2. 연결 보관 — 다중 탭 대응

한 사용자가 여러 탭을 열 수 있으므로 `userIdx`를 키로 `List<SseEmitter>`를 보관한다. 자료구조 선택이 동시성을 떠받친다.

| 자료구조 | 이유 |
| --- | --- |
| `ConcurrentHashMap<Long, List>` | 여러 요청 스레드가 동시에 구독/푸시 |
| `CopyOnWriteArrayList<SseEmitter>` | 푸시 중(읽기) 다른 탭이 끊겨도(쓰기) 안전 순회 |

구독 시 `connect` 이벤트를 즉시 보내 프록시가 응답을 흘려보내게 유도하고, `onCompletion/onTimeout/onError` 콜백으로 끊긴 emitter를 리스트에서 제거한다(리스트가 비면 맵에서도 제거 → 메모리 누수 방지).

### 4-3. 푸시 — 사건이 생기면 해당 유저에게만

다른 모듈(community·inquiry·report·reward 등)은 `MyPageServiceImpl#addNotification` 하나로 진입한다. 여기서 **DB 저장 → SSE 푸시** 순서가 핵심이다.

```java
public void addNotification(FeedNotificationDto noti) {
    myPageMapper.insertNotification(noti);          // 1) 먼저 영속화
    try {
        notificationSseService.sendTo(noti.getUserIdx(), noti); // 2) 그다음 푸시
    } catch (Exception e) {
        log.warn("SSE 푸시 실패 (DB 저장은 완료)", e); // 푸시 실패해도 알림은 살아있음
    }
}
```

`sendTo`는 그 유저의 열린 모든 탭(emitter)에 `notification` 이벤트를 보낸다. 전송 중 `IOException`이 나면 `emitter.complete()`로 정리해 죽은 연결을 솎아낸다.

```text
[community] 새 댓글
     │  myPageService.addNotification(noti)
     ▼
insert MYPAGE_FEED_NOTIFICATION   ← 실패해도 여기서 끊김(트랜잭션)
     │
     ▼
sseService.sendTo(userIdx, noti)  ← 열린 탭이 없으면 그냥 return(DB엔 남음)
     │
     ▼  (탭 A) (탭 B) ... 'notification' 이벤트
브라우저 EventSource → 벨 갱신
```

### 4-4. 하트비트 — 연결을 살려둔다

프록시·방화벽은 일정 시간 트래픽이 없는 연결을 끊는다. 30초 주기로 **주석 라인(`: ping`)**만 보내 idle 타임아웃을 피한다. 주석은 SSE 규격상 `data` 이벤트로 잡히지 않아 클라이언트 핸들러를 깨우지 않는다.

```java
@Scheduled(fixedRate = 30000)
public void heartbeat() {
    emitters.forEach((id, list) -> list.forEach(e -> {
        try { e.send(SseEmitter.event().comment("ping")); }
        catch (IOException ex) { e.complete(); }
    }));
}
```

### 4-5. 타임아웃 — 재연결로 연결 회수

`SseEmitter`는 30분 타임아웃으로 만든다. 30분이 지나면 서버가 연결을 닫고, 브라우저 `EventSource`가 자동으로 다시 붙는다. 무한정 열어두지 않으니 서버 자원이 주기적으로 회수된다.

:::tip WebSocket과의 한 줄 비교
양방향 실시간(채팅·협업 편집)이면 WebSocket, 서버→클라 알림 한 방향이면 SSE. SSE는 HTTP·재연결·쿠키 인증을 공짜로 얻는 대신 클라→서버 채널이 없다.
:::

### 4-6. 폴백 — SSE가 죽어도 개수는 보인다

`NotificationInterceptor#postHandle`이 모든 페이지 렌더링 시 안읽음 개수와 최근 5건을 Model에 주입한다. 즉 SSE 푸시를 못 받아도 다음 페이지 이동 때 벨 숫자가 맞춰진다 — 실시간성은 SSE, 정확성의 안전망은 DB+인터셉터가 담당하는 이중 구조다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `SseEmitter` 구독/푸시, 다중 탭(`List`) | 구현됨 |
| 30초 하트비트(`@Scheduled` comment) | 구현됨 |
| 30분 타임아웃 + `EventSource` 자동 재연결 | 구현됨 |
| DB 저장 후 푸시 안전망, 푸시 실패 격리 | 구현됨 |
| 크로스모듈 알림 진입점(`addNotification`) | 구현됨 |
| 인터셉터 기반 안읽음 개수 폴백 | 구현됨 |
| 다중 서버 인스턴스(스케일아웃) 브로드캐스트 | 미구현 (인메모리 `Map` → 단일 인스턴스 가정. Redis Pub/Sub 등 향후 과제) |
| `Last-Event-ID` 기반 누락 이벤트 재전송 | 미구현 (재연결 시 DB가 진실원천 역할로 대체) |

:::warning 인메모리 보관의 한계
emitter 맵은 JVM 메모리에 있다. 서버를 여러 대로 늘리면 "탭이 붙은 인스턴스"와 "알림을 만든 인스턴스"가 달라 푸시가 누락될 수 있다. 현재는 단일 인스턴스 전제이고, 누락돼도 DB+인터셉터 폴백으로 개수는 보정된다.
:::

## 6. 면접 답변 3단계

1. **한 줄** — "알림은 서버→클라 단방향이라 WebSocket 대신 SSE를 썼습니다. `SseEmitter`로 연결을 열어두고 사건이 생기면 해당 유저 탭에 푸시합니다."
2. **설계 의도** — "순수 HTTP라 기존 세션 인증·인터셉터를 재사용하고, 브라우저 `EventSource`의 자동 재연결을 공짜로 얻습니다. 한 유저가 여러 탭을 열 수 있어 `userIdx → List<SseEmitter>`로 보관하고, `ConcurrentHashMap`+`CopyOnWriteArrayList`로 동시성을 처리했습니다."
3. **신뢰성** — "DB에 먼저 저장하고 그다음 푸시해서, 푸시가 실패해도 알림은 보존됩니다. 30초 하트비트로 프록시 idle 타임아웃을 피하고, 30분 타임아웃 후엔 재연결로 자원을 회수합니다. SSE가 끊겨도 인터셉터가 페이지마다 안읽음 개수를 주입해 정확성을 보장합니다."

## 7. 꼬리질문 + 모범답안

:::details Q. SSE와 WebSocket의 차이는? 왜 SSE를 골랐나?
WebSocket은 프로토콜 업그레이드 후 양방향 풀듀플렉스 채널을 엽니다. SSE는 순수 HTTP `text/event-stream` 응답을 닫지 않고 서버가 단방향으로 텍스트 프레임을 흘려보냅니다. 알림은 클라가 서버로 실시간 데이터를 보낼 일이 없는 단방향 유스케이스라, 양방향·핸드셰이크 비용을 떠안을 필요가 없습니다. 또 SSE는 HTTP 위에서 동작해 세션 쿠키 인증·기존 인터셉터·재연결을 그대로 재사용할 수 있어 선택했습니다.
:::

:::details Q. 한 유저가 탭을 여러 개 열면?
`userIdx`를 키로 `List<SseEmitter>`를 둬서 탭마다 emitter를 따로 보관하고, 푸시할 때 그 리스트 전체를 순회해 모든 탭에 보냅니다. 푸시 도중 다른 탭이 끊겨 리스트가 수정될 수 있어 `CopyOnWriteArrayList`를 써서 순회 안정성을 확보했고, 끊긴 emitter는 `onCompletion`/`onError` 콜백이 리스트에서 제거합니다. 리스트가 비면 맵 엔트리도 지워 누수를 막습니다.
:::

:::details Q. 하트비트는 왜 필요하고, 왜 주석(comment)으로 보내나?
프록시·로드밸런서·방화벽은 일정 시간 데이터가 없는 연결을 idle로 보고 끊습니다. 그래서 30초마다 무언가를 흘려 연결을 살려둡니다. 다만 진짜 `data` 이벤트를 보내면 클라이언트 핸들러가 불필요하게 깨므로, SSE 규격상 클라가 무시하는 주석 라인(`: ping`)을 보내 연결만 유지하고 애플리케이션 로직은 건드리지 않습니다.
:::

:::details Q. 푸시 중 서버가 죽거나 SSE가 끊기면 알림이 사라지나?
아닙니다. `addNotification`은 **DB insert를 먼저** 하고 그다음 SSE 푸시를 하며, 푸시는 try/catch로 격리돼 실패해도 예외가 위로 전파되지 않습니다. 따라서 푸시가 실패해도 `MYPAGE_FEED_NOTIFICATION`에는 남고, 다음 페이지 진입 시 `NotificationInterceptor`가 안읽음 개수를 다시 주입해 벨이 보정됩니다. 실시간성은 SSE, 정확성은 DB+인터셉터가 담당하는 이중 안전망입니다.
:::

:::details Q. 서버를 여러 대로 늘리면 어떻게 되나?
현재 emitter 맵은 JVM 인메모리라 단일 인스턴스 전제입니다. 스케일아웃하면 사용자 탭이 붙은 인스턴스와 알림을 만든 인스턴스가 달라 푸시가 누락될 수 있습니다. 해법은 Redis Pub/Sub 같은 메시지 브로커로 "이 유저에게 푸시" 이벤트를 전 인스턴스에 브로드캐스트하고 각 인스턴스가 자기 emitter만 처리하는 구조입니다. 지금은 미구현이며, 누락돼도 DB 폴백으로 개수는 맞춰진다는 점을 안전장치로 둡니다.
:::

## 8. 직접 말해보기

- SSE를 한 문장으로 정의하고, 같은 유스케이스에서 WebSocket을 고르지 않은 이유를 30초로 말해보라.
- `userIdx → List<SseEmitter>` 자료구조에서 `ConcurrentHashMap`과 `CopyOnWriteArrayList`가 각각 무슨 동시성 문제를 막는지 설명해보라.
- "DB 먼저, 푸시 나중" 순서가 왜 신뢰성에 결정적인지, 반대 순서면 무엇이 깨지는지 말해보라.
- 30초 하트비트와 30분 타임아웃이 각각 어떤 장애를 방어하는지 구분해 설명해보라.

더 보기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether가 알림에 WebSocket이 아니라 SSE를 선택한 가장 핵심적인 이유는?" :choices="['알림은 서버에서 클라이언트로 가는 단방향이라 양방향 채널이 불필요하고, 순수 HTTP라 세션 인증·재연결을 재사용할 수 있어서', 'SSE가 WebSocket보다 항상 더 빠르기 때문', 'WebSocket은 JSON을 보낼 수 없기 때문', 'SSE만 바이너리 데이터를 지원하기 때문']" :answer="0" explanation="알림은 단방향(서버→클라) 유스케이스라 WebSocket의 양방향·핸드셰이크 비용이 불필요하고, SSE는 순수 HTTP 위에서 동작해 기존 세션 쿠키 인증과 EventSource 자동 재연결을 그대로 활용한다." />

<QuizBox question="NotificationSseService가 한 유저의 emitter를 List로 보관하는 직접적인 이유는?" :choices="['알림 우선순위를 정렬하려고', '한 유저가 여러 탭(브라우저)을 동시에 열 수 있어서 탭마다 emitter를 따로 두고 모두에 푸시하려고', '읽은 알림과 안읽은 알림을 분리 저장하려고', 'DB 부하를 줄이려고']" :answer="1" explanation="userIdx → List<SseEmitter> 구조는 한 사용자의 다중 탭에 대응한다. 푸시 시 리스트를 순회해 모든 탭에 보내고, 끊긴 탭은 콜백이 리스트에서 제거한다." />

<QuizBox question="30초마다 보내는 하트비트를 일반 data 이벤트가 아니라 주석(comment) 라인으로 보내는 이유는?" :choices="['data 이벤트는 SSE에서 금지되어서', '주석은 클라이언트 이벤트 핸들러를 깨우지 않고 연결만 유지해, 프록시 idle 타임아웃만 피하고 애플리케이션 로직은 건드리지 않으려고', '주석이 일반 이벤트보다 빠르게 전송되어서', '브라우저가 data 이벤트를 캐싱하기 때문']" :answer="1" explanation="SSE 규격상 주석 라인은 클라가 무시하므로 notification 핸들러를 불필요하게 깨우지 않는다. 연결만 살려 프록시·방화벽의 idle 타임아웃을 회피하는 용도다." />
