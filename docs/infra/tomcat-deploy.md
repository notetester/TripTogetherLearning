# Tomcat 배포

> TripTogether는 `war` 패키징 Spring Boot 앱이다. 같은 산출물 하나(`WAR`)를 개발 중에는 내장(embedded) Tomcat으로 띄우고, 운영에서는 외장(standalone) Tomcat에 그대로 배포할 수 있다.

## 1. 한 줄 정의

JSP를 쓰기 위해 `jar`가 아니라 **`war`로 패키징**하고, `ServletInitializer`로 외장 톰캣 진입점을 만들어 둔 Spring Boot 배포 구성이다. 컨텍스트 경로는 `/TripTogether` 로 고정한다.

## 2. 왜 이렇게 설계했나

- **JSP를 뷰로 쓰기 때문에 `war`가 강제된다.** Spring Boot 실행 가능 `jar`(fat jar) 안에서는 JSP가 정상 동작하지 않는다(`/WEB-INF` 클래스패스 한계). JSP/JSTL을 view로 쓰는 프로젝트는 사실상 `war` 패키징이 표준이다.
- **개발 편의 + 운영 유연성을 동시에.** 내장 톰캣으로는 IDE에서 `main()`만 눌러도 바로 뜨고, 동일한 `war`를 외장 톰캣 `webapps/`에 던지면 운영 WAS에 그대로 올라간다. 산출물이 하나라 "개발에선 되는데 배포에선 안 된다"는 격차를 줄인다.
- **컨텍스트 경로를 명시(`/TripTogether`)**해 외장 톰캣에서 여러 앱을 한 인스턴스에 올릴 때의 경로 충돌을 피하고, 내장/외장 어디서 띄워도 URL이 동일하게 유지되도록 했다.

:::tip war ≠ "실행 불가"
Spring Boot의 `war`는 **여전히 `java -jar`로 단독 실행 가능**하다. `main()`이 내장 톰캣을 띄우기 때문이다. 동시에 외장 톰캣 `webapps/`에 넣으면 WAS가 `ServletInitializer`를 진입점으로 인식한다. 한 산출물이 두 경로를 모두 지원한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·설정)

| 요소 | 실제 위치 / 값 | 역할 |
| --- | --- | --- |
| 패키징 | `pom.xml` → `<packaging>war</packaging>` | JSP 지원 + 외장 배포 가능 |
| 내장 톰캣 | `spring-boot-starter-tomcat` (scope `provided`) | 개발 시 내장 실행, 외장 배포 시 중복 제외 |
| JSP 엔진 | `tomcat-embed-jasper` + JSTL (`jakarta.servlet.jsp.jstl`) | `.jsp` 컴파일/렌더링 |
| 외장 진입점 | `org.triptogether.ServletInitializer` | `SpringBootServletInitializer` 확장 |
| 부트스트랩 | `org.triptogether.TripTogetherApplication` | `@SpringBootApplication`, `main()` |
| 컨텍스트 경로 | `application.properties` → `server.servlet.context-path=/TripTogether` | 모든 URL 접두사 |
| 뷰 리졸버 | `spring.mvc.view.prefix=/WEB-INF/views/`, `suffix=.jsp` | JSP 경로 매핑 |
| 빌드 래퍼 | `mvnw` / `mvnw.cmd` | Maven 미설치 환경 대응 |

**`provided` scope의 핵심.** `spring-boot-starter-tomcat`을 `provided`로 둔 이유는, 외장 톰캣에 배포할 때 톰캣 런타임을 WAS가 이미 제공하므로 `war` 안에 톰캣을 포함시키면 충돌이 나기 때문이다. 그러면서도 개발 시 `mvnw spring-boot:run`에서는 클래스패스에 올라와 내장 실행이 된다.

```java
// org.triptogether.ServletInitializer — 외장 톰캣이 찾는 진입점
public class ServletInitializer extends SpringBootServletInitializer {
    @Override
    protected SpringApplicationBuilder configure(SpringApplicationBuilder application) {
        return application.sources(TripTogetherApplication.class);
    }
}
```

```java
// org.triptogether.TripTogetherApplication — 내장 실행 진입점
@SpringBootApplication
@EnableScheduling   // SSE 알림 등 스케줄링
@EnableAsync        // 비동기 처리
public class TripTogetherApplication {
    public static void main(String[] args) {
        SpringApplication.run(TripTogetherApplication.class, args);
    }
}
```

:::details 왜 `ServletInitializer`가 따로 필요한가
외장 톰캣은 `main()`을 호출하지 않는다. 대신 서블릿 컨테이너가 `SpringBootServletInitializer` 구현체를 찾아 그것으로 Spring 컨텍스트를 부팅한다. `ServletInitializer.configure()`가 부트 앱 클래스를 가리켜 주므로, 내장(`main`)이든 외장(`ServletInitializer`)이든 같은 `TripTogetherApplication` 설정으로 수렴한다.
:::

## 4. 동작 원리 (두 가지 실행 경로)

**경로 A — 내장 톰캣(개발):**

```text
mvnw spring-boot:run
  → TripTogetherApplication.main()
  → SpringApplication.run(...)
  → 내장 Tomcat 기동 + DispatcherServlet 등록
  → context-path /TripTogether 적용
  → 예: http://localhost:8080/TripTogether/
```

**경로 B — 외장 톰캣(운영):**

```text
mvnw clean package           # → target/*.war 생성
  → war 를 외장 Tomcat webapps/ 에 복사
  → Tomcat 이 ServletInitializer 발견
  → configure() 로 TripTogetherApplication 부팅
  → context-path 는 application.properties 값 + 톰캣 배포명 규칙
```

| 항목 | 내장 톰캣 | 외장 톰캣 |
| --- | --- | --- |
| 진입점 | `main()` | `ServletInitializer` |
| 톰캣 런타임 | `war` 내 포함(개발) | WAS가 제공 (`provided`) |
| 실행 명령 | `mvnw spring-boot:run` 또는 `java -jar` | `webapps/`에 `war` 배치 |
| 용도 | 개발·로컬 검증 | 운영 배포 |

:::warning 컨텍스트 경로 이중 적용 주의
외장 톰캣은 보통 **WAR 파일명**을 컨텍스트 경로로 삼는다(`TripTogether.war` → `/TripTogether`). 여기에 `application.properties`의 `server.servlet.context-path=/TripTogether`가 또 적용되면 의도와 다른 경로가 될 수 있다. 운영 배포 시에는 톰캣 배포명과 `context-path` 설정을 일치시키거나, 외장 환경에서는 톰캣 쪽 컨텍스트 설정으로 일원화하는 것이 안전하다. 내장 실행에서는 이 충돌이 없다.
:::

## 5. 구현 상태 (됨 vs 계획)

- **됨:** `war` 패키징, 내장 톰캣 개발 실행, `ServletInitializer`를 통한 외장 톰캣 호환, `/TripTogether` 컨텍스트 경로, JSP/JSTL 렌더링, `mvnw`로 빌드/실행.
- **됨:** SSE 등 장시간 커넥션 대비 `server.tomcat.threads.max=500`로 톰캣 스레드 풀 확장.
- **계획/주의:** 현재는 단일 인스턴스 기준. **무중단 배포, 리버스 프록시(HTTPS 종단), 외부 세션 스토어(다중 인스턴스 시 세션 동기화)** 는 별도 구성 과제다. 세션 기반 인증(`loginUser`)이라 수평 확장 시 sticky session 또는 세션 클러스터링이 필요하다.
- **계획:** 컨테이너(이미지) 기반 배포·CI 자동화는 학습/데모 범위 밖이며, 산출물(`war`) 자체는 두 방식 모두 지원하도록 이미 준비되어 있다.

## 6. 면접 답변 3단계

1. **한 줄:** "JSP를 뷰로 쓰기 때문에 `war`로 패키징했고, 개발은 내장 톰캣, 운영은 외장 톰캣에 같은 `war`를 올리는 구조입니다."
2. **설계 의도:** "`spring-boot-starter-tomcat`을 `provided`로 둬서 외장 배포 시 톰캣 중복을 피하고, `ServletInitializer`로 외장 진입점을 만들어 내장/외장이 같은 부트 설정으로 수렴하게 했습니다. 컨텍스트 경로는 `/TripTogether`로 고정했습니다."
3. **한계 인식:** "세션 기반 인증이라 다중 인스턴스로 확장하면 세션 공유가 필요하고, HTTPS 종단·무중단 배포는 프록시/오케스트레이션 레벨의 추가 과제로 남아 있습니다."

## 7. 꼬리질문 + 모범답안

::: details Q. 왜 `jar`가 아니라 `war`로 패키징했나요?
JSP를 view로 쓰기 때문입니다. Spring Boot 실행형 `jar` 안에서는 JSP가 정상 동작하지 않아(`/WEB-INF` 리소스 로딩 한계), JSP/JSTL 뷰를 쓰는 프로젝트는 `war`가 사실상 표준입니다. 대신 `war`라도 `main()`이 내장 톰캣을 띄우므로 개발 실행은 그대로 됩니다.
:::

::: details Q. `spring-boot-starter-tomcat`을 왜 `provided` scope로 두나요?
외장 톰캣에 배포할 때는 WAS가 톰캣 런타임을 제공하므로, `war` 안에 톰캣을 또 넣으면 클래스 충돌이 납니다. `provided`로 두면 빌드 산출물에는 포함되지 않으면서, 개발 시 `spring-boot:run`에서는 클래스패스에 올라와 내장 실행이 가능합니다. 한 산출물로 두 배포 방식을 모두 지원하기 위한 표준 패턴입니다.
:::

::: details Q. `ServletInitializer`가 없으면 어떤 일이 생기나요?
내장 실행(`main()`)은 여전히 되지만, 외장 톰캣 배포 시 컨테이너가 부팅 진입점을 찾지 못해 Spring 컨텍스트가 뜨지 않습니다. `SpringBootServletInitializer`를 확장한 `ServletInitializer.configure()`가 부트 앱 클래스를 가리켜 줘야 외장 톰캣이 그것으로 애플리케이션을 기동합니다.
:::

::: details Q. 컨텍스트 경로 `/TripTogether`는 어디서 설정되며 왜 명시했나요?
`application.properties`의 `server.servlet.context-path=/TripTogether`입니다. 명시한 이유는 (1) 외장 톰캣에서 한 인스턴스에 여러 앱을 올릴 때 경로 충돌을 피하고, (2) 내장/외장 어디서 띄워도 URL 접두사가 동일하게 유지되도록 하기 위해서입니다. 단, 외장 톰캣은 WAR 파일명을 컨텍스트로 삼는 경우가 있어 배포명과의 일치에 주의해야 합니다.
:::

::: details Q. 이 앱을 여러 대로 수평 확장하려면 무엇이 문제인가요?
세션 기반 인증(세션 속성 `loginUser`)을 쓰기 때문에, 인스턴스가 늘면 요청이 다른 인스턴스로 갈 때 로그인 상태가 끊깁니다. sticky session(같은 사용자를 같은 인스턴스로) 또는 외부 세션 스토어/세션 클러스터링이 필요합니다. 또 SSE 알림 같은 서버 푸시도 인스턴스 간 라우팅을 고려해야 합니다.
:::

## 8. 직접 말해보기

- `war` vs `jar` 선택이 왜 JSP 사용에서 비롯됐는지, 그리고 `war`도 단독 실행 가능한 이유.
- `provided` scope가 내장·외장 두 실행 경로에서 각각 어떻게 동작하는지.
- 내장 실행(`main()`)과 외장 배포(`ServletInitializer`)가 어떻게 같은 부트 설정으로 수렴하는지.
- 컨텍스트 경로를 명시한 이점과, 외장 톰캣 배포명과의 충돌 주의점.
- 세션 인증 구조가 수평 확장에 주는 제약과 해결 방향(sticky session / 세션 공유).

## 퀴즈

<QuizBox
  question="TripTogether가 jar가 아닌 war로 패키징한 가장 직접적인 이유는?"
  :choices="['외장 톰캣 배포가 의무라서', 'JSP를 뷰로 사용하기 때문에', '내장 톰캣을 끄기 위해서', 'fat jar 용량을 줄이기 위해서']"
  :answer="1"
  explanation="JSP/JSTL을 view로 쓰면 실행형 jar 안에서 JSP가 정상 동작하지 않아 war 패키징이 사실상 강제된다. war라도 main()이 내장 톰캣을 띄워 개발 실행은 그대로 가능하다."
/>

<QuizBox
  question="spring-boot-starter-tomcat을 provided scope로 둔 이유로 가장 적절한 것은?"
  :choices="['테스트에서만 톰캣을 쓰려고', '외장 톰캣 배포 시 톰캣 런타임 중복/충돌을 피하려고', 'JSP 컴파일을 비활성화하려고', '컨텍스트 경로를 고정하려고']"
  :answer="1"
  explanation="외장 톰캣은 톰캣 런타임을 WAS가 제공하므로 war 안에 톰캣을 포함하면 충돌이 난다. provided로 두면 산출물에선 빠지고 개발 spring-boot:run에서는 내장 실행에 쓰인다."
/>

<QuizBox
  question="외장 톰캣 webapps/에 배포했을 때 Spring 컨텍스트를 부팅하는 진입점은?"
  :choices="['TripTogetherApplication.main()', 'DispatcherServlet', 'ServletInitializer(SpringBootServletInitializer)', 'application.properties']"
  :answer="2"
  explanation="외장 톰캣은 main()을 호출하지 않는다. SpringBootServletInitializer를 확장한 ServletInitializer.configure()가 부트 앱 클래스를 가리켜 컨테이너가 그것으로 애플리케이션을 기동한다."
/>

---

**관련 페이지**: [Maven · WAR 빌드](/infra/maven-war) · [설정·시크릿 관리](/infra/secrets-config) · [인프라 개요](/infra/)

**허브**: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
