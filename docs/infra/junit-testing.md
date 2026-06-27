# JUnit 테스트 — Service 단위 테스트 + ADR 정책 검증

> 핵심 정책이 모인 Service 레이어를 Mockito로 격리해 빠르게 검증하고, 각 테스트를 ADR(설계 결정) 문서와 1:1로 매핑한다. 전체 31개, 약 12초.

## 1. 한 줄 정의

TripTogether의 테스트 전략은 **JUnit 5 + Mockito 5 + AssertJ 기반 Service 단위 테스트**를 메인으로 삼아, 도배 방지·XSS sanitize·신고 3중 방어·답변 이력·Soft Delete 같은 비즈니스 규칙이 코드로 정확히 동작하는지 검증한다. 의존성(`pom.xml`)에는 `spring-boot-starter-webmvc-test`(MockMvc 포함)와 `mybatis-spring-boot-starter-test`가 들어 있어 통합/슬라이스 테스트로 확장할 길은 열려 있지만, **현재 작성된 31개는 전부 단위 테스트**다.

## 2. 왜 이렇게 설계했나

`docs/adr/0014-junit-test-strategy.md`(MADR 형식)에 결정 배경이 명시돼 있다. 네 가지 옵션을 비교했다.

| 옵션 | 방식 | 장점 | 단점 |
| --- | --- | --- | --- |
| A | 풀 통합 `@SpringBootTest` | 신뢰성 최고 | 매우 느림, 실패 지점 추적 어려움 |
| **B (선택)** | Service 단위 + Mockito | 빠름, 검증 단위 명확 | Mapper SQL·HTTP 계층 미검증 |
| C | Mapper 통합 `@MybatisTest` + H2 | SQL 정확성 검증 | H2↔MySQL 방언 차이 위험 |
| D | Controller 슬라이스 `@WebMvcTest` | HTTP·권한 계층 검증 | Spring 컨텍스트 부팅 부담 |

선택 근거는 단순하다. **핵심 정책(sanitize / BLUR 임계값 / 답변 이력 / Soft Delete / 3중 방어 / 도배 방지)이 전부 Service 레이어에 있다.** Mockito로 Mapper와 외부 서비스를 격리하면 DB·HTTP 부팅 비용 0으로 정책 로직만 정밀하게 검증할 수 있다. ADR 문서가 "정책은 있는데 그 정책이 동작한다는 증거는 없는" 상태였다는 점을 약점으로 진단하고, **ADR ↔ 테스트 페어**로 그 증거를 만든 것이 이 전략의 핵심이다.

:::tip 왜 ADR과 짝을 지었나
"신고는 자동 제재 없이 어드민 큐에만 쌓는다"(ADR-0001)는 문장은 문서일 뿐이다. `submitReport_*` 테스트가 통과해야 비로소 "그 정책이 코드로 살아 있다"가 증명된다. 의존성/시그니처가 바뀌어 정책이 깨지면 테스트가 즉시 빨갛게 실패해 회귀를 막는다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

테스트 코드 위치는 `src/test/java/org/triptogether/**`이고, 빌드는 Maven(`./mvnw test`)이다.

- **JUnit 5 (Jupiter)** — `@Test`, `@DisplayName`(한국어), `@BeforeEach`
- **Mockito 5** — `@ExtendWith(MockitoExtension.class)`, `@Mock`, `@InjectMocks`, `ArgumentCaptor`, `lenient()`
- **AssertJ** — `assertThat(...)`, `assertThatThrownBy(...)`
- **Spring mock 유틸** — `MockMultipartFile`(첨부 검증 테스트), `DataIntegrityViolationException`(레이스 컨디션 시뮬레이션)

테스트 클래스와 검증 대상은 다음과 같다.

| 테스트 클래스 | 검증 대상 Service | 주요 ADR |
| --- | --- | --- |
| `CommunityServiceTest` | `CommunityServiceImpl` | 0001 / 0003 / 0005 / 0006 / 0008 |
| `ReportServiceTest` | `ReportServiceImpl` | 0001 / 0004 |
| `InquiryServiceTest` | `InquiryServiceImpl` | 답변 이력 + 도배 방지 + 첨부 검증 |
| `SuperAdminServiceTest` | `SuperAdminServiceImpl` | (불변식: 최소 1명 SUPERADMIN 유지) |
| `TripTogetherApplicationTests` | 전체 컨텍스트 | `contextLoads()` |

## 4. 동작 원리 (흐름·표·작은 코드)

### 표준 작성 패턴

ADR-0014가 정의한 표준 골격이다. Mapper와 외부 의존성을 `@Mock`으로 채우고, 대상 Service에 `@InjectMocks`로 주입한다.

```java
@ExtendWith(MockitoExtension.class)
class ReportServiceTest {
    @Mock ReportMapper reportMapper;
    @Mock MyPageService myPageService;
    @InjectMocks ReportServiceImpl reportService;   // Mock 자동 주입

    @Test
    @DisplayName("CANCELLED 재활성화 - 취소된 신고가 있으면 reactivate 호출 → true")
    void submitReport_cancelledReactivation_returnsTrue() {
        ReportDto cancelled = new ReportDto();
        cancelled.setStatus("CANCELLED");
        given(reportMapper.selectReportByUserAndTarget(...)).willReturn(cancelled);

        boolean result = reportService.submitReport(...);   // when

        assertThat(result).isTrue();                          // then
        verify(reportMapper).reactivateCancelledReport(...);
        verify(reportMapper, never()).insertReport(any());    // 새 INSERT 안 함
    }
}
```

세 가지 검증 도구를 상황에 맞게 쓴다.

- `verify(mock).method(...)` — 특정 협력 객체 호출이 일어났는지 (예: `insertComment`)
- `verify(mock, never()).method(...)` — 일어나면 안 되는 호출 (예: 본인 글 좋아요 시 알림 미발송)
- `ArgumentCaptor` — Mapper에 **무엇을 넘겼는지** 캡처해 내용까지 검증 (예: sanitize 후 본문, 답변 이력 changeType)

### 정책 외부화 + i18n stub (ADR-0009 / 0013)

`@BeforeEach`에서 정책 객체와 메시지를 stub한다. 정책값을 코드에 하드코딩하지 않고 `ContentModerationPolicyVO`로 주입받는 구조(ADR-0009) 자체가 stub 가능하다는 점으로 검증된다.

```java
@BeforeEach
void setUp() {
    ContentModerationPolicyVO policy = new ContentModerationPolicyVO();
    policy.setPostWindowMinutes(5);
    policy.setPostMaxCount(3);
    lenient().when(moderationPolicyService.getPolicy()).thenReturn(policy);
    lenient().when(msg.get(eq("community.service.error.postRateLimit"), any(), any()))
            .thenReturn("5분 내 게시글을 3개 이상 작성할 수 없습니다.");
}
```

`lenient()`는 Mockito strict 모드에서 "사용되지 않은 stub" 예외를 회피하기 위한 의도된 절충이다. 모든 테스트가 모든 stub을 쓰는 건 아니기 때문이다.

### ADR ↔ 테스트 매핑

| ADR / 정책 | 대표 테스트 | 위치 |
| --- | --- | --- |
| ADR-0001 (자동 제재 금지·신고는 큐) | `submitReport_newInsert_returnsTrue` | Report |
| ADR-0003 (BLUR vs BLOCKED 임계값) | `updatePostReportCache_atThreshold_sendsBlurNotification` | Community |
| ADR-0004 (중복 신고 3중 방어) | `submitReport_duplicateInReview_returnsFalse` / `_cancelledReactivation_` / `_dataIntegrityViolation_` | Report |
| ADR-0005 (XSS 서버 sanitize) | `addComment_sanitize_removesScriptTag` | Community |
| ADR-0006 (카운터 캐시 정합성) | `deleteComment_softDeleteAndDecrement` | Community |
| ADR-0008 (Soft Delete) | `deletePost_softDelete_setsStatusDeleted` | Community |
| 답변 이력 보존 | `updateAnswer_archivesPreviousThenUpdates` / `deleteAnswer_archivesAsDeleteThenRemoves` | Inquiry |
| 첨부 파일 검증(P0) | `addAttachment_invalidExtension_skipped` / `_oversize_skipped` | Inquiry |
| 도배 방지 | `*_floodLimit_throwsException` 다수 | Community / Inquiry |

### 대표 검증 3선

- **XSS sanitize (ADR-0005)** — `<script>alert(1)</script>`를 댓글로 넣고, `ArgumentCaptor`로 Mapper에 저장된 본문을 캡처해 `doesNotContain("<script>")` + 정상 텍스트는 유지됨을 동시에 확인.
- **레이스 컨디션 방어 (ADR-0004)** — `insertReport`가 `DataIntegrityViolationException`(DB UNIQUE 위반)을 던지도록 stub하고, 서비스가 예외를 삼켜 `false`를 반환하는지 검증. 사전 SELECT를 통과한 동시 요청까지 막는 3번째 방어선이다.
- **불변식 (SuperAdmin)** — `countSuperAdmins()`가 1을 반환할 때 마지막 SUPERADMIN을 revoke하면 `IllegalStateException("최소 1명의 SUPERADMIN이 유지되어야 합니다.")`가 터지고 `revokeAdmin`이 **호출되지 않음**을 검증.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 현재 구현된 것 (됨)
- Service 단위 테스트 **31개 전부 통과**, 실행 ~12초
- `CommunityServiceTest`(14) · `InquiryServiceTest`(8) · `ReportServiceTest`(5) · `SuperAdminServiceTest`(3) · `TripTogetherApplicationTests`(1, `@SpringBootTest`로 컨텍스트 부팅 검증)
- 거의 모든 ADR/P0 정책이 최소 1개 테스트로 매핑됨
- `MockMultipartFile`로 첨부 확장자/용량 검증까지 단위 테스트화
:::

:::warning 아직 안 된 것 (Mock/계획)
- **Mapper SQL 자체 미검증** — 단위 테스트라 쿼리 정확성은 못 본다. `@MybatisTest`(Phase 5, 의존성은 이미 추가됨) 도입은 미실시이며 H2↔MySQL 방언 차이가 변수다.
- **Controller/HTTP 계층 미검증** — `@WebMvcTest`(MockMvc) 슬라이스로 ADR-0011(AOP 권한)·ADR-0012(CSRF)를 검증하는 Phase 4가 계획 단계. 의존성(`spring-boot-starter-webmvc-test`)은 준비됐지만 실제 `MockMvc` 테스트 코드는 아직 없다.
- **E2E·TestContainers**(Phase 6)는 매우 추후.
- **커버리지 리포트(JaCoCo)·CI 게이트** 미구성. 프로젝트 전반에 AI 응답 품질 정량평가 체계도 부재.
:::

확장 로드맵(ADR-0014 기준): Phase 4 Controller 슬라이스 → Phase 5 Mapper 통합 → Phase 6 E2E.

## 6. 면접 답변 3단계

1. **한 줄** — "정책이 몰린 Service 레이어를 JUnit 5 + Mockito로 격리 검증하고, 각 테스트를 ADR 문서와 1:1 매핑해 설계 결정이 코드로 동작함을 증명했습니다. 31개, 약 12초입니다."
2. **왜** — "풀 통합·Mapper 통합·Controller 슬라이스를 비교했는데, 핵심 비즈니스 규칙이 전부 Service에 있어 가성비가 가장 좋았습니다. DB·HTTP 부팅 비용 0으로 회귀를 즉시 잡습니다."
3. **구체** — "예를 들어 신고 중복 방지는 사전 SELECT·CANCELLED 재활성화·`DataIntegrityViolationException` 처리의 3중 방어인데, 세 경로를 각각 테스트로 고정했습니다. XSS는 `ArgumentCaptor`로 저장 직전 본문을 캡처해 `<script>` 제거를 확인합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 단위 테스트만으로 충분한가? Mapper SQL이 틀리면?
충분하지 않다는 걸 ADR에 한계로 명시했다. 단위 테스트는 비즈니스 분기 로직을 검증할 뿐 SQL 정확성은 못 본다. 그래서 Phase 5에서 `@MybatisTest`를 계획했고 의존성(`mybatis-spring-boot-starter-test`)도 미리 넣어뒀다. 다만 H2와 MySQL의 방언 차이(UPSERT, LIMIT 서브쿼리 등)가 위험 요소라 도입 시점을 신중히 잡았다.
:::

:::details Q2. `lenient()`를 왜 쓰나? 안티패턴 아닌가?
Mockito strict 모드는 사용되지 않은 stub을 예외로 처리한다. `@BeforeEach`에서 공통 정책·i18n 메시지를 stub하지만 모든 테스트가 모두를 쓰지는 않아 strict 모드와 충돌한다. 남발하면 진짜 불필요한 stub을 못 잡는 단점이 있어, 공통 setUp에 한정하고 개별 테스트의 `given(...)`은 strict로 둔다. 의도된 절충이다.
:::

:::details Q3. `verify(mock, never())`로 검증하는 이유는?
"무언가 일어나지 않아야 한다"가 정책인 경우가 많기 때문이다. 본인 글에 좋아요하면 알림이 가면 안 되고(`addNotification` 미호출), 중복 신고면 `insertReport`가 호출되면 안 된다. 긍정 검증만으로는 "추가로 잘못된 부수효과가 없었다"를 보장할 수 없어 부정 검증이 필수다.
:::

:::details Q4. `ArgumentCaptor`는 언제 쓰나? `verify(any())`와 뭐가 다른가?
`verify(mock).insertComment(any())`는 호출 여부만 본다. `ArgumentCaptor`는 **넘어간 인자의 내용**까지 검증한다. sanitize 테스트는 저장된 본문에 `<script>`가 없는지, 답변 이력 테스트는 `changeType`이 "UPDATE"/"DELETE"인지, `prevContent`가 이전 본문인지를 캡처해 확인한다. 부수효과의 정확성을 볼 때 필수다.
:::

:::details Q5. `@SpringBootTest`로 만든 `contextLoads()`는 의미 있나?
의미 있다. Bean 설정·의존성 와이어링이 깨지면 애플리케이션이 아예 안 뜨는데, 이 한 줄짜리 테스트가 컨텍스트 부팅 자체를 보증한다. 빠른 단위 테스트가 못 잡는 "조립 단계" 회귀를 잡는 안전망이다. 다만 느리므로 이 한 개로 최소화했다.
:::

## 8. 직접 말해보기

- ADR-0014가 비교한 4개 테스트 옵션과, "Service 단위 + Mockito"를 고른 이유를 30초로 설명해 보라.
- 신고 중복 방지의 3중 방어를 각각 어떤 테스트가 고정하는지 메서드 이름까지 말해 보라.
- `lenient()`, `ArgumentCaptor`, `verify(never())`를 각각 한 문장으로 "왜 필요한가"로 설명해 보라.
- 지금 약점(Mapper SQL·Controller 미검증)을 인정하고, 어떤 Phase로 메우는지 로드맵을 말해 보라.

## 퀴즈

<QuizBox question="TripTogether가 메인 테스트 전략으로 '풀 통합 테스트(@SpringBootTest)'가 아니라 'Service 단위 + Mockito'를 선택한 핵심 이유는?" :choices="['MockMvc를 쓸 수 없어서', '핵심 비즈니스 정책이 대부분 Service 레이어에 있고, DB·HTTP 부팅 비용 없이 빠르게 회귀를 잡을 수 있어서', 'MyBatis는 통합 테스트가 불가능해서', 'JUnit 5가 통합 테스트를 지원하지 않아서']" :answer="1" explanation="ADR-0014: sanitize·BLUR 임계값·답변 이력·Soft Delete·3중 방어·도배 방지 등 핵심 정책이 모두 Service에 있어, Mockito로 격리하면 빠르고(전체 ~12초) 검증 단위가 명확하다. Mapper SQL·HTTP 계층 미검증은 한계로 인정하고 Phase 4~5로 확장 계획." />

<QuizBox question="댓글 본문에 들어온 script 태그가 sanitize 후 실제로 저장되지 않았는지 확인할 때, Mapper에 넘어간 인자의 내용까지 검증하기 위해 쓰는 Mockito 도구는?" :choices="['lenient()', 'verify(never())', 'ArgumentCaptor', '@InjectMocks']" :answer="2" explanation="ArgumentCaptor로 insertComment에 전달된 CommunityCommentDto를 캡처해 저장된 본문에 script 태그가 없고 정상 텍스트는 남았는지 검증한다. verify(any())는 호출 여부만, ArgumentCaptor는 인자 내용까지 본다." />

<QuizBox question="현재 TripTogether 테스트 스위트에 대한 설명으로 옳은 것은?" :choices="['@WebMvcTest로 Controller 권한(ADR-0011)까지 모두 검증한다', '31개 테스트가 전부 통과하며 대부분 Service 단위 테스트이고, Mapper SQL·Controller 슬라이스 검증은 아직 계획 단계다', 'JaCoCo 커버리지 게이트가 CI에 걸려 있다', '모든 테스트가 H2 DB를 띄워 SQL을 검증한다']" :answer="1" explanation="현재 31개(Community 14·Inquiry 8·Report 5·SuperAdmin 3·contextLoads 1)는 contextLoads를 제외하면 Service 단위 테스트다. webmvc-test·mybatis-test 의존성은 pom.xml에 있지만 @WebMvcTest(Phase 4)·@MybatisTest(Phase 5) 실제 코드는 아직 없다." />

---

- 허브로 돌아가기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
- 함께 보기: [ADR(MADR) 문서화](/infra/adr-madr) · [Maven · WAR 빌드](/infra/maven-war) · [AOP 권한 체크](/backend/aop-authorization)
