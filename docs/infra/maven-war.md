# Maven · WAR 빌드

> TripTogether의 빌드 도구는 **Maven**이고, 산출물은 실행형 JAR가 아니라 **WAR**다. `spring-boot-starter-parent` 4.0.6이 의존성 버전을 정렬하고, `tomcat-embed-jasper`로 JSP를 컴파일하며, `spring-boot-starter-tomcat`을 `provided`로 묶어 내장·외부 톰캣 양쪽 배포를 동시에 지원한다.

이 페이지는 4명이 도메인을 나눠 만든 TripTogether에서 **모든 도메인이 공유하는 빌드 토대**를 다룬다. auth·community·courses·explore·assistant·inquiry·admin 등 약 14~15개 모듈이 전부 하나의 `pom.xml`, 하나의 WAR로 묶여 나간다. 특정 담당자의 영역이 아니라 프로젝트 전체의 공통 인프라다.

## 1. 한 줄 정의

Maven은 `pom.xml`(Project Object Model) 하나로 **의존성 관리 + 빌드 수명주기 + 패키징**을 표준화하는 도구이고, TripTogether는 그 패키징 형식을 `war`로 지정해 `./mvnw clean package` 한 번으로 톰캣에 올릴 수 있는 `.war`를 만든다.

## 2. 왜 이렇게 설계했나

- **버전 충돌 방지 (BOM 정렬)**: 4명이 14개+ 모듈을 동시에 만들면 라이브러리 버전이 어긋나기 쉽다. `spring-boot-starter-parent`가 Spring·Jackson·Tomcat 등 대부분의 버전을 한 줄로 고정하고, 부모가 다루지 않는 OkHttp·AWS SDK·MyBatis는 `<dependencyManagement>`에서 BOM import로 따로 정렬한다. 개별 의존성에 버전을 흩뿌리지 않는다.
- **WAR 선택은 JSP 때문 (의도적)**: 뷰가 JSP(JSTL/EL)다. JSP는 서블릿 컨테이너의 JSP 엔진(Jasper)이 런타임에 컴파일해야 동작한다. 그래서 산출물을 WAR로 만들어 외부 톰캣에 그대로 올릴 수 있게 하고, 개발 중에는 내장 톰캣으로 띄운다. Thymeleaf였다면 실행형 JAR가 더 단순했겠지만, JSP 스택에서는 WAR가 정석이다.
- **내장 톰캣을 `provided`로 둔 이유**: WAR를 외부 톰캣에 배포하면 컨테이너가 자체 톰캣을 제공한다. 이때 WAR 안에 톰캣이 또 들어 있으면 클래스 충돌이 난다. 그래서 `spring-boot-starter-tomcat`을 `provided` 스코프로 둬 **WAR에는 포함시키지 않되 개발/컴파일 시엔 쓰도록** 한다.
- **재현 가능한 빌드 (Maven Wrapper)**: 팀원마다 Maven 설치 버전이 다르면 빌드가 흔들린다. `mvnw`/`mvnw.cmd`를 커밋해 모두가 동일한 Maven 버전(3.9.14)으로 빌드하게 고정했다.

:::tip 핵심 직관
"Maven = pom.xml로 의존성·빌드·패키징을 표준화." TripTogether에서는 여기에 **packaging=war + provided 톰캣 + jasper**라는 세 선택이 결합되어, *하나의 산출물로 내장·외부 톰캣을 모두 지원*하는 것이 특징이다.
:::

## 3. 어떤 기술로 구현했나 (실제 설정)

| 요소 | 실제 값 / 위치 (`pom.xml`) |
| --- | --- |
| 부모 POM | `spring-boot-starter-parent` 4.0.6 |
| 좌표(GAV) | `org.study:TravelProject:0.0.1-SNAPSHOT` |
| 패키징 | `<packaging>war</packaging>` |
| 자바 | `<java.version>21</java.version>`, 빌드 인코딩 UTF-8 |
| 내장 서버 | `spring-boot-starter-tomcat` (scope `provided`) |
| JSP 컴파일 | `tomcat-embed-jasper` + JSTL API/구현 |
| BOM import | `okhttp-bom`, AWS SDK v2 `bom`, MyBatis 스타터 (`<dependencyManagement>`) |
| 직접 버전 명시 | Cloudinary 2.3.2, POI 5.5.1, jsoup 1.17.2 |
| 빌드 플러그인 | `maven-compiler-plugin`(Lombok 애너테이션 프로세서), `spring-boot-maven-plugin`(Lombok 패키징 제외) |
| Maven Wrapper | `mvnw` / `mvnw.cmd`, `.mvn/wrapper/maven-wrapper.properties` → Maven 3.9.14 (`distributionType=only-script`) |

### 3-1. 패키징과 톰캣 스코프 (핵심 3블록)

```xml
<!-- ① WAR로 패키징 -->
<packaging>war</packaging>

<!-- ② 내장 톰캣: provided → WAR 산출물에는 빼고, 컴파일/개발 때만 사용 -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-tomcat</artifactId>
  <scope>provided</scope>
</dependency>

<!-- ③ JSP 엔진: JSP(JSTL/EL)를 컴파일하려면 Jasper 필요 -->
<dependency>
  <groupId>org.apache.tomcat.embed</groupId>
  <artifactId>tomcat-embed-jasper</artifactId>
</dependency>
```

### 3-2. 버전 정렬 — 부모 BOM + 추가 BOM import

부모 POM이 잡아주지 않는 라이브러리군은 `<dependencyManagement>`에서 BOM을 import해 *버전을 한 곳에 모은다*. 그래서 실제 `<dependencies>`의 OkHttp·AWS 의존성에는 버전 태그가 없다.

```xml
<dependencyManagement>
  <dependencies>
    <dependency>   <!-- OkHttp 5.3.2 계열 정렬 -->
      <groupId>com.squareup.okhttp3</groupId>
      <artifactId>okhttp-bom</artifactId>
      <version>${okhttp.version}</version>
      <type>pom</type><scope>import</scope>
    </dependency>
    <dependency>   <!-- AWS SDK v2 (WAFv2 등) 정렬 -->
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>bom</artifactId>
      <version>${aws.java.sdk.version}</version>
      <type>pom</type><scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

:::warning Spring Boot 4.x에서 직접 명시한 것
이 버전에는 일부 스타터가 없어 모듈을 직접 추가했다 — AOP는 `spring-aop` + `aspectjweaver`, 보안(CSRF 부분 도입, ADR-0012)은 `spring-security-config` + `spring-security-web`. 빈 말이 아니라 `pom.xml` 주석에도 그 이유가 적혀 있다.
:::

## 4. 동작 원리 (빌드 수명주기·흐름)

### 4-1. Maven 빌드 수명주기 (build lifecycle)

`package`를 호출하면 그 앞 단계가 순서대로 자동 실행된다. 즉 `package` 하나가 컴파일·테스트·패키징을 모두 포함한다.

```text
validate → compile → test → package → verify → install → deploy
                ↑        ↑        ↑
       maven-compiler   JUnit   spring-boot-maven-plugin
       (+Lombok AP)    (테스트)  (repackage → 실행 가능한 WAR)
```

| 명령 | 하는 일 |
| --- | --- |
| `./mvnw clean` | `target/` 산출물 삭제 |
| `./mvnw compile` | `src/main/java` 컴파일 (Lombok 애너테이션 처리 포함) |
| `./mvnw test` | JUnit 테스트 실행 (ADR-0014) |
| `./mvnw package` | 위 단계 + `target/TravelProject-0.0.1-SNAPSHOT.war` 생성 |
| `./mvnw clean package -DskipTests` | 클린 후 테스트 생략하고 WAR만 |
| `./mvnw spring-boot:run` | 내장 톰캣으로 즉시 실행 (개발용, context-path `/TripTogether`) |

### 4-2. `spring-boot-maven-plugin`이 WAR를 "다시 포장"한다

`package` 단계에서 이 플러그인이 일반 WAR를 한 번 더 가공(repackage)해, **외부 톰캣에도 올라가고 내장 톰캣으로 `java -jar`처럼 직접 실행도 되는** 실행 가능한 WAR를 만든다. Lombok은 컴파일에만 필요한 도구라 최종 산출물에서는 제외한다.

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <excludes>
      <exclude>                         <!-- Lombok: 런타임 불필요 → WAR에서 제외 -->
        <groupId>org.projectlombok</groupId>
        <artifactId>lombok</artifactId>
      </exclude>
    </excludes>
  </configuration>
</plugin>
```

### 4-3. 의존성 스코프가 산출물을 결정한다

스코프는 "이 라이브러리가 언제 필요하고 WAR에 들어가는가"를 정한다. WAR 크기와 충돌 회피의 핵심이다.

| 스코프 | 의미 | TripTogether 예 |
| --- | --- | --- |
| (기본) `compile` | 컴파일·런타임·패키징 모두 포함 | OkHttp, Cloudinary, POI, jsoup, MyBatis |
| `runtime` | 컴파일엔 불필요, 실행 시 필요 | `mysql-connector-j` |
| `provided` | 컴파일엔 필요, **WAR엔 미포함** (컨테이너가 제공) | `spring-boot-starter-tomcat` |
| `test` | 테스트에서만 | `mybatis-spring-boot-starter-test`, webmvc-test |
| `optional`/제외 | 도구성, 산출물에서 빼기 | Lombok |

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Maven 빌드 + WAR 패키징 | 구현됨 |
| `provided` 톰캣 + `tomcat-embed-jasper`(JSP 컴파일) | 구현됨 |
| `spring-boot-maven-plugin` repackage | 구현됨 |
| BOM import 버전 정렬(OkHttp/AWS/MyBatis) | 구현됨 |
| Maven Wrapper(`mvnw`, 3.9.14 고정) | 구현됨 |
| JUnit 테스트 단계 결합 | 구현됨 (ADR-0014) |
| CI 파이프라인(자동 빌드/배포) | **문서·런타임 기준 미확인** — 수동 `mvnw` 빌드 위주 |
| 멀티 프로파일 빌드 프로파일(`<profiles>`) | **계획/미도입** — 환경 분리는 주로 `application-{프로파일}.properties`로 처리 |
| 컨테이너 이미지(Docker) 빌드 | **계획** |

:::tip 정직한 경계
빌드 자체는 안정적으로 동작하지만, "빌드 → 테스트 → 배포"를 자동화하는 CI/CD와 Docker 이미지화는 현재 저장소 기준으로 확인되지 않는다. 현 시점의 표준 절차는 *로컬 또는 서버에서 `./mvnw clean package`로 WAR를 만들고 톰캣에 올리는* 방식이다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: "빌드는 Maven으로 하고, JSP 뷰를 쓰기 때문에 산출물은 실행형 JAR가 아니라 WAR로 패키징해 `./mvnw clean package` 한 번으로 톰캣 배포용 `.war`를 만듭니다."
2. **왜**: "JSP는 Jasper 엔진이 컴파일해야 해서 `tomcat-embed-jasper`를 넣고, 외부 톰캣 배포 시 충돌을 피하려고 `spring-boot-starter-tomcat`을 `provided`로 뒀습니다. 4명이 14개+ 모듈을 동시에 만들기 때문에 부모 POM과 BOM import로 OkHttp·AWS·MyBatis 버전까지 한곳에서 정렬해 버전 충돌을 막았습니다."
3. **어떻게**: "`<packaging>war</packaging>`에 부모는 `spring-boot-starter-parent` 4.0.6, Java 21입니다. `spring-boot-maven-plugin`이 `package` 단계에서 WAR를 repackage하고 Lombok은 산출물에서 제외합니다. Maven Wrapper로 팀 전체가 동일한 Maven 3.9.14로 빌드해 재현성을 확보합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. WAR와 실행형 JAR의 차이, 왜 WAR를 골랐나요?
실행형 JAR는 내장 서버를 안에 품고 `java -jar`로 단독 실행되는 자족형 산출물이고, WAR는 서블릿 컨테이너(톰캣)에 배포되는 웹 아카이브입니다. TripTogether는 뷰가 JSP라 Jasper 엔진이 필요했고, 외부 톰캣 호환까지 원해서 WAR를 골랐습니다. 다만 `spring-boot-maven-plugin`의 repackage 덕분에 이 WAR는 내장 톰캣으로 직접 실행도 됩니다 — 두 배포 경로를 모두 얻은 셈입니다.
:::

:::details Q2. `provided` 스코프를 톰캣에 쓴 이유는?
WAR를 외부 톰캣에 올리면 컨테이너가 이미 톰캣을 제공합니다. WAR 안에 톰캣이 또 들어가면 같은 서블릿 API 클래스가 두 벌이 되어 충돌(LinkageError 등)이 납니다. `provided`는 "컴파일·개발 시엔 필요하지만 산출물(WAR)에는 넣지 마라"는 뜻이라, 외부 톰캣이 제공하는 톰캣을 쓰게 됩니다. 반대로 개발 중 `spring-boot:run`에서는 이 의존성이 있어 내장 톰캣이 뜹니다.
:::

:::details Q3. 의존성 버전을 어디서 관리하나요? 왜 일부만 `pom.xml`에 버전이 있나요?
대부분은 부모 `spring-boot-starter-parent`가 버전을 고정합니다(그래서 Spring·Jackson·JSTL 의존성엔 버전 태그가 없습니다). 부모가 다루지 않는 군은 `<dependencyManagement>`에서 BOM import로 정렬합니다 — OkHttp는 `okhttp-bom`, AWS SDK v2는 `bom`. BOM이 없는 Cloudinary·POI·jsoup만 개별 의존성에 버전을 직접 적습니다. 이렇게 하면 버전이 한 곳에 모여 충돌과 중복을 줄입니다.
:::

:::details Q4. `spring-boot-maven-plugin`은 정확히 무엇을 하나요? 없으면 어떻게 되나요?
`package` 단계에서 일반 WAR/JAR를 한 번 더 가공(repackage)해 실행 가능한 형태로 만들고, 의존성을 적절한 위치(WAR라면 `WEB-INF/lib`)에 배치합니다. 또 `spring-boot:run` goal로 빌드 없이 즉시 실행도 제공합니다. 이 플러그인이 없으면 Boot의 실행 가능한 패키징과 편의 실행이 빠져, 평범한 WAR만 나옵니다. 여기서는 Lombok처럼 런타임에 불필요한 의존성을 산출물에서 제외하는 설정도 이 플러그인에 둡니다.
:::

:::details Q5. Maven Wrapper(`mvnw`)는 왜 커밋했나요?
팀원·CI마다 설치된 Maven 버전이 다르면 빌드 결과가 달라질 수 있습니다. `mvnw`/`mvnw.cmd`와 `maven-wrapper.properties`를 저장소에 커밋하면, 누구든 Maven을 따로 설치하지 않아도 명시된 버전(3.9.14)으로 동일하게 빌드합니다. 재현 가능한 빌드와 신규 합류자 온보딩을 위한 표준 관행입니다.
:::

:::details Q6. Gradle이 아니라 Maven을 쓴 트레이드오프는?
Maven은 선언적 `pom.xml`과 표준 수명주기로 예측 가능성과 학습 곡선이 낮고, Spring Boot 부모 POM·BOM 생태계와 궁합이 좋습니다. 단점은 XML이 장황하고 복잡한 커스텀 빌드 로직에선 Gradle보다 유연성이 떨어진다는 점입니다. 이 프로젝트는 도메인이 많아도 빌드 자체는 표준적이라(WAR + 스타터), 선언적이고 안정적인 Maven이 합리적인 선택이었습니다.
:::

## 8. 직접 말해보기

아래를 소리 내어 30초 안에 답해보자.

- "이 프로젝트는 왜 JAR가 아니라 WAR로 패키징했고, 그게 톰캣 스코프 설정과 어떻게 연결되나?"
- "`./mvnw clean package`를 치면 어떤 단계들이 순서대로 실행되나? 3개만 들면?"
- "OkHttp·AWS·MyBatis 의존성에는 왜 `pom.xml`에 버전이 안 적혀 있나?"

## 관련 페이지

- [인프라 개요](/infra/) · [Tomcat 배포](/infra/tomcat-deploy) · [설정·시크릿 관리](/infra/secrets-config) · [JUnit 테스트](/infra/junit-testing)
- [Spring Boot](/backend/spring-boot) · [JSP·JSTL·EL](/backend/jsp-jstl-el)
- 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="TripTogether가 spring-boot-starter-tomcat을 provided 스코프로 둔 가장 직접적인 이유는?"
  :choices="['톰캣이 유료 라이선스라 빌드에서 빼야 해서', '외부 톰캣에 WAR를 올릴 때 컨테이너가 톰캣을 제공하므로 WAR에 중복 포함하면 충돌나서', 'provided가 compile보다 빌드가 빨라서', 'MyBatis가 provided 톰캣에서만 동작해서']"
  :answer="1"
  explanation="외부 톰캣 배포 시 컨테이너가 이미 톰캣을 제공한다. WAR에 톰캣을 또 넣으면 같은 서블릿 API 클래스가 충돌하므로, provided로 산출물에서 제외하되 컴파일/개발 시엔 사용한다."
/>

<QuizBox
  question="pom.xml에서 OkHttp·AWS SDK 의존성에 version 태그가 없는 이유로 가장 정확한 것은?"
  :choices="['Maven이 항상 최신 버전을 자동으로 받기 때문', 'dependencyManagement에서 해당 BOM을 import해 버전을 한곳에서 정렬했기 때문', 'WAR 패키징은 버전을 무시하기 때문', 'provided 스코프라 버전이 필요 없기 때문']"
  :answer="1"
  explanation="okhttp-bom과 AWS SDK v2 bom을 dependencyManagement에서 import해 버전을 정렬했기 때문에, 실제 dependencies 항목에는 버전을 적지 않아도 된다. BOM이 없는 Cloudinary/POI/jsoup만 개별 버전을 직접 명시한다."
/>

<QuizBox
  question="./mvnw clean package 실행 시 package 단계에서 WAR를 실행 가능한 형태로 다시 포장(repackage)하는 주체는?"
  :choices="['maven-compiler-plugin', 'tomcat-embed-jasper', 'spring-boot-maven-plugin', 'mysql-connector-j']"
  :answer="2"
  explanation="spring-boot-maven-plugin이 package 단계에서 WAR를 repackage해 내장/외부 톰캣 양쪽에서 동작하게 만들고, Lombok처럼 런타임 불필요한 의존성은 산출물에서 제외한다."
/>
