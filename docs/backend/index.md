# 백엔드 개요

> TripTogether 백엔드는 Spring Boot 4 + MyBatis + 서버사이드 JSP로 짜인 단일 WAR다. 컨트롤러 → 서비스 → 매퍼 → VO 4계층, 세션 인증, 인터셉터 체인, AOP 권한, MyBatis XML 매퍼가 뼈대다.

이 페이지는 백엔드 전체를 빠르게 머릿속에 그리기 위한 진입점이다. 개별 주제(Spring Boot, MyBatis, 인터셉터, AOP 등)는 아래 권장 학습순서를 따라 깊게 들어가면 된다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 한 줄 정의

TripTogether 백엔드는 **임베디드 Tomcat에서 도는 단일 WAR 애플리케이션**으로, REST 전용 API 서버가 아니라 **JSP로 화면을 렌더링하는 전통적 Spring MVC**에 AJAX/AI용 JSON 응답을 섞은 모놀리식 구조다. 약 14~15개 도메인 모듈을 4명이 수직 분담해 공동 개발했다.

## 2. 왜 이렇게 설계했나

- **모놀리식 + JSP 선택**: 국내 여행 올인원(탐색→계획→예약→공유)이라는 넓은 도메인을 한 팀이 빠르게 통합하기 위해, 마이크로서비스/SPA 분리 대신 **서버사이드 렌더링 단일 배포 단위**를 택했다. 화면·세션·인증이 한 프로세스에 모여 디버깅과 협업이 단순하다.
- **MyBatis(JPA 아님)**: 통계성 집계, 태그 공출현 카운트, 회원 360 뷰 같은 **복잡한 SQL을 직접 제어**해야 하는 화면이 많아, ORM 자동 생성 쿼리보다 XML 매퍼로 SQL을 손에 쥐는 쪽이 유리했다.
- **세션 기반 인증**: SPA/모바일 토큰(JWT)이 아니라 JSP 기반이므로, 표준 서블릿 세션(`loginUser` 속성)이 가장 단순하고 안전했다.
- **횡단 관심사 분리**: 권한·로깅·알림·차단·다국어를 컨트롤러마다 반복하지 않도록 **인터셉터 체인 + AOP**로 빼냈다. 컨트롤러는 비즈니스 흐름만 남긴다.
- **설정 외부화**: 위험 정책·차단 규칙·쿼터 등 운영 중 바뀌는 값을 코드가 아니라 **DB 런타임 설정**으로 두어, 재배포 없이 관리자가 조정한다.

## 3. 어떤 기술로 구현했나 (실제 스택·클래스)

코어 스택은 `pom.xml`로 확인된다.

| 영역 | 기술 / 버전 | 비고 |
| --- | --- | --- |
| 프레임워크 | Spring Boot 4.0.6 / Java 21 | `spring-boot-starter-webmvc` |
| 패키징 | WAR + 임베디드 Tomcat | `ServletInitializer`, `provided` Tomcat |
| 뷰 | JSP / JSTL / EL | `tomcat-embed-jasper`, `spring.mvc.view.prefix/suffix` |
| 영속성 | MyBatis 4.0.1 + MySQL | `@Mapper` + `resources/mapper/*.xml` |
| 보안 | Spring Security crypto/config/web | `BCryptConfig`, `SecurityConfig`(CSRF 부분) |
| AOP | spring-aop + aspectjweaver | `@RequireLogin`/`@RequireAdmin` |
| 메일 | spring-boot-starter-mail | 이메일 인증·비번 재설정 |
| 외부 HTTP | OkHttp 5.3.2 | AI/외부 API 호출 |
| 이미지 | Cloudinary 2.3.2 | 업로드·CDN (ADR-0007) |
| Excel | Apache POI 5.5.1 | 관리자 내보내기 |
| WAF | AWS SDK v2 (wafv2) | 로그인 위험 차단 어댑터 |
| 정화 | jsoup 1.17.2 | XSS 서버 정화 (ADR-0005) |
| 모니터링 | actuator | 헬스/메트릭 |

패키지 경로는 `org.triptogether.*` 아래 도메인별로 나뉜다: `auth`, `community`, `courses`, `explore`/`detail`, `inquiry`, `myPage`, `report`, `admin`, `superAdmin`, `reward`, `shop`, `travelPackage`, `flight`, `assistant`, `common`, `config`, `cloudinary`, `moderation`, `perspective`. 컨텍스트 패스는 `/TripTogether`다.

:::tip 4계층 패턴
각 도메인은 같은 모양을 반복한다. 한 도메인을 이해하면 나머지가 같은 골격이라 빠르게 읽힌다.

```text
controller   요청 받기·검증·뷰/JSON 반환 (@Controller / @RestController)
   ↓
service      비즈니스 규칙 (인터페이스 + ServiceImpl, @Transactional)
   ↓
mapper       @Mapper 인터페이스 ↔ resources/mapper/XxxMapper.xml (SQL)
   ↓
vo           DB 행·도메인 데이터 (UsersVO 등)
```
:::

## 4. 동작 원리 (요청 한 건의 여정)

브라우저 요청 하나가 어떤 관문을 통과하는지가 백엔드의 핵심 그림이다. `WebConfig.addInterceptors`에 등록된 순서가 그대로 실행 순서다.

```text
요청
 → DispatcherServlet
 → 인터셉터 체인 (등록 순서대로)
     1 locale          ?lang= 로 언어 결정 (SessionLocaleResolver)
     2 ipBlock         CIDR 기반 IP 차단 검사
     3 activityLog     활동 로그 적재
     4 login           @Require 보호 경로 로그인 확인
     5 admin           관리자 권한
     6 superAdmin       /superAdmin/** 슈퍼관리자
     7 adminMode        관리자 모드 토글
     8 notification     읽지 않은 알림 수 모델 주입
 → Controller (AOP @RequireLogin/@RequireAdmin 재확인, @LoginUser 주입)
 → Service (@Transactional)
 → Mapper → SQL → MySQL
 → JSP 렌더링  또는  JSON 응답(AJAX·AI)
```

- **인증**: 로그인 성공 시 세션 속성 `loginUser = UsersVO`. 컨트롤러는 `@LoginUser UsersVO user`로 자동 주입받는다(별도 ArgumentResolver).
- **권한**: `@RequireLogin` / `@RequireAdmin` 어노테이션을 `AuthorizationAspect`(AOP)가 가로채 차단한다. 인터셉터가 경로 단위 1차 관문, AOP가 메서드 단위 2차 관문이다 (ADR-0011).
- **소프트 삭제**: 실제 DELETE 대신 상태 컬럼(`account_status`, `post_status`, `comment_status`, `is_deleted`)을 바꿔 복구·감사 가능성을 남긴다 (ADR-0008).
- **예외**: `GlobalExceptionHandler`가 `BusinessException`·`UnauthorizedException(401)`·`ForbiddenException(403)`·`NotFoundException(404)` 등을 일관된 형태로 변환한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::warning 정직한 상태 구분
면접에서 과장하지 않는 것이 신뢰를 만든다.
:::

- 구현됨: 4계층·세션 인증·인터셉터 체인·AOP 권한·MyBatis XML 매퍼·소프트 삭제·다국어(ko/en/ja/zh)·이메일/OAuth·Cloudinary 업로드·SSE 알림·관리자 모더레이션·다중 AI 모델 연동·Toss 결제 충전 흐름.
- Mock/부분: **항공권(`flight`)은 Mock 프로바이더**다. `FlightOfferProvider` 인터페이스로 추상화는 해뒀지만 실제 외부 항공 API는 미연동이다.
- 계획/한계: **AI 응답 품질 정량평가 체계 부재**, **모바일은 JSP 데스크톱 레이아웃 위주**(반응형/SPA 향후), **Swagger 부재**. CSRF는 일부 폼만 적용(ADR-0012).

## 6. 면접 답변 3단계

1. **한 문장**: "TripTogether 백엔드는 Spring Boot 4 + MyBatis + JSP 기반 단일 WAR 모놀리식으로, 컨트롤러–서비스–매퍼–VO 4계층에 세션 인증과 인터셉터·AOP 횡단 처리를 얹은 구조입니다."
2. **설계 의도**: "넓은 여행 도메인을 한 팀이 빠르게 통합하려고 SPA 분리 대신 서버사이드 렌더링을 택했고, 복잡한 집계 SQL을 직접 제어하려고 JPA가 아닌 MyBatis를 썼습니다."
3. **차별점**: "권한·로깅·알림·차단·다국어를 인터셉터 체인과 AOP로 빼서 컨트롤러는 비즈니스만 남겼고, 운영 정책은 DB 런타임 설정으로 외부화해 재배포 없이 조정합니다."

## 7. 꼬리질문 + 모범답안

:::details Q. 왜 JPA 대신 MyBatis인가?
회원 360 뷰, 태그 공출현 카운트, 통계 집계처럼 **손으로 짠 복잡한 SQL이 필요한 화면**이 많았습니다. ORM이 자동 생성하는 쿼리보다 XML 매퍼로 SQL을 직접 쥐는 편이 성능 튜닝과 가독성 면에서 유리하다고 판단했습니다. 단순 CRUD가 대부분이었다면 JPA가 생산성에서 앞섰을 겁니다.
:::

:::details Q. 인터셉터와 AOP 권한 체크가 중복 아닌가?
역할이 다릅니다. 인터셉터는 **URL 경로 단위 1차 관문**(IP 차단·로그인·관리자 경로)이고, AOP `AuthorizationAspect`는 **컨트롤러 메서드 단위 2차 관문**으로 `@RequireLogin`/`@RequireAdmin`을 강제합니다. 경로 매핑으로 잡기 애매한 메서드 단위 권한을 어노테이션으로 선언적으로 표현하기 위해 둘을 함께 둡니다.
:::

:::details Q. JSP인데 AJAX·AI 응답은 어떻게 처리하나?
화면은 JSP가 렌더링하지만, 알림·추천·AI 챗봇처럼 페이지 전환 없이 갱신할 부분은 컨트롤러가 `@ResponseBody`/JSON으로 응답합니다. 즉 **하이브리드**입니다 — 전체 페이지는 서버 렌더링, 동적 조각은 JSON으로 부분 갱신합니다.
:::

:::details Q. 단일 WAR 모놀리식의 단점과 대응은?
배포 단위가 하나라 부분 스케일아웃이 어렵고 빌드가 무겁습니다. 대신 도메인 패키지를 명확히 갈라 모듈 경계를 코드 레벨에서 유지했고, 외부 연동(AI·결제·이미지)은 인터페이스로 추상화해(예: `FlightOfferProvider`) 나중에 떼어내기 쉽게 만들었습니다.
:::

:::details Q. 비밀번호·시크릿은 어떻게 다루나?
비밀번호는 `BCryptPasswordEncoder`로 해싱해 평문을 저장하지 않습니다. API 키·DB 자격증명 같은 시크릿은 코드에 박지 않고 `application.properties`의 외부 설정 키(`API_KEY`, `DB_HOST` 같은 자리표시자)로 주입하며, 운영 중 바뀌는 정책 값은 DB 런타임 설정으로 분리합니다.
:::

## 8. 직접 말해보기

아래 질문에 막힘 없이 60초씩 답해보세요. 막히면 해당 상세 페이지로 돌아가세요.

- TripTogether 백엔드 스택을 한 문장으로 말하고, 왜 그렇게 골랐는지 한 가지씩 근거를 대보세요.
- 요청 하나가 들어와 JSP가 렌더링되기까지 거치는 관문(인터셉터·AOP)을 순서대로 설명해보세요.
- "이 기능은 진짜 동작하나요?"라는 질문에 Mock(항공권)과 구현된 부분을 정직하게 구분해 답해보세요.

## 권장 학습순서

1. [Spring Boot](/backend/spring-boot) — 자동 설정·임베디드 Tomcat·WAR
2. [Spring MVC](/backend/spring-mvc) — DispatcherServlet·컨트롤러·뷰 해석
3. [MyBatis](/backend/mybatis) — `@Mapper`와 XML SQL
4. [MySQL 스키마](/backend/mysql-schema) — 테이블·소프트 삭제 컬럼
5. [JSP · JSTL · EL](/backend/jsp-jstl-el) — 서버사이드 렌더링
6. [인터셉터 체인](/backend/interceptors) — 8단계 관문 순서
7. [AOP 권한 체크](/backend/aop-authorization) · [@LoginUser 리졸버](/backend/login-user-resolver)
8. [예외 처리](/backend/exception-handling) · [입력 검증](/backend/validation)
9. 부가: [Cloudinary 업로드](/backend/file-upload-cloudinary) · [이메일](/backend/mail) · [런타임 설정](/backend/runtime-settings) · [OkHttp](/backend/okhttp)

## 단골 면접 질문 5개

1. TripTogether 백엔드 아키텍처를 30초 안에 설명해보세요. (4계층·모놀리식·JSP)
2. 왜 JPA가 아니라 MyBatis인가요?
3. 인증/권한을 어디서(세션·인터셉터·AOP) 어떻게 나눠 처리하나요?
4. 데이터를 실제로 지우지 않고 소프트 삭제하는 이유는 무엇인가요? (ADR-0008)
5. 외부 연동(AI·결제·항공권) 중 실제 구현과 Mock을 구분해 설명해보세요.

## 퀴즈

<QuizBox question="TripTogether 백엔드의 영속성 계층 기술은 무엇인가?" :choices="['JPA / Hibernate', 'MyBatis (@Mapper + XML)', 'Spring Data JDBC', '순수 JDBC Template']" :answer="1" explanation="JPA가 아니라 MyBatis 4.0.1을 사용한다. @Mapper 인터페이스와 resources/mapper/*.xml SQL을 짝지어, 복잡한 집계 쿼리를 직접 제어한다." />

<QuizBox question="인터셉터 체인에서 가장 먼저 실행되어 ?lang= 파라미터로 언어를 결정하는 단계는?" :choices="['login', 'ipBlock', 'locale', 'notification']" :answer="2" explanation="WebConfig 등록 순서상 locale 인터셉터가 가장 먼저다. 이후 ipBlock → activityLog → login → admin → superAdmin → adminMode → notification 순으로 이어진다." />

<QuizBox question="현재 실제 외부 API가 미연동되어 Mock 프로바이더로만 동작하는 기능은?" :choices="['Cloudinary 이미지 업로드', '항공권(flight) 검색', 'OAuth 소셜 로그인', 'SSE 실시간 알림']" :answer="1" explanation="항공권은 FlightOfferProvider 인터페이스로 추상화는 되어 있으나 실제 외부 항공 API는 연동되지 않은 Mock 상태다. 나머지는 구현되어 동작한다." />
