---
title: "문의·알림 면접 플레이북"
owner: B
domain: "문의·알림·마이페이지"
tags: ["면접"]
---

# 문의·알림 면접 플레이북

> 문의 게시판의 상태머신, SSE 실시간 알림, 크로스모듈 단일 알림 인터페이스, AI 답변 초안을 1분/3분 버전과 예상 질문 10개로 정리한다.

## 1. 한 줄 정의

이 도메인은 사용자 문의(고객센터)와 그에 대한 운영진 답변을 상태머신으로 관리하고, 답변·이벤트가 발생하면 SSE로 실시간 알림을 푸시하며, 마이페이지 피드로 누적 기록을 보여주는 CS·알림 통합 영역이다.

## 2. 왜 이렇게 설계했나

핵심 설계 결정은 세 가지이며, 면접에서는 항상 대안과 비교해서 말하는 것이 강하다.

- 실시간 알림을 폴링이 아니라 SSE(Server-Sent Events)로 구현했다. 알림은 서버에서 클라이언트로 흐르는 단방향이라 양방향 WebSocket까지는 과하고, EventSource는 끊기면 브라우저가 알아서 재연결하므로 운영 부담이 작다.
- 알림 생성을 모든 모듈이 공유하는 단일 인터페이스 myPageService.addNotification 하나로 통일했다. 문의 답변, 커뮤니티 댓글, 신고 처리 등 출처가 제각각이어도 알림을 만드는 진입점은 한 곳이라, DB 저장과 SSE 푸시를 한 번에 일관 처리할 수 있다.
- 문의 답변에 AI 초안(Claude Haiku)을 붙였다. 운영진의 빈 화면 공포를 줄이는 보조 도구이며, 호출이 실패해도 빈 문자열을 반환해 사람이 직접 쓰는 흐름을 절대 막지 않는다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 문의 컨트롤러 | InquiryController (/inquiry/**) | 작성·상세·답변·상태전환 엔드포인트 |
| 문의 서비스 | InquiryServiceImpl | 상태 전이, 답변 이력 보존, 첨부 검증 |
| AI 초안 | InquiryAiService | Claude Haiku 단일 호출, fail-safe |
| 알림 SSE 컨트롤러 | NotificationSseController (/sse/notifications) | EventSource 구독 엔드포인트 |
| 알림 SSE 서비스 | NotificationSseService | userIdx 별 emitter 관리, 하트비트 |
| 알림 REST | NotificationController (/api/notifications) | 목록·읽음·삭제 |
| 알림 주입 | NotificationInterceptor | 모든 페이지 unread 개수 주입 |
| URL 생성 | NotificationUrlBuilder | 알림 클릭 시 targetUrl 표준화 |
| 알림 생성 진입점 | MyPageService.addNotification | DB 저장 후 SSE 푸시 |

핵심 테이블은 INQUIRY_POST(상태·시각 컬럼), INQUIRY_ANSWER(문의당 1답변, UNIQUE), INQUIRY_ANSWER_HISTORY(답변 변경 보존), INQUIRY_ATTACHMENT(첨부), MYPAGE_FEED_NOTIFICATION(알림, user_idx + is_read 복합 인덱스)이다.

## 4. 동작 원리 (흐름·표·작은 코드)

운영진이 답변을 등록하면 답변 저장과 알림 푸시가 한 흐름으로 이어진다.

```text
운영진 답변 등록 (POST /inquiry/{id}/answer)
  -> InquiryService.writeAnswer  : INQUIRY_ANSWER insert + status 전이
  -> FeedNotificationDto 구성     : sourceType=inquiry, targetUrl=/inquiry/{id}
  -> myPageService.addNotification
       -> MYPAGE_FEED_NOTIFICATION insert   (영속 = 안전망)
       -> notificationSseService.sendTo     (실시간 푸시, 실패해도 무시)
  -> 구독 중인 모든 탭의 EventSource가 notification 이벤트 수신 -> 토스트
```

알림 생성 진입점의 핵심은 "먼저 저장하고, 그다음 푸시"라는 순서다. 푸시가 실패해도 DB에는 남으므로 사용자가 새로고침하면 알림을 보게 된다.

```java
public void addNotification(FeedNotificationDto noti) {
    myPageMapper.insertNotification(noti);          // 1) 영속 먼저
    try {
        notificationSseService.sendTo(noti.getUserIdx(), noti); // 2) 실시간은 best-effort
    } catch (Exception e) {
        log.warn("SSE 푸시 실패 (DB 저장은 완료)"); // 알림 유실 방지
    }
}
```

SSE 서비스는 한 사용자가 여러 탭을 열 수 있으므로 userIdx 하나에 emitter 목록을 매핑한다.

| 항목 | 값 | 이유 |
| --- | --- | --- |
| 매핑 구조 | userIdx 에서 List of SseEmitter | 다중 탭 동시 푸시 |
| 타임아웃 | 30분 | 만료 시 브라우저가 자동 재연결 |
| 하트비트 | 30초 주석 라인 | 프록시·방화벽 idle timeout 회피 |
| 정리 | onCompletion / onTimeout / onError | 죽은 emitter 자동 제거 |

문의 상태머신은 단순 토글이 아니라 누가 어떤 전이를 할 수 있는지로 갈린다. 사용자는 PENDING 또는 IN_PROGRESS에서 취소(CANCELLED)할 수 있고, COMPLETED에서만 삭제 요청(DELETE_REQUESTED)을 보내며, 운영진이 그 요청을 승인해야 실제 삭제된다. 자기 글의 PENDING 상태에서만 수정이 가능하다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: 문의 CRUD와 다단계 상태 전이, 답변 등록·수정과 INQUIRY_ANSWER_HISTORY 이력 보존, 첨부 업로드(Cloudinary), 비공개·공개 요청 워크플로우, SSE 실시간 알림, 마이페이지 피드, AI 답변 초안(Claude Haiku).
- 부분/주의: AI 초안은 보조 도구이며 응답 품질의 정량 평가 체계는 없다. SSE 상태는 단일 서버 메모리(ConcurrentHashMap)에 있어, 다중 인스턴스로 수평 확장하면 인스턴스 간 푸시 공유 장치(예: 메시지 브로커)가 추가로 필요하다.
- 계획/한계: 모바일은 JSP 데스크톱 레이아웃 위주이고, 알림 일괄 정책(만료·보존기간)이나 푸시 채널(웹푸시·이메일) 확장은 향후 과제다.

## 6. 면접 답변 3단계

::: tip 1분 버전
저는 문의 게시판과 실시간 알림을 맡았습니다. 문의는 PENDING에서 COMPLETED까지 이어지는 상태머신으로 관리하고, 운영진이 답변하면 SSE로 사용자에게 실시간 알림이 갑니다. 알림은 항상 DB에 먼저 저장한 뒤 푸시해서, 푸시가 실패해도 유실되지 않게 했습니다. 답변 작성에는 Claude Haiku로 초안을 붙여 운영진 부담을 줄였습니다.
:::

3분 버전에서는 설계 이유를 덧붙인다. 알림이 단방향이라 WebSocket 대신 SSE를 택했고, EventSource의 자동 재연결로 운영을 단순화했다는 점. 알림 생성을 모듈마다 흩지 않고 addNotification 단일 인터페이스로 모아 DB 저장과 SSE 푸시를 한 곳에서 일관 처리한다는 점. 그리고 AI 초안은 실패 시 빈 문자열을 반환하는 fail-safe라 사람이 직접 쓰는 흐름을 막지 않는다는 점을 강조한다.

심화 버전에서는 트레이드오프를 먼저 꺼낸다. 현재 SSE 상태가 단일 서버 메모리라 수평 확장 시 한계가 있다는 점, 30초 하트비트와 30분 타임아웃으로 프록시 idle를 견딘다는 점, 답변 변경을 INQUIRY_ANSWER_HISTORY로 보존해 CS 추적성을 확보했다는 점을 근거와 함께 말한다.

## 7. 꼬리질문 + 모범답안

::: details 왜 폴링이 아니라 SSE인가
폴링은 주기적으로 서버를 두드려 평소에도 빈 응답을 반복합니다. 알림은 서버에서 클라이언트로만 흐르는 단방향이라 SSE 한 줄 스트림이면 충분하고, 데이터가 생긴 순간에만 push하므로 지연과 낭비가 동시에 줄어듭니다. 끊기면 EventSource가 알아서 재연결합니다.
:::

::: details 왜 WebSocket이 아니라 SSE인가
WebSocket은 양방향 프로토콜이라 클라이언트가 서버로도 자주 보내는 채팅 같은 경우에 맞습니다. 알림은 받기만 하므로 양방향 핸드셰이크와 프레이밍 비용이 불필요합니다. SSE는 일반 HTTP 위에서 동작해 프록시 친화적이고 구현·디버깅이 단순합니다.
:::

::: details DB 저장과 SSE 푸시 중 무엇을 먼저 하나, 왜인가
DB 저장을 먼저 합니다. SSE는 best-effort라 사용자가 오프라인이거나 푸시가 실패할 수 있는데, DB에 먼저 남기면 새로고침이나 다음 페이지 진입 때 인터셉터가 unread를 다시 읽어와 결국 보게 됩니다. 즉 영속을 진실의 원천으로, 실시간 푸시를 부가 채널로 둡니다.
:::

::: details 한 사용자가 탭을 여러 개 열면 어떻게 되나
SSE 서비스는 userIdx 하나에 emitter 목록을 매핑합니다. 탭마다 EventSource가 별도 emitter로 등록되고, sendTo는 그 목록 전체를 순회하며 보냅니다. 어떤 emitter로 보내다 IOException이 나면 complete를 호출하고, 등록해 둔 onCompletion 콜백이 목록에서 그 emitter를 제거합니다.
:::

::: details 답변을 수정하면 원본은 어떻게 추적하나
수정 전 본문을 INQUIRY_ANSWER_HISTORY에 먼저 보존하고 나서 INQUIRY_ANSWER를 갱신합니다. change_type을 UPDATE 또는 DELETE로 남겨 변경 종류까지 구분합니다. CS 답변은 분쟁 소지가 있어 무엇이 언제 누구에 의해 바뀌었는지 되돌아볼 수 있어야 하기 때문입니다.
:::

::: details AI 초안 호출이 실패하면 어떻게 되나
빈 문자열을 반환하는 fail-safe로 설계했습니다. AI는 어디까지나 보조 도구라, 외부 API가 느리거나 죽어도 운영진이 직접 답변을 쓰는 본 흐름을 막으면 안 됩니다. 컨트롤러는 빈 초안일 때 실패 메시지를 주되 답변 작성 화면 자체는 정상 동작합니다.
:::

## 8. 직접 말해보기

다음 질문에 자료를 덮고 소리 내어 답해 보라.

1. 이 도메인에서 SSE를 고른 이유를 WebSocket·폴링과 비교해 한 문장씩으로 말해 보라.
2. addNotification이 단일 인터페이스라는 게 어떤 이점을 주는지, 출처가 다른 알림 두 개를 예로 들어 설명해 보라.
3. 문의가 작성부터 삭제까지 거치는 상태들을 순서대로 말하고, 각 전이를 누가 트리거하는지 구분해 보라.
4. SSE 상태가 단일 서버 메모리라 생기는 한계와 그 해결 방향을 말해 보라.

## 퀴즈

<QuizBox question="이 도메인이 실시간 알림에 SSE를 선택한 핵심 이유로 가장 적절한 것은?" :choices="['알림은 서버에서 클라이언트로의 단방향이라 양방향 WebSocket이 과하고 EventSource가 자동 재연결해서', '클라이언트가 서버로 자주 메시지를 보내야 해서', 'SSE가 폴링보다 항상 더 많은 요청을 보내서', '브라우저가 SSE만 지원해서']" :answer="0" explanation="알림 흐름은 단방향이라 SSE가 적합하고, EventSource의 자동 재연결로 운영이 단순해진다. WebSocket은 양방향이 필요한 채팅 등에 맞다." />

<QuizBox question="addNotification에서 DB 저장과 SSE 푸시의 순서와 그 이유로 옳은 것은?" :choices="['SSE 먼저 보내고 실패하면 DB에 저장한다', 'DB에 먼저 저장하고 SSE는 best-effort로 푸시해 푸시 실패 시에도 알림이 유실되지 않게 한다', '둘을 하나의 외부 트랜잭션으로 묶어 동시에 처리한다', 'SSE만 보내고 DB에는 저장하지 않는다']" :answer="1" explanation="영속을 진실의 원천으로 두고 실시간 푸시는 부가 채널로 처리한다. 푸시가 실패해도 새로고침 시 인터셉터가 unread를 다시 읽어 결국 알림이 노출된다." />

<QuizBox question="문의 답변 수정 시 원본 추적을 위해 사용하는 테이블과 동작으로 옳은 것은?" :choices="['INQUIRY_POST의 status만 바꾸고 별도 보존은 없다', '수정 전 본문을 INQUIRY_ANSWER_HISTORY에 보존한 뒤 INQUIRY_ANSWER를 갱신한다', '첨부 테이블에 옛 답변을 복사한다', '알림 테이블에 변경 로그를 남긴다']" :answer="1" explanation="수정 전 본문을 INQUIRY_ANSWER_HISTORY에 먼저 보존하고 change_type을 UPDATE 또는 DELETE로 기록해 CS 답변 변경을 추적한다." />
