# 백엔드 퀴즈

> Spring Boot · MyBatis · JSP · 세션 인증 · AOP · 인터셉터 체인 · 소프트 삭제 — TripTogether 백엔드의 핵심 패턴을 10문항으로 점검한다. 답은 모두 실제 코드(`WebConfig`, `AuthorizationAspect`, `LoginUserArgumentResolver`, 매퍼 XML, `TripTogetherDB.sql`)에 근거한다.

:::tip 허브
[도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 같이 보면 좋은 페이지: [Spring Boot](/backend/spring-boot) · [MyBatis](/backend/mybatis) · [인터셉터 체인](/backend/interceptors) · [AOP 권한 체크](/backend/aop-authorization)
:::

## 1. 이 퀴즈가 점검하는 것

TripTogether 백엔드는 **Spring Boot 4.0.6 / Java 21 / MyBatis 4.0.1 / MySQL** 위에 올라간 WAR 애플리케이션이다. 한 줄로 요약하면 다음과 같다.

| 축 | 선택 | 한 줄 근거 |
| --- | --- | --- |
| 영속성 | MyBatis (JPA 미사용) | `@Mapper` 인터페이스 + `resources/mapper/*.xml` 1:1 |
| 뷰 | JSP (JSTL/EL) | `tomcat-embed-jasper`, WAR 패키징, embedded Tomcat |
| 인증 | 서버 세션 | 세션 속성 `loginUser`(타입 `UsersVO`) |
| 권한 | AOP 어노테이션 | `@RequireLogin` / `@RequireAdmin` → `AuthorizationAspect` |
| 횡단 관심사 | 인터셉터 체인 | locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification |
| 삭제 | 소프트 삭제 | `account_status` / `post_status` / `comment_status` / `is_deleted` |

아래 퀴즈는 각 축에서 **면접에서 자주 파고드는 지점**만 골랐다. 한 문항을 풀고 나면 해설의 핵심어를 소리 내어 다시 설명해 보는 것이 좋다.

## 2. 학습 순서 추천

처음 보는 개념이 있으면 먼저 해당 페이지를 읽고 오면 정답률이 올라간다.

1. [Spring Boot](/backend/spring-boot) · [Spring MVC](/backend/spring-mvc) — 요청이 컨트롤러까지 오는 길
2. [MyBatis](/backend/mybatis) · [MySQL 스키마](/backend/mysql-schema) — 영속성과 데이터 모델
3. [인터셉터 체인](/backend/interceptors) · [AOP 권한 체크](/backend/aop-authorization) · [@LoginUser 리졸버](/backend/login-user-resolver) — 인증/권한 3종 세트
4. [예외 처리](/backend/exception-handling) · [JSP · JSTL · EL](/backend/jsp-jstl-el) — 응답을 만드는 마지막 단계

## 3. 핵심 패턴 한눈에 (정답을 외우지 말고 원리를 잡기)

### 인증·권한 3종 세트의 역할 분담

세 장치는 **서로 다른 일**을 한다. 면접에서 가장 흔한 함정이 이 셋을 뭉뚱그리는 것이다.

| 장치 | 언제 동작 | 하는 일 | 실패 시 |
| --- | --- | --- | --- |
| 인터셉터(`LoginInterceptor` 등) | 핸들러 진입 **전**, 경로 패턴 기준 | URL 단위 광역 차단(`/mypage/**`, `/admin/**`) | 리다이렉트 또는 에러 페이지 |
| AOP(`AuthorizationAspect`) | 컨트롤러 메서드 진입 **직전**, 어노테이션 기준 | 메서드 단위 정밀 차단 | `UnauthorizedException` / `ForbiddenException` |
| 리졸버(`LoginUserArgumentResolver`) | 파라미터 바인딩 시점 | 세션 `loginUser`를 `@LoginUser UsersVO`로 주입 | 비로그인이면 `null` 주입 |

핵심: **AOP가 막아주므로** `@RequireLogin`이 붙은 메서드 본문에서는 `@LoginUser` 파라미터가 항상 non-null이라고 가정해도 안전하다. 순서가 보장되기 때문이다.

### 소프트 삭제의 실제 컬럼

물리 DELETE 대신 상태 컬럼을 바꾼다([ADR-0008](/glossary/soft-delete)). 도메인마다 컬럼 이름과 값 집합이 다르다.

```text
USERS.account_status      = ACTIVE / DORMANT / BLOCKED / DELETED
COMMUNITY_POST.post_status     = ACTIVE / BLOCKED / DELETED
COMMUNITY_COMMENT.comment_status = ACTIVE / DELETED
(그 외 다수 테이블)  is_deleted = 0 / 1
```

조회 쿼리는 항상 `post_status = ACTIVE` 같은 조건으로 살아있는 행만 거른다. 삭제된 데이터도 감사·복구·통계를 위해 물리적으로 남긴다.

### 인터셉터 등록 순서

`WebConfig.addInterceptors()`에 **추가한 순서대로** preHandle이 실행된다. IP 차단이 활동 로그보다, 로그인 체크가 관리자 체크보다 앞선다. 순서를 바꾸면 차단돼야 할 요청이 로그를 먼저 남기는 식으로 동작이 달라진다.

## 4. 퀴즈

각 문항은 객관식(정답 1개)이거나 주관식이다. 객관식은 보기를 고른 뒤 해설을 확인하고, 주관식은 입력 후 모범답안과 비교한다.

<QuizBox
  question="TripTogether의 영속성 계층에 대한 설명으로 옳은 것은?"
  :choices="['JPA 엔티티와 리포지토리로 자동 매핑한다', 'MyBatis만 사용하며 @Mapper 인터페이스와 resources/mapper의 XML이 1:1로 대응한다', 'JdbcTemplate으로 직접 SQL을 실행한다', '도메인마다 ORM과 MyBatis를 혼용한다']"
  :answer="1"
  explanation="영속성은 전부 MyBatis다. @Mapper 인터페이스가 SQL의 계약이고 실제 SQL은 XML에 작성하며, JPA는 쓰지 않는다. XML의 namespace는 매퍼 인터페이스의 FQN과 일치해야 바인딩된다."
/>

<QuizBox
  question="이 프로젝트가 JSP 뷰를 embedded Tomcat에서 렌더링하기 위해 빌드를 WAR로 패키징하고 함께 넣는 의존성은?"
  :choices="['spring-boot-starter-thymeleaf', 'tomcat-embed-jasper (JSP 컴파일러)', 'spring-boot-starter-webflux', 'react-dom']"
  :answer="1"
  explanation="JSP는 서블릿으로 컴파일되어야 하므로 JSP 엔진인 tomcat-embed-jasper와 JSTL이 필요하다. 패키징은 war이고 embedded Tomcat 위에서 동작하며 context-path는 슬래시TripTogether다."
/>

<QuizBox
  question="로그인 인증 상태는 어디에 어떤 형태로 보관되는가?"
  :choices="['JWT 토큰을 Authorization 헤더로 매 요청 전달', '서버 세션의 loginUser 속성에 UsersVO 객체로 저장', '브라우저 localStorage에 사용자 정보 전체 저장', 'DB 세션 테이블에서 매 요청 SELECT']"
  :answer="1"
  explanation="세션 기반 인증이다. 로그인에 성공하면 세션 속성 loginUser에 UsersVO를 넣고, 인터셉터/AOP/리졸버가 모두 이 속성을 읽어 인증과 권한을 판단한다."
/>

<QuizBox
  question="@RequireLogin / @RequireAdmin 어노테이션이 붙은 컨트롤러 메서드의 권한을 검증하는 주체는?"
  :choices="['Spring Security의 FilterChainProxy', 'AuthorizationAspect (AOP Before 어드바이스)', '각 컨트롤러 메서드가 직접 if문으로 검사', 'MyBatis 인터셉터']"
  :answer="1"
  explanation="ADR-0011에 따라 AOP로 권한을 검증한다. AuthorizationAspect의 Before 어드바이스가 메서드 진입 직전에 세션 loginUser를 확인하고, 실패하면 UnauthorizedException 또는 ForbiddenException을 던진다."
/>

<QuizBox
  question="AuthorizationAspect가 권한 검증 실패 시 던지는 예외는 어떻게 사용자에게 응답으로 변환되는가?"
  :choices="['예외가 그대로 노출되어 500 스택트레이스가 보인다', 'GlobalExceptionHandler가 잡아 표준 응답으로 변환한다', '인터셉터의 afterCompletion이 처리한다', 'JSP가 try-catch로 직접 처리한다']"
  :answer="1"
  explanation="UnauthorizedException은 401, ForbiddenException은 403 등으로 GlobalExceptionHandler가 매핑해 일관된 응답을 만든다. 예외 종류와 HTTP 상태코드를 분리해 두는 것이 핵심이다."
/>

<QuizBox
  question="@LoginUser UsersVO user 파라미터에 세션 사용자를 자동 주입하는 장치는?"
  :choices="['@RequestBody 처리기', 'LoginUserArgumentResolver (HandlerMethodArgumentResolver 구현)', 'LoginInterceptor의 preHandle', '@ModelAttribute 바인더']"
  :answer="1"
  explanation="LoginUserArgumentResolver가 supportsParameter로 @LoginUser와 UsersVO 타입을 확인하고, resolveArgument에서 세션 loginUser를 꺼내 주입한다. WebConfig의 addArgumentResolvers에 등록되어 동작한다."
/>

<QuizBox
  question="@RequireLogin이 붙은 메서드 본문에서 @LoginUser 파라미터를 non-null로 가정해도 안전한 이유는?"
  :choices="['리졸버가 비로그인 시 빈 UsersVO를 만들어 주기 때문', 'AOP의 권한 검증이 파라미터 주입보다 먼저 비로그인 요청을 차단하기 때문', 'JSP가 null을 자동으로 거르기 때문', 'MySQL이 null을 막기 때문']"
  :answer="1"
  explanation="리졸버 자체는 비로그인이면 null을 주입한다. 다만 @RequireLogin이 있으면 AOP Before 어드바이스가 먼저 막으므로, 본문에 도달했다는 것은 이미 로그인된 요청이라는 뜻이다."
/>

<QuizBox
  question="WebConfig.addInterceptors에서 인터셉터의 preHandle 실행 순서를 결정하는 것은?"
  :choices="['클래스 이름의 알파벳 순서', 'registry.addInterceptor를 호출한 등록 순서', '@Order 어노테이션 값', '경로 패턴의 길이']"
  :answer="1"
  explanation="addInterceptor를 호출한 순서대로 preHandle이 실행된다. 그래서 IP 차단이 활동 로그보다, 로그인 체크가 관리자 체크보다 앞에 등록되어 차단이 로깅보다 먼저 일어난다."
/>

<QuizBox
  question="소프트 삭제에서 댓글이 삭제되어도 화면에서만 사라지게 하려면 조회 시 어떤 조건을 거는가? (값은 따옴표 없이 서술)"
  :choices="['comment_status가 DELETED인 행만 SELECT', 'comment_status가 ACTIVE인 행만 SELECT (DELETED는 제외)', '물리적으로 DELETE된 행을 복구', 'is_deleted 컬럼을 무시']"
  :answer="1"
  explanation="물리 삭제 대신 comment_status를 DELETED로 바꾸고, 조회 쿼리는 comment_status가 ACTIVE인 행만 보여 준다. 데이터는 감사와 복구를 위해 남는다. 게시글은 post_status, 계정은 account_status로 같은 패턴을 쓴다."
/>

<QuizBox
  question="MyBatis 동적 SQL에서 사용자 입력값을 바인딩할 때 #{} 를 쓰고 ${} 를 피하는 이유를 한 문장으로 설명하라. (따옴표 없이 서술)"
  explanation="#{}는 PreparedStatement 파라미터 바인딩이라 값이 안전하게 들어가 SQL 인젝션을 막는다. 반면 ${}는 SQL 문자열에 그대로 치환되므로 컬럼명이나 정렬 키워드 같은 구조에만 제한적으로 쓰고 사용자 입력에는 절대 쓰지 않는다."
/>

<QuizBox
  question="TripTogether 백엔드의 controller에서 vo까지 4계층을 요청 처리 순서대로 나열하라."
  explanation="controller에서 service로, service에서 mapper로, mapper가 vo를 채워 돌려준다. service는 인터페이스와 ServiceImpl로 나뉘고, mapper는 @Mapper 인터페이스와 XML 한 쌍이며, 응답 객체는 vo 또는 dto다."
/>

## 5. 직접 말해보기

퀴즈를 다 풀었으면 아래를 막힘 없이 30초씩 말할 수 있어야 한다.

- 인터셉터 / AOP / ArgumentResolver가 각각 무엇을 담당하고 어떤 순서로 동작하는지.
- 세션 속성 `loginUser` 하나가 인증·권한·사용자 주입 세 곳에서 어떻게 재사용되는지.
- 소프트 삭제를 택한 이유와, 도메인별 상태 컬럼(`account_status` / `post_status` / `comment_status` / `is_deleted`)이 다른 까닭.
- WAR + embedded Tomcat + JSP 조합을 고른 배경과, 그 선택이 빌드(Maven, `clean package`)에 주는 영향.

:::warning 면접 팁
세 장치(인터셉터·AOP·리졸버)를 "전부 로그인 체크하는 것"으로 뭉뚱그리면 깊이가 드러나지 않는다. **경로 단위 광역 차단(인터셉터) vs 메서드 단위 정밀 차단(AOP) vs 파라미터 주입(리졸버)** 로 역할을 분리해서 말하라.
:::

다음 단계: [도메인 퀴즈](/quizzes/domains) · [AI 퀴즈](/quizzes/ai) · [프로젝트 Q&A](/quizzes/project-qna)
