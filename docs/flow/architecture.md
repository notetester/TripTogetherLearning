# 전체 아키텍처

> TripTogether는 **Spring Boot 4.0.6 / Java 21** 기반의 모놀리식 웹 애플리케이션이다. 화면은 JSP(서버 렌더링), 비동기 데이터는 REST API로 동시에 제공하고, 영속성은 MyBatis/MySQL, 외부 연동은 다중 AI API·Cloudinary·Toss로 처리한다. 패키징은 **WAR**, 실행은 내장 Tomcat이다.

이 페이지는 한 화면이 뜨기까지 요청이 거쳐가는 전 구간을 한 줄로 잇는다. 도메인별 깊이는 [도메인 전체 개요](/domains)에서, 사람 단위 분담은 [담당별 보기](/by-area/)에서, 다른 흐름은 [전체 흐름](/flow/)에서 본다.

## 1. 한 줄 정의

TripTogether 아키텍처는 **하나의 Spring MVC 애플리케이션**이 같은 컨트롤러 계층에서 JSP 뷰와 REST(JSON)를 함께 내보내고, 그 뒤로 `service → mapper → MySQL`의 4계층이 일을 처리하며, 외부 AI·이미지·결제는 HTTP 어댑터로 격리한 **모듈러 모놀리스**다.

## 2. 왜 이렇게 설계했나

| 선택 | 이유 |
| --- | --- |
| **모놀리식 + 모듈 패키지** | 4인 공동 개발 규모에서 마이크로서비스 운영 비용은 과함. 도메인별 패키지(`auth`, `community`, `courses`, `explore` 등 약 14~15개)로 경계만 명확히 나누고 배포는 단일 WAR로 단순화 |
| **JSP(SSR) + REST 혼합** | 페이지 골격은 서버 렌더링으로 SEO·초기 로딩에 유리하게, 좋아요·알림·챗봇 같은 부분 갱신은 REST/JSON으로 비동기 처리 |
| **MyBatis(매퍼 XML)** | 통계·집계·동적 검색이 많은 도메인 특성상 SQL을 직접 통제. JPA 대신 명시적 매핑 채택 |
| **자체 세션 인증 + 인터셉터/AOP** | Spring Security 인증 플로우 대신 가벼운 세션 모델을 쓰되, 인가는 인터셉터(경로 단위)와 AOP(메서드 단위)로 이중화 |
| **Spring Security는 CSRF만 부분 사용** | 인증은 자체 구현이 담당하고, Security는 변경 요청 보호(CSRF)에만 최소 적용([ADR-0012](/flow/moderation-governance)) |
| **외부 연동 어댑터화** | AI·이미지·결제·항공권을 인터페이스 뒤로 숨겨, Mock과 실제 구현을 교체 가능하게 함 |

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

핵심 런타임 구성 요소다. 클래스명은 실제 소스 기준이다.

| 계층 | 기술 / 실제 구성 |
| --- | --- |
| **진입/구동** | `TripTogetherApplication`(부트 진입), `ServletInitializer`(WAR 배포용), 내장 Tomcat + Jasper, context-path `/TripTogether` |
| **MVC 설정** | `WebConfig`(인터셉터·리소스 핸들러·MessageSource·LocaleResolver 등록), `SecurityConfig`(CSRF 부분 적용), `JacksonConfig`, `RestTemplateConfig`, `BCryptConfig` |
| **인터셉터** | `IpBlockInterceptor`, `ActivityLogInterceptor`, `LoginInterceptor`, `AdminInterceptor`, `SuperAdminInterceptor`, `AdminModeInterceptor`, `NotificationInterceptor`, `LocaleChangeInterceptor` |
| **인가/주입** | `AuthorizationAspect`(@RequireLogin/@RequireAdmin AOP), `LoginUserArgumentResolver`(@LoginUser 주입), `GlobalExceptionHandler` |
| **영속성** | `@Mapper` 인터페이스 + `resources/mapper/*.xml`, MyBatis 4.0.1, MySQL. VO는 도메인별 `*.vo` 패키지(예: `UsersVO`) |
| **외부 HTTP** | OkHttp 5.3.2(AI 호출), Cloudinary 2.3.2(이미지), Apache POI 5.5.1(Excel), AWS SDK v2(WAFv2), jsoup 1.17.2(XSS 정화), spring-boot-starter-mail |
| **AI 모델** | OpenAI gpt-4o-mini, Google gemini-2.5-flash, Anthropic claude-haiku, Google Perspective API, Google Cloud Translation |

DB 테이블은 도메인별로 정규화돼 있다. 대표 예: `USERS`, `COMMUNITY_POST`/`POST_TAG`/`TAG_RELATION`, `TRAVEL_PLAN`/`PLAN_SPOT`, `SPOT`/`SPOT_REVIEW`, `INQUIRY_POST`/`ANSWER`, `MYPAGE_FEED_NOTIFICATION`, `ADMIN_ACTION_AUDIT`, `APPLICATION_RUNTIME_SETTING`. 전체는 [데이터 모델 전체](/flow/data-model) 참고.

## 4. 동작 원리(요청 생명주기)

브라우저 요청 하나가 화면이 되기까지의 경로다. **인터셉터 체인이 컨트롤러보다 먼저** 돌고, 그 안에서 인가가 1차 결정된다.

```text
[브라우저]
   │  GET /TripTogether/community/123  (또는 POST /community/123/like)
   ▼
[내장 Tomcat → DispatcherServlet]
   ▼
[인터셉터 체인 (preHandle 순서)]
   locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification
   │   · locale     : ?lang= 또는 세션 locale로 언어 결정 (ko/en/ja/zh)
   │   · ipBlock    : 차단 IP면 여기서 중단
   │   · login/admin: 보호 경로면 세션 loginUser 확인, 없으면 리다이렉트
   │   · notification: 로그인 유저면 안읽은 알림 수를 모델에 주입
   ▼
[ArgumentResolver]  @LoginUser UsersVO → 세션 loginUser 자동 주입
   ▼
[AOP AuthorizationAspect]  @RequireLogin/@RequireAdmin 메서드면 권한 재검증
   ▼
[Controller]  요청 바인딩 → 서비스 호출
   ▼
[Service / ServiceImpl]  비즈니스 규칙, @Transactional 경계, 외부 AI/이미지 호출
   ▼
[Mapper(@Mapper) + XML]  MyBatis SQL 실행
   ▼
[MySQL]  소프트삭제 status 컬럼 기준으로 조회/갱신
   ▲
   │  반환 분기
   ├─ 화면 요청  → JSP 뷰 이름 반환 → JSTL/EL 렌더링 → HTML 응답
   └─ API 요청   → @ResponseBody DTO → Jackson → JSON 응답
```

흐름에서 중요한 두 가지 분리:

- **인가는 두 겹이다.** 경로 단위(인터셉터: `/mypage/**`, `/admin/**`, `/superAdmin/**`)와 메서드 단위(AOP: `@RequireLogin`/`@RequireAdmin`). 인터셉터를 통과해도 AOP가 한 번 더 막는다.
- **인증과 인가의 책임 분리.** 세션 기반 인증은 자체 구현이 담당하고, Spring Security는 `/community`·`/report`·`/inquiry`의 변경 요청(POST/PUT/DELETE)에 CSRF 토큰 검증만 건다.

핵심 인가 코드(추상화):

```java
// AuthorizationAspect — 컨트롤러 메서드 진입 직전
@Before("@annotation(...RequireAdmin)")
public void checkAdmin() {
    UsersVO user = currentLoginUser();        // 세션에서 추출
    if (user == null) throw new UnauthorizedException();   // 401
    if (!user.hasAdminRole()) throw new ForbiddenException();   // 403
}
```

예외는 `GlobalExceptionHandler`가 받아 화면이면 에러 페이지로, API면 상태코드(401/403/404/409 등)를 분리한 JSON으로 변환한다.

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 정직한 현황
대부분의 핵심 흐름은 실제 동작한다. 외부 의존이 큰 일부만 Mock이거나 향후 과제다.
:::

| 영역 | 상태 |
| --- | --- |
| JSP/REST 혼합 렌더링, 인터셉터 체인, AOP 인가, 전역 예외 처리 | **구현됨** |
| MyBatis/MySQL 4계층, 소프트삭제, 트랜잭션 롤백 | **구현됨** |
| AI 연동(어시스턴트·코스 일정·탐색 추천·문의 초안·챗봇·모더레이션·번역) | **구현됨**(실제 모델 호출) |
| Cloudinary 이미지, Toss 결제/충전, 이메일, Excel(POI), WAFv2 어댑터 | **구현됨** |
| **항공권(flight)** | **Mock 프로바이더** — `FlightOfferProvider` 인터페이스만 추상화, 실제 외부 항공 API 미연동 |
| AI 응답 품질 정량 평가 체계 | **부재(향후 과제)** |
| 모바일 최적화 | JSP 데스크톱 위주 레이아웃, 반응형/SPA는 향후 |
| API 문서(Swagger) | **부재** |

:::warning Mock 경계
항공권은 Mock이지만 `FlightOfferProvider` 인터페이스로 격리돼 있어, 실제 항공 API 연동 시 구현체만 교체하면 된다. 같은 패턴이 AI 모델 교체에도 적용된다.
:::

## 6. 면접 답변 3단계

1. **한 줄** — "단일 Spring Boot WAR 안에서 JSP 서버 렌더링과 REST JSON을 같은 컨트롤러 계층으로 함께 제공하는 모듈러 모놀리스입니다. 영속성은 MyBatis/MySQL, 외부 AI·이미지·결제는 어댑터로 격리했습니다."
2. **한 단계 더** — "요청은 DispatcherServlet 뒤에서 8단계 인터셉터 체인(locale→ipBlock→activityLog→login→admin→superAdmin→adminMode→notification)을 먼저 거치고, AOP가 메서드 단위 권한을 한 번 더 검증한 뒤 `service→mapper→DB`로 내려갑니다. 인증은 세션 기반 자체 구현, Spring Security는 CSRF 보호에만 부분 적용했습니다."
3. **트레이드오프** — "마이크로서비스 대신 모놀리스를 택해 4인 협업과 배포를 단순화했고, 경계는 도메인 패키지와 어댑터 인터페이스로 잡았습니다. 단점은 단일 배포 단위라 부분 스케일이 어렵고, 항공권은 아직 Mock, AI 품질 정량 평가와 Swagger는 향후 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 JSP와 REST를 한 애플리케이션에서 섞었나
페이지 골격은 SSR(JSP)로 초기 로딩·SEO 이점을 얻고, 좋아요·알림·챗봇처럼 부분만 바뀌는 상호작용은 REST/JSON으로 비동기 처리합니다. 같은 컨트롤러 계층에서 뷰 이름을 반환하면 JSP, @ResponseBody DTO를 반환하면 Jackson이 JSON으로 직렬화합니다. 덕분에 서비스·매퍼 계층을 둘이 공유합니다.
:::

:::details Q2. 인터셉터로 인가하면 되는데 왜 AOP를 또 두나
인터셉터는 URL 경로 단위라 굵습니다(예: `/admin/**`). 같은 컨트롤러 안에서 특정 메서드만 관리자 전용으로 막거나, 경로로는 구분이 안 되는 세밀한 권한이 필요할 때 `@RequireAdmin` 같은 메서드 단위 AOP가 더 정확합니다. 두 겹을 두면 경로 누락이나 신규 엔드포인트에서의 권한 구멍을 줄일 수 있습니다.
:::

:::details Q3. JPA 대신 MyBatis를 쓴 이유는
커뮤니티 통계, 태그 공출현 집계, 관리자 360 뷰처럼 복잡한 조인·집계 SQL이 많습니다. JPA의 추상화보다 SQL을 직접 통제하는 편이 성능 튜닝과 가독성에 유리하다고 판단했습니다. 대신 매퍼 XML이 늘어나 관리 비용이 생기는 트레이드오프가 있습니다.
:::

:::details Q4. 세션 인증인데 Spring Security는 왜 의존성에 있나
인증·인가는 세션과 인터셉터·AOP로 자체 처리하지만, CSRF 보호는 검증된 구현을 쓰는 편이 안전합니다. 그래서 Security를 변경 요청(POST/PUT/DELETE)의 CSRF 토큰 검증에만 부분 적용하고, 점진적으로 적용 범위를 넓히는 방향입니다. 이 결정은 ADR로 남겼습니다.
:::

:::details Q5. 외부 AI/결제 장애가 전체를 멈추지 않게 하려면
외부 호출은 인터페이스(어댑터) 뒤로 숨겨 격리했습니다. 예를 들어 탐색 추천은 DB 캐시→AI→트렌딩의 3단 폴백이 있어 AI가 죽어도 기본 결과를 냅니다. 항공권은 아예 Mock 프로바이더라 외부 의존 없이 흐름을 검증할 수 있습니다. 결제·이미지 같은 동기 연동은 트랜잭션 경계와 예외 처리로 부분 실패를 격리합니다.
:::

## 8. 직접 말해보기

아래를 막힘없이 입으로 설명할 수 있으면 이 페이지는 통과다.

- "요청이 들어와서 화면이 뜨기까지, 인터셉터 체인 8단계를 순서대로 말해보라."
- "JSP 응답과 JSON 응답이 같은 컨트롤러에서 어떻게 갈라지는지 설명하라."
- "인증과 인가가 각각 어디서 처리되는지(세션/인터셉터/AOP/Security) 구분해 말하라."
- "이 아키텍처에서 Mock이거나 미완인 부분과, 그걸 교체 가능하게 만든 설계를 한 문장으로 말하라."

다음 흐름으로 이어서 보기: [인증·세션 흐름](/flow/auth-session-flow) · [AI 통합 맵](/flow/ai-integration-map) · [데이터 모델 전체](/flow/data-model)

## 퀴즈

<QuizBox question="TripTogether의 패키징·배포 형태로 맞는 것은?" :choices="['JAR로 빌드해 별도 Tomcat 없이 실행만 한다', 'WAR로 패키징하고 내장 Tomcat에서 실행한다', 'Docker 이미지로만 배포한다', '정적 사이트로 빌드해 CDN에 올린다']" :answer="1" explanation="TripTogether는 WAR 패키징이며 내장 Tomcat(Jasper 포함)에서 구동된다. context-path는 슬래시 TripTogether 다." />

<QuizBox question="요청 인터셉터 체인의 preHandle 실행 순서로 올바른 것은?" :choices="['login → locale → ipBlock → notification', 'locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification', 'ipBlock → login → locale → admin', 'notification → admin → login → locale']" :answer="1" explanation="언어 결정(locale)과 IP 차단이 가장 앞에서 돌고, 인증·관리자 인가를 거쳐 마지막에 알림 데이터를 주입한다." />

<QuizBox question="이 프로젝트에서 인증과 인가, CSRF의 책임 분리로 옳은 것은?" :choices="['Spring Security가 로그인 인증까지 모두 담당한다', '세션 기반 자체 인증을 쓰고, 인가는 인터셉터와 AOP로 이중화하며, Spring Security는 일부 변경 요청의 CSRF 검증에만 쓴다', '인가는 오직 AOP만 담당하고 인터셉터는 인가에 관여하지 않는다', 'CSRF 보호는 모든 GET 요청에 적용된다']" :answer="1" explanation="인증은 세션 기반 자체 구현, 인가는 경로 단위 인터셉터와 메서드 단위 AOP로 두 겹, Spring Security는 community report inquiry 의 POST PUT DELETE CSRF 검증에만 부분 적용한다. GET은 CSRF 대상이 아니다." />
