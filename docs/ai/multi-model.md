# 다중 AI 모델 통합

> TripTogether는 단일 LLM에 모든 일을 시키지 않는다. 대화·일정은 GPT, 네비·추천은 Gemini, 답변 초안은 Claude, 독성 판정은 Perspective — 용도별로 모델을 나눠 비용과 강점을 맞춘다.

이 페이지는 특정 모듈 한 곳이 아니라 프로젝트 전반(여러 도메인이 공동 사용하는)에 걸친 AI 모델 선택 전략을 다룬다. 도메인별 상세는 각 모델 페이지로 링크한다.

## 1. 한 줄 정의

서로 다른 4개 외부 AI 제공자(OpenAI GPT-4o-mini, Google Gemini 2.5 Flash, Anthropic Claude Haiku, Google Perspective)를 용도별로 분리 호출하고, 모두 같은 HTTP 호출 패턴으로 추상화해 다루는 통합 전략.

## 2. 왜 이렇게 설계했나

핵심 질문은 "왜 하나로 통일하지 않았나"이다. 단일 모델은 운영이 단순하지만, 작업 성격이 너무 다르면 한 모델이 모든 면에서 최적일 수 없다.

| 작업 성격 | 요구 사항 | 선택 모델 |
| --- | --- | --- |
| 멀티턴 여행 상담, 일정 생성 | 대화 품질, 엄격한 JSON Schema 구조화 출력 | GPT-4o-mini |
| 사이트 네비 챗봇, 개인화 추천 | 빠르고 저렴, 구조화 JSON, 대량 호출 | Gemini 2.5 Flash |
| 문의 답변 초안 | 긴 맥락 요약, 정중한 한국어 작문 | Claude Haiku |
| 댓글·문의 독성 판정 | 0~1 수치 점수, 분류 전용 | Perspective API |

설계 의도를 한 문장으로 요약하면 **"비용이 싼 작은 모델을 여러 개, 각자 잘하는 자리에"** 다.

- **비용**: 사용자 트래픽이 몰리는 챗봇·추천에는 가장 저렴한 Gemini Flash를, 빈도가 낮고 작문 품질이 중요한 문의 초안에는 Claude Haiku를 둔다. 전부 GPT-4o로 통일했다면 호출량 많은 경로의 비용이 불필요하게 커진다.
- **강점 분리**: GPT는 `strict: true` JSON Schema 구조화 출력이 강해 일정 생성처럼 깨지면 안 되는 데이터에 쓴다. Perspective는 생성 모델이 아니라 분류 전용 API라 독성 점수만 뽑는 데 정확하고 싸다.
- **장애 격리**: 한 제공자가 다운돼도 다른 기능은 살아 있다. 예를 들어 OpenAI 장애가 추천(Gemini)이나 독성 판정(Perspective)을 막지 않는다.

:::tip 트레이드오프
모델이 늘면 API 키 관리·프롬프트 유지보수·응답 포맷 차이라는 운영 비용이 생긴다. TripTogether는 호출 코드를 단일 패턴으로 통일하고(아래 4절), 키를 런타임 설정/환경변수로 분리해 이 비용을 억제한다.
:::

## 3. 어떤 기술로 구현했나

네 모델 모두 외부 REST API다. 자체 SDK 없이 **Spring의 `RestTemplate` 빈 하나**(`RestTemplateConfig`)로 JSON을 직접 POST하고 응답 Map을 파싱한다.

| 모델 | 호출 클래스 | API 엔드포인트(호스트) | 인증 헤더/파라미터 |
| --- | --- | --- | --- |
| GPT-4o-mini (어시스턴트) | `AssistantServiceImpl` | api.openai.com/v1/chat/completions | Authorization Bearer |
| GPT-4o-mini (AI 일정) | `AiPlanGPTServiceImpl` | api.openai.com/v1/chat/completions | Authorization Bearer |
| Gemini 2.5 Flash | `ChatbotService`, `RecommendService` | generativelanguage.googleapis.com/v1beta | URL 쿼리 key |
| Claude Haiku | `InquiryAiService` | api.anthropic.com/v1/messages | x-api-key + anthropic-version |
| Perspective | `PerspectiveService` | commentanalyzer.googleapis.com/v1alpha1 | URL 쿼리 key |

모델명·API 키 같은 가변 값은 코드에 박지 않고 외부 설정으로 주입한다.

```java
// 모델명은 설정에서, 기본값을 함께 지정
@Value("${openai.model:gpt-4o-mini}")
private String openAiModel;

// 키는 절대 소스에 두지 않고 환경변수/런타임 설정으로
@Value("${openai.api.key:}")
private String openAiApiKey;
```

:::warning 보안 — 키는 코드에 두지 않는다
API 키는 환경변수 또는 DB 런타임 설정(`APPLICATION_RUNTIME_SETTING`, `is_secret` 플래그)으로 주입하고, 소스·커밋·이 학습 페이지 어디에도 평문 키를 남기지 않는다. 모델별로 키를 분리하면 한 키 유출 시 영향 범위가 줄어든다. 문서에서는 항상 `API_KEY` 같은 자리표시자만 쓴다.
:::

## 4. 동작 원리

### 공통 호출 흐름

제공자가 달라도 코드 골격은 같다. 이 단일 패턴이 다중 모델을 "통합"으로 묶어 주는 핵심이다.

```text
요청 객체 구성(Map)  →  헤더 세팅(인증·Content-Type)
   →  RestTemplate POST  →  응답 Map 파싱
   →  실패 시 try/catch로 폴백 또는 안전한 기본값
```

```java
// 어느 모델이든 동일한 골격
Map<String, Object> body = new HashMap<>();
body.put("model", openAiModel);          // 모델별로 키 이름만 다름
// ... 메시지/스키마 추가 ...
HttpHeaders headers = new HttpHeaders();
headers.setContentType(MediaType.APPLICATION_JSON);
// 인증 헤더는 제공자마다: Bearer / x-api-key / URL key
Map<?, ?> res = restTemplate.postForObject(url, new HttpEntity<>(body, headers), Map.class);
```

### 제공자별 차이점

- **GPT (어시스턴트)**: 멀티턴. 직전 대화 히스토리를 `MAX_HISTORY = 20`개로 잘라 함께 보내고, `temperature = 0.7`. 시스템 프롬프트는 사용자 언어(ko/en/ja/zh)에 맞춰 동적으로 생성한다.
- **GPT (AI 일정)**: `response_format`에 `json_schema`를 `strict: true`로 지정해 `title/summary/days[]` 구조를 강제한다. 응답은 `AiPlanResponseDTO`로 역직렬화되고 DB 저장은 `@Transactional`로 묶여 실패 시 롤백된다.
- **Gemini (챗봇)**: 응답을 `{message, links[], quickReplies[], inappropriate}` JSON으로 받아 네비/링크 UI에 매핑한다. 단순 네비 질문은 fast-path로 LLM 호출 자체를 건너뛰고, 그 앞단에서 등급 쿼터·의도 분류를 통과해야 한다.
- **Claude (문의 초안)**: `x-api-key`와 `anthropic-version` 헤더를 쓰는 messages API. 문의 본문을 정중한 한국어 초안으로 요약하며, 관리자가 검토 후 발송한다(자동 발송 아님).
- **Perspective (독성)**: 생성이 아니라 분류. `requestedAttributes`에 `TOXICITY`를 요청하고 `attributeScores.TOXICITY.summaryScore.value`(0~1)를 꺼낸다. 정책 임계값(`toxicityThreshold`) 이상이면 모더레이션 대상으로 표시한다.

### 표: 한눈에 비교

| 항목 | GPT-4o-mini | Gemini 2.5 Flash | Claude Haiku | Perspective |
| --- | --- | --- | --- | --- |
| 역할 | 대화·일정 | 네비·추천 | 답변 초안 | 독성 점수 |
| 출력 형태 | 텍스트 / strict JSON | 구조화 JSON | 텍스트 | 수치 0~1 |
| 호출 빈도 | 중 | 높음 | 낮음 | 높음 |
| 구조화 강제 | 강함 | 보통 | 약함 | 해당 없음 |

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| GPT 멀티턴 어시스턴트 + DB/세션 히스토리 | 구현됨 |
| GPT AI 일정 생성 (strict JSON Schema, 트랜잭션 롤백) | 구현됨 |
| Gemini 네비 챗봇 (fast-path, 쿼터, 의도 분류) | 구현됨 |
| Gemini 개인화 추천 (DB 캐시 → Gemini → 트렌딩 3단 폴백) | 구현됨 |
| Claude 문의 답변 초안 | 구현됨 |
| Perspective 독성 점수 + 관리자 승인 모더레이션 | 구현됨 |
| **AI 응답 품질 정량 평가 체계** | **계획 (현재 부재, 향후 과제)** |

:::tip 정직한 한계
4개 모델 호출은 모두 실제 연동이다. 다만 응답 품질을 수치로 회귀 테스트하는 평가 하니스는 없다. 면접에서 강점을 말한 뒤 이 한계를 먼저 짚으면 신뢰가 올라간다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: TripTogether는 단일 LLM 대신 작업 성격에 맞춰 GPT, Gemini, Claude, Perspective 네 모델을 용도별로 나눠 씁니다.
2. **이유**: 대화·구조화 일정은 GPT, 대량 호출되는 챗봇·추천은 저렴한 Gemini Flash, 작문 품질이 필요한 문의 초안은 Claude, 독성 판정은 분류 전용 Perspective로 비용과 강점을 동시에 맞췄습니다. 한 제공자가 다운돼도 다른 기능이 살아 장애가 격리됩니다.
3. **구현**: 네 모델 모두 `RestTemplate` 하나로 JSON을 직접 POST하는 동일 패턴으로 추상화했고, 모델명과 키는 환경변수·DB 런타임 설정으로 분리했습니다. GPT 일정은 strict JSON Schema로 구조를 강제하고 트랜잭션으로 롤백합니다.

## 7. 꼬리질문 + 모범답안

:::details 모델을 하나로 통일하면 운영이 더 단순하지 않나요?
단순해지지만 호출량 많은 챗봇·추천까지 비싼 모델을 쓰면 비용이 커지고, 한 제공자 장애가 전체 AI를 멈춥니다. 호출 코드를 단일 패턴으로 통일해 운영 복잡도는 억제하고, 모델 선택만 용도별로 분리해 비용·강점·장애 격리를 얻는 절충을 택했습니다.
:::

:::details 모델마다 응답 포맷이 다른데 어떻게 다뤘나요?
구조가 중요한 GPT 일정은 strict JSON Schema로 스키마를 강제하고 DTO로 역직렬화합니다. Gemini는 응답 JSON 형식을 시스템 프롬프트로 고정하고 파싱 실패에 대비한 try/catch를 둡니다. Perspective는 정해진 응답 트리에서 점수만 꺼냅니다. 즉 모델별 신뢰도에 맞춰 강제 수준을 다르게 둡니다.
:::

:::details 외부 AI 호출이 실패하면 사용자 경험은 어떻게 되나요?
호출은 try/catch로 감싸 실패해도 화면이 깨지지 않게 합니다. 추천은 DB 캐시에서 Gemini, 다시 트렌딩으로 내려가는 3단 폴백이 있고, 독성 점수는 호출 실패 시 null을 반환해 차단을 강제하지 않습니다. 문의 초안과 일정은 관리자/사용자가 다시 시도할 수 있는 보조 기능이라 핵심 흐름을 막지 않습니다.
:::

:::details API 키는 어떻게 관리하나요?
소스에 평문으로 두지 않고 환경변수 또는 DB 런타임 설정(is_secret 플래그)으로 주입합니다. 모델별로 키를 분리해 한 키가 유출돼도 영향 범위를 좁힙니다. 코드에는 자리표시자와 기본값만 둡니다.
:::

:::details 왜 OpenAI SDK 대신 RestTemplate로 직접 호출했나요?
제공자가 4곳이라 각각 SDK를 붙이면 의존성과 학습 비용이 늘어납니다. 모두 단순 REST/JSON이라 RestTemplate 빈 하나로 동일한 호출 골격을 공유하는 편이 통합 관점에서 일관적이고 유지보수가 쉽습니다.
:::

## 8. 직접 말해보기

아래를 막힘없이 60초로 말할 수 있으면 이 주제는 통과다.

- 네 모델과 각자의 역할을 한 문장씩.
- "왜 하나로 통일하지 않았나"를 비용·강점·장애 격리 세 단어로.
- GPT 일정에서 strict JSON Schema가 왜 필요한지.
- 외부 호출이 실패할 때 추천·독성 판정이 각각 어떻게 버티는지.
- 현재 없는 것(품질 정량 평가)을 한 줄로 인정하기.

**더 읽기**

- [GPT 어시스턴트·일정](/ai/gpt-assistant)
- [Gemini 챗봇·추천](/ai/gemini-chatbot)
- [Claude 문의 초안](/ai/claude-inquiry)
- [Perspective 독성 감지](/ai/perspective-toxicity)
- [구조화 출력](/ai/structured-outputs) · [폴백 전략](/ai/fallback-strategy)
- 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TripTogether가 단일 LLM 대신 모델을 용도별로 4개로 나눈 핵심 이유로 가장 거리가 먼 것은?" :choices="['대량 호출 경로에 저렴한 모델을 배치해 비용을 줄이려고', '작업 성격에 맞는 각 모델의 강점을 활용하려고', '한 제공자 장애가 전체 AI를 멈추지 않게 장애를 격리하려고', '모든 모델을 합쳐 하나의 더 큰 모델처럼 앙상블 추론을 하려고']" :answer="3" explanation="모델을 합쳐 앙상블 추론을 하려는 것이 아니라, 비용 절감 강점 활용 장애 격리를 위해 용도별로 분리한 것이다." />

<QuizBox question="네 AI 모델 호출에서 공통으로 사용한 HTTP 처리 방식은?" :choices="['각 제공자 전용 공식 SDK를 모두 의존성에 추가', 'Spring RestTemplate 빈 하나로 JSON을 직접 POST하고 응답 Map을 파싱', 'JPA 리포지토리를 통해 외부 API를 매핑', '프론트엔드에서 직접 모델 API를 호출']" :answer="1" explanation="모두 단순 REST JSON이라 RestTemplate 빈 하나로 동일한 호출 골격을 공유한다. SDK를 4개 붙이지 않는다." />

<QuizBox question="구조가 절대 깨지면 안 되는 AI 일정 생성에서 GPT 응답 형식을 강제하기 위해 사용한 방법은?" :choices="['응답을 정규식으로 후처리', '온도를 0으로 낮추기만 함', 'json_schema를 strict true로 지정해 스키마를 강제', 'Perspective로 출력 검증']" :answer="2" explanation="response_format에 json_schema를 strict true로 지정해 title summary days 구조를 강제하고 DTO로 역직렬화한다." />
