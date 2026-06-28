---
title: "알림 인터셉터·토스트"
owner: B
domain: "문의·알림·마이페이지"
tags: ["알림", "인터셉터"]
---

# 알림 인터셉터·토스트

> 모든 View 페이지에 안읽음 개수와 최근 알림을 자동 주입하는 인터셉터, 그리고 그 데이터를 헤더 벨 배지·드롭다운·토스트로 보여주는 클라이언트 한 쌍.

## 1. 한 줄 정의

`NotificationInterceptor`는 로그인 사용자가 여는 모든 View 페이지의 `ModelAndView`에 안읽음 알림 개수(`headerUnreadCount`)와 최근 5건(`headerRecentNotifications`)을 주입하고, JSP 헤더가 이를 벨 배지·드롭다운으로 렌더링하며, 실시간 도착분은 SSE로 받아 토스트로 띄운다.

## 2. 왜 이렇게 설계했나

알림 벨은 헤더에 있으므로 사실상 모든 화면에 노출된다. 각 컨트롤러가 매번 안읽음 개수를 모델에 담는 방식은 누락과 중복을 부른다. 이 횡단 관심사를 한 곳으로 모은 것이 인터셉터다.

- 횡단 관심사 분리: 컨트롤러는 자기 도메인 로직만 다루고, 헤더 알림 데이터는 인터셉터가 책임진다.
- 정확한 적용 시점: 데이터를 모델에 넣어야 하므로 핸들러 실행 후 View 렌더링 직전인 `postHandle`에서 처리한다. `preHandle`은 모델이 아직 없고, `afterCompletion`은 이미 렌더링이 끝난 뒤다.
- 불필요한 조회 차단: 비로그인 사용자, 그리고 View가 없는 응답(REST/JSON, SSE 스트림)에는 알림 데이터가 의미 없으므로 일찍 반환한다.
- 초기 상태 대 실시간: 페이지를 처음 그릴 때의 스냅샷은 인터셉터가, 페이지 머무는 동안 새로 도착하는 알림은 SSE가 담당한다. 두 경로가 같은 DTO 형태를 공유해 클라이언트 렌더링 코드를 재사용한다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 구성요소 | 위치/이름 | 역할 |
| --- | --- | --- |
| 인터셉터 | `config.NotificationInterceptor` | `postHandle`에서 모델에 알림 데이터 주입 |
| 등록 | `config.WebConfig#addInterceptors` | `/**` 적용, 정적/`/api/**`/`/sse/**` 제외 |
| 서비스 | `myPage.service.MyPageService` | `getUnreadCount`, `getRecentNotifications` 등 |
| DTO | `myPage.vo.FeedNotificationDto` | 알림 한 건의 표현 |
| REST API | `myPage.controller.NotificationController` | 읽음/삭제/조회 비동기 처리 |
| 실시간 푸시 | `myPage.service.NotificationSseService` | userIdx 기준 SseEmitter 보관·전송 |
| 헤더 뷰 | `WEB-INF/views/common/header.jsp` | 벨 배지·드롭다운 초기 렌더 |
| 클라이언트 | `resources/js/common/notification.js` | 드롭다운·토스트·SSE 구독 |
| 테이블 | `MYPAGE_FEED_NOTIFICATION` | 알림 영속 저장 |

인터셉터는 `MyPageService` 하나에만 의존하고, 다른 인터셉터(로케일·IP차단·로그인·관리자 등)와 함께 `WebConfig`의 체인에 등록된다.

```java
// NotificationInterceptor#postHandle (요지)
if (modelAndView == null) return;            // View 없는 응답 무시
HttpSession session = request.getSession(false);
if (session == null) return;
UsersVO loginUser = (UsersVO) session.getAttribute("loginUser");
if (loginUser == null) return;               // 비로그인 무시

Long userIdx = loginUser.getUserIdx();
int unreadCount = myPageService.getUnreadCount(userIdx);
List<FeedNotificationDto> recent = myPageService.getRecentNotifications(userIdx, RECENT_LIMIT);
modelAndView.addObject("headerUnreadCount", unreadCount);
modelAndView.addObject("headerRecentNotifications", recent);
```

`MYPAGE_FEED_NOTIFICATION`의 핵심 컬럼은 `user_idx`, `source_type`(community/inquiry/plan 등), `source_id`, `message`, `target_url`(contextPath 제외 상대경로), `is_read`, `created_at`이다. 안읽음 조회를 위해 user_idx + is_read + created_at 복합 인덱스가 걸려 있다.

## 4. 동작 원리(흐름·표·작은 코드)

페이지 로드 시점의 흐름:

1. 사용자가 View 페이지를 요청한다.
2. 컨트롤러가 핸들러를 실행하고 `ModelAndView`를 만든다.
3. `postHandle`이 호출되어 로그인·세션·View 유무를 확인한다.
4. 조건을 통과하면 안읽음 개수와 최근 5건을 모델에 담는다.
5. `header.jsp`가 배지(`headerUnreadCount`)와 드롭다운 목록(`headerRecentNotifications`)을 렌더링한다.

머무는 동안의 실시간 흐름:

| 단계 | 주체 | 동작 |
| --- | --- | --- |
| 구독 | `notification.js` | `new EventSource(ctx + /sse/notifications)` |
| 생성 | 타 모듈 | `myPageService.addNotification(dto)` 호출 |
| 저장 후 푸시 | `MyPageServiceImpl` | DB insert 성공 후 `sseService.sendTo` |
| 수신 | 브라우저 | notification 이벤트 → 배지+1, 드롭다운 prepend, 토스트 |
| 클릭 | 사용자 | read API 호출 후 `target_url`로 이동 |

DB 저장과 푸시의 안전망 분리:

```java
// MyPageServiceImpl#addNotification (요지)
myPageMapper.insertNotification(notification);          // 먼저 영속화
try {
    notificationSseService.sendTo(notification.getUserIdx(), notification);
} catch (Exception e) {
    log.warn("SSE 푸시 실패 (DB 저장은 완료): userIdx={}", ...);
}
```

푸시가 실패해도 알림은 DB에 남아 있으므로, 다음 페이지 로드 때 인터셉터가 다시 집어 온다. 실시간 경로는 보조이고 영속 저장이 진실의 원천이다.

토스트 클라이언트의 동작 요점(`notification.js`):

- 우상단 토스트 스택(`noti-toast-stack`)에 최신이 위로 쌓이며, 최대 5개를 넘으면 오래된 것부터 제거하고 각 토스트는 3초 후 자동 사라진다.
- `source_type`별 아이콘과 라벨(커뮤니티/문의/신고/레벨업/등급/계정차단)을 매핑하고, 알 수 없는 타입은 기본값으로 폴백한다.
- 토스트의 보기 버튼이나 본문 클릭은 읽음 API 호출 후 `target_url`로 이동하고, 닫기 버튼은 이동 없이 토스트만 제거한다.
- 라벨은 헤더가 `window.__notificationConfig`에 i18n 메시지를 주입해 다국어로 표시되며, 키가 해석되지 않으면 영어 기본 문구로 폴백한다.

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현 완료
- 인터셉터의 모델 주입, 헤더 배지·드롭다운 렌더링은 동작한다.
- SSE 실시간 푸시(다중 탭 userIdx → List 관리, 30분 타임아웃, 30초 하트비트), DB 저장 후 푸시 안전망도 동작한다.
- 읽음/모두읽음/삭제 REST API와 토스트 스택·자동숨김·다국어 라벨도 구현되어 있다.
:::

:::warning 한계·향후
- 인터셉터는 매 View 요청마다 안읽음 개수와 최근 5건을 조회한다. 인덱스가 받쳐 주지만 캐싱은 없다.
- 레이아웃은 JSP 데스크톱 기준이며 모바일 반응형은 향후 과제다.
- 알림 종류 확장 시 아이콘·라벨 매핑을 클라이언트와 메시지 번들 양쪽에 추가해야 한다.
:::

## 6. 면접 답변 3단계

1. 한 줄: 헤더 알림 벨에 필요한 안읽음 개수와 최근 목록을 모든 View 페이지에 자동으로 채워 넣는 인터셉터를 두고, 실시간 도착분은 SSE 토스트로 보완했습니다.
2. 설계 의도: 알림 데이터는 모든 화면에 공통이라 컨트롤러마다 넣으면 누락이 생깁니다. 모델이 만들어진 뒤인 postHandle에서 한 번에 주입하고, 비로그인과 View 없는 응답은 걸러 불필요한 조회를 막았습니다.
3. 깊이: 초기 스냅샷은 인터셉터, 실시간 갱신은 SSE가 맡되 둘이 같은 DTO를 공유합니다. 알림 생성은 DB 저장을 먼저 하고 푸시는 try-catch로 감싸, 푸시가 실패해도 다음 로드 때 인터셉터가 복구합니다.

## 7. 꼬리질문+모범답안

:::details 왜 preHandle이 아니라 postHandle인가
모델에 데이터를 넣으려면 컨트롤러가 ModelAndView를 만든 뒤여야 합니다. preHandle 시점에는 모델이 없고, afterCompletion은 렌더링이 끝난 뒤라 너무 늦습니다. 따라서 핸들러 실행 후 렌더링 직전인 postHandle이 맞습니다.
:::

:::details REST/JSON 응답이나 SSE 스트림에는 어떻게 영향을 막았나
두 겹입니다. 우선 등록 단계에서 `/api/**`와 `/sse/**`를 excludePathPatterns로 제외했습니다. 그리고 인터셉터 내부에서도 modelAndView가 null이면 즉시 반환하므로, 혹시 View 없는 응답이 들어와도 안전합니다.
:::

:::details 한 사용자가 여러 탭을 열면 알림이 중복되지 않나
SSE는 userIdx 하나에 SseEmitter 여러 개를 List로 보관하고 sendTo가 모두에게 전송하므로, 탭마다 토스트가 뜨는 것은 의도된 동작입니다. 읽음 처리는 알림 ID 단위 서버 상태라서, 한 탭에서 읽으면 다른 탭은 다음 갱신 때 반영됩니다.
:::

:::details 푸시가 실패하면 알림이 사라지나
아닙니다. addNotification은 DB insert를 먼저 하고 SSE 전송만 try-catch로 감쌉니다. 푸시가 실패해도 레코드는 남아 있어 다음 페이지 로드 때 인터셉터가 다시 읽어 옵니다. 영속 저장이 진실의 원천이고 실시간은 보조입니다.
:::

:::details 매 페이지마다 알림을 두 번 조회하면 부담되지 않나
안읽음 개수와 최근 5건 두 쿼리이며, user_idx + is_read + created_at 복합 인덱스로 좁은 범위만 읽습니다. 현재는 캐싱이 없어 트래픽이 커지면 세션 캐시나 짧은 TTL 캐시가 다음 개선 후보입니다.
:::

## 8. 직접 말해보기

- 인터셉터가 알림 데이터를 주입하는 시점을 preHandle/postHandle/afterCompletion 중에서 고르고 이유를 설명해 보세요.
- 같은 알림이 인터셉터 경로와 SSE 경로로 어떻게 흘러가는지, 두 경로가 무엇을 공유하는지 말해 보세요.
- DB 저장과 SSE 푸시의 순서와 예외 처리가 왜 그렇게 설계됐는지 설명해 보세요.

관련 문서: [SSE 실시간 알림](/inquiry/sse-notification) · [마이페이지 피드·크로스모듈](/inquiry/mypage-feed) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="NotificationInterceptor가 알림 데이터를 모델에 넣는 메서드와 시점으로 옳은 것은?" :choices="['preHandle, 컨트롤러 실행 전', 'postHandle, 핸들러 실행 후 View 렌더링 직전', 'afterCompletion, 렌더링이 모두 끝난 후', '컨트롤러 메서드 내부에서 직접 추가']" :answer="1" explanation="모델은 핸들러가 ModelAndView를 만든 뒤에 존재하므로, 렌더링 직전인 postHandle에서 주입한다. modelAndView가 null이면 곧바로 반환한다." />

<QuizBox question="addNotification에서 DB 저장과 SSE 푸시를 분리해 처리하는 이유는?" :choices="['푸시 속도를 높이려고', 'DB 저장이 진실의 원천이고 푸시는 보조라서, 푸시 실패해도 다음 로드 때 인터셉터가 복구하므로', 'SSE가 트랜잭션을 지원하지 않아서', '읽음 처리를 자동화하려고']" :answer="1" explanation="insert를 먼저 하고 sendTo만 try-catch로 감싼다. 푸시가 실패해도 레코드가 남아 다음 페이지 로드 시 인터셉터가 다시 읽어 온다." />

<QuizBox question="인터셉터가 알림 데이터를 주입하지 않는 경우로 옳은 것을 모두 고른다면?" :choices="['비로그인 사용자 요청', 'api 하위 JSON 응답과 sse 스트림', 'View가 있는 로그인 사용자 페이지', '비로그인과 View 없는 응답 모두']" :answer="3" explanation="로그인 세션이 없거나 modelAndView가 null인 경우 반환하고, 등록 단계에서 정적 자원과 api, sse 경로를 제외한다. 따라서 비로그인과 View 없는 응답 모두 주입 대상이 아니다." />
