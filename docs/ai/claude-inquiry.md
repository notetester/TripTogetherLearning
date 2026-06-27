# Claude 문의 답변 초안

> 운영진이 문의에 답변할 때, Claude Haiku가 카테고리·제목·본문을 읽고 한국어 답변 초안을 만들어 준다. 운영진은 초안을 검토·보완해 등록하므로 응대 시간이 줄고, 최종 책임은 사람이 진다.

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트다. 이 페이지는 `inquiry`(고객 문의 게시판) 모듈의 **AI 답변 초안 생성** 기능을 다룬다. 같은 프로젝트의 다른 AI(여행 멀티턴 어시스턴트=GPT-4o-mini, 사이트 네비 챗봇·여행지 추천=Gemini 2.5 Flash, 독성 감지=Perspective)와는 모델·역할·코드가 모두 독립이다. 여기서 다루는 모델은 **Claude Haiku** 하나이고, 진입점은 운영진 전용 `POST /inquiry/{id}/ai-draft`다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

`InquiryAiService.generateDraft(category, title, content)`는 문의 한 건의 정보를 단일 메시지로 Anthropic Messages API(모델 `claude-haiku-4-5`)에 보내, **운영진이 그대로 등록하지 않고 검토·수정할 답변 초안 텍스트**를 돌려받는 싱글턴(대화 히스토리 없음) 호출이다.

## 2. 왜 이렇게 설계했나

문의 응대는 양은 많지만 답변의 70~80%가 정형(인사 → 안내 → 마무리)이다. 운영진이 매번 빈 칸에서 시작하면 느리고 톤도 들쭉날쭉해진다. 그래서 **사람을 대체하지 않고 초안만 제공**하는 보조 도구로 설계했다.

핵심 설계 결정 세 가지.

- **사람이 최종 결정(human-in-the-loop)** — AI는 자동 등록하지 않는다. 응답은 답변 입력란을 채우는 초안일 뿐이고, 운영진이 읽고 고쳐 `POST /inquiry/{id}/answer`로 별도 등록한다. AI가 사실을 틀려도 사용자에게 바로 나가지 않는다.
- **싱글턴, 무상태** — 문의 한 건은 독립 사건이라 대화 히스토리가 필요 없다. 멀티턴 어시스턴트(`MAX_HISTORY=20`)와 달리 매번 새 컨텍스트로 호출해 비용·복잡도를 낮춘다.
- **fail-safe(실패해도 막지 않음)** — API 키 누락, 네트워크 오류, 응답 파싱 실패 등 어떤 예외든 **빈 문자열**을 반환한다. AI가 죽어도 운영진의 수기 답변 작성은 그대로 가능하다. AI는 편의 기능이지 의존 경로가 아니다.

:::tip 왜 Haiku인가
문의 초안은 짧고 정형적이라 최상위 추론 모델이 필요 없다. Haiku 계열은 응답이 빠르고 토큰 단가가 낮아, 운영자가 버튼을 누르고 기다리는 UX와 운영 비용 양쪽에 맞는다. `MAX_TOKENS=1024`로 한 건 분량을 넉넉히 덮으면서 폭주를 막는다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 위치 / 식별자 | 역할 |
| --- | --- | --- |
| AI 호출 서비스 | `inquiry.service.InquiryAiService` | 프롬프트 구성 + Messages API 호출 + 응답 파싱 |
| 진입점(운영진) | `InquiryController#aiDraft` → `POST /inquiry/{inquiryId}/ai-draft` | 권한·문의 존재 검사 후 초안 반환 |
| 답변 등록(별도) | `InquiryController#answer` → `POST /inquiry/{inquiryId}/answer` | 운영진이 보완한 최종 답변 저장 |
| HTTP 클라이언트 | `RestTemplate` | Anthropic `/v1/messages` POST |
| 모델 ID | `claude-haiku-4-5` (상수 `MODEL`) | 사용할 Claude 모델 |
| 인증 키 | `inquiry.claude.api.key` (자리표시자 `API_KEY`) | 이 모듈 전용 키, 다른 모듈 키와 분리 |
| 문의 본문 | 테이블 `INQUIRY_POST` (`category` / `title` / `content` / `status`) | 프롬프트 입력 출처 |
| 최종 답변 | 테이블 `INQUIRY_ANSWER` (`inquiry_id` UNIQUE, `content`) | 운영진이 등록한 답변(초안은 저장하지 않음) |

중요한 점: **초안 자체는 어디에도 저장되지 않는다.** `ai-draft`는 텍스트를 응답으로만 돌려주고, 그것을 등록할지·어떻게 고칠지는 전적으로 운영진 몫이다. `INQUIRY_POST.ai_flagged`는 이 기능과 무관하다 — 그건 Perspective 독성 감지가 세우는 플래그다.

API 호출 골격(추상화):

```java
headers.set("x-api-key", API_KEY);            // 모듈 전용 키
headers.set("anthropic-version", "2023-06-01");

Map<String,Object> body = Map.of(
    "model",      "claude-haiku-4-5",
    "max_tokens", 1024,
    "system",     SYSTEM_PROMPT,               // CS 담당자 역할·출력 규칙
    "messages",   List.of(Map.of("role","user","content", userMessage)));

// 응답에서 content[0].text 만 추출. 실패하면 "" 반환(fail-safe)
```

## 4. 동작 원리 (흐름·표·작은 코드)

운영진이 문의 상세에서 AI 초안 버튼을 누르면 다음 순서로 흐른다.

| 단계 | 주체 | 동작 |
| --- | --- | --- |
| 1 | 운영진 | 문의 상세에서 AI 초안 요청 → `POST /inquiry/{id}/ai-draft` |
| 2 | `InquiryController#aiDraft` | 운영진 권한 확인(아니면 403) |
| 3 | 컨트롤러 | `INQUIRY_POST` 조회, 없으면 404 |
| 4 | `InquiryAiService` | 카테고리 코드를 한글 레이블로 변환, 제목·본문과 합쳐 user 메시지 구성 |
| 5 | Anthropic API | system 프롬프트 + user 메시지로 초안 생성 |
| 6 | 서비스 | `content[0].text` 추출, 예외 시 빈 문자열 |
| 7 | 컨트롤러 | 초안이 비어 있으면 500, 아니면 JSON으로 반환 |
| 8 | 운영진 | 초안을 입력란에 받아 검토·수정 후 `POST /inquiry/{id}/answer`로 등록 |

프롬프트는 두 부분으로 나뉜다.

- **system 프롬프트** — TripTogether CS 담당자 역할을 부여하고, 출력 규칙을 강제한다: 인사말로 시작, 문의 유형·내용에 맞는 구체 안내, 마무리 인사로 종료, **초안 텍스트만 출력**(설명·메타 텍스트 금지).
- **user 메시지** — 카테고리 한글 레이블 + 제목 + 본문을 한 덩어리로 구성. 카테고리 코드는 매핑으로 한글화한다.

```
service → 서비스 이용   payment → 결제/환불   account → 계정/로그인
bug     → 오류 신고     etc     → 기타
```

권한과 fail-safe가 함께 작동하는 컨트롤러 골격:

```java
if (!isAdmin(session)) return 403;                 // 운영진만
InquiryPostDto q = inquiryService.getInquiry(id);
if (q == null) return 404;                          // 문의 존재 확인

String draft = inquiryAiService.generateDraft(
        q.getCategory(), q.getTitle(), q.getContent());

if (draft == null || draft.isBlank()) return 500;   // AI 실패 = 초안 없음
return ok({ success: true, draft });                // 등록은 아직 안 함
```

:::warning 초안은 답변이 아니다
`ai-draft`는 `INQUIRY_ANSWER`에 아무것도 쓰지 않는다. 사용자에게 보이는 답변은 운영진이 검토 후 `POST /inquiry/{id}/answer`로 등록할 때 비로소 저장되고, 그 시점에 문의 status가 IN_PROGRESS 또는 COMPLETED로 바뀌며 작성자에게 피드 알림이 나간다. 초안 생성과 답변 등록은 별개의 두 요청이다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Claude Haiku 초안 생성(`generateDraft`) | 구현됨 |
| 운영진 전용 진입점 `POST /inquiry/{id}/ai-draft` (403/404/500 분기) | 구현됨 |
| 카테고리 한글 매핑 + 역할·규칙 system 프롬프트 | 구현됨 |
| fail-safe(예외 시 빈 문자열, 운영 흐름 비차단) | 구현됨 |
| 모듈 전용 키 분리(`inquiry.claude.api.key`) | 구현됨 |
| 초안 품질 정량 평가·자동 회귀 측정 | **부재(계획)** — 프로젝트 전반의 AI 응답 품질 정량평가 체계가 아직 없음 |
| 초안 호출 로그·토큰 사용량 모니터링 대시보드 | **계획** — 현재는 실패 시 warn 로그 수준 |
| 멀티턴/문맥 누적(이전 답변 참고) | 미적용 — 의도적으로 싱글턴 유지 |

정직하게 말하면, 이 기능은 **동작하지만 품질을 수치로 보증하지는 못한다.** 그래서 human-in-the-loop가 안전망이자 핵심 설계 전제다. 운영진 검토 단계가 곧 품질 게이트 역할을 한다.

## 6. 면접 답변 3단계

1. **한 줄** — "문의 게시판에서 운영진이 답변할 때, Claude Haiku로 카테고리·제목·본문을 읽어 한국어 답변 초안을 만들어 줍니다. 자동 등록이 아니라 운영진이 검토·수정 후 등록하는 보조 기능입니다."
2. **설계 의도** — "사람을 대체하지 않고 초안만 줘서 응대 시간을 줄이는 게 목표라, human-in-the-loop를 전제로 했습니다. 문의 한 건은 독립 사건이라 멀티턴이 필요 없어 싱글턴·무상태로 두고, Haiku로 비용·속도를 맞췄습니다. AI 호출이 실패해도 운영을 막지 않도록 빈 문자열을 돌려주는 fail-safe로 설계했습니다."
3. **트레이드오프** — "초안 품질을 정량으로 보증하는 평가 체계는 아직 없습니다. 대신 운영진 검토 단계가 품질 게이트 역할을 하도록 의존했고, 키도 모듈 전용으로 분리해 다른 AI 기능과 장애·비용을 격리했습니다."

## 7. 꼬리질문 + 모범답안

:::details AI가 잘못된 답변을 만들면 사용자에게 그대로 나가지 않나?
나가지 않습니다. `ai-draft`는 초안 텍스트를 응답으로만 돌려주고 어디에도 저장하지 않습니다. 사용자에게 보이는 답변은 운영진이 검토·수정한 뒤 별도 요청(`POST /inquiry/{id}/answer`)으로 등록할 때 비로소 생깁니다. AI는 입력란을 채워줄 뿐이고 최종 책임은 사람이 집니다. 이게 human-in-the-loop 설계의 핵심입니다.
:::

:::details 왜 멀티턴 어시스턴트처럼 대화 히스토리를 안 쓰나?
문의 한 건은 독립적인 사건이라 이전 대화 맥락이 필요 없습니다. 멀티턴 여행 어시스턴트는 사용자와 주고받으며 계획을 다듬으니 히스토리가 의미 있지만, 문의 초안은 카테고리·제목·본문만 있으면 한 번에 만들 수 있습니다. 무상태로 두면 호출이 단순해지고 토큰·비용도 줄어듭니다.
:::

:::details AI API가 죽으면 어떻게 되나?
초안 생성만 안 될 뿐, 운영진의 수기 답변 작성과 등록은 그대로 됩니다. 서비스가 예외를 잡아 빈 문자열을 반환하고 컨트롤러는 그걸 500으로 알려주지만, 답변 등록 경로(`/answer`)는 AI와 완전히 분리돼 있어 영향받지 않습니다. AI를 편의 기능으로만 두고 의존 경로에서 뺀 설계입니다.
:::

:::details 같은 프로젝트에 GPT·Gemini·Perspective도 쓰는데 왜 문의만 Claude인가?
모델을 기능 특성에 맞춰 골랐습니다. 문의 초안은 짧고 정형적이라 빠르고 저렴한 Haiku가 적합했고, 멀티턴 여행 플래닝과 일정 구조화 출력은 GPT-4o-mini, 사이트 네비 챗봇과 여행지 추천은 Gemini, 독성 점수화는 Perspective가 맡습니다. 키도 모듈별로 분리해 한 모델·한 계정의 장애나 비용이 다른 기능으로 번지지 않게 격리했습니다.
:::

:::details 초안 품질은 어떻게 보장하나?
현재 품질을 수치로 측정하는 자동 평가 체계는 없습니다. 정직하게 말하면 이게 한계이자 향후 과제입니다. 지금은 운영진 검토 단계가 품질 게이트 역할을 하도록 의존하고, system 프롬프트로 출력 형식(인사·구체 안내·마무리, 초안 텍스트만)을 강하게 제약해 편차를 줄였습니다. 다음 단계로는 샘플 기반 정성 평가나 응답 회귀 측정을 붙일 수 있습니다.
:::

## 8. 직접 말해보기

- `ai-draft`와 `answer` 두 요청의 책임 차이를 한 문장으로 설명해 보세요.
- 이 기능이 fail-safe로 빈 문자열을 반환하는 이유를, 운영 흐름 관점에서 말해 보세요.
- "왜 멀티턴이 아니라 싱글턴인가"에 30초로 답해 보세요.
- 같은 프로젝트에서 모델을 GPT·Gemini·Claude·Perspective로 나눈 기준을 들어 보세요.
- 초안 품질을 보증하지 못하는 한계를 인정하면서도 안전한 이유를 설명해 보세요.

## 퀴즈

<QuizBox question="문의 AI 답변 초안 기능에서 생성된 초안은 어떻게 처리되나?" :choices="['INQUIRY_ANSWER 테이블에 자동 저장되어 즉시 사용자에게 노출된다', '응답으로만 반환되며 운영진이 검토·수정 후 별도로 등록해야 한다', 'INQUIRY_POST의 ai_flagged 컬럼에 저장된다', '작성자에게 알림으로 바로 전송된다']" :answer="1" explanation="ai-draft는 초안 텍스트를 응답으로만 돌려주고 저장하지 않는다. 사용자에게 보이는 답변은 운영진이 검토 후 POST answer로 등록할 때 비로소 INQUIRY_ANSWER에 저장된다. human-in-the-loop 설계다." />

<QuizBox question="InquiryAiService가 API 호출 중 예외가 나면 어떻게 동작하나?" :choices="['예외를 그대로 던져 요청을 실패시킨다', '재시도를 무한 반복한다', '빈 문자열을 반환해 운영 흐름을 막지 않는다', '관리자 계정을 잠근다']" :answer="2" explanation="fail-safe 설계로 어떤 예외든 빈 문자열을 반환한다. AI가 죽어도 운영진의 수기 답변 작성과 등록은 그대로 가능하다. AI는 의존 경로가 아니라 편의 기능이다." />

<QuizBox question="문의 초안 생성을 멀티턴이 아닌 싱글턴(무상태)으로 둔 이유로 가장 적절한 것은?" :choices="['Claude가 멀티턴을 지원하지 않아서', '문의 한 건은 독립 사건이라 대화 히스토리가 불필요하고 호출이 단순해지기 때문', '보안 정책상 히스토리 저장이 금지되어서', '카테고리가 5개뿐이기 때문']" :answer="1" explanation="문의 초안은 카테고리·제목·본문만으로 한 번에 생성 가능한 독립 사건이라 이전 맥락이 필요 없다. 멀티턴 여행 어시스턴트와 달리 무상태로 두면 호출이 단순하고 토큰·비용이 줄어든다." />
