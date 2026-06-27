# AI 기능 전체

> TripTogether는 한 개의 거대 AI가 아니라, **용도가 다른 5개 외부 AI를 도메인별로 나눠 쓰는 다중 모델 구조**다. GPT-4o-mini는 어시스턴트·일정, Gemini 2.5 Flash는 네비 챗봇·추천, Claude Haiku는 문의 답변 초안, Perspective는 독성 감지, Google 번역은 다국어를 맡는다.

이 페이지는 프로젝트 전체에 흩어진 AI 기능을 한 장에서 매핑하기 위한 진입점이다. 각 기능이 **어떤 모델로, 어느 도메인에서, 무엇을 하는지**를 표로 잡고, 깊이 들어가는 개별 문서로 연결한다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 한 줄 정의

TripTogether의 AI는 **단일 챗봇이 아니라, 작업 성격에 맞춰 모델·프롬프트·출력 형식·실패 처리를 따로 설계한 5종 외부 AI의 조합**이다. 4명이 도메인을 수직 분담해 만들었기 때문에, 각 도메인이 자기 목적에 가장 잘 맞는 모델을 독립적으로 선택했고, 그 결과 자연스럽게 멀티 모델 아키텍처가 됐다.

## 2. 왜 이렇게 설계했나

- **작업마다 최적 모델이 다르다.** 멀티턴 대화(어시스턴트)는 GPT, 구조화 JSON 응답(챗봇·추천)은 Gemini, 짧은 단발 초안(문의)은 빠르고 저렴한 Claude Haiku, 텍스트 독성 점수는 전용 분류 API(Perspective)가 각각 유리하다. 하나로 통일하기보다 **용도별 최적화**를 택했다.
- **도메인 자율성.** 도메인을 수직 분담했으므로, AI 호출도 각 도메인 서비스(`AssistantServiceImpl`, `ChatbotService`, `RecommendService`, `InquiryAiService`, `PerspectiveService`)가 **자기 책임 범위 안에서 독립**적으로 한다. 공용 AI 게이트웨이를 강제하지 않아 모듈 간 결합을 낮췄다.
- **실패해도 서비스가 멈추지 않게.** 외부 AI는 느리거나 죽을 수 있다. 그래서 거의 모든 호출이 **fail-safe**다 — 챗봇은 폴백 응답, 추천은 트렌딩 폴백, 문의 초안은 빈 문자열, 독성 검사는 false(통과)로 떨어진다. AI 장애가 핵심 기능(글쓰기·답변·탐색)을 막지 않는다.
- **AI가 만든 출력은 신뢰하지 않고 검증한다.** Gemini가 돌려준 링크 URL은 화이트리스트로 거르고, AI 일정의 장소명은 실제 스팟 FK로 매칭하지 않으며, 추천 spot_idx는 후보 집합에 있는지 다시 확인한다. **LLM 출력은 입력처럼 취급해 정화**한다.

## 3. 어떤 기술로 구현했나 (실제 모델·도메인·클래스)

다섯 갈래 모두 외부 HTTP API 호출이며, `RestTemplate`(일부 OkHttp) + JSON 파싱으로 붙는다. API 키는 자리표시자 기준 `API_KEY`로 환경변수/설정에서 주입된다.

| 모델 / API | 담당 도메인 | 핵심 클래스 | 무엇을 하나 | 출력 형식 |
| --- | --- | --- | --- | --- |
| OpenAI GPT-4o-mini | assistant | `AssistantServiceImpl` | 여행 멀티턴 도우미(최근 20개 히스토리, 다국어 시스템 프롬프트) | 자유 텍스트 |
| OpenAI GPT-4o-mini | courses | `AiPlanGPTServiceImpl` | 여행 일정 자동 생성 | Structured Outputs(JSON Schema strict) |
| Google Gemini 2.5 Flash | common | `ChatbotService` | 사이트 네비게이션 챗봇(트립이) | 구조화 JSON(message/links/quickReplies/inappropriate) |
| Google Gemini 2.5 Flash | explore | `RecommendService` | 여행지 개인화 추천 3건 | JSON 배열(spot_idx/reason/score) |
| Anthropic Claude Haiku | inquiry | `InquiryAiService` | 관리자 문의 답변 초안(단발) | 자유 텍스트 |
| Google Perspective API | community·inquiry | `PerspectiveService` | 독성(TOXICITY) 점수 0~1 측정 | 점수(숫자) |
| Google Cloud Translation | i18n·explore | `SpotTextTranslationService` 등 | 다국어 번역(캐싱) | 번역 텍스트 |

:::tip 다섯 갈래를 한 문장으로
**GPT는 말하고 짜고(대화·일정), Gemini는 안내하고 고르고(챗봇·추천), Claude는 초안을 쓰고, Perspective는 검열하고, Google 번역은 옮긴다.**
:::

보조 장치들도 AI 비용·안전을 떠받친다. 챗봇은 등급별 쿼터(`ChatbotQuotaService`), 단순 네비는 LLM을 생략하는 fast-path(`ChatbotFastPathService`), 2단계 의도 분류(`IntentContextService`), 차단(`ChatbotBlockService`)을 거친다.

## 4. 동작 원리 (도메인 → 모델 → 안전망)

다섯 갈래의 공통 골격은 같다. **요청을 받아 → 컨텍스트를 모아 → 프롬프트를 만들어 → 모델을 호출 → 출력을 검증·저장**한다. 차이는 출력 형식과 실패 처리다.

```text
[챗봇 한 건]  차단체크 → 쿼터체크 → fast-path? → 의도분류 → Gemini 호출
              → URL 화이트리스트로 링크 정화 → DB 저장 → 사용량 +1
[일정 생성]   요청검증 → GPT(JSON Schema strict) → DTO 역직렬화
              → @Transactional 로 TRAVEL_PLAN/PLAN_SPOT 저장(실패 시 롤백)
[추천]        최근 30건 체류로그 → 관심태그 추출 → 후보 조회
              → Gemini → spot_idx FK 검증 → 캐시 저장 (없으면 트렌딩 폴백)
[문의 초안]   카테고리/제목/본문 → Claude 단발 호출 → 실패 시 빈 문자열
[독성]        텍스트 → Perspective → 임계값 이상이면 ai_flagged=1 (비동기)
```

표로 정리하면 각 갈래의 설계 결정이 또렷하다.

| 갈래 | 컨텍스트 소스 | 출력 검증 | 실패 시 |
| --- | --- | --- | --- |
| GPT 어시스턴트 | 세션·DB 히스토리(최대 20) | 텍스트 그대로 | 안내 메시지 |
| GPT 일정 | 사용자 폼 입력 | JSON Schema가 형식 보장 | 예외 → 롤백 |
| Gemini 챗봇 | 로그인 상태·현재 경로·실시간 사이트 데이터 | URL 화이트리스트 + 위험 스킴 차단 | 폴백 응답 |
| Gemini 추천 | 체류시간·방문빈도 가중 태그 프로필 | 후보 spot_idx 집합 대조 | 트렌딩 폴백 |
| Claude 초안 | 단일 문의 1건 | 없음(관리자 검수 전제) | 빈 문자열 |
| Perspective | 단일 텍스트 | 정책 임계값 비교 | false(통과) |

## 5. 구현 상태 (됨 vs Mock/계획)

:::warning 정직한 현황
- **됨**: 위 다섯 갈래(GPT 어시스턴트·일정, Gemini 챗봇·추천, Claude 초안, Perspective 독성, Google 번역)는 모두 실제 외부 API에 연동되어 동작한다. 챗봇 쿼터·fast-path·의도분류·URL 화이트리스트·추천 3단 폴백·일정 Structured Outputs·비동기 독성 플래그도 구현되어 있다.
- **별개 주의**: 항공권(flight)은 AI가 아니라 **Mock 프로바이더**(`FlightOfferProvider` 인터페이스만 추상화, 실제 항공 API 미연동)다. AI와 혼동하지 말 것.
- **계획/한계**: AI 응답 품질을 수치로 재는 **정량 평가 체계가 아직 없다**(향후 과제). 프롬프트는 사람이 눈으로 보고 다듬는 단계다. 또한 일정 생성의 장소명은 자유 텍스트라 실제 `SPOT_TRAVEL`과 자동 매칭되지 않는다(spot_id는 비워 저장).
:::

## 6. 면접 답변 3단계

1. **한 문장**: "TripTogether는 단일 챗봇이 아니라, 대화는 GPT, 안내·추천은 Gemini, 문의 초안은 Claude, 독성 검열은 Perspective로 **용도별 5개 모델을 도메인마다 나눠 쓰는** 멀티 모델 구조입니다."
2. **설계 근거**: "작업 성격이 다르면 최적 모델이 다릅니다. 멀티턴은 GPT, 구조화 JSON은 Gemini, 짧고 저렴한 단발은 Claude Haiku가 맞았습니다. 도메인을 수직 분담했기에 각 도메인이 독립적으로 최적 모델을 골랐고, 그게 자연스럽게 멀티 모델이 됐습니다."
3. **운영 관점**: "외부 AI는 느리거나 죽을 수 있어서 거의 모든 호출을 fail-safe로 짰습니다. 챗봇은 폴백 응답, 추천은 트렌딩 폴백, 독성은 통과로 떨어집니다. 그리고 AI 출력을 신뢰하지 않고 URL 화이트리스트·FK 대조·JSON Schema로 검증합니다."

## 7. 꼬리질문 + 모범답안

:::details 모델을 5개나 쓰면 운영이 복잡하지 않나요?
복잡성은 인정합니다. 다만 각 호출이 도메인 서비스 안에 캡슐화되어 있어 서로 영향을 주지 않고, 공통 관심사(키 주입·RestTemplate·JSON 파싱)는 패턴이 같아 학습 비용이 낮습니다. 통일했다면 일정 생성의 Structured Outputs나 챗봇의 구조화 JSON 같은 모델별 강점을 포기해야 했을 겁니다. 트레이드오프를 의식적으로 택한 결과입니다.
:::

:::details LLM이 만든 응답을 그대로 신뢰하나요?
아니요. LLM 출력은 사용자 입력처럼 신뢰하지 않는 게 원칙입니다. 챗봇이 돌려준 링크는 내부 경로 화이트리스트와 위험 스킴(자바스크립트·데이터·파일 스킴)·경로 순회 차단을 통과해야 살아남고, 추천이 돌려준 spot_idx는 후보 집합에 실제로 있는지 다시 검증하며, 일정 JSON은 strict JSON Schema로 형식을 강제합니다.
:::

:::details AI 호출이 실패하거나 느릴 때는요?
갈래별로 다릅니다. 챗봇·추천은 미리 정의한 폴백(폴백 응답, 요즘 뜨는 여행지)으로 사용자가 빈 화면을 보지 않게 합니다. 문의 초안은 빈 문자열을 반환해 관리자가 직접 쓰면 되고, 독성 검사는 false로 떨어져 글쓰기를 막지 않습니다. 또 독성 검사는 응답을 1~5초 지연시키지 않도록 비동기(@Async)로 돌려 플래그만 나중에 답니다.
:::

:::details 비용은 어떻게 통제하나요?
챗봇 기준으로 세 겹입니다. 첫째, 등급별 일일 쿼터로 호출 횟수 자체를 제한합니다. 둘째, 단순 네비게이션 질문은 fast-path로 LLM을 아예 생략합니다. 셋째, 1차 의도 분류에서 부적절로 판정되면 본 호출을 건너뛰고 안전 응답을 돌려 토큰을 아낍니다. 추천도 5분 캐시로 같은 사용자에게 반복 호출하지 않습니다.
:::

:::details AI 응답 품질은 어떻게 보장하나요?
정직하게 말하면 현재는 정량 평가 체계가 없습니다. 프롬프트를 사람이 검수하며 다듬는 단계이고, 이는 인지된 한계이자 향후 과제입니다. 다만 형식 안정성은 별개로 확보돼 있습니다 — 일정은 JSON Schema strict로, 챗봇은 응답 MIME을 JSON으로 고정하고 파싱 실패 시 폴백으로 떨어지므로, 적어도 깨진 응답이 사용자에게 노출되지는 않습니다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 답해 보세요. 막히면 위 섹션으로 돌아가세요.

- TripTogether가 한 모델로 통일하지 않고 5개를 나눠 쓴 이유를 한 문장으로?
- 챗봇이 Gemini가 준 링크를 그대로 쓰지 않는다면, 무엇으로 어떻게 거르나?
- AI 일정 생성이 실패하면 DB는 어떤 상태가 되나? (힌트: @Transactional)
- 추천이 Gemini 결과를 못 받았을 때 사용자는 무엇을 보게 되나?
- 독성 검사를 비동기로 돌리는 이유는?

## 권장 학습 순서

전체 그림 → 모델별 심화 → 공통 기법 순으로 읽으면 막힘이 없다.

1. [다중 AI 모델 통합](/ai/multi-model) — 왜 5개로 나눴는지, 모델 선택 기준 전체 지도
2. [GPT 어시스턴트·일정](/ai/gpt-assistant) — 멀티턴 대화 + 일정 생성 두 갈래
3. [Gemini 챗봇·추천](/ai/gemini-chatbot) — 구조화 JSON 챗봇 + 개인화 추천
4. [Claude 문의 초안](/ai/claude-inquiry) — 단발 답변 초안 생성
5. [Perspective 독성 감지](/ai/perspective-toxicity) — 텍스트 독성 점수·비동기 플래그
6. [구조화 출력](/ai/structured-outputs) — JSON Schema·구조화 JSON 강제 기법
7. [폴백 전략](/ai/fallback-strategy) — fail-safe·캐시·트렌딩 폴백 정리

도메인 관점에서 보고 싶다면: [AI 어시스턴트·챗봇](/assistant/) · [여행 코스·AI 일정](/courses/) · [여행지 탐색](/explore/) · [커뮤니티·신고](/community/) · [문의·알림](/inquiry/) · [전체 AI 통합 맵](/flow/ai-integration-map).

## 단골 면접 질문 5선

1. TripTogether의 AI 아키텍처를 한 문장으로 설명하고, 왜 멀티 모델인지 근거를 대시오.
2. 같은 Gemini 2.5 Flash를 챗봇과 추천에 쓰는데, 두 호출의 출력 형식과 검증 방식은 어떻게 다른가?
3. LLM이 생성한 URL·spot_idx·일정 JSON을 어떻게 신뢰하지 않고 검증하는가?
4. 외부 AI 장애 상황에서 각 기능이 어떻게 degrade(폴백)되는가?
5. AI 비용·안전을 위해 챗봇에 둔 3중 절감 장치(쿼터·fast-path·사전 의도분류)를 설명하시오.

## 퀴즈

<QuizBox question="TripTogether에서 여행 일정 자동 생성에 사용하는 모델과, 출력 형식을 강제하는 방식의 조합으로 옳은 것은?" :choices="['Gemini 2.5 Flash + 구조화 JSON', 'GPT-4o-mini + Structured Outputs JSON Schema', 'Claude Haiku + 자유 텍스트', 'Perspective + 독성 점수']" :answer="1" explanation="일정 생성은 courses 도메인의 AiPlanGPTServiceImpl이 GPT-4o-mini를 호출하며, response_format에 strict=true JSON Schema를 지정해 형식을 강제한다." />

<QuizBox question="챗봇이 Gemini가 돌려준 링크 URL을 화면에 내보내기 전에 적용하는 검증으로 옳지 않은 것은?" :choices="['내부 경로 화이트리스트 패턴 매칭', '자바스크립트·데이터·파일 같은 위험 스킴 차단', '경로 순회(점 두 개) 차단', '외부 도메인 링크 자동 단축']" :answer="3" explanation="ChatbotService는 화이트리스트 매칭, 위험 스킴 차단, 경로 순회 차단, 슬래시 두 개 시작 차단을 적용한다. 외부 링크는 단축하는 게 아니라 화이트리스트에 없으면 그냥 버린다." />

<QuizBox question="다음 중 실제 외부 API에 연동되지 않고 Mock 프로바이더로만 동작하는 기능은?" :choices="['Gemini 여행지 추천', 'GPT 멀티턴 어시스턴트', '항공권 검색', 'Perspective 독성 감지']" :answer="2" explanation="항공권은 FlightOfferProvider 인터페이스로 추상화만 되어 있고 실제 항공 API는 미연동된 Mock 상태다. 나머지 AI 세 기능은 실제 외부 API에 연동되어 동작한다." />
