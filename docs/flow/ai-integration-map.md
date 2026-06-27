# AI 통합 맵

> TripTogether는 한 개의 거대 모델이 아니라, 도메인 특성에 맞춰 5개의 AI 서비스를 골라 쓴다. 이 페이지는 어떤 AI가 어느 도메인에서, 어떤 호출 패턴·폴백·쿼터·모더레이션으로 동작하는지를 한 장의 지도로 정리한다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

TripTogether의 AI 레이어는 **생성형 LLM 3종(OpenAI GPT-4o-mini, Google Gemini 2.5 Flash, Anthropic Claude Haiku)** 과 **분류·번역 API 2종(Google Perspective, Google Cloud Translation)** 을 도메인별로 분담시키고, 공통적으로 **외부 HTTP 호출 추상화·폴백·쿼터·모더레이션** 으로 감싼 구조다.

## 2. 왜 이렇게 설계했나

한 모델로 전부 처리하지 않은 이유는 **작업 성격이 도메인마다 다르기 때문**이다.

- **멀티턴 대화 vs 단발 분류**: 여행 상담은 문맥 누적이 필요하지만, 문의 답변 초안은 1회성이다.
- **자유 텍스트 vs 엄격한 스키마**: 챗봇 답변은 자연어지만, AI 일정은 DB에 바로 들어갈 JSON이어야 한다.
- **품질 우선 vs 비용·속도 우선**: 사용자 대면 상담은 품질을, 관리자 보조나 대량 모더레이션은 속도·단가를 우선한다.
- **장애 격리**: 한 벤더가 죽어도 다른 도메인은 살아 있어야 한다. 모델을 쪼개면 장애 폭발 반경이 도메인 단위로 제한된다.

그래서 도메인별로 가장 잘 맞는 모델을 붙이고, 어떤 AI가 실패해도 **핵심 사용자 흐름(글쓰기·문의 등록·관리자 답변)은 막히지 않도록** 모든 호출을 fail-safe로 감쌌다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

### AI별 담당 매핑

| AI / API | 모델·엔드포인트 | 주 사용 도메인 | 핵심 클래스 | 출력 형태 |
| --- | --- | --- | --- | --- |
| OpenAI | gpt-4o-mini, chat/completions | assistant(멀티턴 상담), courses(AI 일정) | `AssistantServiceImpl`, `AiPlanGPTServiceImpl` | 자유 텍스트 / 엄격 JSON Schema |
| Google Gemini | gemini-2.5-flash, generateContent | common(네비 챗봇), explore(개인화 추천), 의도 분류 | `ChatbotService`, `RecommendService`, `IntentContextService` | 구조화 JSON |
| Anthropic Claude | claude-haiku, v1/messages | inquiry(답변 초안) | `InquiryAiService` | 답변 초안 텍스트 |
| Google Perspective | comments:analyze, TOXICITY | community·inquiry 독성 감지 | `PerspectiveService` | 0.0~1.0 점수 |
| Google Translation | 번역 API + DB 캐시 | i18n·explore 다국어 | `SpotTextTranslationService`, i18n 모듈 | 번역 텍스트 |

### 호출을 감싸는 공통 인프라

| 관심사 | 구현 위치 | 동작 |
| --- | --- | --- |
| HTTP 호출 | `RestTemplate`(공통) + OkHttp(일부) | 모든 외부 AI 호출이 동일한 클라이언트 추상화를 거침 |
| 쿼터 | `ChatbotQuotaService`, `CHATBOT_QUOTA` 테이블 | 등급별 일일 메시지·대화 수 한도 |
| 사전 분류 | `IntentContextService` | 본 호출 전 의도·키워드 추출(쿼터 미소모) |
| Fast-Path | `ChatbotFastPathService` | 단순 네비게이션은 LLM 호출 자체를 생략 |
| 모더레이션 | `PerspectiveService`, `AdminAssistantModerationService` | 독성 점수 산출 + 관리자 승인 큐 |
| 차단 | `ChatbotBlockService`, `AdminAssistantBlockService` | IP·USER 단위 차단 |
| 정책 임계값 | `ModerationPolicyService`, `CONTENT_MODERATION_POLICY` | 독성 임계값 등을 DB에서 런타임 조회 |

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 도메인 → AI 라우팅 한눈에

```text
사용자 여행 상담        → assistant   → OpenAI GPT-4o-mini (멀티턴, history 최대 20)
AI 여행 일정 자동생성   → courses     → OpenAI GPT-4o-mini (JSON Schema strict=true)
사이트 네비 챗봇        → common      → Gemini 2.5 Flash   (구조화 JSON: message·links·quickReplies)
여행지 개인화 추천      → explore     → Gemini 2.5 Flash   (DB캐시 → Gemini → 트렌딩 3단 폴백)
관리자 문의 답변 초안   → inquiry     → Claude Haiku       (싱글턴, 실패 시 빈 문자열)
댓글·글·문의 독성 검사  → community   → Perspective        (비동기, ai_flagged 세팅)
다국어 표시            → i18n·explore → Translation + DB캐시
```

### 4-2. 챗봇 호출 파이프라인 (쿼터·분류·Fast-Path·폴백이 모두 보이는 대표 흐름)

`ChatbotService.ask()` 한 메서드 안에 공통 패턴이 압축돼 있다.

```text
1. 차단 체크        (IP + USER)         → 차단이면 즉시 안내 응답
2. 등급별 한도 조회  (resolveGrade)
3. 주기 사용량 체크  (한도 초과면 즉시 반환)
4. 대화 조회/생성    (대화 수 한도 체크)
5. 유저 메시지 저장
5.5 Fast-Path        단순 네비면 LLM 생략하고 즉답
6. 최근 N개 히스토리 로드
6.5 1차 의도 분류    (쿼터 미소모, 실패 시 규칙 기반 fallback)
6.6 부적절 판정 시   본 호출 생략 + 안전 응답 (토큰 절감)
7. Gemini 본 호출
8~12 응답 파싱·저장·사용량 +1
```

핵심은 **본 LLM 호출에 도달하기 전에 차단·쿼터·Fast-Path·사전 분류로 여러 번 걸러낸다**는 점이다. 비용과 악용을 호출 이전 단계에서 줄인다.

### 4-3. 공통 폴백 원칙 (fail-safe)

AI 실패가 사용자 흐름을 막지 않도록, 도메인마다 다른 안전망을 둔다.

| 도메인 | AI 실패 시 동작 |
| --- | --- |
| explore 추천 | DB 캐시 → Gemini → 트렌딩 여행지 순으로 폴백 |
| common 챗봇 | 고정 안내 메시지 + 기본 탐색·커뮤니티 링크 반환 |
| inquiry 초안 | 빈 문자열 반환 → 관리자가 직접 작성 |
| community 독성 | 점수 null이면 통과(필터 건너뜀), 글쓰기는 항상 성공 |

### 4-4. 구조화 출력 (GPT JSON Schema)

courses의 AI 일정은 DB에 바로 적재되므로, GPT 응답 형식을 강제한다. `AiPlanGPTServiceImpl`이 `response_format`에 JSON Schema를 strict=true로 넘긴다.

```text
travel_plan_response
└ title, summary
└ days[]
   └ dayNo, date, theme
   └ spots[]
      └ name, description, visitOrder   (모두 required)
```

응답은 `AiPlanResponseDTO`로 역직렬화되고, `AiPlanServiceImpl`이 `@Transactional` 안에서 `TRAVEL_PLAN`(plan_source = AI)과 `PLAN_SPOT`(visit_order)에 저장한다. 중간 실패 시 전체 롤백된다.

### 4-5. 챗봇이 만든 링크 검증

Gemini가 응답 JSON에 내부 링크를 넣어주는데, 모델 출력은 신뢰할 수 없으므로 화이트리스트로 검증한다.

```text
허용: 정규식 화이트리스트에 매칭되는 내부 경로만 (예: /explore, /courses)
차단: 위험 스킴(javascript: data: file: vbscript:),
      프로토콜 상대경로 //, 경로 순회 .. 포함
비로그인 사용자에게는 /mypage 링크 제거
```

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- GPT 멀티턴 상담 + 대화 DB 저장(`CHAT_POST`/`CHAT_COMMENT`), history 최대 20
- GPT 구조화 출력 기반 AI 일정 생성·저장
- Gemini 네비 챗봇 + 구조화 JSON + 링크 화이트리스트
- Gemini 개인화 추천 3단 폴백
- 의도 분류·Fast-Path·등급별 쿼터·차단
- Claude Haiku 문의 답변 초안
- Perspective 비동기 독성 감지 + ai_flagged
- 관리자 모더레이션 큐·쿼터·차단 모니터링
:::

:::warning Mock·계획 단계
- 항공권은 Mock 프로바이더로 실제 외부 항공 API와 연동되지 않음(추상 인터페이스만 정의)
- **AI 응답 품질을 정량 평가하는 체계는 아직 없음**(임계값·휴먼 검수 중심, 자동 스코어링은 향후 과제)
- 일부 외부 키가 미발급일 수 있어 폴백·fail-safe 경로로 빠질 수 있음
- Swagger 등 API 문서 자동화 부재
:::

:::details 보안 메모
프롬프트·엔드포인트·모델명은 공개해도 무방하지만, 실제 API 키·계정 식별자는 절대 코드에 남기면 안 된다. 운영 값은 환경변수(API_KEY 형태)로 주입하는 것이 원칙이다. 이 학습 자료의 모든 키·호스트는 자리표시자다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "도메인 성격에 맞춰 GPT·Gemini·Claude·Perspective·번역 API를 분담시키고, 호출 추상화·폴백·쿼터·모더레이션을 공통으로 감싼 다중 AI 구조입니다."
2. **왜·어떻게**: "멀티턴 상담은 GPT, 구조화 일정은 GPT의 JSON Schema, 네비·추천은 Gemini, 문의 초안은 빠르고 저렴한 Claude Haiku, 독성 검사는 Perspective로 나눴습니다. 본 호출 전에 차단·쿼터·Fast-Path·사전 분류로 걸러 비용과 악용을 줄였고, 모든 호출은 실패해도 사용자 흐름을 막지 않게 fail-safe로 설계했습니다."
3. **한계·확장**: "현재 AI 품질을 정량 평가하는 자동 체계가 없는 게 약점이라, 출력 스키마 검증 로그와 휴먼 검수에 의존합니다. 다음 단계는 평가 지표 수집과 모델 교체를 쉽게 하는 추상화 강화입니다."

## 7. 꼬리질문 + 모범답안

:::details 모델을 왜 한 개로 통일하지 않았나요?
작업 성격이 다르기 때문입니다. 멀티턴 상담, DB에 바로 들어가는 구조화 출력, 단발 답변 초안, 대량 독성 분류는 요구 품질·비용·지연이 다릅니다. 도메인별로 적합한 모델을 붙이면 비용·품질을 최적화하고, 한 벤더 장애의 영향 범위를 도메인 단위로 격리할 수 있습니다.
:::

:::details AI가 응답을 못 줄 때 서비스는 어떻게 되나요?
도메인마다 폴백이 다릅니다. 추천은 DB 캐시와 트렌딩으로, 챗봇은 고정 안내와 기본 링크로, 문의 초안은 빈 문자열로 떨어져 관리자가 직접 작성합니다. 독성 검사가 실패하면 점수를 null로 보고 글쓰기를 통과시킵니다. 공통 원칙은 AI 실패가 핵심 사용자 행동을 막지 않는 것입니다.
:::

:::details LLM이 만든 링크를 그대로 화면에 노출하면 위험하지 않나요?
그래서 챗봇은 정규식 화이트리스트로 내부 경로만 허용하고, 위험 스킴(javascript: data: file:)·프로토콜 상대경로·경로 순회를 차단합니다. 비로그인 사용자에게는 마이페이지 링크를 제거합니다. 모델 출력은 신뢰 경계 밖이라는 전제로 검증합니다.
:::

:::details 토큰 비용과 악용은 어떻게 통제하나요?
본 호출 이전에 여러 게이트를 둡니다. 차단된 IP·유저는 즉시 거르고, 등급별 일일 쿼터로 호출 수를 제한하며, 단순 네비게이션은 Fast-Path로 LLM을 아예 생략합니다. 사전 의도 분류에서 부적절로 판정되면 본 호출 없이 안전 응답을 돌려 토큰을 아낍니다.
:::

:::details GPT 응답이 형식을 어기면 어떻게 되나요?
AI 일정 생성은 JSON Schema를 strict로 강제해 형식을 보장하고, DTO 역직렬화 단계에서 한 번 더 검증합니다. 저장은 트랜잭션 안에서 이뤄져 중간 실패 시 전체 롤백됩니다. 챗봇은 코드블록 마커를 제거한 뒤 파싱하고, 실패하면 폴백 응답으로 떨어집니다.
:::

## 8. 직접 말해보기

- 5개 AI를 각각 어느 도메인이 왜 쓰는지 30초 안에 표 없이 말해보기
- 챗봇 한 번 호출이 본 LLM에 닿기까지 거치는 게이트(차단·쿼터·Fast-Path·분류)를 순서대로 설명하기
- AI가 전부 실패한 상황을 가정하고, 각 도메인이 무엇으로 폴백하는지 말하기
- LLM이 만든 출력을 왜 신뢰 경계 밖으로 보고 검증하는지, 링크 검증 규칙을 예로 설명하기

## 퀴즈

<QuizBox question="TripTogether에서 DB에 바로 저장되는 AI 여행 일정 생성에 사용하는 모델과 출력 강제 방식의 조합으로 옳은 것은?" :choices="['Gemini 2.5 Flash + 자유 텍스트', 'GPT-4o-mini + JSON Schema strict 구조화 출력', 'Claude Haiku + 싱글턴 텍스트', 'Perspective + 독성 점수']" :answer="1" explanation="courses 도메인의 AiPlanGPTServiceImpl은 GPT-4o-mini에 response_format으로 JSON Schema를 strict=true로 강제해, DB에 적재 가능한 구조화 응답을 받는다." />

<QuizBox question="사이트 네비게이션 챗봇에서 단순한 경로 안내 요청을 처리할 때 본 LLM 호출을 생략하는 최적화 장치의 이름은?" :choices="['IntentContextService', 'ChatbotFastPathService', 'PerspectiveService', 'ChatbotBlockService']" :answer="1" explanation="ChatbotFastPathService가 단순 네비게이션 요청을 LLM 호출 없이 즉답해 토큰 비용을 줄인다. IntentContextService는 사전 의도 분류, BlockService는 차단을 담당한다." />

<QuizBox question="Gemini 기반 여행지 개인화 추천에서 AI 호출이 실패하거나 결과가 없을 때의 최종 폴백으로 옳은 것은?" :choices="['오류 화면을 그대로 노출한다', 'DB 캐시 다음 단계로 트렌딩 여행지를 반환한다', 'GPT로 재시도한다', '빈 배열을 반환하고 사용자에게 다시 요청을 받는다']" :answer="1" explanation="RecommendService는 DB 캐시 적중 다음으로 Gemini를 호출하고, 후보가 없거나 Gemini 결과가 없으면 요즘 뜨는 여행지 트렌딩 목록으로 폴백한다." />
