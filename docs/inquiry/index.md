---
title: "문의·알림·마이페이지 개요"
owner: B
domain: "문의·알림·마이페이지"
tags: ["문의", "알림"]
---

# 문의·알림·마이페이지 개요

> 1:1 고객 문의를 다단계 상태머신으로 운영하고, 처리 결과를 SSE 실시간 알림으로 사용자에게 밀어 넣으며, 그 모든 활동 이력을 마이페이지 한곳에 모으는 운영·사용자 접점 도메인.

TripTogether는 국내 여행 올인원 플랫폼(탐색 → 계획 → 예약 → 공유)이고, 이 도메인은 그 위에서 발생하는 사용자와 운영진 사이의 소통을 책임진다. 문의(고객센터), 알림(피드 푸시), 마이페이지(내 활동 집계)는 화면상 따로 보이지만 데이터 흐름으로 강하게 묶여 있다. 문의에 답변이 달리면 알림이 발생하고, 그 알림과 문의 내역은 마이페이지에 모인다. 이 페이지는 도메인 전체 지도이고, 세부 개념은 아래 학습 순서의 링크에서 다룬다.

## 1. 이 도메인은 무엇을 하나

세 축으로 나뉜다.

| 축 | 핵심 책임 | 대표 테이블/클래스 |
| --- | --- | --- |
| 문의(inquiry) | 1:1 고객센터, 다단계 상태머신, AI 답변 초안, 비공개·첨부 워크플로우 | `INQUIRY_POST`, `INQUIRY_ANSWER`, `INQUIRY_ANSWER_HISTORY`, `INQUIRY_ATTACHMENT` |
| 알림(notification) | 처리 결과 실시간 푸시(SSE), 안읽음 배지 주입 | `FeedNotificationDto`, `NotificationSseService` |
| 마이페이지(myPage) | 내 글·문의·신고·리뷰·일정·예약·지갑 집계 | `MyPageMapper`(`selectMyInquiryList` 등), `MyPage*Dto` |

문의는 단순한 게시판이 아니라 상태 전이가 핵심이다. PENDING(대기) → ANSWERED/COMPLETED(완료)로 끝나지 않고, 유저가 취소·삭제요청·공개전환을 요청하고 관리자가 수락하는 양방향 워크플로우를 가진다.

## 2. 담당과 협업 맥락

TripTogether는 4인이 도메인을 수직 분담해 만든 팀 프로젝트다. 이 챕터(`owner: B`)는 문의·알림·마이페이지를 다루지만, 이 도메인은 본질적으로 다른 모듈을 받아 모으는 허브라 협업 면이 넓다.

- **크로스모듈 알림 진입점**: `myPageService.addNotification(FeedNotificationDto)`는 inquiry뿐 아니라 community·report 등 여러 도메인이 호출한다. 즉 알림 발행은 이 도메인이 제공하는 공용 서비스다.
- **공통 인프라 의존**: 세션 인증(세션 속성 loginUser=UsersVO), 권한 AOP(`@RequireAdmin`/`@LoginUser`, ADR-0011), 소프트삭제 status 컬럼(ADR-0008)을 그대로 쓴다.
- **모더레이션 연계**: 문의 작성 시 Perspective 독성 평가를 비동기로 호출해 `ai_flagged`를 세운다. AI 모더레이션 정책은 admin 도메인(ADR-0010)과 맞물린다.
- **마이페이지 집계 대상**: 마이페이지의 각 탭(커뮤니티·신고·리뷰·일정·항공권·패키지·지갑)은 다른 도메인의 데이터를 읽어 합친다.

즉 이 도메인은 자기 데이터(문의)도 갖지만, 동시에 다른 도메인의 결과를 사용자에게 전달하고 모으는 접점이다. 도메인 경계는 [도메인 전체 개요](/domains)와 [전체 흐름](/flow/)에서 확인할 수 있다.

## 3. 핵심 기술 5가지

면접에서 이 도메인을 설명할 때 반드시 짚어야 할 다섯 가지다.

:::tip 한눈에 보기
문의 다단계 상태머신 → 양방향 요청·수락 워크플로우 → Claude Haiku 답변 초안 → SSE 실시간 알림 → 마이페이지 크로스모듈 집계. 이 다섯이 운영 접점 도메인의 골격이다.
:::

### (1) 문의 다단계 상태머신

문의는 단일 `status` 컬럼으로 여러 상태를 오간다. PENDING(대기), IN_PROGRESS(처리중), COMPLETED(완료), CANCELLED(취소), USER_COMPLETED(유저 직접 완료), DELETE_REQUESTED(삭제요청), PRIVATE_REQUESTED/PUBLIC_REQUESTED(공개전환 요청). 각 전이는 상태 가드로 보호된다. 예를 들어 수정·삭제는 PENDING일 때만, 취소는 PENDING 또는 IN_PROGRESS일 때만, 삭제요청은 COMPLETED일 때만 가능하다. 잘못된 전이는 HTTP 400으로 거절한다.

### (2) 양방향 요청·수락 워크플로우

유저가 일방적으로 글을 지우거나 공개를 바꾸지 않는다. 유저는 삭제요청(`/inquiry/{id}/delete-request`)이나 공개전환요청(`/inquiry/{id}/visibility-request`)을 보내고, 관리자가 수락(`/delete-approve`, `/visibility-approve`)해야 실제로 반영된다. 권한은 본인 여부(403)와 관리자 여부(403)로 분리하고, 대상 부재는 404로 구분한다. 운영 추적성을 위한 설계다.

### (3) Claude Haiku AI 답변 초안 (ADR-0010 계열)

관리자가 답변을 처음부터 쓰지 않도록 `/inquiry/{id}/ai-draft`가 Anthropic Claude Haiku로 초안을 생성한다(`InquiryAiService`). 카테고리(service/payment/account/bug/etc)와 제목·본문을 한국어 시스템 프롬프트에 넣은 단일 메시지(싱글턴) 호출이고, 대화 히스토리는 유지하지 않는다. 호출이 실패해도 빈 문자열을 돌려주는 fail-safe라 관리자의 수동 답변 작성을 막지 않는다. API 키는 다른 AI 모듈과 독립된 별도 키(`API_KEY` 자리표시자)로 분리돼 있다.

### (4) SSE 실시간 알림 (ADR 계열·인터셉터 결합)

`NotificationSseService`가 `SseEmitter` 기반으로 서버 푸시를 구현한다. 한 유저가 여러 탭을 열 수 있으므로 `userIdx → List<SseEmitter>`로 관리하고, 30분 타임아웃 후 브라우저 EventSource가 자동 재연결한다. 프록시·방화벽의 idle timeout을 피하려고 30초 주기 하트비트(주석 라인)를 보낸다. 핵심은 **DB 저장 후 푸시**라는 순서다. 알림을 먼저 영구 저장하고 그다음 SSE로 밀기 때문에, 푸시가 실패하거나 유저가 오프라인이어도 알림이 사라지지 않는 안전망이 된다.

### (5) 알림 인터셉터 + 마이페이지 크로스모듈 집계

NotificationInterceptor가 모든 페이지 렌더링 시 안읽음 알림 수를 모델에 주입해 헤더 배지를 항상 최신으로 유지한다. 알림 클릭 시 이동 경로는 `targetUrl`(contextPath 제외 상대경로)로 저장하고, `NotificationUrlBuilder`가 출처별 URL을 만든다. 마이페이지는 `MyPageMapper`의 여러 select(커뮤니티·문의·신고·리뷰·일정·항공권·패키지·레벨리워드)를 모아 한 화면에 보여준다.

## 4. 동작 원리 — 문의 한 건의 일생

작성부터 답변·알림·정리까지 문의 한 건이 거치는 흐름이다.

```text
작성 요청 (POST /inquiry/write)
  → 로그인 체크(미로그인 401)
  → 작성 빈도 제한 초과 시 429
  → INQUIRY_POST INSERT (status=PENDING)
  → Perspective 독성 비동기 평가 → 임계 초과면 ai_flagged 세팅
운영진 답변 (POST /inquiry/{id}/answer)
  → @RequireAdmin 권한 검증(비관리자 403)
  → (선택) /ai-draft 로 Claude Haiku 초안 받아 편집
  → INQUIRY_ANSWER INSERT, status 전이
  → FeedNotificationDto 생성 → myPageService.addNotification
  → DB 저장 후 SSE 푸시 → 마이페이지/헤더 배지 갱신
유저 후속 (취소/완료/삭제요청/공개전환)
  → 본인 여부 403, 상태 가드 위반 400
  → updateStatusWithTime 으로 상태 전이 + 시각 기록
관리자 수락
  → delete-approve / visibility-approve
  → 삭제는 status 기반 소프트삭제(ADR-0008)
답변 수정 시
  → 수정 전 본문을 INQUIRY_ANSWER_HISTORY 에 보존(변경 추적)
```

답변 수정 이력을 별도 테이블에 남기는 점이 특징이다. 관리자가 답변을 고치면 이전 내용·수정자·시각이 `INQUIRY_ANSWER_HISTORY`에 쌓여, 운영 책임 추적이 가능하다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 문의 다단계 상태머신(전이 가드 포함) | 구현됨 |
| 유저↔관리자 양방향 요청·수락 워크플로우 | 구현됨 |
| Claude Haiku AI 답변 초안(fail-safe) | 구현됨 |
| Perspective 독성 비동기 평가 + ai_flagged | 구현됨 |
| 답변 수정 이력 보존(INQUIRY_ANSWER_HISTORY) | 구현됨 |
| 첨부파일(INQUIRY_ATTACHMENT) | 구현됨 |
| SSE 실시간 알림(다중 탭·하트비트·DB 후 푸시) | 구현됨 |
| 알림 인터셉터 안읽음 배지 주입 | 구현됨 |
| 마이페이지 크로스모듈 집계 | 구현됨 |
| AI 답변 초안 품질 정량 평가 | 미구현(향후 과제) |
| 모바일 반응형 알림 UI | 미구현(JSP 데스크톱 위주) |

핵심 운영 흐름은 대부분 동작한다. AI 초안 품질의 정량 평가 부재와 데스크톱 위주 레이아웃이 알려진 한계다.

## 6. 권장 학습 순서

이 도메인을 처음 본다면 아래 순서로 읽기를 권한다.

1. **문의 상태머신** — PENDING부터 각 전이와 상태 가드, HTTP 코드 분리 → [문의 상태머신](/inquiry/inquiry-statemachine)
2. **AI 답변 초안(Claude)** — 싱글턴 호출, fail-safe, 키 분리 → [AI 답변 초안(Claude)](/inquiry/ai-draft-claude)
3. **첨부·비공개 워크플로우** — 첨부 저장과 공개·비공개 요청·수락 → [첨부·비공개 워크플로우](/inquiry/attachments-visibility)
4. **SSE 실시간 알림** — SseEmitter, 다중 탭, 하트비트, DB 후 푸시 → [SSE 실시간 알림](/inquiry/sse-notification)
5. **알림 인터셉터·토스트** — 안읽음 배지 주입과 targetUrl → [알림 인터셉터·토스트](/inquiry/notification-interceptor)
6. **마이페이지 피드·크로스모듈** — addNotification 공용화와 집계 → [마이페이지 피드·크로스모듈](/inquiry/mypage-feed)
7. **면접 플레이북** — 도메인 전체 질의응답 정리 → [면접 플레이북](/inquiry/interview-playbook)

허브 링크: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 7. 단골 면접 질문 5개

이 도메인을 설명할 때 거의 항상 나오는 질문이다. 각 답의 핵심만 적었다.

1. **문의 상태를 왜 단순 처리완료 하나로 안 두고 여러 단계로 나눴나?**
   고객센터는 운영 추적성이 핵심이라 PENDING·IN_PROGRESS·COMPLETED·CANCELLED·DELETE_REQUESTED 같은 단계를 둔다. 각 전이를 상태 가드로 막아 잘못된 흐름은 HTTP 400으로 거절하고, 유저 행동과 관리자 행동을 분리해 누가 무엇을 했는지 남긴다.

2. **유저가 직접 삭제하지 않고 삭제요청을 거치게 한 이유는?**
   답변까지 끝난 문의를 유저가 임의로 지우면 운영 기록이 사라진다. 그래서 유저는 DELETE_REQUESTED로 요청만 하고 관리자 수락으로 실제 삭제(소프트삭제, ADR-0008)가 일어나는 양방향 워크플로우로 설계했다.

3. **AI 답변 초안이 실패하면 어떻게 되나?**
   `InquiryAiService`는 호출 실패 시 빈 문자열을 반환하는 fail-safe 구조다. 초안은 관리자의 보조일 뿐이라 AI가 죽어도 수동 답변 작성을 막지 않는다. 키도 다른 AI 모듈과 독립된 별도 키로 분리해 장애 격리를 했다.

4. **실시간 알림을 폴링 대신 SSE로 구현한 이유와 다중 탭 처리는?**
   서버에서 사용자로 단방향 푸시만 필요해 WebSocket보다 가벼운 SSE를 택했다. 한 유저가 여러 탭을 열 수 있어 `userIdx → List<SseEmitter>`로 관리하고, 끊긴 emitter는 콜백으로 제거하며 30초 하트비트로 idle timeout을 피한다.

5. **푸시가 실패하면 알림을 잃지 않나?**
   잃지 않는다. 알림은 먼저 DB에 저장하고 그다음 SSE로 푸시한다. 유저가 오프라인이거나 푸시가 실패해도 저장된 알림은 남아, 다음 접속 시 인터셉터가 안읽음 배지로 보여준다. DB 저장이 안전망이다.

## 8. 직접 말해보기

다음 문장을 막힘없이 1분 안에 말할 수 있으면 이 도메인을 이해한 것이다.

- "TripTogether 문의는 단순 게시판이 아니라 PENDING부터 시작하는 다단계 상태머신입니다. 수정·삭제·취소·삭제요청·공개전환마다 상태 가드가 있고, 유저 요청과 관리자 수락이 분리된 양방향 워크플로우입니다."
- "관리자 답변은 Claude Haiku 초안으로 시작할 수 있는데, 실패해도 빈 문자열을 돌려주는 fail-safe라 수동 작성을 막지 않습니다. 키도 다른 AI 모듈과 분리했습니다."
- "알림은 DB에 먼저 저장하고 SSE로 푸시합니다. 다중 탭은 userIdx 대 List 매핑으로 관리하고, 인터셉터가 모든 페이지에 안읽음 배지를 주입합니다. 푸시가 실패해도 알림은 살아 있습니다."

## 퀴즈

<QuizBox question="TripTogether 문의 도메인에서 유저가 답변 완료된 문의를 없애려 할 때 일어나는 흐름으로 가장 정확한 것은?" :choices="['유저가 즉시 INQUIRY_POST 행을 물리적으로 삭제한다', '유저는 DELETE_REQUESTED 상태로 삭제요청만 하고 관리자 수락 후에 소프트삭제된다', '관리자만 삭제요청 버튼을 누를 수 있다', '문의는 어떤 경우에도 삭제되지 않는다']" :answer="1" explanation="운영 추적성을 위해 유저는 삭제요청(DELETE_REQUESTED)만 보내고, 관리자가 delete-approve로 수락해야 status 기반 소프트삭제가 일어나는 양방향 워크플로우입니다." />

<QuizBox question="실시간 알림을 SseEmitter로 구현할 때 한 유저가 여러 탭을 열어도 모든 탭에 알림이 가도록 한 설계는?" :choices="['userIdx 하나당 SseEmitter 하나만 저장한다', 'userIdx를 키로 List 형태의 여러 SseEmitter를 관리한다', '세션 ID로만 구분하고 탭은 구분하지 않는다', '탭마다 별도 서버 인스턴스를 띄운다']" :answer="1" explanation="NotificationSseService는 userIdx에서 List of SseEmitter로 매핑해 한 유저의 모든 탭에 푸시하고, 끊긴 emitter는 완료 콜백으로 리스트에서 제거합니다." />

<QuizBox question="문의 답변 AI 초안 호출이 실패했을 때 InquiryAiService가 빈 문자열을 반환하도록 설계한 주된 이유는 무엇인가요?" explanation="AI 초안은 관리자의 보조 수단일 뿐 답변의 전제 조건이 아닙니다. 그래서 외부 AI 호출이 실패해도 예외로 흐름을 막지 않고 빈 문자열을 돌려주는 fail-safe로 두어, 관리자가 언제든 수동으로 답변을 작성할 수 있게 합니다. 키도 다른 모듈과 분리해 장애를 격리했습니다." />
