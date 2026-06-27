# 사용자 여정 (탐색 → 계획 → 예약 → 공유)

> 한 명의 사용자가 가입부터 여행 후기 공유까지 이동하는 전체 동선과, 각 단계가 어느 도메인·어느 기술로 구현됐는지를 한 장에 잇는다.

TripTogether는 기능 단위가 아니라 **여행 한 번의 라이프사이클**을 따라 설계됐다. 탐색에서 시작해 코스를 만들고, 결제로 예약하고, 후기를 커뮤니티에 공유한다. 4명이 도메인을 나눠 만들었기 때문에 한 여정은 여러 도메인을 가로지른다. 이 페이지는 그 가로지름을 단계별로 추적해, 면접에서 프로젝트 전체를 하나의 흐름으로 설명할 수 있게 한다.

도메인 단위로 더 깊게 보려면 [도메인 전체 개요](/domains), 담당 묶음으로 보려면 [담당별 보기](/by-area/), 시스템 경계 전체는 [전체 흐름](/flow/)을 본다.

## 1. 한 줄 정의

사용자 여정은 **회원가입·로그인 → 여행지 탐색(추천) → 코스 계획(직접/AI) → 항공권·패키지 예약(결제) → 커뮤니티 공유 → AI 도우미 상담**으로 이어지는 6단계 동선이며, 각 단계는 독립 도메인 모듈로 구현되고 세션·알림·리워드가 단계를 가로질러 연결한다.

## 2. 왜 이렇게 설계했나

- **여행 한 번의 라이프사이클이 곧 정보 구조다.** 메뉴를 기능별로 나열하지 않고 탐색→계획→예약→공유 순서로 배치하면, 사용자는 다음에 무엇을 할지 안내받는다. 탐색에서 찜한 여행지가 코스 계획의 후보가 되고, 코스가 패키지 예약과 후기 공유로 자연스럽게 이어진다.
- **도메인 경계는 명확히, 연결은 얇게.** 각 단계는 독립 모듈(auth, explore, courses, commerce, community, assistant)로 분리해 4인이 병렬 개발했다. 단계 사이는 세션의 `loginUser`, 알림(SSE), 리워드 적립처럼 **공통 인프라**로만 느슨하게 연결한다. 한 도메인이 다른 도메인의 내부를 직접 호출하지 않고, 알림은 크로스모듈 진입점(myPageService.addNotification) 하나로 모은다.
- **여정 전체에 일관된 규약을 깐다.** 인증(세션 + AOP), 소프트삭제(status 컬럼), i18n(4개국어), 응답 포맷을 단계마다 다시 만들지 않고 공통 규약으로 통일했다. 그래서 어느 단계든 같은 방식으로 권한을 검사하고 같은 방식으로 삭제·번역된다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 단계 | 핵심 도메인 모듈 | 대표 클래스 | 대표 테이블 |
| --- | --- | --- | --- |
| 가입·로그인 | auth, common | AuthController, AuthorizationAspect, LoginUserArgumentResolver | UsersVO 기반 계정 테이블 |
| 탐색·추천 | explore, detail | ExploreServiceImpl, RecommendService | SPOT, SPOT_REVIEW, SPOT_FAVORITE, SPOT_LIKE, SPOT_VIEW_LOG |
| 코스 계획 | courses | TravelPlanServiceImpl, AiPlanServiceImpl | TRAVEL_PLAN, plan_spot |
| 예약·결제 | commerce(flight, travelPackage, shop, reward) | MockFlightOfferProvider, FlightOfferProvider | TRAVEL_PACKAGE, TRAVEL_PACKAGE_BOOKING, USER_WALLET_HISTORY, WALLET_REFUND_LOG |
| 공유 | community, report | 게시글·댓글·태그 서비스 | 커뮤니티 게시글/댓글, AD_CAMPAIGN |
| 상담 | assistant, common | AssistantServiceImpl, ChatbotService | CHAT_POST, CHAT_COMMENT |

가로지르는 공통 인프라:

- **인증·세션**: 세션 속성 `loginUser`(UsersVO), `@RequireLogin`/`@RequireAdmin`(AuthorizationAspect), `@LoginUser`(LoginUserArgumentResolver 자동 주입). 자세히는 [인증·세션 흐름](/flow/auth-session-flow).
- **알림**: SseEmitter 서버 푸시 + NotificationInterceptor가 모든 페이지에 미확인 수 주입, MYPAGE_FEED_NOTIFICATION 저장. 자세히는 [알림 SSE 흐름](/flow/notification-sse-flow).
- **리워드**: 단계별 활동이 포인트·경험치로 적립되어 레벨 자동 승급(EXP_LEVEL_POLICY), 3원 지갑(캐시·마일리지·포인트, USER_WALLET_HISTORY).
- **AI 통합**: 단계마다 다른 모델을 쓴다(추천=Gemini 2.5 Flash, AI 일정=GPT-4o-mini, 상담=GPT-4o-mini, 챗봇=Gemini, 문의 초안=Claude Haiku). 자세히는 [AI 통합 맵](/flow/ai-integration-map).

## 4. 동작 원리 (단계별 흐름)

### 단계 0 — 가입·로그인 (auth)

이메일 인증 또는 소셜 로그인(Kakao/Naver/Google)으로 진입한다. 비밀번호는 BCryptPasswordEncoder로 해싱하고, 로그인 시 LoginRiskAssessmentProvider가 위험도를 평가한다. 성공하면 세션에 `loginUser`(UsersVO)가 올라가고, 이후 모든 단계의 권한 검사는 이 세션 속성을 기준으로 한다.

- 더 보기: [로그인·세션](/auth/login-session), [OAuth 소셜 로그인](/auth/oauth-social), [로그인 위험도 평가](/auth/login-risk-assessment)

### 단계 1 — 여행지 탐색·추천 (explore + detail)

7탭 필터로 여행지(SPOT)를 탐색한다. 개인화 추천은 최근 30건 체류 로그(SPOT_VIEW_LOG)와 태그 선호를 분석해 **3단 폴백**으로 만든다.

```text
추천 요청
  → DB 캐시 적중?  → 즉시 반환
  → 미적중         → Gemini 2.5 Flash 호출 → 결과 반환·캐싱
  → 호출 실패      → 트렌딩(인기순) 폴백   → 항상 무언가는 반환
```

마음에 든 여행지는 찜(SPOT_FAVORITE)·좋아요(SPOT_LIKE)로 저장해 다음 단계의 코스 후보로 넘긴다.

- 더 보기: [탐색 필터](/explore/explore-filters), [AI 추천(Gemini)](/explore/ai-recommendation-gemini), [추천 캐시·폴백](/explore/recommendation-cache-fallback)

### 단계 2 — 코스 계획: 직접 또는 AI (courses)

코스(TRAVEL_PLAN)는 두 경로로 만든다.

- **직접 작성(plan_source = MANUAL)**: 스팟을 골라 plan_spot에 담고 visit_order로 방문 순서를 관리한다.
- **AI 일정(AiPlanServiceImpl)**: GPT-4o-mini의 Structured Outputs(JSON Schema, strict = true)로 일정을 받는다. 응답은 `AiPlanResponseDTO`(title, summary, days)로 역직렬화되고, days는 `AiDayDTO` → `AiSpotDTO`(visitOrder)로 펼쳐진다. 저장은 `@Transactional`이라 중간 실패 시 전부 롤백된다.

완성된 코스는 is_public으로 공개 피드에 노출할 수 있고, 비공개 코스는 isOwner 가드로 본인만 접근한다.

- 더 보기: [직접 일정 작성](/courses/manual-plan), [AI 일정 생성(GPT)](/courses/ai-plan-gpt), [구조화 출력(JSON Schema)](/courses/structured-outputs), [공개 코스 피드](/courses/public-feed)

### 단계 3 — 예약·결제 (flight + travelPackage + reward/shop)

- **항공권**: 외부 항공 API 대신 추상 인터페이스 `FlightOfferProvider` 뒤에 `MockFlightOfferProvider`를 둔다. 인터페이스 경계는 그대로라, 실제 프로바이더로 교체해도 호출부는 바뀌지 않는다.
- **패키지 마켓플레이스**: 판매자(SELLER)가 등록한 패키지(TRAVEL_PACKAGE)가 관리자 승인 상태머신(DRAFT → PENDING → APPROVED)을 거쳐 공개되고, 구매는 TRAVEL_PACKAGE_BOOKING으로 기록된다.
- **결제·지갑**: Toss Payments로 충전·결제하며, 3원 지갑(캐시·마일리지·포인트)을 혼합 결제한다. 모든 잔액 변동은 USER_WALLET_HISTORY에 남고, 환불은 WALLET_REFUND_LOG로 추적한다.

- 더 보기: [항공권(Mock 프로바이더)](/explore/flight-mock), [패키지 마켓플레이스](/explore/package-marketplace), [Toss 결제](/explore/toss-payments), [3원 지갑](/explore/three-wallet)

### 단계 4 — 커뮤니티 공유 (community + report)

여행 후기를 게시글 유형(review/photo/tip/question)으로 올린다. 댓글·대댓글(parent_comment_id)과 질문 채택, 좋아요(like_count 캐시), 태그 공출현(co_count)으로 글을 잇는다. 이미지는 Cloudinary 업로드 + Pixabay 24시간 캐싱 폴백을 쓴다. 부적절 콘텐츠는 신고(sourceType/sourceId 상태머신)와 ai_flagged, 3-스트라이크 누적 블러로 다룬다.

- 더 보기: [게시글 유형](/community/post-types), [좋아요·태그](/community/likes-tags), [신고 상태머신](/community/report-system)

### 단계 5 — AI 도우미 상담 (assistant + common)

여정 어디서든 두 종류의 AI가 돕는다.

| 도우미 | 모델 | 역할 | 저장 |
| --- | --- | --- | --- |
| 여행 어시스턴트 | GPT-4o-mini | 멀티턴 여행 상담(MAX_HISTORY = 20, 다국어 시스템 프롬프트) | CHAT_POST, CHAT_COMMENT 2계층(DB + 세션) |
| 사이트 네비 챗봇 | Gemini 2.5 Flash | 구조화 JSON(message, links, quickReplies, inappropriate)으로 사이트 안내 | 등급 쿼터·차단 로그 |

챗봇은 단순 네비게이션이면 fast-path로 LLM을 생략하고, 링크는 URL 화이트리스트로 검증해 위험 스킴을 차단한다.

- 더 보기: [멀티턴 어시스턴트(GPT)](/assistant/multiturn-gpt), [네비 챗봇(Gemini)](/assistant/chatbot-gemini), [의도 분류·Fast-Path](/assistant/intent-fastpath)

### 단계를 잇는 두 가닥

| 가닥 | 어떻게 잇나 |
| --- | --- |
| 알림(SSE) | 댓글·채택·신고 처리 등 이벤트가 MYPAGE_FEED_NOTIFICATION에 쌓이고 SseEmitter로 즉시 푸시, NotificationInterceptor가 모든 페이지에 미확인 수 주입 |
| 리워드 | 가입·작성·구매 등 활동이 포인트·경험치로 적립되어 레벨 자동 승급, 지갑 잔액(캐시·마일리지·포인트) 갱신 |

## 5. 구현 상태 (됨 vs Mock/계획)

| 단계 | 상태 |
| --- | --- |
| 가입·로그인(이메일·소셜·위험평가) | 구현됨 |
| 탐색·추천(Gemini 3단 폴백) | 구현됨 |
| 코스 계획(직접 + AI 일정) | 구현됨 |
| 패키지 예약·Toss 결제·3원 지갑·환불 | 구현됨 |
| 커뮤니티 공유·신고·모더레이션 | 구현됨 |
| AI 어시스턴트·네비 챗봇 | 구현됨 |
| **항공권 예약** | **Mock 프로바이더** — FlightOfferProvider 추상화는 완성, 실제 외부 항공 API 미연동 |
| AI 응답 품질 정량 평가 | 미구현(향후 과제) |
| 모바일 반응형·SPA | 미구현 — JSP 데스크톱 위주 레이아웃, 향후 과제 |

:::warning 정직하게 구분
"항공권 예약까지 결제가 완성됐다"고 말하면 과장이다. 정확히는 **결제·지갑·환불은 실제로 동작하고, 항공권 오퍼만 Mock 프로바이더로 채웠으며 인터페이스 경계가 교체 가능하도록 설계됐다**고 말한다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: "TripTogether는 여행 한 번의 라이프사이클을 따라 탐색→계획→예약→공유로 동선을 설계한 국내 여행 올인원 플랫폼입니다."
2. **구조**: "각 단계는 독립 도메인 모듈로 분리해 4명이 병렬 개발했고, 단계 사이는 세션 인증·SSE 알림·리워드 적립 같은 공통 인프라로만 느슨하게 연결했습니다. AI는 단계마다 가장 맞는 모델을 골라 썼습니다 — 추천은 Gemini, AI 일정과 상담은 GPT, 문의 초안은 Claude."
3. **트레이드오프**: "결제·지갑은 실제로 동작하지만 항공권 오퍼는 Mock 프로바이더로 채웠습니다. 외부 항공 API 키 없이도 전체 흐름을 끝까지 시연할 수 있게 인터페이스를 추상화했고, 실제 프로바이더로 교체해도 호출부는 안 바뀝니다."

## 7. 꼬리질문 + 모범답안

:::details 단계 사이는 어떻게 연결되나요? 강결합 아닌가요?
도메인끼리 내부 메서드를 직접 호출하지 않습니다. 연결은 세 가지 공통 인프라로만 합니다 — 세션의 loginUser로 누구인지 알고, 알림은 크로스모듈 진입점 하나(myPageService.addNotification)로 모아 SSE로 푸시하고, 활동 결과는 리워드로 적립됩니다. 그래서 한 도메인을 바꿔도 다른 도메인 코드를 건드리지 않습니다.
:::

:::details 추천이 항상 결과를 주나요? AI가 죽으면요?
3단 폴백이라 항상 무언가는 반환합니다. DB 캐시가 있으면 즉시 주고, 없으면 Gemini를 호출하고, Gemini가 실패하면 트렌딩(인기순)으로 떨어집니다. 사용자 화면은 AI 가용성과 무관하게 비지 않습니다.
:::

:::details AI 일정이 깨진 JSON을 주면 어떻게 막나요?
GPT-4o-mini의 Structured Outputs를 strict = true JSON Schema로 강제해, 모델이 스키마 밖 형태를 만들지 못하게 합니다. 응답은 AiPlanResponseDTO로 역직렬화되고 저장은 @Transactional이라, 일부 스팟만 들어가다 실패하면 전부 롤백돼 반쪽 코스가 남지 않습니다.
:::

:::details 항공권이 Mock이면 결제도 가짜인가요?
아닙니다. 항공권 오퍼 데이터만 Mock 프로바이더가 만들고, 결제 단계는 Toss Payments와 3원 지갑으로 실제 동작합니다. 잔액 변동은 USER_WALLET_HISTORY에, 환불은 WALLET_REFUND_LOG에 남습니다. 오퍼 소스만 FlightOfferProvider 인터페이스 뒤에서 교체 가능하게 분리했습니다.
:::

:::details 왜 AI 모델을 하나로 통일하지 않았나요?
작업 성격이 다르기 때문입니다. 사이트 네비 챗봇과 개인화 추천은 Gemini의 구조화 JSON에, 멀티턴 상담과 일정 생성은 GPT의 Structured Outputs에, 문의 답변 초안은 Claude에 맡겼습니다. 모델별 강점에 맞춰 배치했고, 모든 외부 호출은 OkHttp로 통일해 호출 계층은 일관됩니다.
:::

## 8. 직접 말해보기

- TripTogether의 사용자 여정 6단계를 순서대로, 각 단계가 어느 도메인인지 붙여 말해보기
- 탐색에서 찜한 여행지가 어떻게 코스 계획과 공유로 이어지는지, 데이터가 어느 테이블을 거치는지 설명하기
- "결제가 다 되나요?"라는 질문에 항공권 Mock과 실제 결제·환불을 구분해 30초로 답하기
- 단계 사이를 잇는 세 가닥(세션·SSE 알림·리워드)을 들어 강결합이 아님을 설명하기

## 퀴즈

<QuizBox question="TripTogether 사용자 여정의 핵심 순서로 가장 알맞은 것은?" :choices="['예약 → 탐색 → 계획 → 공유','탐색 → 계획 → 예약 → 공유','공유 → 예약 → 계획 → 탐색','계획 → 탐색 → 공유 → 예약']" :answer="1" explanation="여행 한 번의 라이프사이클을 따라 탐색(여행지 발견) → 계획(코스 작성) → 예약(결제) → 공유(커뮤니티) 순으로 설계됐다." />

<QuizBox question="여행지 추천(explore)의 3단 폴백 순서로 옳은 것은?" :choices="['Gemini 호출 → DB 캐시 → 트렌딩','DB 캐시 → Gemini 호출 → 트렌딩','트렌딩 → DB 캐시 → Gemini 호출','DB 캐시 → 트렌딩 → Gemini 호출']" :answer="1" explanation="DB 캐시가 있으면 즉시 반환, 없으면 Gemini 2.5 Flash 호출, 호출이 실패하면 트렌딩(인기순)으로 폴백해 화면이 비지 않게 한다." />

<QuizBox question="항공권 예약 단계의 실제 구현 상태로 정확한 것은?" :choices="['외부 항공 API와 실제 연동되어 있다','FlightOfferProvider 인터페이스 뒤의 Mock 프로바이더로 채워져 있고 결제·환불은 실제 동작한다','항공권과 결제 모두 Mock이라 동작하지 않는다','항공권만 동작하고 결제는 미구현이다']" :answer="1" explanation="항공권 오퍼는 MockFlightOfferProvider가 만들지만 인터페이스 경계는 완성되어 교체 가능하고, Toss 결제와 3원 지갑·환불(WALLET_REFUND_LOG)은 실제로 동작한다." />
