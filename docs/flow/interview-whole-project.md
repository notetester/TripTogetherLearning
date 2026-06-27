# 프로젝트 전체 면접 플레이북

> "프로젝트 전체를 설명해 보세요"는 거의 모든 면접 첫 질문이다. 이 페이지는 TripTogether를 **1분·3분·5분** 길이로 말하는 대본과, 그 뒤에 따라오는 15~20개 꼬리질문의 모범답안을 한 곳에 모은다. TripTogether는 4명이 14~15개 도메인을 수직 분담해 만든 팀 프로젝트이므로, 자기 담당은 `[내 영역]` 자리에 채워 넣고 나머지 도메인도 동등하게 설명할 수 있어야 한다.

이 페이지는 [흐름 개요](/flow/)의 종착점이다. [전체 아키텍처](/flow/architecture), [사용자 여정](/flow/user-journey), [AI 통합 맵](/flow/ai-integration-map)을 먼저 읽고 오면 대본의 모든 문장이 근거를 갖는다. 도메인 단위로 더 깊이 파려면 [도메인 전체 개요](/domains), 담당 라벨로 좁히려면 [담당별 보기](/by-area/)로 간다.

## 1. 한 줄 정의

TripTogether는 **국내 여행을 탐색 → 계획 → 예약 → 공유까지 한 곳에서 처리하는 올인원 플랫폼**이며, Spring Boot 단일 애플리케이션 안에서 14~15개 도메인을 4계층 공통 골격으로 묶고, 도메인별로 서로 다른 외부 AI에 지능형 기능을 위임한다.

## 2. 왜 이렇게 설계했나

면접에서 강한 인상을 주는 것은 기능 나열이 아니라 **선택의 이유**다. 핵심 선택 4가지를 근거와 함께 외워 둔다.

- **단일 모놀리식 + 수직 분담**: 4명·학습용 범위에서 마이크로서비스는 운영 비용이 과하다. 대신 도메인을 14~15개로 나눠 사람마다 수직 슬라이스(컨트롤러~매퍼)를 맡고, 4계층·소프트 삭제·세션 인증 같은 공통 규칙으로 일관성을 잡았다.
- **MyBatis(JPA 아님)**: 탐색 7탭 동적 필터, 통계성 집계, 카운터 캐시 갱신처럼 SQL을 직접 제어할 일이 많아 매퍼 XML로 쿼리를 명시한다. 팀 전체가 같은 영속성 패턴을 쓰게 통일했다.
- **JSP 서버 렌더링**: 서버 렌더링 + 세션 인증 + i18n 메시지 결합이 단순하고 빠르다. SPA 분리와 모바일 반응형은 향후 과제로 명시적으로 남겼다.
- **다중 AI 모델**: 단일 벤더에 묶지 않고 작업 성격에 맞는 모델을 골랐다. 멀티턴·구조화 출력은 GPT-4o-mini, 사이트 네비·개인화 추천은 Gemini 2.5 Flash, 문의 답변 초안은 Claude Haiku, 독성 점수는 Perspective API. 모델을 다양화하되 호출 골격은 동일하게 통일했다.

:::tip 한 문장으로 압축하면
**도메인은 수직으로 나누되, 횡단 규칙(인증·로깅·알림·국제화·소프트 삭제)은 인터셉터/AOP로 공통화해, 4명이 큰 규모를 일관되게 끌고 갔다.**
:::

## 3. 어떤 기술로 구현했나 (실제 스택·클래스·테이블)

| 영역 | 기술 / 클래스 | 비고 |
| --- | --- | --- |
| 런타임 | Spring Boot 4.0.6 · Java 21 · WAR · embedded Tomcat | context-path /TripTogether |
| 영속성 | MyBatis 4.0.1 (`@Mapper` + resources/mapper/*.xml) · MySQL | JPA 미사용 |
| 화면 | JSP(JSTL/EL) 서버 렌더링 | 4개국어 ko/en/ja/zh |
| 계층 | controller → service(인터페이스+ServiceImpl) → mapper → vo | 전 도메인 동일 |
| 인증 | 세션 속성 loginUser(UsersVO) · `AuthorizationAspect` · `LoginUserArgumentResolver` | ADR-0011 |
| 횡단 | 인터셉터 체인 locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification | |
| 보안 | BCryptPasswordEncoder · jsoup XSS 정화 · Spring Security 부분 CSRF | ADR-0005, 0012 |
| 외부 연동 | OkHttp(AI/HTTP) · Cloudinary(이미지) · spring-boot-starter-mail · Apache POI(Excel) · AWS SDK v2(WAFv2) | ADR-0007 |
| AI | GPT-4o-mini · Gemini 2.5 Flash · Claude Haiku · Perspective · Google Translation | 도메인별 위임 |

대표 클래스와 테이블을 도메인별로 한 줄씩 매핑해 두면 어떤 질문에도 구체로 답할 수 있다.

- 멀티턴 도우미: `AssistantServiceImpl`(MAX_HISTORY 20) · CHAT_POST/CHAT_COMMENT
- AI 일정: `AiPlanServiceImpl` → `AiPlanResponseDTO`(days → AiDayDTO → AiSpotDTO) · TRAVEL_PLAN/plan_spot
- 네비 챗봇: `ChatbotService` · CHATBOT_CONVERSATION
- 개인화 추천: explore RecommendService · SPOT_TRAVEL/SPOT_REVIEW/SPOT_FAVORITE
- 항공권: `FlightOfferProvider` 인터페이스 · `MockFlightOfferProvider` · FLIGHT_PURCHASE_SIMULATION
- 알림: myPageService.addNotification · MYPAGE_FEED_NOTIFICATION · SseEmitter
- 운영: ADMIN_ACTION_AUDIT · APPLICATION_RUNTIME_SETTING(is_secret) · REPORT

## 4. 동작 원리 (한 요청의 일생)

도메인이 많아도 한 요청이 거치는 길은 동일하다. 이 흐름 하나를 말로 풀 수 있으면 "전체 흐름"질문은 끝난다.

```text
브라우저(?lang=ko/en/ja/zh)
  │
  ▼ 인터셉터 체인 locale → ipBlock → activityLog → login → admin → ... → notification
  ▼ AOP @RequireLogin/@RequireAdmin (AuthorizationAspect) + @LoginUser 자동 주입
Controller ─► Service(ServiceImpl) ─► Mapper(@Mapper + XML) ─► MySQL(소프트삭제 status)
                   │ 외부 위임
                   ▼ OkHttp → AI(GPT/Gemini/Claude/Perspective) · Cloudinary · 메일
결과 ─► JSP 렌더 또는 ─► myPageService.addNotification ─► SSE 푸시(다른 도메인)
```

도메인은 분리돼 있어도 **크로스모듈 알림**으로 느슨하게 묶인다. 신고가 처리되거나(report) 질문에 댓글이 달리면(community) 해당 도메인이 공용 진입점 하나(`addNotification`)로 MYPAGE_FEED_NOTIFICATION에 적재하고, SSE가 접속 중 사용자에게 즉시 푸시한다. 직접 테이블을 건드리는 결합이 아니라 알림이라는 공용 채널을 통한다는 점이 핵심이다.

AI는 별도 시스템이 아니라 서비스 안의 외부 호출이며, 골격은 항상 같다.

| 끼어드는 곳 | 모델 | 실패 시 폴백 |
| --- | --- | --- |
| 멀티턴 도우미 | GPT-4o-mini | 오류 안내 |
| AI 일정 생성 | GPT-4o-mini(JSON Schema strict) | 트랜잭션 롤백 |
| 네비 챗봇 | Gemini 2.5 Flash | 폴백 응답 |
| 개인화 추천 | Gemini 2.5 Flash | 트렌딩 폴백 |
| 문의 답변 초안 | Claude Haiku | 빈 문자열 |
| 독성 감지 | Perspective | 통과(false) |

원칙은 **AI 출력을 입력처럼 의심한다**다. 추천 결과 id는 후보 집합에 있는지 다시 확인하고, 챗봇이 돌려준 링크는 화이트리스트로 거르며 위험 스킴(javascript / data / file)과 경로 순회를 차단한다.

## 5. 구현 상태 (됨 vs Mock/계획)

면접에서 정직한 한계 인식은 가산점이다. 무엇이 진짜 동작하고 무엇이 Mock·계획인지 분명히 구분해 말한다.

| 항목 | 상태 |
| --- | --- |
| 탐색·계획·커뮤니티·문의·알림·관리자·리워드 핵심 기능 | 구현됨 |
| 다중 AI(GPT·Gemini·Claude·Perspective·번역) 연동 | 구현됨 |
| 세션 인증·AOP 권한·소프트 삭제·i18n·SSE | 구현됨 |
| 항공권 예약 | Mock 프로바이더(`MockFlightOfferProvider`), 실제 외부 항공 API 미연동 |
| AI 응답 품질 정량 평가 체계 | 부재(향후 과제) |
| 모바일 반응형 · SPA 분리 | JSP 데스크톱 위주, 향후 과제 |
| API 문서(Swagger) | 부재 |

:::warning 정직하게 말하는 법
항공권을 "구현했다"가 아니라 "프로바이더 인터페이스로 추상화해 Mock으로 동작하며, 실제 항공 API는 어댑터만 갈아끼우면 된다"고 설명한다. 추상화가 끝나 있다는 점이 오히려 설계 역량으로 읽힌다.
:::

## 6. 면접 답변 3단계 (1분 / 3분 / 5분)

질문의 무게와 면접관의 관심에 맞춰 길이를 조절한다. 한 호흡에 끝내지 말고 단계적으로 확장한다.

**① 1분 — 한 호흡 엘리베이터 피치**

> TripTogether는 국내 여행을 탐색·계획·예약·공유까지 한 곳에서 처리하는 올인원 플랫폼입니다. Spring Boot 4와 Java 21, MyBatis와 MySQL로 만든 단일 애플리케이션이고, 화면은 JSP로 서버 렌더링합니다. 4명이 14~15개 도메인을 수직 분담했고, 공통 규칙으로 일관성을 유지했습니다. 여행 도우미·일정 생성·추천·챗봇 같은 지능형 기능은 작업 성격에 맞는 외부 AI에 위임했습니다. 저는 그중 `[내 영역]`을 담당했습니다.

**② 3분 — 아키텍처와 협업까지**

1분 피치에 이어 횡단 골격을 덧붙인다: 한 요청은 인터셉터 체인(locale·login·notification 등)을 통과하고, AOP `@RequireLogin`과 `@LoginUser`로 인증·주입을 가로채며, 서비스가 비즈니스 규칙과 외부 AI 호출을 맡고, 매퍼가 MySQL을 다룬다. 삭제는 status 컬럼 소프트 삭제, 예외는 `GlobalExceptionHandler`가 HTTP 상태코드로 정규화한다. 협업은 수직 분담 + ADR(MADR 0001~0014)로 설계 결정을 문서화했다고 마무리한다.

**③ 5분 — 다중 AI·트레이드오프·한계까지**

3분 답변에 다중 AI 전략과 정직한 한계를 추가한다: 멀티턴·구조화 출력은 GPT-4o-mini, 네비·추천은 Gemini, 문의 초안은 Claude, 독성은 Perspective로 작업별 최적 모델을 골랐고, 모든 호출을 fail-safe로 설계해 AI 장애가 핵심 기능을 멈추지 않게 했다. 그리고 항공권은 Mock 프로바이더이고, AI 품질 정량 평가·모바일 반응형·Swagger는 향후 과제라고 정직하게 닫는다. 마지막에 `[내 영역]`에서 본인이 직접 해결한 문제 하나를 깊게 풀어낸다.

## 7. 꼬리질문 + 모범답안

:::details 마이크로서비스가 아니라 모놀리식으로 간 이유는?
4명·학습용 범위에서 서비스 분리는 배포·관측·통신 비용이 과합니다. 대신 단일 애플리케이션 안에서 도메인을 14~15개로 나눠 사람마다 수직 슬라이스를 맡고, 4계층·소프트 삭제·세션 인증 같은 공통 규칙으로 모듈 경계를 지켰습니다. 규모가 커지면 도메인 경계가 이미 명확하니 분리가 쉽습니다.
:::

:::details 4명이 14~15개 모듈을 어떻게 충돌 없이 만들었나?
기능별 수직 분담으로 도메인 폴더를 나눠 코드 충돌 면적을 줄였고, 모든 모듈이 동일한 4계층 골격을 따라 서로의 코드를 빠르게 읽었습니다. 공통 영역(인증·알림·국제화)은 인터셉터/AOP로 한곳에 모았고, 설계 결정은 ADR로 문서화해 나중에 합류한 사람도 맥락을 따라올 수 있게 했습니다.
:::

:::details JPA가 아니라 MyBatis를 고른 트레이드오프는?
얻은 것은 SQL 완전 제어입니다. 탐색 7탭 동적 필터, 통계 집계, 카운터 캐시 갱신을 매퍼 XML로 명시했습니다. 잃은 것은 엔티티 자동 매핑과 변경 감지 편의입니다. 본 프로젝트는 복잡 쿼리 비중이 높아 제어권이 더 가치 있다고 판단했습니다.
:::

:::details JSP가 구식이라는 지적에는?
서버 렌더링 + 세션 인증 + i18n 메시지 결합에는 JSP가 단순하고 빠르게 동작해 팀 프로젝트 범위에 적합했습니다. 다만 모바일 반응형과 SPA 분리는 한계로 분명히 인식하고 향후 과제로 남겼습니다. 트렌드와 현재 적합성을 분리해 판단했습니다.
:::

:::details AI 모델을 왜 한 벤더로 통일하지 않았나?
작업 성격이 달라서입니다. 긴 멀티턴과 strict JSON Schema 구조화 출력은 GPT-4o-mini, 사이트 네비·개인화 추천은 Gemini 2.5 Flash, 문의 답변 초안은 Claude Haiku, 독성 점수는 Perspective가 각각 강점이 있었습니다. 모델은 다양화하되 호출 골격(컨텍스트 수집 → 호출 → 검증·저장 → 폴백)은 동일하게 통일해 운영 복잡도를 낮췄습니다.
:::

:::details AI가 잘못된 답이나 위험한 링크를 주면?
AI 출력을 입력처럼 검증합니다. 추천 결과 id는 후보 집합에 있는지 재확인하고, 챗봇 링크는 화이트리스트로 거르며 위험 스킴(javascript / data / file)과 경로 순회를 차단합니다. 일정 생성은 strict JSON Schema로 구조를 강제하고 트랜잭션으로 묶어 깨진 결과는 롤백합니다.
:::

:::details 외부 AI가 느리거나 죽으면 서비스 전체가 멈추나?
아니요. 거의 모든 AI 호출이 fail-safe입니다. 추천은 트렌딩으로, 챗봇은 폴백 응답으로, 문의 초안은 빈 문자열로, 독성 검사는 통과로 떨어져 글쓰기·답변·탐색 같은 핵심 기능은 계속 동작합니다. AI는 부가가치이지 단일 장애점이 아니도록 설계했습니다.
:::

:::details 가장 어렵게 풀었던 문제 하나는?
도메인마다 AI 실패를 다르게 다뤄야 했던 점입니다. 추천은 사용자 경험상 멈추면 안 되니 DB 캐시 → Gemini → 트렌딩 3단 폴백을 두었고, 일정 생성은 절반만 저장되면 안 되니 strict JSON Schema + 트랜잭션 롤백으로 원자성을 보장했습니다. 같은 외부 호출이라도 도메인 요구에 맞춰 실패 전략을 달리한 것이 핵심이었습니다.
:::

:::details 데이터 정합성은 어떻게 보장하나?
다중 행을 함께 쓰는 작업은 @Transactional로 묶습니다. AI 일정 생성은 TRAVEL_PLAN과 plan_spot을 한 트랜잭션에서 저장해 중간 실패 시 전부 롤백합니다. 좋아요 같은 카운터는 캐시 컬럼과 재집계로 일관성을 맞춥니다(ADR-0006). 삭제는 status 컬럼 소프트 삭제라 참조 무결성도 보존됩니다.
:::

:::details 보안은 어떤 층위로 다뤘나?
입력은 jsoup로 XSS를 정화하고, 비밀번호는 BCrypt로 해싱하며, 상태 변경 요청은 Spring Security CSRF를 부분 적용했습니다(ADR-0012). 인증은 세션 기반이고 권한은 AOP `@RequireLogin`/`@RequireAdmin`으로 가로챕니다. 운영 측면에서는 IP 차단(CIDR), 로그인 위험도 평가, 감사 로그(ADMIN_ACTION_AUDIT)를 두었습니다.
:::

:::details API 키 같은 시크릿은 어디에 두나?
코드에 박지 않고 환경변수와 런타임 설정(APPLICATION_RUNTIME_SETTING, is_secret 플래그)으로 주입합니다. 공개 저장소에는 자리표시자(API_KEY, DB_HOST)만 들어가고 실제 값은 배포 환경에서 채웁니다.
:::

:::details 이 프로젝트의 가장 아쉬운 점은?
항공권이 실제 외부 API 대신 Mock 프로바이더라는 점, AI 응답 품질의 정량 평가 체계가 아직 없다는 점, 모바일 반응형과 Swagger 문서가 부재하다는 점입니다. 다만 항공권은 `FlightOfferProvider` 인터페이스로 추상화돼 있어 실제 API 어댑터만 갈아끼우면 되도록 설계해 두었습니다.
:::

:::details 다시 한다면 무엇을 바꾸겠나?
AI 호출에 응답 품질·지연·실패율을 측정하는 관측 레이어를 처음부터 넣겠습니다. 지금은 fail-safe는 있지만 품질을 정량으로 추적하지 못합니다. 그리고 화면 레이어를 API + SPA로 분리해 모바일 대응과 프런트 협업을 쉽게 만들겠습니다.
:::

## 8. 직접 말해보기

녹음하면서 아래를 막힘 없이 답할 수 있으면 면접 준비가 충분하다.

- TripTogether를 모르는 사람에게 1분 안에 무엇을 하는 서비스인지, 어떤 스택인지 말해 보라.
- 한 요청이 인터셉터 체인 → AOP → 서비스 → 매퍼 → DB를 거쳐 화면이나 알림으로 돌아오는 과정을 말로 풀어 보라.
- 4명이 14~15개 도메인을 일관되게 만든 비결을 공통 규칙 3가지로 설명해 보라.
- AI 모델 4종을 작업별로 왜 다르게 골랐는지, 각각의 실패 폴백과 함께 나열해 보라.
- 구현되지 않은 부분(항공권 Mock·AI 품질 평가·모바일·Swagger)을 정직하게 말하고, 그중 하나의 개선안을 제시해 보라.
- `[내 영역]`에서 본인이 직접 해결한 문제 하나를 1분 동안 깊게 설명해 보라.

## 퀴즈

<QuizBox question="TripTogether의 전체 아키텍처를 한 문장으로 가장 정확히 요약한 것은?" :choices="['마이크로서비스 여러 개를 메시지 큐로 연결한 분산 시스템', 'Spring Boot 단일 애플리케이션에서 도메인을 수직 분담하고 횡단 관심사는 인터셉터와 AOP로 공통화한 모놀리식', 'React SPA와 GraphQL 게이트웨이 중심의 프런트 주도 구조', 'JPA 엔티티 그래프로 모든 도메인을 자동 매핑한 구조']" :answer="1" explanation="TripTogether는 Spring Boot 단일 애플리케이션 안에서 14~15개 도메인을 수직 분담하고, 인증·로깅·알림·국제화 같은 횡단 관심사는 인터셉터 체인과 AOP로 공통 적용한 모놀리식이다. JPA가 아니라 MyBatis를 쓴다." />

<QuizBox question="면접에서 구현 상태를 정직하게 말할 때 Mock 또는 향후 과제로 분류해야 하는 항목은?" :choices="['세션 기반 로그인', 'AI 일정 생성의 트랜잭션 롤백', '항공권 예약과 AI 응답 품질 정량 평가', '소프트 삭제와 SSE 알림']" :answer="2" explanation="항공권은 MockFlightOfferProvider로 동작하며 실제 외부 항공 API는 미연동이고, AI 응답 품질의 정량 평가 체계와 모바일 반응형, Swagger는 부재한 향후 과제다. 나머지는 모두 구현된 기능이다." />

<QuizBox question="여러 외부 AI 모델을 작업별로 다르게 배치한 이유로 가장 적절한 것은?" :choices="['단일 벤더 가격이 비싸서 무작위로 분산했다', '멀티턴과 구조화 출력은 GPT, 네비와 추천은 Gemini, 문의 초안은 Claude, 독성은 Perspective처럼 작업 성격에 맞는 강점을 골랐다', '모델마다 다른 언어로만 응답하기 때문이다', '프런트엔드에서 각자 직접 호출해야 하기 때문이다']" :answer="1" explanation="작업 성격에 맞춰 모델을 골랐다. 긴 멀티턴과 strict JSON Schema 구조화 출력은 GPT-4o-mini, 사이트 네비와 개인화 추천은 Gemini 2.5 Flash, 문의 답변 초안은 Claude Haiku, 독성 점수는 Perspective다. 모델은 다양화하되 호출 골격은 통일했다." />
