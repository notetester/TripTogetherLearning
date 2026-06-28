---
title: "SSE 실시간 알림"
owner: B
domain: "문의·알림·마이페이지"
tags: ["SSE", "알림"]
---

# SSE 실시간 알림

> 서버가 클라이언트에게 단방향으로 알림을 밀어 넣는 Server-Sent Events 구조. 폴링 없이 새 알림을 즉시 띄우면서, DB 저장을 진실의 원천으로 두어 푸시 실패에도 알림을 잃지 않는다.

이 문서는 TripTogether의 한 도메인 챕터다. 프로젝트는 4명이 도메인을 나눠 공동 개발했고, 실시간 알림은 마이페이지·알림 도메인에 속한다. 전체 지형은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 볼 수 있다.

## 1. 한 줄 정의

SSE(Server-Sent Events)는 HTTP 연결 하나를 열어 두고 서버가 클라이언트로 이벤트를 흘려보내는 단방향 푸시 프로토콜이며, TripTogether는 이를 써서 새 알림이 생기는 즉시 헤더 벨 배지와 토스트를 갱신한다.

## 2. 왜 이렇게 설계했나

알림은 "서버에서 사건이 생겼을 때 사용자에게 알린다"는 본질적으로 서버 주도(server-push) 문제다. 선택지는 세 가지였다.

| 방식 | 특징 | TripTogether 선택 이유 |
| --- | --- | --- |
| 폴링(주기적 GET) | 구현 단순, 그러나 지연·낭비 트래픽 | 빈 응답이 대부분이라 낭비 |
| WebSocket | 양방향 풀듀플렉스, 별도 프로토콜·핸드셰이크 | 알림은 단방향이라 과한 도구 |
| SSE | 단방향, 순수 HTTP, 브라우저 자동 재연결 내장 | 요구사항에 정확히 맞음 |

알림은 클라이언트가 서버로 보낼 말이 없는 단방향 흐름이다. SSE는 표준 `EventSource` API가 끊김 감지와 자동 재연결을 브라우저 레벨에서 처리해 주므로, 단방향 푸시에는 WebSocket보다 코드가 가볍다. 또한 순수 HTTP(`text/event-stream`)라 기존 세션 인증·프록시 인프라를 그대로 탄다.

핵심 설계 원칙은 **DB가 진실의 원천**이라는 것이다. 푸시는 어디까지나 즉시성을 위한 부가 채널이고, 알림 자체는 항상 먼저 DB에 저장된다. 연결이 끊겨 있어도 다음 페이지 로드 때 헤더가 DB에서 알림을 다시 읽어 오므로 유실이 없다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

서버는 Spring MVC의 `SseEmitter`를 사용한다. 관련 구성요소는 모두 `myPage` 도메인에 있다.

| 구성요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 구독 엔드포인트 | `NotificationSseController` | `GET /sse/notifications` 로 `SseEmitter` 반환 |
| 푸시 서비스 | `NotificationSseService` | userIdx별 emitter 보관·전송·하트비트 |
| 푸시 진입점 | `MyPageServiceImpl.addNotification` | DB 저장 후 SSE 전송 |
| 영속화 | `MyPageMapper.insertNotification` | `MYPAGE_FEED_NOTIFICATION` insert |
| 전송 DTO | `FeedNotificationDto` | 알림 한 건의 페이로드 |
| 헤더 주입 | `NotificationInterceptor` | 모든 뷰에 안읽음 개수·최근 5건 주입 |
| 브라우저 구독 | `resources/js/common/notification.js` | `EventSource` 구독·배지·토스트 |

저장 테이블 `MYPAGE_FEED_NOTIFICATION`의 주요 컬럼은 다음과 같다.

```sql
notification_id  BIGINT PK AUTO_INCREMENT
user_idx         BIGINT       -- 알림 받을 유저
source_type      VARCHAR(20)  -- community / inquiry / plan / ...
source_id        BIGINT       -- post_id / inquiry_id / ...
message          VARCHAR(200)
target_url       VARCHAR(255) -- 클릭 시 이동할 상대경로 (contextPath 제외)
created_at       DATETIME
is_read          TINYINT      -- 0 안읽음, 1 읽음
-- 인덱스: idx_user_unread (user_idx, is_read, created_at DESC)
```

`idx_user_unread` 복합 인덱스 덕분에 헤더가 매 페이지마다 호출하는 "안읽은 개수"와 "최근 5건" 조회가 인덱스만으로 해결된다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 구독: userIdx → 여러 emitter

한 사용자가 탭을 여러 개 열 수 있으므로 emitter는 유저당 리스트로 관리한다. 동시성 안전을 위해 바깥은 `ConcurrentHashMap`, 안쪽은 `CopyOnWriteArrayList`를 쓴다.

```java
private final Map<Long, List<SseEmitter>> emitters = new ConcurrentHashMap<>();

public SseEmitter subscribe(Long userIdx) {
    SseEmitter emitter = new SseEmitter(TIMEOUT_MS); // 30분
    emitters.computeIfAbsent(userIdx, k -> new CopyOnWriteArrayList<>()).add(emitter);
    // onCompletion / onTimeout / onError 모두에서 리스트에서 자기 자신 제거
    emitter.send(SseEmitter.event().name("connect").data("ok")); // 즉시 플러시 유도
    return emitter;
}
```

종료 콜백(`onCompletion`/`onTimeout`/`onError`)에서 항상 자기 자신을 리스트에서 빼고, 리스트가 비면 맵 키까지 제거해 죽은 연결이 쌓이지 않게 한다.

### 4-2. 푸시: DB 저장 후 전송 (안전망)

알림 생성의 단일 진입점은 `MyPageServiceImpl.addNotification`이다. 순서가 핵심이다.

```java
public void addNotification(FeedNotificationDto notification) {
    myPageMapper.insertNotification(notification);   // 1) DB 저장 (진실의 원천)
    try {
        notificationSseService.sendTo(
            notification.getUserIdx(), notification); // 2) 살아있는 탭에 푸시
    } catch (Exception e) {
        log.warn("SSE 푸시 실패 (DB 저장은 완료): ...", e); // 3) 푸시 실패해도 삼킴
    }
}
```

DB 저장이 먼저고 푸시는 best-effort다. 푸시가 던지는 예외를 잡아 삼키므로, 연결이 없거나 네트워크가 끊겨 푸시가 실패해도 알림은 이미 DB에 있다. 다른 도메인(커뮤니티, 문의, 리워드 등)은 `myPageService.addNotification`만 호출하면 되고 SSE 존재를 몰라도 된다. 이것이 크로스모듈 알림 패턴이다.

`sendTo`는 해당 유저의 모든 emitter를 순회하며 `notification` 이벤트로 DTO를 전송하고, 전송 중 `IOException`이 나면 그 emitter를 `complete()` 처리해 콜백이 리스트에서 제거하도록 위임한다.

### 4-3. 연결 유지: 타임아웃·하트비트·버퍼링 회피

| 장치 | 값 | 목적 |
| --- | --- | --- |
| emitter 타임아웃 | 30분 | 만료 시 브라우저가 자동 재연결(EventSource 기본) |
| 하트비트 | 30초 주기 | idle 끊김(프록시·방화벽 timeout) 회피 |
| `X-Accel-Buffering: no` | 응답 헤더 | 역방향 프록시(Nginx 등)의 응답 버퍼링 차단 |
| `Cache-Control: no-cache` | 응답 헤더 | 스트림 캐싱 방지 |
| `connect` 초기 이벤트 | 구독 직후 1회 | 즉시 플러시로 연결 확립 신호 |

하트비트는 `@Scheduled(fixedRate = 30000)`로 30초마다 모든 emitter에 SSE 주석 라인(`event().comment("ping")`)을 보낸다. 주석은 클라이언트 이벤트 핸들러를 깨우지 않으면서 연결만 살려 두는 데이터다. 30분 타임아웃은 의도된 설계로, 만료되면 `EventSource`가 알아서 재접속한다.

### 4-4. 클라이언트: EventSource → 배지·드롭다운·토스트

```js
const sse = new EventSource(ctx + '/sse/notifications');
sse.addEventListener('notification', function (e) {
    const noti = JSON.parse(e.data);
    incrementBadge();   // 벨 배지 +1 (99 초과는 99+)
    prependRow(noti);   // 드롭다운 맨 위에 행 삽입 (최대 5행 유지)
    showToast(noti);    // 우측 토스트 스택에 표시 (3초 후 자동 숨김)
});
sse.onerror = function () {}; // 브라우저가 기본 3초 간격으로 자동 재연결
```

클릭 시 `POST /api/notifications/{id}/read`로 읽음 처리하고 서버가 돌려준 `targetUrl`(없으면 행의 fallback)로 이동한다. SSE 경로(`/sse/**`)와 읽음 API(`/api/**`)는 `NotificationInterceptor`의 제외 패턴에 들어가, 헤더 주입 인터셉터가 스트림·AJAX 응답에 끼어들지 않는다.

### 전체 한 컷

```text
[타 도메인 사건] → myPageService.addNotification
   ├─ insertNotification → MYPAGE_FEED_NOTIFICATION  (항상 성공시킴)
   └─ sseService.sendTo(userIdx) → 살아있는 탭들로 push  (best-effort)
                                      ↓
[브라우저 EventSource] → notification 이벤트 → 배지+드롭다운+토스트
[연결 없음/끊김]      → 다음 페이지 로드 시 NotificationInterceptor가 DB에서 재조회
```

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- `SseEmitter` 기반 단방향 푸시, 유저당 다중 탭(`List<SseEmitter>`) 관리
- DB 저장 후 푸시(예외 삼킴) 안전망, 크로스모듈 `addNotification` 진입점
- 30분 타임아웃 + 30초 하트비트 + `X-Accel-Buffering: no`
- 헤더 벨 배지·드롭다운·토스트, 읽음/모두읽음 처리
- `idx_user_unread` 복합 인덱스로 안읽음 개수·최근 목록 조회 최적화
:::

:::warning 한계·계획
- emitter 저장소가 단일 JVM 인메모리 맵이라 다중 인스턴스로 수평 확장하면 인스턴스 간 푸시가 닿지 않는다. 분산 환경에서는 메시지 브로커(예: Redis Pub/Sub) 같은 fan-out 계층이 필요하다.
- 레이아웃이 데스크톱 JSP 중심이라 토스트·드롭다운의 모바일 반응형은 향후 과제.
- SSE 연결·재연결 지표를 정량 모니터링하는 체계는 아직 없다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "알림은 서버 주도 단방향 문제라 WebSocket 대신 SSE를 골랐고, 브라우저 `EventSource`의 자동 재연결을 그대로 활용합니다."
2. **설계 의도**: "푸시는 best-effort 부가 채널일 뿐이고 DB 저장을 진실의 원천으로 둡니다. 알림은 항상 먼저 `MYPAGE_FEED_NOTIFICATION`에 들어가고, 푸시 실패는 예외를 삼켜 무시합니다. 연결이 없어도 다음 페이지 로드 때 인터셉터가 DB에서 다시 읽어 유실이 없습니다."
3. **운영 디테일**: "한 유저가 탭을 여러 개 열 수 있어 userIdx를 키로 emitter 리스트를 관리하고, 30분 타임아웃으로 재연결을 유도하며 30초 하트비트와 `X-Accel-Buffering: no`로 프록시 idle 끊김과 버퍼링을 막습니다."

## 7. 꼬리질문 + 모범답안

:::details WebSocket이 아니라 SSE를 쓴 이유는?
알림은 클라이언트가 서버로 보낼 메시지가 없는 단방향 흐름이다. WebSocket의 양방향 풀듀플렉스는 과하고 별도 프로토콜 핸드셰이크가 필요하다. SSE는 순수 HTTP `text/event-stream`이라 기존 세션 인증·프록시를 그대로 타고, 끊김 감지와 재연결을 표준 `EventSource`가 브라우저 레벨에서 처리해 코드가 가볍다.
:::

:::details 푸시 도중 서버가 죽거나 연결이 끊기면 알림이 사라지지 않나?
사라지지 않는다. `addNotification`은 DB insert를 먼저 하고 그 다음에 푸시한다. 푸시 호출은 try-catch로 감싸 예외를 삼긴다. 즉 푸시 실패는 로그만 남기고 무시되며, 알림 본체는 이미 `MYPAGE_FEED_NOTIFICATION`에 있다. 사용자가 다음 페이지를 열면 `NotificationInterceptor`가 안읽은 개수와 최근 목록을 DB에서 다시 읽어 헤더에 채운다.
:::

:::details 한 사용자가 탭을 여러 개 열면 어떻게 처리하나?
emitter 저장소가 `Map<Long, List<SseEmitter>>` 구조다. userIdx 하나에 emitter 여러 개가 매달려, `sendTo`가 해당 유저의 모든 탭으로 동일 알림을 푸시한다. 동시성을 위해 바깥은 `ConcurrentHashMap`, 안쪽 리스트는 순회 중 안전 제거가 가능한 `CopyOnWriteArrayList`를 쓴다. 탭이 닫히면 종료 콜백이 그 emitter만 리스트에서 빼고, 리스트가 비면 맵 키도 지운다.
:::

:::details 30분 타임아웃과 30초 하트비트는 각각 왜 필요한가?
둘은 목적이 다르다. 30초 하트비트는 SSE 주석 라인을 흘려보내 프록시·방화벽의 idle timeout으로 연결이 끊기는 것을 막는다. 30분 타임아웃은 의도적으로 연결을 만료시켜 `EventSource`가 깨끗하게 재연결하게 만든다. 장기 연결이 영원히 매달려 자원과 죽은 핸들을 쌓는 것을 주기적으로 정리하는 셈이다.
:::

:::details 역방향 프록시 뒤에 두면 SSE가 안 보일 때가 있다는데?
Nginx 같은 프록시가 응답을 버퍼링하면 이벤트가 모였다가 한꺼번에 나가 실시간성이 깨진다. 그래서 구독 응답에 `X-Accel-Buffering: no`와 `Cache-Control: no-cache`를 붙이고, 구독 직후 `connect` 이벤트를 한 번 보내 즉시 플러시를 유도한다.
:::

:::details 이 구조를 서버 여러 대로 확장하면?
현재 emitter 맵은 단일 JVM 인메모리라 인스턴스 A에 연결된 사용자에게 인스턴스 B에서 일어난 사건을 직접 푸시할 수 없다. 확장하려면 인스턴스 간 fan-out 계층(예: Redis Pub/Sub)을 두고, 사건이 난 인스턴스가 채널에 발행하면 각 인스턴스가 자기 로컬 emitter로 전달하는 식으로 바꿔야 한다. 단 DB 저장 안전망은 그대로라, 푸시가 닿지 않아도 정합성은 유지된다.
:::

## 8. 직접 말해보기

- SSE와 WebSocket을 알림 맥락에서 한 문장으로 비교하고, 왜 SSE를 골랐는지 말해 보자.
- "DB 저장이 먼저, 푸시는 best-effort"라는 순서가 왜 유실 방지에 중요한지 설명해 보자.
- 30분 타임아웃과 30초 하트비트가 각각 무엇을 막는지 구분해 말해 보자.
- 다중 탭을 지원하기 위해 자료구조를 어떻게 잡았고, 죽은 연결은 언제 정리되는지 설명해 보자.

## 퀴즈

<QuizBox question="TripTogether가 알림에 WebSocket 대신 SSE를 선택한 핵심 이유는?" :choices="['알림은 단방향 서버 주도 흐름이고 EventSource가 자동 재연결을 내장해서', '양방향 채팅 기능이 필요해서', 'SSE가 WebSocket보다 보안이 강해서', 'MyBatis가 WebSocket을 지원하지 않아서']" :answer="0" explanation="알림은 클라이언트가 서버로 보낼 말이 없는 단방향 흐름이라 SSE가 적합하다. 순수 HTTP라 기존 인증 프록시를 그대로 타고, 표준 EventSource가 끊김 감지와 재연결을 처리한다." />

<QuizBox question="addNotification에서 DB 저장과 SSE 푸시의 순서·관계로 옳은 것은?" :choices="['푸시를 먼저 하고 성공해야만 DB에 저장한다', 'DB에 먼저 저장하고 푸시는 best-effort로 예외를 삼킨다', 'DB 저장 없이 푸시만 한다', '둘을 하나의 트랜잭션으로 묶어 푸시 실패 시 DB도 롤백한다']" :answer="1" explanation="DB 저장이 진실의 원천이다. insert를 먼저 하고 푸시는 try-catch로 감싸 실패를 삼킨다. 푸시가 실패해도 알림은 DB에 남아 다음 페이지 로드 시 인터셉터가 다시 읽어 온다." />

<QuizBox question="30초 하트비트와 30분 타임아웃의 역할을 바르게 짝지은 것은?" :choices="['하트비트는 연결을 만료시키고 타임아웃은 idle을 막는다', '둘 다 idle 끊김을 막는 같은 목적이다', '하트비트는 프록시 idle 끊김을 막고 타임아웃은 만료 후 자동 재연결을 유도한다', '하트비트는 응답 버퍼링을 끄고 타임아웃은 캐시를 끈다']" :answer="2" explanation="30초 하트비트는 주석 라인으로 idle timeout 끊김을 막고, 30분 타임아웃은 의도적 만료로 EventSource의 깨끗한 재연결을 유도한다. 버퍼링·캐시 제어는 별도로 X-Accel-Buffering과 Cache-Control 헤더가 담당한다." />
