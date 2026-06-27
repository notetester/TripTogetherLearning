# 흐름 개요

> TripTogether는 14~15개 모듈을 4명이 도메인으로 나눠 만든 **국내 여행 올인원 플랫폼**(탐색 → 계획 → 예약 → 공유)이다. 이 페이지는 흩어진 도메인을 한 장에 잇고, "프로젝트 전체를 설명해 보세요"라는 면접 질문에 답할 진입점이다.

도메인 하나하나는 [도메인 전체 개요](/domains)에서 들어가고, 담당 라벨로 필터링하려면 [담당별 보기](/by-area/)로 간다. 이 흐름 섹션은 **모듈 사이의 연결선**, 즉 한 요청이 컨트롤러에서 시작해 어떤 계층과 외부 API와 DB를 거쳐 다시 화면으로 돌아오는지를 다룬다.

## 1. 한 장으로 보는 그림

TripTogether는 하나의 Spring Boot 애플리케이션(WAR, embedded Tomcat, context-path `/TripTogether`)이다. 화면은 JSP(JSTL/EL)로 서버 렌더링하고, 영속성은 MyBatis로 MySQL에 붙고, 지능형 기능은 도메인별로 서로 다른 외부 AI API에 위임한다.

```text
브라우저(JSP 화면, ?lang=ko/en/ja/zh)
   │  HTTP
   ▼
인터셉터 체인  locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification
   │
   ▼
Controller ──► Service(인터페이스 + ServiceImpl) ──► Mapper(@Mapper + XML) ──► MySQL
                     │                                            ▲
                     │ 외부 위임                                   │ 소프트삭제 status 컬럼
                     ▼                                            │
            AI/HTTP (OkHttp · RestTemplate)            Cloudinary 이미지 · 메일 · WAF
            GPT-4o-mini · Gemini 2.5 Flash · Claude Haiku · Perspective · Google 번역
```

가로축은 **계층**(controller → service → mapper → vo), 세로축은 **횡단 관심사**(인증·로깅·알림·국제화는 인터셉터/AOP로 모든 도메인에 공통 적용)다. 이 두 축이 14~15개 모듈을 같은 골격으로 묶는다.

## 2. 도메인이 어떻게 연결되나

도메인은 독립 모듈이지만 **사용자 한 명의 여정** 위에서 서로 호출한다.

| 단계 | 주요 도메인 | 대표 테이블 | 핵심 동작 |
| --- | --- | --- | --- |
| 탐색 | explore / detail | SPOT_TRAVEL · SPOT_REVIEW · SPOT_FAVORITE · SPOT_VIEW_LOG | 여행지 필터·리뷰·찜, Gemini 개인화 추천 3건 |
| 계획 | courses | TRAVEL_PLAN · plan_spot | 직접 일정 작성 또는 GPT 자동 일정(구조화 JSON) |
| 예약·결제 | commerce(flight·travelPackage·reward·shop) | FLIGHT_PURCHASE_SIMULATION · TRAVEL_PACKAGE · WALLET_REFUND_LOG · USER_WALLET_HISTORY | 항공권(Mock)·패키지 예약, Toss 충전, 3원 지갑 |
| 공유 | community | COMMUNITY_POST · COMMUNITY_COMMENT · COMMUNITY_TAG | 후기·사진·팁·질문 글, 댓글·태그·좋아요 |
| 도움 | assistant / common | CHAT_POST · CHATBOT_CONVERSATION | 멀티턴 여행 도우미(GPT), 사이트 네비 챗봇(Gemini) |
| 보호·운영 | auth · report · moderation · admin · superAdmin | USERS · REPORT · ADMIN_ACTION_AUDIT | 로그인·신고·독성 감지·감사 로그·정책 |
| 알림 | myPage / notification | MYPAGE_FEED_NOTIFICATION | SSE 실시간 푸시, 크로스모듈 알림 적재 |

연결의 핵심은 **크로스모듈 알림**이다. 예를 들어 신고가 처리되거나(report) 질문에 댓글이 달리면(community), 해당 도메인이 `myPageService.addNotification`을 호출해 `MYPAGE_FEED_NOTIFICATION`에 적재하고, `NotificationSseService`가 접속 중인 사용자에게 SSE로 즉시 푸시한다. 도메인은 분리돼 있어도 알림이라는 **공용 채널**로 느슨하게 묶인다.

## 3. 공통 골격 (모든 도메인이 따르는 규칙)

모듈이 많아도 패턴이 같아서 한 도메인을 이해하면 나머지가 빠르게 읽힌다.

- **4계층**: `controller → service(인터페이스+ServiceImpl) → mapper(@Mapper + resources/mapper/*.xml) → vo`. JPA 없이 MyBatis만 사용.
- **세션 인증**: 로그인 시 세션 속성 `loginUser`에 `UsersVO`를 저장. AOP `@RequireLogin`/`@RequireAdmin`(`AuthorizationAspect`)으로 권한을 가로채고, `@LoginUser`(`LoginUserArgumentResolver`)로 컨트롤러에 현재 사용자를 자동 주입(ADR-0011).
- **소프트 삭제**: 행을 실제로 지우지 않고 status 컬럼(account_status / post_status / comment_status, is_deleted)으로 표시(ADR-0008). 조회 시 활성 상태만 거른다.
- **응답·예외**: `GlobalExceptionHandler`가 예외를 HTTP 상태코드(401/403/404/409 등)로 정규화. i18n 메시지로 사용자에게 전달(ADR-0013).
- **국제화**: 4개국어(ko/en/ja/zh). `SessionLocaleResolver` + `LocaleChangeInterceptor`(`?lang=`)로 전환, `MessageSource`로 메시지 해석.
- **보안 정화**: 본문은 jsoup로 XSS 정화(ADR-0005), 비밀번호는 BCrypt 해싱, AI가 돌려준 링크 URL은 화이트리스트로 거른다.

:::tip 한 문장 요약
**한 요청은 인터셉터 체인을 통과해 컨트롤러로 들어가고, 서비스가 비즈니스 규칙과 외부 AI 호출을 맡고, 매퍼가 MySQL을 다루며, 결과는 JSP로 렌더되거나 알림으로 다른 도메인에 전파된다.**
:::

## 4. AI가 흐름에 끼어드는 지점

AI는 별도 시스템이 아니라 각 도메인 서비스 안에서 호출되는 **외부 위임**이다. 모델이 달라도 골격은 같다 — 컨텍스트를 모아 프롬프트를 만들고, 호출하고, 출력을 검증·저장하고, 실패하면 폴백한다.

| 끼어드는 곳 | 모델 | 담당 클래스 | 실패 시 |
| --- | --- | --- | --- |
| 멀티턴 도우미 | GPT-4o-mini | AssistantServiceImpl | 사용자에게 오류 안내 |
| AI 일정 생성 | GPT-4o-mini(JSON Schema strict) | AiPlanServiceImpl | 트랜잭션 롤백 |
| 네비 챗봇 | Gemini 2.5 Flash | ChatbotService | 폴백 응답 |
| 개인화 추천 | Gemini 2.5 Flash | RecommendService | 트렌딩 폴백 |
| 문의 답변 초안 | Claude Haiku | InquiryAiService | 빈 문자열 |
| 독성 감지 | Perspective API | PerspectiveService | false(통과) |

핵심 원칙은 **AI 출력을 입력처럼 의심한다**는 것이다. 추천 spot_idx는 후보 집합에 있는지 다시 확인하고, 챗봇 링크는 위험 스킴(javascript:/data:/file:)을 차단하며 경로 순회를 막는다. AI 장애가 글쓰기·답변·탐색 같은 핵심 기능을 멈추지 않게 거의 모든 호출이 fail-safe다. 상세는 [AI 통합 맵](/flow/ai-integration-map)과 [AI 기능 전체](/ai/).

## 5. 권장 학습 순서

흐름을 읽는 순서는 **큰 그림 → 사용자 동선 → 횡단 관심사 → 데이터 → 면접 정리**다.

1. [전체 아키텍처](/flow/architecture) — Spring Boot REST/JSP + MyBatis/MySQL + 다중 AI API의 전체 구조
2. [사용자 여정](/flow/user-journey) — 탐색 → 계획 → 예약 → 공유 한 사이클을 따라가며 도메인 호출 추적
3. [인증·세션 흐름](/flow/auth-session-flow) — 인터셉터·AOP·@LoginUser가 모든 요청을 어떻게 감싸는지
4. [AI 통합 맵](/flow/ai-integration-map) — 5종 외부 AI가 어느 도메인에서 무엇을 하는지
5. [알림 SSE 흐름](/flow/notification-sse-flow) — 크로스모듈 알림과 서버 푸시
6. [모더레이션·거버넌스](/flow/moderation-governance) — 신고·독성·관리자 승인·감사 로그의 운영 흐름
7. [데이터 모델 전체](/flow/data-model) — 주요 테이블과 관계
8. [프로젝트 전체 면접 플레이북](/flow/interview-whole-project) — 한 번에 설명하는 대본

도메인을 깊이 파려면 언제든 [도메인 전체 개요](/domains)로, 담당 라벨로 좁히려면 [담당별 보기](/by-area/)로 가면 된다.

## 6. 프로젝트 전체 면접 단골 질문 5개

면접에서 가장 자주 나오는 "프로젝트 전체" 질문과 한 줄 방향이다. 자세한 대본은 [전체 면접 플레이북](/flow/interview-whole-project)에 있다.

1. **이 프로젝트를 한 문장으로 설명하면?**
   국내 여행을 탐색·계획·예약·공유까지 한 곳에서 처리하는 올인원 플랫폼이며, 4명이 14~15개 도메인을 수직 분담해 Spring Boot 단일 애플리케이션으로 구현했다.

2. **전체 아키텍처를 말해 보라.**
   Spring Boot 4 + Java 21, JSP 서버 렌더링(WAR/embedded Tomcat), MyBatis + MySQL, 4계층(controller → service → mapper → vo)이고, 인증·로깅·알림·국제화는 인터셉터 체인과 AOP로 횡단 적용한다. 지능형 기능은 도메인별로 GPT·Gemini·Claude·Perspective·Google 번역에 위임한다.

3. **본인이 가장 어렵게 풀었던 문제는?**
   외부 AI는 느리거나 죽을 수 있어서, 추천은 DB 캐시 → Gemini → 트렌딩 3단 폴백, 일정 생성은 구조화 JSON + 트랜잭션 롤백처럼 도메인마다 fail-safe와 출력 검증을 설계한 점.

4. **이 정도 규모를 4명이 어떻게 협업했나?**
   기능별 수직 분담으로 도메인을 나누되, 4계층·소프트 삭제·ApiResponse·AOP 권한 같은 공통 규칙과 ADR(MADR 0001~0014)로 설계 결정을 문서화해 일관성을 유지했다.

5. **아쉬운 점이나 향후 과제는?**
   항공권은 실제 외부 API 대신 Mock 프로바이더이고, AI 응답 품질의 정량 평가 체계와 모바일 반응형, Swagger 문서가 아직 없다.

## 7. 꼬리질문 + 모범답안

:::details 모듈이 14~15개나 되는데 결합이 너무 복잡하지 않나?
모든 모듈이 같은 4계층 골격과 공통 규칙(세션 인증, 소프트 삭제, AOP 권한)을 따르므로 한 도메인을 이해하면 나머지를 빠르게 읽을 수 있다. 모듈 간 직접 호출은 알림처럼 꼭 필요한 크로스모듈 지점으로 제한하고, 그조차 myPageService.addNotification 같은 공용 진입점 하나로 모은다.
:::

:::details JPA가 아니라 MyBatis를 쓴 이유는?
통계성 조회, 동적 필터(탐색 7탭), 카운터 캐시 갱신 등 SQL을 직접 제어할 일이 많아 매퍼 XML로 쿼리를 명시적으로 다루는 편이 유리했다. 영속성 규칙을 MyBatis로 통일해 팀 전체가 같은 패턴으로 작업했다.
:::

:::details JSP를 쓰면 요즘 트렌드와 안 맞지 않나?
서버 렌더링과 세션 인증, i18n 메시지 결합에는 JSP가 단순하고 빠르게 동작해 학습용 팀 프로젝트 범위에 적합했다. 다만 모바일 반응형과 SPA 분리는 향후 과제로 분명히 남겨 두었고, 정직하게 한계로 설명한다.
:::

:::details 외부 AI API 키나 장애는 어떻게 다루나?
키는 환경변수/런타임 설정(APPLICATION_RUNTIME_SETTING, is_secret)으로 주입하고 코드에 박지 않는다. 장애 대비로 거의 모든 AI 호출이 fail-safe라, 추천은 트렌딩, 챗봇은 폴백 응답, 문의 초안은 빈 문자열, 독성 검사는 통과로 떨어져 핵심 기능을 막지 않는다.
:::

:::details 데이터 정합성은 어디서 보장하나?
다중 행을 함께 쓰는 작업은 @Transactional로 묶는다. 대표적으로 AI 일정 생성은 TRAVEL_PLAN과 plan_spot을 한 트랜잭션에서 저장해 중간 실패 시 전부 롤백한다. 카운터(좋아요 등)는 캐시 컬럼과 재집계로 일관성을 맞춘다(ADR-0006).
:::

## 8. 직접 말해보기

아래 질문에 막힘 없이 답할 수 있으면 이 흐름 섹션을 충분히 소화한 것이다.

- TripTogether를 모르는 사람에게 30초 안에 무엇을 하는 서비스인지 설명해 보라.
- 사용자가 여행지를 검색해서 후기를 남기기까지, 요청이 거치는 계층과 횡단 관심사를 순서대로 말해 보라.
- AI가 끼어드는 6개 지점과 각각의 실패 폴백을 한 번에 나열해 보라.
- 도메인이 14~15개인데도 코드가 일관된 이유를 공통 규칙 3가지로 설명해 보라.
- 이 프로젝트에서 아직 구현되지 않은 부분(Mock·향후 과제) 3가지를 정직하게 말해 보라.

## 퀴즈

<QuizBox question="TripTogether에서 한 HTTP 요청이 컨트롤러에 닿기 전에 거치는 횡단 관심사 처리 방식으로 옳은 것은?" :choices="['모든 도메인이 각자 코드로 인증을 직접 구현한다', '인터셉터 체인과 AOP로 인증·로깅·알림·국제화를 공통 적용한다', 'JPA 엔티티 콜백으로 처리한다', '프런트엔드 SPA 라우터가 처리한다']" :answer="1" explanation="locale, ipBlock, activityLog, login, admin 등 인터셉터 체인과 AOP(AuthorizationAspect)가 모든 도메인에 공통으로 적용되는 횡단 관심사다." />

<QuizBox question="도메인 간 알림은 어떤 방식으로 전파되는가?" :choices="['각 도메인이 직접 SQL로 다른 도메인 테이블을 수정한다', '공용 진입점으로 MYPAGE_FEED_NOTIFICATION에 적재하고 SSE로 푸시한다', '주기적 폴링으로만 갱신된다', '이메일로만 전달된다']" :answer="1" explanation="report나 community 같은 도메인이 myPageService.addNotification으로 MYPAGE_FEED_NOTIFICATION에 적재하고, NotificationSseService가 접속 중 사용자에게 SSE로 즉시 푸시한다." />

<QuizBox question="외부 AI 호출에서 TripTogether가 일관되게 적용한 원칙으로 가장 적절한 것은?" :choices="['AI 응답을 항상 그대로 신뢰해 저장한다', 'AI가 죽으면 서비스 전체를 중단한다', 'fail-safe 폴백과 출력 검증으로 핵심 기능을 보호한다', 'AI 호출은 프런트엔드에서만 한다']" :answer="2" explanation="추천은 트렌딩 폴백, 챗봇은 폴백 응답, 문의 초안은 빈 문자열 등 거의 모든 AI 호출이 fail-safe이며, 추천 spot_idx 재검증과 링크 화이트리스트처럼 AI 출력을 입력처럼 검증한다." />
