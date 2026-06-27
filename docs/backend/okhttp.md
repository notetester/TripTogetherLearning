# HTTP 클라이언트 (OkHttp · RestTemplate · JDK HttpClient)

> TripTogether는 외부 AI·보안 API를 부르려고 세 갈래 HTTP 스택을 가진다 — pom에 선언된 OkHttp 5, 실제 AI 호출을 도맡는 Spring `RestTemplate`, 그리고 보안 프로바이더 호출에 쓰는 JDK `java.net.http.HttpClient`.

이 페이지는 특정 도메인 소유가 아니라 4명이 공유하는 공통 인프라다. OpenAI·Gemini·Claude·Perspective·Toss·번역·WAF 호출이 모두 이 계층을 지난다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 한 줄 정의

서버가 외부 HTTP API(주로 LLM·모더레이션·결제·보안 프로바이더)를 호출하기 위한 클라이언트 계층이다. 빌드에는 OkHttp 5.3.2가 의존성으로 선언돼 있지만, **현재 런타임 호출 경로의 대부분은 Spring `RestTemplate`** 이고, 로그인 위험평가 등 보안 프로바이더 호출은 **JDK `HttpClient`** 가 담당한다.

## 2. 왜 이렇게 설계했나

- **외부 의존을 한 계층에 가둔다.** OpenAI·Gemini·Anthropic·Google Perspective·Google Translation·Toss Payments는 전부 외부 HTTPS API다. 서비스 코드가 직접 소켓을 다루지 않고 HTTP 클라이언트 추상화 뒤에 두면, 타임아웃·재시도·키 주입·실패 처리 정책을 호출부마다 흩뿌리지 않고 한 군데에서 결정할 수 있다.
- **두 종류의 호출은 신뢰 경계가 다르다.** AI 보조 기능(여행 도우미, 챗봇, 답변 초안)은 실패해도 사용자 경험만 저하될 뿐 보안에 직결되지 않는다. 반면 로그인 위험평가 같은 보안 프로바이더 호출은 결과가 인증 결정에 쓰여서 **타임아웃·재시도·fail-closed/fail-open 정책**이 핵심이다. 그래서 후자는 별도 클라이언트(`SecurityAssessmentHttpClient`, `WafSyncHttpClient`)로 분리하고 호출당 정책을 DB 설정으로 주입받는다.
- **OkHttp는 인터셉터·연결 풀·테스트 도구가 강점이라 선택지로 둔다.** pom에는 `okhttp`, `okhttp-jvm`, `logging-interceptor`(요청/응답 로깅), `mockwebserver3`(테스트용 가짜 서버)까지 OkHttp 패밀리를 갖춰, 향후 AI 클라이언트를 OkHttp로 일원화하고 인터셉터로 로깅·헤더·재시도를 횡단 처리할 여지를 열어 둔다.

## 3. 어떤 기술로 구현했나 (실제 클래스·의존성)

| 스택 | 선언/설정 위치 | 실제 호출 클래스(예) |
| --- | --- | --- |
| OkHttp 5.3.2 (`com.squareup.okhttp3`) | `pom.xml` — `okhttp-bom` import + `okhttp`/`okhttp-jvm`/`logging-interceptor`/`mockwebserver3` | (src/main에 `okhttp3` import 없음 — 선언 단계) |
| Spring `RestTemplate` | `config/RestTemplateConfig` — `@Bean RestTemplate restTemplate()` | `AssistantServiceImpl`(GPT-4o-mini), `ChatbotService`·`IntentContextService`(Gemini), `InquiryAiService`(Claude Haiku), `PerspectiveService`(Perspective), `AiPlanGPTServiceImpl`, `SpotTextTranslationService`·`AdminTranslationServiceImpl`(번역), `TossPaymentsClient`, `CommunityImageScheduler`(Pixabay) |
| JDK `java.net.http.HttpClient` | 클래스 내부 직접 생성 | `auth/risk/SecurityAssessmentHttpClient`, `auth/risk/WafSyncHttpClient` |

:::warning OkHttp는 "선언됨"이지 "호출됨"이 아니다
`pom.xml`에 OkHttp 5.3.2 패밀리가 의존성으로 들어가 있지만, `src/main/java/org/triptogether/**` 어디에도 `import okhttp3.*`로 `OkHttpClient`를 생성해 호출하는 코드는 없다. 면접에서 "OkHttp로 AI를 호출했다"고 단정하면 사실과 어긋난다. 정확히는 **OkHttp는 빌드에 준비돼 있고, 실제 AI/외부 호출은 `RestTemplate`과 JDK `HttpClient`로 구현돼 있다.**
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### (a) AI 호출 — RestTemplate 경로

대부분의 LLM·모더레이션·결제 호출이 같은 모양을 따른다. 헤더에 키를 싣고, 바디를 JSON으로 직렬화해 `exchange()`로 보내고, 응답 JSON에서 필요한 필드만 뽑는다.

```java
// AssistantServiceImpl — OpenAI Chat Completions 호출(추상화)
HttpHeaders headers = new HttpHeaders();
headers.setContentType(MediaType.APPLICATION_JSON);
headers.setBearerAuth(apiKey.trim());                  // Authorization: Bearer ...

HttpEntity<String> entity = new HttpEntity<>(requestJson, headers);
ResponseEntity<String> response = restTemplate.exchange(
        OPENAI_API_URL, HttpMethod.POST, entity, String.class);

// 응답 JSON에서 choices[0].message.content 만 추출
```

`PerspectiveService`는 같은 패턴이되 키를 URL 쿼리(`...:analyze?key=`)로 붙이고, **호출 실패 시 예외를 흡수해 `null`/`false`로 떨어뜨리는 fail-safe**라서 외부 API 장애가 댓글·문의 작성을 막지 않는다.

### (b) 보안 프로바이더 호출 — JDK HttpClient 경로

`SecurityAssessmentHttpClient.doCall()`은 프로바이더별 DB 설정(`SecurityAssessmentProviderConfigVO`)에서 엔드포인트·메서드·헤더·타임아웃을 읽어 요청을 조립한다.

```java
HttpRequest.Builder builder = HttpRequest.newBuilder()
        .uri(URI.create(provider.getEndpointUrl()))
        .timeout(Duration.ofMillis(
                provider.getTimeoutMillis() == null ? 3000 : provider.getTimeoutMillis()))
        .header("Content-Type", "application/json");
// 메서드 분기(GET/POST/PUT/PATCH/DELETE) + Bearer 키 주입
HttpResponse<String> res = HttpClient.newHttpClient()
        .send(builder.build(), HttpResponse.BodyHandlers.ofString());
```

이 경로에만 있는 안전 장치:

| 메커니즘 | 동작 |
| --- | --- |
| 타임아웃 | 프로바이더 설정값, 미설정 시 기본 3000ms |
| 재시도 | `retryCount + 1`회, 백오프 `retryBackoffMs × (n+1)` 점증 |
| 스로틀 | `ProviderCallThrottler.acquire()` 리스 미발급 시 호출 차단 |
| 실패 정책 | `failOpen=1`이면 빈 결과(통과), 아니면 `riskLevel=PENDING`·`action=REVIEW`로 **fail-closed** |
| 응답 매핑 | `responseMappingJson`의 JSON Pointer로 score/label/confidence/decision 추출 |

### (c) 세 스택 비교

| 항목 | OkHttp 5 | RestTemplate | JDK HttpClient |
| --- | --- | --- | --- |
| 현재 사용 | 선언만(미호출) | AI·결제·번역 실호출 | 보안 프로바이더 실호출 |
| 타임아웃 | 빌더에 connect/read/write/call 분리 | 기본 빈은 무설정(기본 무한대) | 요청별 `timeout(Duration)` |
| 인터셉터 | `addInterceptor`(로깅·헤더 횡단) | `ClientHttpRequestInterceptor` | 없음(직접 코드) |
| 테스트 | `mockwebserver3` 동봉 | `MockRestServiceServer` | 외부 목 서버 필요 |

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨:** AI·모더레이션·결제·번역 호출 전부 `RestTemplate`로 동작. 보안 프로바이더 호출은 `HttpClient` + 타임아웃·재시도·스로틀·fail-closed까지 동작.
- **선언만:** OkHttp 5.3.2 패밀리(+`logging-interceptor`·`mockwebserver3`)는 pom에 있으나 `src/main`에서 호출 코드 없음. 클라이언트 일원화·인터셉터 기반 로깅의 기반만 마련된 상태.
- **주의 / 개선 여지:**
  - `RestTemplateConfig`의 기본 빈은 **타임아웃 미설정** — 외부 AI가 느려지면 요청 스레드가 오래 묶일 수 있다. AI 호출용 빈에는 `connectTimeout`/`readTimeout`을 거는 것이 바람직.
  - `AiPlanGPTServiceImpl`은 공유 빈 대신 `new RestTemplate()`을 자체 생성 — 풀·타임아웃 정책이 공유 빈과 분리된다.
  - 일부 호출은 키를 코드 상수/테스트 키로 보유(`TEST_API_KEY`) — 운영에선 설정·시크릿으로 분리 필요(공개 문서이므로 실제 키 값은 표기하지 않는다).

## 6. 면접 답변 3단계

1. **한 문장:** "외부 AI·보안 API 호출 계층입니다. OkHttp 5를 의존성으로 준비해 두되, 현재 실제 호출은 AI·결제·번역은 Spring `RestTemplate`, 로그인 위험평가 같은 보안 프로바이더는 JDK `HttpClient`로 구현돼 있습니다."
2. **한 단락:** "신뢰 경계가 다른 두 종류의 호출을 분리한 게 핵심입니다. AI 보조 기능은 실패해도 UX만 저하되니 `RestTemplate`로 단순하게, Perspective처럼 fail-safe로 흡수합니다. 반면 보안 프로바이더 호출은 인증 결정에 직결되므로 `SecurityAssessmentHttpClient`로 떼어 호출당 타임아웃·재시도·스로틀·fail-closed 정책을 DB 설정으로 주입받습니다."
3. **트레이드오프:** "OkHttp를 pom에만 둔 건 인터셉터·연결 풀·`mockwebserver3` 같은 강점을 향후 클라이언트 일원화에 쓰려는 포석입니다. 다만 지금 기본 `RestTemplate` 빈에 타임아웃이 없는 건 약점이라, AI 전용 빈에 read/connect 타임아웃을 거는 게 다음 개선 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details OkHttp가 의존성에 있는데 왜 코드에서 안 쓰나요?
현재 AI 호출은 Spring MVC 스택과 자연스럽게 맞물리는 `RestTemplate`로 충분히 동작합니다. OkHttp는 인터셉터 기반 횡단 로깅·헤더 주입, 연결 풀, `mockwebserver3` 테스트 등을 위해 미리 선언해 둔 것이고, 클라이언트를 한 종류로 통일할 때 도입할 기반입니다. 즉 "준비됨"이지 "사용됨"은 아니라고 정직하게 답합니다.
:::

:::details 외부 AI가 30초씩 느려지면 어떻게 되나요?
기본 `RestTemplate` 빈은 타임아웃이 없어 요청 스레드가 응답까지 묶일 위험이 있습니다. 그래서 개선안은 AI 호출용 빈에 `connectTimeout`/`readTimeout`을 설정하거나, 타임아웃을 일급으로 다루는 OkHttp/`HttpClient`로 옮기는 것입니다. 보안 프로바이더 경로는 이미 `timeout(Duration)`으로 호출당 상한(기본 3000ms)을 둡니다.
:::

:::details 보안 호출에서 fail-closed와 fail-open은 무슨 차이인가요?
프로바이더 호출이 실패했을 때의 기본값 정책입니다. `failOpen=1`이면 결과를 비우고 통과시켜 가용성을 우선합니다. 아니면 `riskLevel=PENDING`·`action=REVIEW`로 떨어뜨려, 외부 장애 시에도 위험을 낮게 단정하지 않고 보수적으로 검토 대기로 보냅니다. 인증 결정에 쓰이는 호출이라 기본을 fail-closed로 두는 게 안전합니다.
:::

:::details RestTemplate와 OkHttp 인터셉터의 횡단 처리는 어떻게 다른가요?
RestTemplate은 `ClientHttpRequestInterceptor`로 헤더·로깅을 끼웁니다. OkHttp는 `addInterceptor`로 애플리케이션/네트워크 두 층의 인터셉터를 두어 재시도·인증 갱신·요청·응답 로깅(`logging-interceptor`)을 더 세밀하게 횡단 처리할 수 있습니다. 멀티 AI 프로바이더의 공통 헤더·로깅을 한 곳에 모으려면 OkHttp 인터셉터가 유리합니다.
:::

:::details 응답 매핑을 코드에 하드코딩하지 않은 이유는요?
`SecurityAssessmentHttpClient`는 프로바이더마다 응답 JSON 모양이 달라서, `responseMappingJson`에 JSON Pointer로 score/label/confidence/decision 위치를 설정해 두고 런타임에 그 경로로 값을 뽑습니다. 새 프로바이더를 코드 수정 없이 설정만으로 붙일 수 있어, 보안 프로바이더 교체·추가가 쉬워집니다.
:::

## 8. 직접 말해보기

- TripTogether의 세 HTTP 스택을 한 문장씩으로 구분해 설명해 보라(선언 vs 실호출 포함).
- AI 호출과 보안 프로바이더 호출을 왜 다른 클라이언트로 분리했는지, 신뢰 경계 관점에서 말해 보라.
- 기본 `RestTemplate` 빈에 타임아웃이 없을 때 생기는 문제와 두 가지 해결책을 말해 보라.
- fail-closed 기본값이 보안 호출에 적합한 이유를 한 문장으로 정리해 보라.

## 퀴즈

<QuizBox question="TripTogether에서 OpenAI·Gemini·Claude·Perspective 같은 AI/모더레이션 API의 실제 런타임 호출을 주로 담당하는 클라이언트는?" :choices="['코드에서 직접 생성한 OkHttpClient', 'config의 RestTemplate 빈', 'JDK java.net.http.HttpClient', 'Spring WebClient(WebFlux)']" :answer="1" explanation="pom에 OkHttp 5가 선언돼 있지만 src/main에는 okhttp3 호출 코드가 없다. AssistantServiceImpl·PerspectiveService·InquiryAiService 등은 RestTemplateConfig가 제공하는 RestTemplate 빈으로 호출한다." />

<QuizBox question="로그인 위험평가용 SecurityAssessmentHttpClient의 호출 정책으로 옳은 것은?" :choices="['타임아웃 없이 무한 대기한다', '실패하면 항상 통과시켜 가용성을 우선한다', '프로바이더 설정 타임아웃(기본 3000ms)·재시도·스로틀을 적용하고 기본은 fail-closed다', 'OkHttp 인터셉터로 재시도를 구현한다']" :answer="2" explanation="이 경로는 JDK HttpClient에 timeout(Duration)을 걸고, retryCount 기반 백오프 재시도와 ProviderCallThrottler 스로틀을 적용한다. failOpen=1이 아니면 실패 시 PENDING/REVIEW로 떨어뜨리는 fail-closed가 기본이다." />

<QuizBox question="현재 기본 RestTemplate 빈(config/RestTemplateConfig)의 잠재적 약점은?" :choices="['CSRF 토큰을 자동으로 붙이지 않는다', 'connect/read 타임아웃이 설정돼 있지 않다', 'JSON 직렬화를 지원하지 않는다', '세션 인증을 깨뜨린다']" :answer="1" explanation="new RestTemplate()는 타임아웃 미설정이라 외부 AI 지연 시 요청 스레드가 오래 묶일 수 있다. AI 전용 빈에 connect/read 타임아웃을 거는 것이 개선 과제다." />
