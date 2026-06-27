# 인프라 / 협업 개요

> TripTogether를 "돌아가게" 만드는 빌드·배포·협업·문서·테스트의 지도. 4명이 한 코드베이스를 충돌 없이 함께 만든 방식을 면접에서 설명할 수 있게 정리한다.

## 1. 이 섹션이 다루는 것

도메인 페이지가 "무엇을 만들었나"를 다룬다면, 이 섹션은 **그 코드를 어떻게 빌드하고 배포하고 함께 관리했는가**를 다룬다. 핵심 축은 다섯 가지다.

| 축 | 무엇 | 대표 산출물 |
| --- | --- | --- |
| 빌드 | Maven 멀티 의존성 → 단일 WAR | `pom.xml`, `./mvnw clean package` |
| 배포 | embedded Tomcat + context-path | `spring-boot:run`, `/TripTogether` |
| 협업 | 개인 브랜치 → PR, 수직 분담 | Git, 도메인 폴더 경계 |
| 의사결정 | 정책/구조 결정을 ADR로 고정 | `docs/adr/0001~0014` (MADR) |
| 검증 | Service 단위 + ADR 정책 회귀 | JUnit (`src/test/.../*ServiceTest`) |

TripTogether는 약 14~15개 도메인 모듈을 **4명이 수직 분담**해 동시 개발했다. 그래서 "한 명이 잘 짠 코드"보다 "여러 명이 같은 규약 위에서 충돌 없이 합친 코드"라는 점이 협업 관점의 핵심이다.

## 2. 담당과 경계

특정 사람을 "주인공"으로 두지 않는다. 도메인을 4개 묶음으로 나눠 각자 controller → service → mapper → vo 의 **세로 한 줄(수직 슬라이스)** 을 책임지는 구조다.

- 각 도메인은 `src/main/java/org/triptogether/<도메인>/` 폴더 하나로 격리된다(예: `auth`, `community`, `courses`, `explore`, `inquiry`, `admin`, `assistant`, `commerce`, `reward` 등).
- 공유 자원은 `common`(권한 AOP·예외 핸들러·로그인 리졸버), `resources/mapper/*.xml`, `TripTogetherDB.sql`, `pom.xml`, i18n properties에 모여 있고, 이 영역은 변경 시 합의 후 손대는 "공동 소유" 구역이다.
- 충돌이 잦은 지점은 **공유 SQL 스키마**와 **공통 인터셉터 체인**이라, 컬럼 추가나 인터셉터 순서 변경은 PR에서 특히 신중히 리뷰했다.

이 분담의 장단을 솔직히 말하면, 장점은 "내 도메인은 끝까지 내가 책임진다"는 명확성이고, 단점은 도메인 간 횡단 기능(알림 SSE, 모더레이션, 리워드 적립처럼 여러 도메인을 가로지르는 흐름)에서 인터페이스 합의가 필요하다는 점이다. TripTogether는 이 횡단 부분을 `myPageService.addNotification` 같은 **명시적 크로스모듈 호출**과 ADR로 묶어 관리했다.

## 3. 핵심 기술 스택 (인프라 관점)

```text
빌드      Maven (mvnw 래퍼) · packaging=war
런타임    Java 21 · Spring Boot 4.0.6 · embedded Tomcat(Jasper)
영속성    MyBatis 4.0.1 + MySQL (JPA 미사용)
뷰        JSP(JSTL/EL) — WAR 내부 정적+동적 렌더링
외부 I/O  OkHttp 5.3.2(AI/HTTP), Cloudinary 2.3.2(이미지), POI 5.5.1(Excel), AWS SDK v2(WAFv2)
보안      Spring Security crypto/config/web(BCrypt·부분 CSRF)
문서      ADR(MADR 0.6) 0001~0014
테스트    JUnit (Service 단위 + ADR 정책 검증)
```

:::tip 왜 WAR + embedded Tomcat인가
"JSP를 쓰려면 서블릿 컨테이너가 필요"하고, "배포는 단순하게 하나의 실행물로" 하고 싶었기 때문이다. WAR 패키징으로 JSP 컴파일(Jasper)을 살리면서도, embedded Tomcat 덕분에 `./mvnw spring-boot:run` 한 줄로 로컬에서 바로 뜬다. 외부 Tomcat에 따로 배포할 필요가 없다.
:::

## 4. 권장 학습 순서

이 섹션은 아래 순서로 읽으면 "코드 한 줄 → 사용자에게 도달"까지 한 번에 꿰어진다.

1. [Maven · WAR 빌드](/infra/maven-war) — 의존성 관리와 단일 산출물(WAR)이 만들어지는 과정
2. [Tomcat 배포](/infra/tomcat-deploy) — embedded Tomcat, context-path `/TripTogether`, 실행 명령
3. [Git 협업 전략](/infra/git-workflow) — 개인 브랜치 → PR, 수직 분담, 공유 파일 충돌 관리
4. [ADR(MADR) 문서화](/infra/adr-madr) — 결정을 코드가 아니라 문서로 고정하는 이유와 14개 ADR 지도
5. [JUnit 테스트](/infra/junit-testing) — Service 단위 + ADR 정책이 코드로 회귀 검증되는 방식
6. [설정·시크릿 관리](/infra/secrets-config) — DB 우선 런타임 설정과 API 키를 코드에 박지 않는 방법

처음 보는 독자라면 먼저 [백엔드 개요](/backend/)에서 4계층 구조를 잡고 오면 이 섹션이 훨씬 잘 붙는다.

## 5. 구현 상태 (됨 vs Mock/계획)

정직하게 구분한다. 인프라는 "있어 보이게"가 아니라 "실제로 무엇이 도는가"가 중요하다.

| 항목 | 상태 |
| --- | --- |
| Maven WAR 빌드 / embedded Tomcat 실행 | ✅ 구현됨 (`./mvnw spring-boot:run`) |
| Git 개인 브랜치 → PR 협업 | ✅ 실제 운영 방식 |
| ADR 0001~0014 (MADR) | ✅ 작성·인덱싱됨 (`docs/adr/README.md`) |
| JUnit Service 테스트 | ✅ 일부 도메인(`CommunityServiceTest`, `InquiryServiceTest`, `ReportServiceTest`, `SuperAdminServiceTest`) |
| DB 우선 런타임 설정(`APPLICATION_RUNTIME_SETTING`) | ✅ 구현됨 (`is_secret`/`value_type`) |
| 전 도메인 테스트 커버리지 | ⚠️ 부분 — 핵심 정책 위주, 전 모듈 커버리지는 미달 |
| CI/CD 파이프라인 자동화 | ⚠️ 계획/수동 — 자동 빌드·배포 파이프라인은 정식 구축 전 |
| API 문서(Swagger/OpenAPI) | ❌ 부재 — REST/JSP 혼재라 자동 문서화 미도입 |
| 모바일 반응형 레이아웃 | ⚠️ JSP 데스크톱 위주, 반응형은 향후 과제 |

:::warning 과장하지 말 것
면접에서 "CI/CD를 완비했다"라고 말하면 안 된다. TripTogether는 **빌드·실행은 단일 명령으로 재현 가능**하지만, 자동 배포 파이프라인과 전 도메인 테스트 커버리지는 계획 단계다. 이 경계를 정확히 말하는 것이 오히려 신뢰를 준다.
:::

## 6. 단골 면접 질문 5개

이 섹션 전체를 관통하는 질문들이다. 각각의 상세 답은 하위 페이지에 있다.

1. **"빌드와 배포를 어떻게 했나요?"**
   Maven으로 의존성을 관리하고 단일 WAR로 패키징한다. embedded Tomcat을 써서 `./mvnw spring-boot:run` 한 줄로 실행되고, context-path는 `/TripTogether`다. → [Maven·WAR](/infra/maven-war), [Tomcat 배포](/infra/tomcat-deploy)

2. **"4명이 한 코드베이스를 어떻게 충돌 없이 작업했나요?"**
   도메인별 수직 분담(controller→service→mapper→vo 한 줄)과 개인 브랜치 → PR 전략. 공유 자원(SQL 스키마, 인터셉터, `pom.xml`)은 합의 후 변경했다. → [Git 협업](/infra/git-workflow)

3. **"왜 JPA가 아니라 MyBatis인가요?"**
   복잡한 조인·집계 쿼리와 캐시 컬럼 정합성(예: `like_count`)을 SQL로 명시적으로 통제하기 위해서다. 영속성은 MyBatis만 쓰고 JPA는 도입하지 않았다. → [MyBatis](/backend/mybatis)

4. **"기술 결정은 어떻게 기록·합의했나요?"**
   주요 결정을 MADR 형식 ADR(0001~0014)로 남겼다. 예: 신고 자동제재 범위(0001), jsoup XSS(0005), 소프트삭제(0008), AI 모더레이션(0010), 부분 CSRF(0012). → [ADR](/infra/adr-madr)

5. **"테스트는 무엇을 검증하나요?"**
   Service 계층 단위 테스트와 더불어 **ADR로 정한 정책이 깨지지 않는지**를 회귀 검증한다(ADR-0014). 예: 신고 누적이 자동 차단으로 번지지 않는다는 정책. → [JUnit 테스트](/infra/junit-testing)

---

더 넓은 맥락은 허브에서 이어진다: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [백엔드 개요](/backend/)

## 퀴즈

<QuizBox
  question="TripTogether가 외부 Tomcat에 별도 배포 없이 './mvnw spring-boot:run' 한 줄로 실행될 수 있는 핵심 이유는?"
  :choices="['JPA가 내장 서버를 띄우기 때문', 'embedded Tomcat(Jasper)을 포함한 WAR 패키징이라서', 'Swagger가 서버를 기동하기 때문', 'MySQL이 애플리케이션 서버를 겸하기 때문']"
  :answer="1"
  explanation="packaging=war 이지만 embedded Tomcat(tomcat-embed-jasper)을 포함하므로 JSP 컴파일을 살리면서도 단일 명령으로 기동된다. 외부 서블릿 컨테이너가 필요 없다."
/>

<QuizBox
  question="4명 공동 개발에서 '변경 시 합의가 필요한 공동 소유 구역'에 해당하지 않는 것은?"
  :choices="['공유 SQL 스키마(TripTogetherDB.sql)', '공통 인터셉터 체인 순서', '특정 도메인 폴더 내부의 service 로직', 'pom.xml 의존성']"
  :answer="2"
  explanation="도메인 폴더 내부(controller→service→mapper→vo)는 담당자의 수직 슬라이스라 단독으로 진행한다. SQL 스키마·인터셉터 체인·pom.xml은 여러 도메인에 영향을 주는 공동 소유 구역이라 합의가 필요하다."
/>

<QuizBox
  question="ADR-0014가 정의한 JUnit 테스트 전략의 특징을 가장 정확히 설명한 것은?"
  :choices="['모든 도메인의 100% 커버리지를 강제한다', 'Controller end-to-end 테스트만 수행한다', 'Service 단위 테스트와 함께 ADR로 정한 정책의 회귀를 검증한다', 'AI 응답 품질을 정량 점수로 자동 평가한다']"
  :answer="2"
  explanation="ADR-0014는 Service 계층 단위 테스트와 ADR 정책(예: 신고 자동제재 금지)의 회귀 검증을 묶는다. 전 도메인 커버리지나 AI 품질 정량평가는 부재/향후 과제다."
/>
