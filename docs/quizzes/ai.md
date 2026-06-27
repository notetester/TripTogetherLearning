# AI 퀴즈

> TripTogether의 AI 기능을 면접에서 설명할 수 있는지 점검한다. 다중 모델 분리, 구조화 출력, 폴백, 등급별 쿼터, 모더레이션, 개인화 추천 — 6개 축을 객관식 10문항과 짧은 주관식으로 확인한다.

이 페이지는 개념을 처음 배우는 곳이 아니라 **이미 학습한 내용을 빠르게 검증**하는 곳이다. 막히는 문항이 있으면 괄호 안 상세 페이지로 돌아가 다시 읽고 오자. 허브: [AI 기능 전체](/ai/) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

:::tip 푸는 법
선택지를 고르면 정답과 해설이 바로 펼쳐진다. 정답을 맞히는 것보다 **왜 그 답인지 한 문장으로 말할 수 있는지**가 중요하다. 면접관은 결론이 아니라 근거를 묻는다.
:::

## 1. 다중 모델 분리 — 왜 4개인가

TripTogether는 단일 LLM에 모든 일을 맡기지 않는다. 멀티턴 상담과 일정 생성은 OpenAI GPT-4o-mini, 사이트 네비 챗봇과 개인화 추천은 Google Gemini 2.5 Flash, 문의 답변 초안은 Anthropic Claude Haiku, 댓글·문의 독성 판정은 Google Perspective API로 나눈다. 모두 외부 REST JSON 호출이라 같은 `RestTemplate` 골격을 공유한다. (상세: [다중 AI 모델 통합](/ai/multi-model))

<QuizBox question="TripTogether가 단일 LLM 대신 모델을 용도별로 4개로 나눈 핵심 이유로 가장 거리가 먼 것은?" :choices="['대량 호출 경로에 저렴하고 빠른 모델을 배치해 비용을 줄이려고', '작업 성격에 맞는 각 모델의 강점을 활용하려고', '한 제공자에 장애가 나도 전체 AI가 멈추지 않게 위험을 분산하려고', '네 모델을 하나로 합쳐 더 큰 단일 모델처럼 앙상블 추론을 하려고']" :answer="3" explanation="모델을 합쳐 앙상블 추론을 하려는 것이 아니라 비용 절감 강점 활용 위험 분산을 위해 용도별로 분리한 것이다. 호출 자체는 각각 독립적이다." />

<QuizBox question="네 AI 모델 호출에서 공통으로 사용한 HTTP 처리 방식은?" :choices="['제공자별 전용 공식 SDK를 네 개 모두 의존성에 추가', 'Spring RestTemplate 빈 하나로 JSON을 직접 POST하고 응답을 파싱', 'JPA 리포지토리로 외부 API를 매핑', '프론트엔드 JSP에서 직접 모델 API를 호출']" :answer="1" explanation="모두 단순 REST JSON이라 RestTemplate 빈 하나로 동일한 호출 골격을 공유한다. SDK를 네 개 붙이지 않는다." />

## 2. 구조화 출력 — 응답이 깨지면 안 될 때

AI 일정 생성(`AiPlanGPTServiceImpl`)은 응답을 바로 `AiPlanResponseDTO`로 역직렬화해야 하므로 형식이 한 글자라도 어긋나면 실패한다. 그래서 OpenAI `response_format`에 `json_schema`를 주고 `strict=true`로 스키마를 강제한다. 스키마는 title summary days 구조이며, days 안의 spots 각 항목은 name description visitOrder를 required로 가진다. 네비 챗봇과 추천은 Gemini의 `responseMimeType`을 application/json으로 지정해 JSON을 받는다. (상세: [구조화 출력](/ai/structured-outputs), [구조화 출력 JSON Schema](/courses/structured-outputs))

<QuizBox question="구조가 절대 깨지면 안 되는 AI 일정 생성에서 GPT 응답 형식을 강제하기 위해 사용한 방법은?" :choices="['응답 문자열을 정규식으로 후처리해 교정', '온도를 0으로 낮추기만 함', 'response_format에 json_schema를 지정하고 strict를 true로 설정', 'Perspective로 출력 형식을 검증']" :answer="2" explanation="response_format에 json_schema를 strict true로 지정해 title summary days 구조를 모델 레벨에서 강제하고 그대로 DTO로 역직렬화한다." />

<QuizBox question="GPT가 반환한 JSON을 자바 객체로 받을 때 매핑되는 최종 응답 DTO는?" :choices="['AiPlanRequestDTO', 'AiPlanResponseDTO', 'TravelPlanVO', 'ChatbotResponseVO']" :answer="1" explanation="요청은 AiPlanRequestDTO 응답은 AiPlanResponseDTO다. 응답 DTO 안에 일자별 AiDayDTO 그 안에 방문지별 AiSpotDTO가 visitOrder와 함께 들어간다." />

## 3. 폴백 — 외부 API가 실패할 때

외부 LLM은 느려지거나 비거나 오류를 줄 수 있다. 추천(`RecommendService`)은 3단 폴백을 쓴다: 먼저 캐시된 추천을 보고, 부족하면 Gemini를 호출하고, 그래도 결과가 없으면 요즘 뜨는 여행지(트렌딩)를 반환한다. 챗봇은 Gemini 호출이나 파싱에 실패하면 `fallbackResponse`로 안전한 안내 카드를 돌려준다. 핵심 원칙은 **AI가 실패해도 기능이 죽지 않는다**이다. (상세: [폴백 전략](/ai/fallback-strategy), [추천 캐시·폴백](/explore/recommendation-cache-fallback))

<QuizBox question="개인화 여행지 추천의 3단 폴백 순서로 옳은 것은?" :choices="['Gemini 호출 먼저 실패하면 캐시 그래도 없으면 트렌딩', '캐시 적중 먼저 부족하면 Gemini 그래도 없으면 트렌딩 여행지', '트렌딩 먼저 그다음 캐시 마지막에 Gemini', '항상 Gemini만 호출하고 실패하면 빈 목록 반환']" :answer="1" explanation="캐시에서 추천 정원이 차면 바로 반환하고 부족하면 Gemini를 부른다. Gemini 결과나 저장이 비면 트렌딩 여행지로 폴백한다." />

<QuizBox question="문의 답변 초안 생성에서 Claude 호출이 실패하면 어떻게 처리하나?" :choices="['예외를 그대로 던져 관리자 답변 작성을 막는다', '빈 문자열을 반환해 관리자가 직접 작성하도록 둔다', '자동으로 GPT로 재시도한다', '미리 저장된 템플릿 답변을 강제로 등록한다']" :answer="1" explanation="generateDraft는 fail-safe로 설계되어 실패 시 빈 문자열을 반환한다. AI 초안은 보조 기능이라 실패해도 관리자의 본래 답변 작성 흐름을 막지 않는다." />

## 4. 등급별 쿼터 — 비용을 막는 관문

LLM 호출은 돈이다. 무제한 호출을 막기 위해 챗봇은 회원 등급별 주기 한도를 둔다. `ChatbotQuotaService`가 등급을 해석하고, 비로그인은 GUEST로 IP 기준, 로그인 사용자는 등급 기준으로 사용량을 센다. ADMIN과 SUPERADMIN은 면제다. 한도 초과면 LLM을 부르지 않고 안내만 반환해 토큰을 아낀다. (상세: [등급별 쿼터](/assistant/quota-grade))

<QuizBox question="챗봇 쿼터에서 비로그인 사용자의 사용량은 무엇을 기준으로 집계하나?" :choices="['브라우저 쿠키 ID', '로그인 세션 userIdx', 'IP 주소', '디바이스 핑거프린트']" :answer="2" explanation="비로그인은 GUEST 등급으로 처리되며 userIdx가 없으므로 IP 주소 기준으로 주기 사용량을 집계한다. 로그인 사용자는 userIdx 기준이다." />

<QuizBox question="챗봇 쿼터 한도 체크가 면제되는 대상은?" :choices="['모든 로그인 사용자', 'PLATINUM 등급 이상', 'ADMIN과 SUPERADMIN 역할', '비로그인 GUEST']" :answer="2" explanation="isQuotaExempt는 사용자 역할이 ADMIN 또는 SUPERADMIN일 때 true를 반환한다. 운영자는 한도 없이 챗봇을 점검할 수 있어야 한다." />

## 5. 모더레이션 — 들어오고 나가는 것 거르기

부적절한 입력과 위험한 출력을 모두 막는다. 입력 쪽은 챗봇이 본 호출 전에 1차 의도 분류(`IntentContextService`)를 돌려 INAPPROPRIATE면 LLM 호출을 생략하고 안전 응답을 저장한다. 댓글·문의의 독성은 Google Perspective API가 TOXICITY를 0~1 점수로 매긴다. 출력 쪽은 챗봇이 Gemini가 만든 링크를 화이트리스트로 검증하고 javascript: data: file: 같은 위험 스킴과 경로 순회(..)를 차단한다. (상세: [차단·모더레이션](/assistant/block-moderation), [URL 화이트리스트 보안](/assistant/url-whitelist), [Perspective 독성 감지](/ai/perspective-toxicity))

<QuizBox question="챗봇이 사용자 입력을 부적절(INAPPROPRIATE)로 1차 분류하면 어떻게 동작하나?" :choices="['그래도 본 LLM을 호출한 뒤 결과만 버린다', '본 LLM 호출을 생략하고 안전 응답을 저장해 토큰을 절감한다', '사용자를 즉시 영구 차단한다', '관리자에게 메일을 보낸 뒤 정상 응답한다']" :answer="1" explanation="사전 분류에서 부적절로 판정되면 본 Gemini 호출을 건너뛰고 안전 응답을 반환 저장한다. 불필요한 토큰 소모를 막는 설계다." />

<QuizBox question="챗봇 응답에 들어온 링크 URL을 검증할 때 차단 대상이 아닌 것은?" :choices="['javascript: data: file: 같은 위험 스킴', '.. 가 포함된 경로 순회 시도', '슬래시로 시작하고 화이트리스트 패턴에 맞는 내부 경로', '//로 시작하는 프로토콜 상대 URL']" :answer="2" explanation="슬래시로 시작하고 허용 패턴에 매칭되는 내부 경로만 통과시킨다. 위험 스킴 경로 순회 프로토콜 상대 URL은 모두 차단된다." />

## 6. 개인화 추천 — 무엇을 보고 추천하나

추천은 모델에 통째로 맡기지 않는다. 최근 30건 체류 로그를 모아 체류 시간과 방문 빈도로 관심 태그 프로파일을 만들고, DB에서 태그 매칭 점수가 높은 후보를 먼저 추린 뒤 그 후보 목록 안에서만 Gemini가 3개를 고르게 한다. 모델이 후보 밖 엉뚱한 spot을 반환하면 FK 검증으로 걸러낸다. 즉 **사실은 DB가 정하고 LLM은 순위만 거든다**. (상세: [AI 추천 Gemini](/explore/ai-recommendation-gemini))

<QuizBox question="개인화 추천에서 Gemini의 역할을 가장 정확히 설명한 것은?" :choices="['DB 없이 Gemini가 전 세계 여행지에서 자유롭게 추천한다', 'DB가 추린 후보 목록 안에서만 상위 몇 개를 고르고 순위를 거든다', '사용자 체류 로그를 Gemini가 직접 DB에 저장한다', '추천 결과를 Gemini가 최종 결제까지 처리한다']" :answer="1" explanation="DB가 태그 매칭으로 후보를 먼저 추리고 Gemini는 그 후보 안에서만 선택한다. 후보 밖 spot은 FK 검증으로 제거되어 신뢰성을 확보한다." />

## 7. 주관식 — 말로 설명해보기

선택지 없이 직접 답을 떠올린 뒤 펼쳐서 비교하자. 면접에서 실제로 나오는 형태다.

<QuizBox question="면접관이 AI 응답 형식이 깨질까 봐 걱정되지 않느냐고 물으면 어떻게 답하겠는가? GPT 일정 생성과 Gemini 챗봇을 각각 들어 설명해보라." explanation="모범 답안 요지: GPT 일정은 response_format의 json_schema를 strict true로 지정해 모델이 스키마를 벗어난 출력을 못 하게 강제하고 곧바로 응답 DTO로 역직렬화한다. Gemini 챗봇은 responseMimeType을 application/json으로 받고 코드블록 마커를 제거한 뒤 파싱하며 파싱이 실패하면 안전한 fallback 카드를 돌려줘 화면이 깨지지 않는다. 핵심은 구조 강제와 실패 시 폴백을 함께 둔다는 점." />

<QuizBox question="외부 LLM이 느리거나 죽었을 때 사용자 경험을 어떻게 보호하는지 추천 기능을 예로 설명해보라." explanation="모범 답안 요지: 추천은 캐시 적중을 먼저 본다. 캐시가 부족할 때만 Gemini를 부르고 결과가 없으면 트렌딩 여행지를 반환한다. 세 단계 모두 빈 화면 대신 무언가를 보여주도록 설계해 외부 API 장애가 곧 기능 장애가 되지 않게 했다. 챗봇도 마찬가지로 Gemini 실패 시 안내 카드로 폴백한다." />

<QuizBox question="LLM 비용과 악용을 어떻게 통제했는지 두 가지 메커니즘을 들어 설명해보라." explanation="모범 답안 요지: 첫째 등급별 쿼터로 주기당 호출 수를 제한하고 비로그인은 IP 기준 운영자는 면제로 두었다. 둘째 본 호출 전에 1차 의도 분류를 돌려 부적절하거나 단순 네비게이션이면 본 LLM 호출을 생략한다. 즉 사전 분류와 fast-path로 불필요한 토큰을 줄이고 쿼터로 상한을 건다." />

## 8. 직접 말해보기

타이머 90초. 아래 질문에 막힘 없이 답할 수 있으면 이 페이지는 통과다.

1. TripTogether가 AI 모델을 네 개로 나눈 이유를 비용·강점·위험 세 단어로 설명하기
2. 구조화 출력에서 strict와 responseMimeType의 차이 한 문장으로 말하기
3. 추천 3단 폴백 순서를 캐시·Gemini·트렌딩으로 읊기
4. 챗봇이 토큰을 아끼는 두 지점(사전 분류, fast-path) 짚기
5. Gemini가 만든 링크를 그대로 믿지 않는 이유와 차단 항목 세 가지 대기

:::details 더 깊게 가려면
모델별 상세는 [GPT 어시스턴트·일정](/ai/gpt-assistant), [Gemini 챗봇·추천](/ai/gemini-chatbot), [Claude 문의 초안](/ai/claude-inquiry)으로. 전체 그림은 [AI 통합 맵](/flow/ai-integration-map)에서 한 장으로 본다.
:::
