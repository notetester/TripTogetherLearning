# Spring Boot

> TripTogether의 백엔드 토대. 자동설정(Auto-configuration)·내장 톰캣·스타터(Starter)로 설정을 줄이고, **WAR로 패키징**해 전통 서블릿 컨테이너 배포까지 함께 지원하는 Java 21 기반 애플리케이션.

이 페이지는 4명이 도메인을 나눠 만든 TripTogether에서 **모든 도메인이 공유하는 실행 토대**를 설명한다. 특정 담당자의 영역이 아니라, auth·community·courses·explore·assistant·admin 등 약 14~15개 모듈 전체가 같은 Spring Boot 컨텍스트 위에서 돌아간다.

## 1. 한 줄 정의

Spring Boot는 Spring 프레임워크 위에 **자동설정 + 내장 서버 + 의존성 스타터**를 얹어, `main()` 한 줄로 웹 애플리케이션을 띄우는 실행 런타임이다. TripTogether는 그 버전 **4.0.6**, JDK **21**, 패키징은 **WAR**를 쓴다.

## 2. 왜 이렇게 설계했나

- **설정 최소화로 도메인 로직에 집중**: 4명이 동시에 14개+ 모듈을 만든다. DispatcherServlet, DataSource, 트랜잭션 매니저, 인코딩 필터 같은 인프라를 각자 손으로 잡으면 충돌·중복이 생긴다. 자동설정이 이 공통 인프라를 한곳에서 책임진다.
- **스타터로 의존성 묶음 관리**: `spring-boot-starter-parent`가 라이브러리 버전을 정렬(BOM)해, OkHttp·AWS SDK·MyBatis처럼 부모가 직접 안 잡는 것만 `pom.xml`에서 버전을 명시한다. "버전 지옥"을 줄인다.
- **WAR 패키징 선택은 의도적**: JSP(JSTL/EL) 뷰를 쓰기 때문이다. JSP는 서블릿 컨테이너의 JSP 엔진(Jasper)이 컴파일해야 한다. 그래서 내장 톰캣으로 개발하면서도, 산출물은 WAR로 만들어 외부 톰캣에도 그대로 올릴 수 있게 했다. 실행형 JAR보다 전통 배포 친화적이다.
- **Java 21(LTS)**: 최신 LTS로 record·switch 패턴·virtual thread 등 신문법과 장기 보안 지원을 확보.

:::tip 핵심 직관
"Spring Boot = Spring + 자동설정 + 내장 서버 + 스타터." 그리고 TripTogether에서는 여기에 **WAR + JSP**라는 전통 웹 스택을 결합한 것이 특징이다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·설정)

| 요소 | 실제 위치 / 값 |
| --- | --- |
| 부모 POM | `spring-boot-starter-parent` 4.0.6 |
| 진입점 | `org.triptogether.TripTogetherApplication` (`@SpringBootApplication`) |
| WAR 부트스트랩 | `org.triptogether.ServletInitializer extends SpringBootServletInitializer` |
| 패키징 | `<packaging>war</packaging>` (Maven) |
| 자바 | `<java.version>21</java.version>` |
| 핵심 스타터 | `spring-boot-starter-webmvc`, `mybatis-spring-boot-starter`, `spring-boot-starter-mail`, `spring-boot-starter-actuator` |
| 내장 서버 | `spring-boot-starter-tomcat`(scope `provided`) + `tomcat-embed-jasper`(JSP 컴파일) |
| 설정 파일 | `src/main/resources/application.properties`, `application-local.properties` |

`@SpringBootApplication`은 사실상 세 애너테이션의 합성이다.

```java
@SpringBootApplication          // = @Configuration + @EnableAutoConfiguration + @ComponentScan
@EnableScheduling               // 주기 작업(스케줄러) 활성화
@EnableAsync                    // 비동기 실행(@Async) 활성화 — SSE 알림 푸시 등
public class TripTogetherApplication {
    public static void main(String[] args) {
        SpringApplication.run(TripTogetherApplication.class, args);
    }
}
```

- `@EnableAutoConfiguration`: 클래스패스에 mysql-connector-j와 MyBatis가 있으면 DataSource·SqlSessionFactory를 자동 구성한다.
- `@ComponentScan`: `org.triptogether` 패키지 하위의 `@Controller`/`@Service`/`@Mapper` 등을 자동 등록한다. 그래서 도메인별 폴더만 만들면 빈으로 잡힌다.
- `@EnableScheduling`·`@EnableAsync`: 알림(SSE) 푸시, 주기성 작업 같은 크로스 도메인 기능을 위해 진입점에서 한 번에 켠다.

WAR로 외부 톰캣에 올릴 때는 `ServletInitializer`가 `web.xml` 없이 자바 코드로 `TripTogetherApplication`을 부트스트랩한다(서블릿 3.0+ 방식).

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 부팅 흐름

```text
main() / 외부 톰캣
   ↓
SpringApplication.run( TripTogetherApplication )
   ↓ ① 클래스패스 스캔 → 어떤 자동설정을 켤지 결정
   ↓ ② ApplicationContext(빈 컨테이너) 생성
   ↓ ③ @ComponentScan: org.triptogether.** 빈 등록
   ↓ ④ 자동설정: DataSource · SqlSessionFactory · DispatcherServlet · 인코딩 필터 …
   ↓ ⑤ 내장 톰캣 시작 → context-path /TripTogether 바인딩
   ↓ ⑥ 인터셉터 체인·AOP·예외 핸들러 결합 후 요청 수신
```

### 4-2. 자동설정이 켜지는/꺼지는 조건 (조건부 구성)

자동설정은 무조건 켜지지 않는다. **클래스패스에 무엇이 있는지**에 따라 조건부로 동작한다.

| 클래스패스에 존재 | 자동으로 구성되는 것 |
| --- | --- |
| `spring-boot-starter-webmvc` | DispatcherServlet, 메시지 컨버터(Jackson), 정적 리소스 핸들러 |
| `mysql-connector-j` + datasource 속성 | HikariCP DataSource, JDBC 트랜잭션 매니저 |
| `mybatis-spring-boot-starter` | SqlSessionFactory, `@Mapper` 스캔, mapper XML 로딩 |
| `spring-boot-starter-mail` | `JavaMailSender` (이메일 인증 발송) |
| `spring-boot-starter-actuator` | `/actuator/**` 헬스·상태 엔드포인트 |

즉 "의존성을 추가하면 설정이 따라온다"가 자동설정의 본질이다. 직접 `@Bean`을 선언하면 자동설정보다 사용자 정의가 우선한다.

### 4-3. 외부화 설정 (Externalized Configuration)

핵심 설정은 `application.properties`에 키-값으로 두고, 환경별 차이는 `application-local.properties`(프로파일 `local`)로 분리한다. 코드와 환경값을 떼어놓는다.

```properties
spring.application.name=TripTogether
server.servlet.context-path=/TripTogether     # 모든 URL이 /TripTogether 하위
server.tomcat.threads.max=500                  # SSE 장시간 커넥션 대비 스레드 확장
spring.mvc.view.prefix=/WEB-INF/views/         # JSP 뷰 경로 prefix
spring.mvc.view.suffix=.jsp                    # JSP 뷰 경로 suffix
spring.servlet.encoding.force=true             # 요청/응답 UTF-8 강제
spring.datasource.url=jdbc:mysql://DB_HOST:3306/DB_NAME...
spring.datasource.username=DB_USER
spring.datasource.password=DB_PASSWORD
```

:::warning 공개 문서에서의 자리표시자
위 예시의 `DB_HOST`/`DB_USER`/`DB_PASSWORD`나 각종 API 키는 **자리표시자**다. 실제 저장소의 `application.properties`에는 운영 비밀값이 들어가므로, 학습 자료·발표 자료에는 절대 실값을 옮기지 않는다. 운영에서는 환경변수·외부 시크릿으로 주입하는 것이 정석이다.
:::

또한 일부 설정값은 정적 파일이 아니라 **DB 우선(런타임 설정)**으로 덮어쓰는 구조가 별도로 있다 — [런타임 설정](/backend/runtime-settings) 참고. `application.properties`는 기본값, DB의 `APPLICATION_RUNTIME_SETTING`이 우선값 역할이다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 자동설정 기반 부팅(`@SpringBootApplication`) | 구현됨 |
| WAR 패키징 + 내장 톰캣 + JSP(Jasper) | 구현됨 |
| 외부 톰캣용 `ServletInitializer` | 구현됨 |
| 프로파일 분리(`application-local.properties`) | 구현됨 |
| `@EnableScheduling` / `@EnableAsync` | 구현됨 |
| Actuator 헬스 엔드포인트 의존성 | 구현됨(기본 노출 범위) |
| 시크릿 외부화(환경변수/시크릿 매니저) | **부분/계획** — 현재 일부 키가 properties에 존재, 운영 외부화는 향후 과제 |
| API 문서화(Swagger/OpenAPI) | **미도입** |
| 모바일 반응형/SPA | **계획** — 현재 JSP 데스크톱 레이아웃 위주 |

## 6. 면접 답변 3단계

1. **한 문장**: "Spring Boot 4.0.6과 Java 21 기반이고, 자동설정·내장 톰캣·스타터로 인프라 설정을 줄이되, JSP 뷰를 쓰기 때문에 산출물은 WAR로 패키징해 전통 톰캣 배포까지 지원합니다."
2. **왜**: "4명이 14개 넘는 도메인을 동시에 만들기 때문에, DispatcherServlet·DataSource·트랜잭션 같은 공통 인프라를 자동설정에 맡기고 각자 도메인 로직에 집중하게 했습니다. JSP+JSTL을 선택했으니 JSP 엔진이 필요해 WAR로 갔고, 그래서 내장 톰캣으로 개발하면서도 외부 컨테이너 호환을 동시에 얻었습니다."
3. **어떻게**: "`@SpringBootApplication`을 단 `TripTogetherApplication`이 진입점이고, WAR 배포용으로 `SpringBootServletInitializer`를 상속한 `ServletInitializer`를 둡니다. context-path는 `/TripTogether`, 뷰는 `spring.mvc.view.prefix/suffix`로 `/WEB-INF/views/*.jsp`에 매핑하고, 환경값은 properties로 외부화하며 일부는 DB 런타임 설정으로 덮어씁니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 실행형 JAR가 아니라 WAR로 했나요?
JSP를 뷰로 쓰기 때문입니다. JSP는 서블릿 컨테이너의 Jasper 엔진이 컴파일해야 동작하는데, 이는 WAR + 톰캣 조합에서 가장 매끄럽습니다. 그래서 `spring-boot-starter-tomcat`을 `provided` 스코프로 두고 `tomcat-embed-jasper`를 추가했습니다. 개발 시엔 내장 톰캣으로 띄우고, 배포 산출물은 WAR라 외부 톰캣에도 그대로 올릴 수 있습니다. 만약 Thymeleaf 같은 템플릿 엔진을 썼다면 실행형 JAR가 더 단순했을 겁니다.
:::

:::details Q2. 자동설정은 어떻게 "켤지 말지"를 결정하나요?
조건부 구성입니다. Spring Boot는 클래스패스에 어떤 클래스/빈이 있는지(`@ConditionalOnClass`, `@ConditionalOnMissingBean` 등)를 보고 자동설정을 적용합니다. 예를 들어 `mysql-connector-j`와 datasource 속성이 있으면 HikariCP DataSource를 자동 구성하고, MyBatis 스타터가 있으면 SqlSessionFactory를 만듭니다. 제가 직접 같은 타입의 `@Bean`을 선언하면 그 사용자 정의가 자동설정을 덮어씁니다.
:::

:::details Q3. `ServletInitializer`는 왜 필요한가요? 없으면 안 되나요?
실행형 JAR로 `main()`만 돌릴 거라면 필요 없습니다. 하지만 WAR를 **외부** 톰캣에 배포하면 컨테이너가 `main()`을 호출하지 않습니다. 이때 `SpringBootServletInitializer`를 상속한 클래스가 `web.xml` 없이 자바 코드로 Spring 컨텍스트를 부트스트랩합니다. TripTogether는 두 경로(내장/외부) 모두 지원하려고 둘 다 갖췄습니다.
:::

:::details Q4. context-path가 `/TripTogether`인 이유와 영향은?
한 톰캣에 여러 앱을 올릴 때를 대비해 애플리케이션을 고유 경로로 격리합니다. 영향은 모든 URL·리다이렉트·정적 리소스·OAuth 콜백·이메일 링크가 `/TripTogether` 접두를 가져야 한다는 점입니다. 그래서 링크 생성 시 `app.base-url` 같은 설정값으로 절대 URL을 만들고, JSP에선 컨텍스트 경로를 붙여 깨지지 않게 합니다.
:::

:::details Q5. 설정값은 어디에 두고, 비밀값은 어떻게 관리하나요?
기본값은 `application.properties`에, 환경 차이는 `application-local.properties`(프로파일 `local`)에 둡니다. 일부 운영 가변값은 DB의 `APPLICATION_RUNTIME_SETTING`에서 우선 적용해 재배포 없이 바꿉니다(`is_secret` 플래그로 민감값 구분). 다만 현재 일부 API 키가 properties에 남아 있어, 운영에서는 환경변수·시크릿 매니저로 외부화하는 것이 정석이고 향후 과제로 봅니다. 공개 자료에는 절대 실값을 노출하지 않습니다.
:::

:::details Q6. Spring Boot 4.x에서 starter 구성이 달랐던 점이 있나요?
네. 이 버전에서는 일부 모듈을 스타터로 한 번에 못 잡아 직접 명시했습니다. AOP는 `spring-aop` + `aspectjweaver`를, 보안(CSRF 부분 도입)은 `spring-security-config` + `spring-security-web`을 모듈 단위로 추가했습니다. 부모 POM이 버전을 정렬하지 않는 OkHttp·AWS SDK·MyBatis 등은 `pom.xml`에서 BOM/버전을 직접 관리했습니다.
:::

## 8. 직접 말해보기

아래를 소리 내어 30초 안에 답해보자.

- "이 프로젝트는 JAR가 아니라 WAR로 패키징했는데, 그 이유를 한 문장으로?"
- "`@SpringBootApplication`을 풀어서 설명하고, 자동설정이 무엇을 자동으로 만들어주는지 2개 예를 들면?"
- "비밀 설정값을 코드에서 어떻게 분리했고, 운영에서 더 개선한다면?"

## 관련 페이지

- [백엔드 개요](/backend/)
- [Spring MVC](/backend/spring-mvc) · [MyBatis](/backend/mybatis) · [런타임 설정(DB 우선)](/backend/runtime-settings)
- 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="TripTogether가 실행형 JAR가 아니라 WAR로 패키징한 가장 직접적인 이유는?"
  :choices="['MySQL 연결이 WAR에서만 가능해서', 'JSP 뷰를 쓰기 때문에 서블릿 컨테이너의 JSP(Jasper) 엔진이 필요해서', 'Spring Boot 4.x는 JAR 패키징을 지원하지 않아서', 'WAR가 JAR보다 항상 빠르기 때문에']"
  :answer="1"
  explanation="JSP는 Jasper 엔진이 컴파일해야 하고, 이는 WAR+톰캣 조합에서 매끄럽다. 그래서 starter-tomcat을 provided로 두고 tomcat-embed-jasper를 추가했다."
/>

<QuizBox
  question="@SpringBootApplication 한 애너테이션이 합성하는 세 가지가 아닌 것은?"
  :choices="['@Configuration', '@EnableAutoConfiguration', '@ComponentScan', '@EnableScheduling']"
  :answer="3"
  explanation="@SpringBootApplication은 @Configuration + @EnableAutoConfiguration + @ComponentScan의 합성이다. @EnableScheduling/@EnableAsync는 진입점에 별도로 추가한 애너테이션이다."
/>

<QuizBox
  question="Spring Boot 자동설정이 DataSource·SqlSessionFactory를 자동 구성하는 판단 기준에 가장 가까운 것은?"
  :choices="['application.properties 파일 이름', '클래스패스에 어떤 드라이버/라이브러리와 속성이 존재하는지(조건부 구성)', '서버의 운영체제 종류', 'WAR인지 JAR인지 패키징 형태']"
  :answer="1"
  explanation="자동설정은 @ConditionalOnClass 등 조건부 구성으로, 클래스패스에 있는 라이브러리와 설정 속성에 따라 켜지고 꺼진다. 사용자가 같은 타입 @Bean을 선언하면 그것이 우선한다."
/>
