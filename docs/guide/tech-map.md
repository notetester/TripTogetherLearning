# 기술 지도 — 기능에서 기술·파일·도메인으로

> 8개 도메인을 동등하게 한 장에 펼친 색인. "이 기능은 어떤 기술로, 어떤 클래스/테이블로 구현됐고, 더 깊게 보려면 어디로 가나"를 한 표에서 찾는다.

이 페이지는 **탐색용 지도**다. 깊은 설명은 각 도메인 심화 페이지에 있고, 여기서는 도메인마다 `담당 기능 → 핵심 기술 → 대표 클래스/테이블 → 심화 링크`만 압축해 보여준다. TripTogether는 4명이 도메인을 수직으로 나눠 만든 팀 프로젝트이며, 이 표는 누구의 영역인지가 아니라 **무엇이 어디에 있는지**를 기준으로 정리한다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [AI 전체](/ai/)

## 1. 한 줄 정의

기능 이름만 알 때, 그 기능을 떠받치는 기술 스택·실제 클래스·DB 테이블·심화 학습 경로를 한 번에 역추적하는 **도메인 × 기술 매핑 표**다.

## 2. 왜 이렇게 설계했나

- **면접에서는 "그 기능 어떻게 구현했어요?"가 기능 단위로 들어온다.** 코드 구조(controller/service/mapper/vo)가 아니라 기능에서 출발해 기술과 파일로 내려가는 색인이 필요하다.
- **14~15개 모듈이 8개 도메인으로 묶인다.** 모듈을 하나씩 외우는 대신, 도메인 단위로 "핵심 기술 1~2개 + 대표 테이블 1~2개"를 묶어두면 기억과 설명이 동시에 쉬워진다.
- **공통 인프라(세션 인증·AOP·인터셉터·i18n)는 모든 도메인이 공유한다.** 도메인마다 반복 설명하지 않도록 공통 축을 따로 떼어 맨 앞에 둔다.

## 3. 공통 인프라 (전 도메인 공유)

모든 도메인이 같은 4계층(`controller → service(인터페이스+ServiceImpl) → mapper(@Mapper + XML) → vo`)과 아래 공통 장치 위에 올라간다.

| 공통 축 | 핵심 기술 | 대표 클래스 | 동작 요약 |
| --- | --- | --- | --- |
| 인증 | 세션 기반 (`loginUser=UsersVO`) | `LoginInterceptor`, `LoginUserArgumentResolver` | 세션 속성으로 로그인 상태 유지, `@LoginUser`로 컨트롤러에 자동 주입 |
| 권한 | AOP | `AuthorizationAspect`, `@RequireLogin` / `@RequireAdmin` | 어노테이션 한 줄로 메서드 진입 전 권한 검사 |
| 인터셉터 체인 | Spring MVC 인터셉터 | `WebConfig#addInterceptors` | locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification 순 |
| 알림 주입 | 인터셉터 + SSE | `NotificationInterceptor` | 모든 페이지 모델에 unread 카운트 주입 |
| 다국어 | `MessageSource` + `SessionLocaleResolver` | `LocaleChangeInterceptor` | `?lang=` 으로 ko/en/ja/zh 전환 |
| 런타임 설정 | DB 우선 설정 | `RuntimeSettingService` | `APPLICATION_RUNTIME_SETTING` 값을 코드보다 우선 적용 |
| 예외 | 전역 핸들러 | `GlobalExceptionHandler` | 도메인 예외를 HTTP 상태코드로 일관 변환 |
| 보안 | BCrypt · jsoup · CSRF 부분 | `BCryptPasswordEncoder` | 비번 해싱, XSS 정화(ADR-0005), CSRF 부분 적용(ADR-0012) |

:::tip
공통 인프라는 [백엔드 개요](/backend/) 와 [인터셉터 체인](/backend/interceptors) · [AOP 권한 체크](/backend/aop-authorization) · [`@LoginUser` 리졸버](/backend/login-user-resolver) 에서 코드 단위로 깊게 다룬다.
:::

## 4. 도메인 × 기술 지도 (8개 도메인 동등)

각 행은 `담당 기능 → 핵심 기술 → 대표 클래스/테이블 → 심화 링크` 순서다. 모든 도메인을 같은 형식으로 나열한다.

### 인증·계정·보안 — `/auth/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 로그인·세션 | 세션 인증, BCrypt | `UsersVO`, `account_status` |
| 소셜 로그인 | OAuth (Kakao/Naver/Google) | OAuth 프로바이더 |
| 이메일 인증·비번 재설정 | 액션 토큰, `spring-boot-starter-mail` | 토큰 테이블 |
| 로그인 위험도 평가 | 어댑터 패턴 | `LoginRiskAssessmentProvider` |
| WAF 연동 | AWS SDK v2(WAFv2) / Cloudflare 어댑터 | WAF 어댑터 |
| 차단 해제 신청 | 워크플로우 | `SecurityAppealController` |

심화: [개요](/auth/) · [로그인·위험도](/auth/login-risk-assessment) · [OAuth](/auth/oauth-social) · [WAF 어댑터](/auth/waf-adapters)

### 커뮤니티·신고 — `/community/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 게시글 (review/photo/tip/question) | MyBatis, 소프트삭제 | `post_status`, 게시글 테이블 |
| 댓글·대댓글·채택 | 자기참조 | `parent_comment_id`, `comment_status` |
| 좋아요·태그 | 카운트 캐시, 공출현 | `like_count`, `COMMUNITY_TAG`/`POST_TAG`/`TAG_RELATION` `co_count` |
| 이미지 | Cloudinary + Pixabay 24h 캐싱 fallback (ADR-0007) | 이미지 테이블 |
| 독성·자동 플래그 | Google Perspective API | `ai_flagged` |
| 3-스트라이크 블러 | 누적 정책 | 신고/스트라이크 테이블 |
| 네이티브 광고 | 캠페인 CRUD·트래킹 | `AD_CAMPAIGN` |
| 신고 상태머신 | 상태 전이, 중복 방지(ADR-0004) | `sourceType`/`sourceId` |

심화: [개요](/community/) · [독성 감지](/community/toxicity-perspective) · [신고 상태머신](/community/report-system) · [데이터 모델](/community/data-model)

### 문의·알림·마이페이지 — `/inquiry/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 문의 상태머신 | 상태 전이 (PENDING→ANSWERED) | `INQUIRY_POST`, `ANSWER`, `ANSWER_HISTORY` |
| AI 답변 초안 | Anthropic Claude Haiku | `/inquiry/{id}/ai-draft` |
| 비공개·첨부 | 가시성 워크플로우 | `visibility`, `ATTACHMENT` |
| 실시간 알림 | SSE (`SseEmitter`) | `userIdx → List<SseEmitter>` |
| 알림 주입 | 인터셉터 | `NotificationInterceptor` |
| 마이페이지 피드 | 크로스모듈 푸시 | `MYPAGE_FEED_NOTIFICATION`, `myPageService.addNotification` |

심화: [개요](/inquiry/) · [AI 답변 초안](/inquiry/ai-draft-claude) · [SSE 알림](/inquiry/sse-notification) · [마이페이지 피드](/inquiry/mypage-feed)

### 여행 코스·AI 일정 — `/courses/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 직접 일정 작성 | MyBatis CRUD | `TRAVEL_PLAN`, `plan_source=MANUAL` |
| 스팟 순서 관리 | 순서 컬럼 | `PLAN_SPOT`, `visit_order` |
| AI 일정 생성 | OpenAI GPT-4o-mini, Structured Outputs(JSON Schema strict) | `AiPlanService`, `AiPlanResponseDTO` |
| 트랜잭션 안전 | `@Transactional` 롤백 | 저장 일괄 처리 |
| 공개 코스 피드 | 소유권 가드 | `is_public`, `isOwner` |

심화: [개요](/courses/) · [AI 일정 생성](/courses/ai-plan-gpt) · [구조화 출력](/courses/structured-outputs) · [공개 피드](/courses/public-feed)

### 여행지 탐색·커머스·리워드 — `/explore/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 여행지 탐색·필터 | 7탭 필터, Google Maps | `SPOT`, `SPOT_REVIEW`, `SPOT_FAVORITE`, `SPOT_LIKE` |
| 개인화 추천 | Google Gemini 2.5 Flash, 3단 폴백(DB캐시→Gemini→트렌딩) | 추천 캐시, 체류 로그 |
| 항공권 | **Mock 프로바이더** (인터페이스 추상화) | `FlightOfferProvider` |
| 결제·충전 | Toss Payments, 혼합 결제 | 결제 테이블 |
| 3원 지갑 | 캐시·마일리지·포인트 | `USER_WALLET_HISTORY`, `WALLET_REFUND_LOG` |
| 게이미피케이션 | 레벨·경험치 자동 승급 | `EXP_LEVEL_POLICY`, `POINT_SHOP_ITEM` |
| 패키지 마켓플레이스 | SELLER 등록→관리자 승인 | `DRAFT`/`PENDING`/`APPROVED` |

심화: [개요](/explore/) · [AI 추천](/explore/ai-recommendation-gemini) · [항공권 Mock](/explore/flight-mock) · [Toss 결제](/explore/toss-payments) · [3원 지갑](/explore/three-wallet)

### AI 어시스턴트·챗봇 — `/assistant/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 멀티턴 여행 도우미 | OpenAI GPT-4o-mini, MAX_HISTORY=20 | `AssistantServiceImpl` |
| 히스토리 저장 | 2계층 (DB + 세션) | `CHAT_POST`, `CHAT_COMMENT` |
| 사이트 네비 챗봇 | Google Gemini 2.5 Flash, 구조화 JSON | `ChatbotService`, `IntentContextService` |
| 의도 분류·Fast-Path | 2단계 의도 분류, 단순 네비는 LLM 생략 | `ChatbotFastPathService` |
| 등급별 쿼터 | GUEST 18 / SILVER 60 / GOLD 120 / PLATINUM 600 (일) | `ChatbotQuotaService` |
| 차단·URL 보안 | 화이트리스트, 위험 스킴 차단 | `ChatbotBlockService` |

심화: [개요](/assistant/) · [멀티턴 GPT](/assistant/multiturn-gpt) · [네비 챗봇](/assistant/chatbot-gemini) · [의도·Fast-Path](/assistant/intent-fastpath) · [URL 보안](/assistant/url-whitelist)

### 관리자·운영 — `/admin/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 회원 360 뷰 | 통합 조회 | 회원/활동 조인 |
| 모더레이션 | Perspective + 관리자 승인 (ADR-0010) | `ADMIN_ASSISTANT_MODERATION` |
| 감사 로그 | 행위 추적 | `ADMIN_ACTION_AUDIT` (action_type/domain/actor/target/reason_code) |
| IP 차단 | CIDR | IP 차단 테이블 |
| 런타임 설정 | DB 우선, is_secret | `APPLICATION_RUNTIME_SETTING` |
| 권한 그룹 | 권한 매핑 | `ADMIN_PERMISSION`, `ADMIN_PERMISSION_GROUP` |
| superAdmin·조직 | 역할·조직 enum, 급여 Excel | `/superAdmin/**`, position/rank/tier |
| 데이터 내보내기 | Apache POI 5.5.1 | Excel 익스포트 |

심화: [개요](/admin/) · [모더레이션 파이프라인](/admin/moderation-pipeline) · [감사 로그](/admin/audit-logs) · [런타임 설정](/admin/runtime-settings) · [superAdmin·조직](/admin/superadmin-org)

### 다국어·공통 — `/i18n/`

| 담당 기능 | 핵심 기술 | 대표 클래스 / 테이블 |
| --- | --- | --- |
| 메시지 다국어 | `MessageSource` (다수 basename), `useCodeAsDefaultMessage` | properties 번들 |
| 언어 전환 | `SessionLocaleResolver` (기본 KOREAN), `?lang=` | `LocaleChangeInterceptor` |
| 외부 번역 | Google Cloud Translation, 캐싱 | 번역 캐시 |
| DB 번역 관리 | 관리자 편집 | `AdminTranslation` |

심화: [개요](/i18n/) · [MessageSource](/i18n/messagesource) · [LocaleResolver](/i18n/locale-resolver) · [Google 번역](/i18n/google-translation)

## 5. AI 모델 한눈에 (도메인 교차)

AI는 도메인을 가로지르므로 모델별로 한 번 더 정리한다. 자세한 통합 관점은 [AI 전체](/ai/) · [다중 모델 통합](/ai/multi-model) 참고.

| 모델 | 쓰는 도메인 | 용도 |
| --- | --- | --- |
| `gpt-4o-mini` | assistant, courses | 멀티턴 도우미, AI 일정(Structured Outputs) |
| `gemini-2.5-flash` | assistant(common), explore | 네비 챗봇 구조화 JSON, 개인화 추천 |
| `claude-haiku` | inquiry | 문의 답변 초안 |
| Perspective API | community, admin | 독성(TOXICITY 0~1) 감지·모더레이션 |
| Google Cloud Translation | i18n | 다국어 번역 캐싱 |

:::warning 자리표시자만 사용
실제 운영 키·호스트는 코드/문서에 넣지 않는다. 외부 연동 값은 `API_KEY`, `DB_HOST` 같은 자리표시자로만 표기하고, 시크릿은 `APPLICATION_RUNTIME_SETTING`(is_secret) 으로 관리한다.
:::

## 6. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 8개 도메인 핵심 기능 (인증·커뮤니티·문의·코스·탐색·어시스턴트·관리자·i18n) | 구현됨 |
| 다중 AI 모델 연동 (GPT/Gemini/Claude/Perspective/Translation) | 구현됨 |
| 항공권(flight) 외부 API | **Mock 프로바이더** — `FlightOfferProvider` 인터페이스만, 실제 항공 API 미연동 |
| AI 응답 품질 정량평가 | 계획 — 평가 체계 부재(향후 과제) |
| 모바일/반응형·SPA | 계획 — JSP 데스크톱 위주 레이아웃 |
| API 문서(Swagger) | 부재 |

## 7. 면접 답변 3단계

1. **한 줄:** "TripTogether는 8개 도메인을 4계층(controller-service-mapper-vo)과 공통 인프라(세션 인증·AOP 권한·인터셉터 체인·i18n) 위에 올린 여행 올인원 플랫폼입니다."
2. **두 문장:** "도메인마다 핵심 기술이 다릅니다 — 코스는 GPT Structured Outputs로 JSON 일정을 강제하고, 탐색은 Gemini로 추천하되 DB캐시→Gemini→트렌딩 3단 폴백을 둡니다. 문의는 Claude로 답변 초안을, 커뮤니티/관리자는 Perspective로 독성을 거릅니다."
3. **마무리(정직):** "항공권은 인터페이스로 추상화했지만 아직 Mock 프로바이더이고, AI 응답 품질의 정량평가와 모바일 반응형은 다음 과제로 남겨뒀습니다."

## 8. 꼬리질문 + 모범답안

:::details 도메인이 8개인데 공통은 어떻게 공유하나요?
4계층 구조와 공통 장치(`LoginInterceptor` 세션 인증, `AuthorizationAspect` AOP 권한, `LoginUserArgumentResolver` 주입, `MessageSource` i18n)를 전 도메인이 공유합니다. 인터셉터는 `WebConfig`에서 locale→ipBlock→activityLog→login→admin→superAdmin→adminMode→notification 순으로 한 번만 등록되고 모든 요청에 적용됩니다.
:::

:::details AI 모델을 왜 한 종류로 통일하지 않았나요?
용도가 다르기 때문입니다. 일정 생성은 스키마를 강제해야 해서 GPT Structured Outputs, 추천은 비용·속도가 중요해 Gemini Flash, 문의 초안은 Claude Haiku, 독성 점수는 전용 Perspective API가 적합합니다. 모델을 용도에 맞춰 선택하고, 외부 호출 실패에 대비해 폴백(추천의 경우 DB캐시→Gemini→트렌딩)을 둡니다.
:::

:::details 항공권이 Mock이면 결제는 진짜인가요?
결제 흐름(Toss Payments, 3원 지갑 캐시·마일리지·포인트, `WALLET_REFUND_LOG` 환불)은 구현돼 있습니다. 다만 항공 상품 공급은 `FlightOfferProvider` 인터페이스만 두고 Mock 구현체를 끼웠습니다. 실제 항공 API가 붙어도 인터페이스 뒤만 교체하면 되도록 설계했습니다.
:::

:::details 이 표에서 "대표 클래스/테이블"만 외우면 충분한가요?
출발점으로는 충분합니다. 면접에서 기능 질문이 들어오면 이 표로 기술·클래스·테이블을 떠올리고, 거기서 심화 링크로 들어가 동작 원리(상태머신·폴백·트랜잭션 경계)를 설명하는 순서가 좋습니다.
:::

:::details 소프트삭제와 상태 컬럼이 도메인마다 반복되는데 일관성은?
`status` 계열 컬럼(account_status/post_status/comment_status, is_deleted)으로 소프트삭제를 통일했습니다(ADR-0008). 물리 삭제 대신 상태 전이로 복구·감사 추적이 가능하고, 신고/문의처럼 상태머신이 필요한 도메인과 자연스럽게 맞물립니다.
:::

## 9. 직접 말해보기

- 8개 도메인 이름을 순서대로 말하고, 각 도메인의 **핵심 기술 1개 + 대표 테이블 1개**를 붙여 말해본다.
- "코스 AI 일정"과 "탐색 추천"이 **왜 다른 모델**을 쓰는지 한 문장으로 설명한다.
- 공통 인터셉터 체인 순서를 외워서 말하고, 각 단계가 무엇을 막는지 한 단어로 답한다.
- 구현됨 / Mock / 계획을 각각 하나씩 예로 들어 **정직하게** 구분해 말한다.

## 퀴즈

<QuizBox question="TripTogether에서 코스 AI 일정 생성과 탐색 개인화 추천에 각각 쓰이는 AI 모델 조합으로 옳은 것은?" :choices="['둘 다 Claude Haiku', '코스=GPT-4o-mini Structured Outputs, 탐색=Gemini 2.5 Flash', '코스=Gemini, 탐색=Perspective', '둘 다 GPT-4o-mini']" :answer="1" explanation="코스 AI 일정은 OpenAI GPT-4o-mini의 Structured Outputs(JSON Schema)로 일정 구조를 강제하고, 탐색 추천은 Google Gemini 2.5 Flash를 DB캐시→Gemini→트렌딩 3단 폴백과 함께 사용합니다." />

<QuizBox question="공통 인터셉터 체인의 등록 순서로 옳은 것은?" :choices="['login → locale → admin → notification', 'locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification', 'notification → login → locale → ipBlock', 'ipBlock → login → locale → admin']" :answer="1" explanation="WebConfig#addInterceptors 기준 순서는 locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification 입니다. 언어 결정이 가장 먼저, 알림 주입이 가장 마지막입니다." />

<QuizBox question="현재 구현 상태로 옳게 짝지은 것은?" :choices="['항공권 외부 API는 실제 연동 완료', '항공권은 FlightOfferProvider 인터페이스 뒤의 Mock 프로바이더이고, AI 응답 정량평가는 향후 과제', 'Perspective 독성 감지는 미구현', '결제(Toss)는 계획 단계']" :answer="1" explanation="항공권은 인터페이스(FlightOfferProvider)로 추상화돼 있으나 실제 항공 API 미연동(Mock)이고, AI 응답 품질의 정량평가 체계와 모바일 반응형은 계획 단계입니다. 결제와 Perspective 독성 감지는 구현돼 있습니다." />
