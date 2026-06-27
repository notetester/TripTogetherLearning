# 입력 검증

> 신뢰 경계는 서버다. 폼 검증·날짜 정합성·XSS 정화를 모두 서버 계층에서 막는다.

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트이며, 입력 검증은 특정 도메인의 전유물이 아니라 모든 도메인에 공통으로 깔린 방어선이다. 이 페이지는 AI 일정 생성 폼의 입력 검증과 커뮤니티 본문의 jsoup XSS 정화를 대표 사례로, "서버에서 무엇을 어떻게 막는가"를 정리한다.

## 1. 한 줄 정의

입력 검증은 클라이언트가 보낸 모든 값을 신뢰하지 않고, **서비스 계층에서** 필수값·형식·논리 정합성을 확인하고 위험한 HTML을 화이트리스트로 정화한 뒤에만 비즈니스 로직과 DB에 흘려보내는 작업이다.

## 2. 왜 이렇게 설계했나

핵심 원칙은 **신뢰 경계(trust boundary)** 다. 브라우저 폼의 `required`, JavaScript 검사, Summernote 에디터의 자체 필터는 모두 **우회 가능**하다. Postman·curl로 컨트롤러에 직접 POST하면 클라이언트 검증은 통째로 건너뛴다. 따라서 검증의 최종 책임은 서버에 있어야 한다.

- **계층 선택 — 컨트롤러가 아니라 서비스**: TripTogether는 `controller → service → mapper → vo` 4계층이다. 입력 검증을 서비스의 트랜잭션 메서드 안에서 수행하면, 같은 비즈니스 로직을 호출하는 모든 진입점(웹 폼, 향후 API)이 동일한 검증을 공유한다. 컨트롤러는 세션/리다이렉트 같은 웹 관심사만 담당한다.
- **저장 시점 정화**: XSS 정화는 출력 시점이 아니라 **저장(INSERT/UPDATE) 직전 한 번**만 한다. 출력마다 escape를 반복하면 한 군데라도 빠뜨릴 위험이 있지만, 저장 시 정화하면 DB에 들어간 값 자체가 안전하다(ADR-0005).
- **검증 메시지 i18n**: 모든 오류 문구는 하드코딩하지 않고 `MessageSource` 코드로 던진다. 4개국어(ko/en/ja/zh)를 지원하므로 검증 실패 메시지도 현재 로케일에 맞춰 나가야 한다(ADR-0013).

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 영역 | 클래스 / 위치 | 역할 |
| --- | --- | --- |
| AI 일정 입력 DTO | `org.triptogether.ai.dto.AiPlanRequestDTO` | 폼 바인딩 대상(destination, startDate, endDate, companion, style, budget, requestText) |
| AI 일정 검증·저장 | `org.triptogether.courses.service.AiPlanServiceImpl` | `validateRequest()` + `@Transactional generateAndSavePlan()` |
| AI 일정 컨트롤러 | `org.triptogether.courses.controller.AiPlanController` | 세션 확인·예외→리다이렉트 변환 |
| XSS 정화 | `org.triptogether.community.service.CommunityServiceImpl` | `sanitizeHtml()`, `sanitizeCommentText()` (jsoup `Safelist`) |
| 메시지 소스 | Spring `MessageSource` + properties basename | 검증 실패 문구 i18n |

구현 특징:

- 검증 실패는 `IllegalArgumentException`(필수값·날짜 정합성) 또는 `IllegalStateException`(예: photo 글 이미지 최소 장수)으로 던진다. 컨트롤러나 `GlobalExceptionHandler`가 이를 잡아 사용자용 메시지/상태코드로 변환한다(예외 처리 상세는 [예외 처리](/backend/exception-handling) 참고).
- jsoup 의존성(`jsoup 1.17.2`)은 인라인 이미지 orphan 정리에 이미 쓰고 있어, XSS 정화에 추가 라이브러리 없이 재사용했다.

:::warning 공개 자료 주의
이 페이지의 코드는 모두 추상화/자리표시자다. 실제 API 키·DB 호스트·자격증명은 절대 코드/문서에 노출하지 않는다. 외부 모델 키는 `API_KEY`처럼 설정 프로퍼티(`${openai.api.key}` 등)로 주입하고, 운영 비밀은 DB 우선 런타임 설정(`is_secret`)으로 관리한다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. AI 일정 입력 검증

폼 → 컨트롤러 → 서비스 검증 → 외부 모델 호출 → DB 저장 순서다. 검증은 **외부 모델을 호출하기 전**에 한다(잘못된 입력으로 유료 호출을 낭비하지 않는다).

```text
[planForm.jsp] POST /courses/ai/generate
   │  AiPlanRequestDTO 바인딩
   ▼
[AiPlanController] 세션 loginUser 확인 → 없으면 로그인 리다이렉트
   ▼
[AiPlanServiceImpl.generateAndSavePlan]  @Transactional
   1) validateRequest(dto)          ← 여기서 막힘 → IllegalArgumentException
   2) aiPlanGPTService.generatePlan ← GPT-4o-mini 구조화 출력 호출
   3) TRAVEL_PLAN / PLAN_SPOT INSERT
```

검증 규칙(실제 `validateRequest`):

| 검사 | 조건 | 실패 메시지 코드 |
| --- | --- | --- |
| 요청 객체 존재 | `dto != null` | `course.error.requestEmpty` |
| 여행지 필수 | `destination` not blank | `course.error.destinationRequired` |
| 날짜 필수 | `startDate`·`endDate` not blank | `course.error.dateRequired` |
| 날짜 정합성 | `end >= start` | `course.error.endBeforeStart` |

```java
private void validateRequest(AiPlanRequestDTO dto) {
    if (dto == null) throw new IllegalArgumentException(msg("course.error.requestEmpty"));
    if (isBlank(dto.getDestination()))
        throw new IllegalArgumentException(msg("course.error.destinationRequired"));
    if (isBlank(dto.getStartDate()) || isBlank(dto.getEndDate()))
        throw new IllegalArgumentException(msg("course.error.dateRequired"));

    LocalDate start = LocalDate.parse(dto.getStartDate());
    LocalDate end   = LocalDate.parse(dto.getEndDate());
    if (end.isBefore(start))           // 종료일 < 시작일이면 차단
        throw new IllegalArgumentException(msg("course.error.endBeforeStart"));
}
```

핵심 포인트:

- `isBlank()`는 `null`과 공백 전용 문자열(`"  "`)을 모두 빈 값으로 처리한다.
- 날짜는 `LocalDate.parse(...)`로 파싱하므로 형식이 깨지면 파싱 단계에서 예외가 난다(형식 검증을 겸한다).
- 검증 통과 후 `@Transactional` 안에서 외부 모델 호출과 `TRAVEL_PLAN`/`PLAN_SPOT` INSERT가 한 트랜잭션으로 묶인다. 저장 중 실패하면 롤백된다.

### 4-2. XSS 정화 (jsoup Safelist)

Summernote 에디터는 사용자 입력을 **HTML 그대로** 저장한다. 그래서 본문과 댓글은 입력 통로에 따라 정화 강도를 다르게 둔다(ADR-0005).

| 입력 | 정책 | 메서드 |
| --- | --- | --- |
| 게시글 본문(WYSIWYG) | 화이트리스트 태그/속성만 허용 | `sanitizeHtml()` — `Safelist.basicWithImages()` 확장 |
| 댓글/대댓글(plain textarea) | 모든 태그 제거, 텍스트만 | `sanitizeCommentText()` — `Safelist.none()` |

```java
// 본문: 허용 태그(서식/이미지) 외 전부 제거
private String sanitizeHtml(String html) {
    if (html == null || html.isBlank()) return "";
    return Jsoup.clean(html, "", COMMUNITY_SAFELIST,
            new Document.OutputSettings().prettyPrint(false));
}

// 댓글: HTML 자체를 허용하지 않음
private String sanitizeCommentText(String text) {
    if (text == null || text.isBlank()) return "";
    return Jsoup.clean(text, "", Safelist.none(),
            new Document.OutputSettings().prettyPrint(false));
}
```

화이트리스트 방식이라 정의되지 않은 모든 것이 자동 차단된다:

- `<script>`, `<iframe>`, `<object>`, `<style>` 등 위험 태그 제거
- `onerror`, `onclick` 등 모든 `on*` 이벤트 핸들러 속성 제거
- `javascript:` 같은 위험 URL 스킴 차단

정화는 저장 직전(`writePost()` / `editPost()`)에 적용된다. photo 유형 글은 정화된 본문에서 `img` 태그 수를 세어 **최소 3장** 같은 추가 입력 검증도 같은 자리에서 한다(`IllegalStateException`).

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| AI 일정 필수값·날짜 정합성 서버 검증 | 구현됨 (`validateRequest`) |
| 검증 실패 메시지 i18n(MessageSource) | 구현됨 |
| 게시글 본문 jsoup Safelist 정화 | 구현됨 (`sanitizeHtml`) |
| 댓글/대댓글 plain-text 정화 | 구현됨 (`Safelist.none()`) — ADR-0005의 TODO가 코드에서 해소됨 |
| photo 글 이미지 최소 장수 검증 | 구현됨 |
| 독성(욕설·혐오) 콘텐츠 판정 | 별도 파이프라인 — Google Perspective API([독성 감지](/community/toxicity-perspective)) |
| Bean Validation(`@Valid`/`@NotBlank`) 어노테이션 일괄 적용 | 부분/계획 — 현재는 수동 검증 위주 |
| 외부 입력에 대한 통합 검증 프레임워크 표준화 | 향후 과제 |

:::tip 독성 검사와 입력 검증은 다르다
입력 검증은 "형식·구조·안전성"(빈 값인가, 날짜가 맞나, 스크립트가 들었나)을 본다. 욕설·혐오 같은 **의미적 유해성**은 Perspective API의 TOXICITY 점수로 따로 판정한다. 두 가지를 섞어 설명하면 면접에서 감점된다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "클라이언트 검증은 우회 가능하므로, 모든 입력은 서비스 계층에서 필수값·날짜 정합성을 검증하고 본문 HTML은 jsoup 화이트리스트로 정화한 뒤에만 DB에 저장합니다."
2. **근거**: "예를 들어 AI 일정 폼은 `AiPlanServiceImpl.validateRequest()`에서 여행지·날짜 필수와 종료일이 시작일보다 앞서지 않는지를 확인하고, 검증 통과 후에야 외부 모델을 호출합니다. 커뮤니티 본문은 `Safelist.basicWithImages()` 화이트리스트로 정화해 script·on* 핸들러·javascript: 스킴을 제거합니다."
3. **트레이드오프**: "검증을 서비스에 두면 진입점마다 중복이 줄지만, Bean Validation 어노테이션을 전면 적용하지 않아 일부는 수동 검증이라는 한계가 있습니다. 표준화는 향후 과제로 둡니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 클라이언트에서 이미 막는데 서버 검증이 왜 또 필요한가?
브라우저 폼 검증과 JS 필터는 신뢰할 수 없는 클라이언트에서 돌기 때문에 Postman·curl로 컨트롤러에 직접 요청하면 전부 우회됩니다. 검증의 최종 책임은 신뢰 경계 안쪽인 서버에 있어야 하므로, 서비스 계층 검증이 진짜 방어선입니다. 클라이언트 검증은 UX(즉시 피드백)용 보조 수단으로만 봅니다.
:::

:::details Q2. 검증 로직을 컨트롤러가 아니라 서비스에 둔 이유는?
컨트롤러는 세션 확인·리다이렉트 같은 웹 관심사를 담당하고, 비즈니스 규칙(필수값·날짜 정합성)은 트랜잭션 경계 안에 있어야 합니다. 서비스에 두면 같은 로직을 호출하는 모든 진입점이 동일한 검증을 공유하고, `@Transactional` 안에서 검증→외부 호출→저장이 한 단위로 묶여 실패 시 깔끔하게 롤백됩니다.
:::

:::details Q3. 종료일이 시작일보다 앞서면 어떻게 처리되나?
`validateRequest()`에서 `end.isBefore(start)`이면 `course.error.endBeforeStart` 메시지로 `IllegalArgumentException`을 던집니다. 컨트롤러가 이를 잡아 폼으로 리다이렉트하며 플래시 속성에 오류 메시지를 담습니다. 중요한 건 이 검증이 외부 모델 호출 **전**이라, 잘못된 입력으로 유료 호출을 낭비하지 않는다는 점입니다.
:::

:::details Q4. XSS를 왜 출력 시 escape가 아니라 저장 시 정화로 막았나?
Summernote 본문은 굵게·이미지·링크 같은 서식을 보존해야 하므로 출력 시 전부 escape하면 WYSIWYG 의미가 사라집니다. 그래서 화이트리스트 기반 jsoup `Safelist`로 허용 태그만 남기고 저장합니다. 저장 시점에 한 번 정화하면 DB 값 자체가 안전해, 출력 지점마다 escape를 빠뜨릴 위험이 없습니다(ADR-0005). 댓글은 서식이 필요 없어 `Safelist.none()`으로 모든 태그를 제거합니다.
:::

:::details Q5. 화이트리스트와 블랙리스트 정화의 차이는?
블랙리스트는 알려진 위험 태그를 나열해 제거하므로 새로운 우회 벡터를 놓치기 쉽습니다. 화이트리스트(`Safelist`)는 허용 목록에 없는 모든 것을 자동 차단하므로, 미처 예상 못 한 공격 벡터도 기본적으로 막힙니다. 보안에서는 "기본 거부(default deny)" 원칙이라 화이트리스트가 더 안전합니다.
:::

## 8. 직접 말해보기

- AI 일정 폼이 검증하는 4가지 규칙과, 검증을 외부 모델 호출 전에 두는 이유를 1분 안에 설명해 보라.
- "클라이언트 검증으로 충분하지 않냐"는 반론에 신뢰 경계로 반박해 보라.
- 게시글 본문과 댓글의 정화 강도가 다른 이유(`basicWithImages` vs `none`)를 화이트리스트 관점에서 말해 보라.
- 검증 실패 메시지를 하드코딩하지 않고 `MessageSource` 코드로 던지는 이유를 i18n과 엮어 설명해 보라.

---

더 보기: [예외 처리](/backend/exception-handling) · [AI 일정 생성(GPT)](/courses/ai-plan-gpt) · [구조화 출력(JSON Schema)](/courses/structured-outputs) · [독성 감지(Perspective)](/community/toxicity-perspective)
허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="TripTogether에서 AI 일정 입력 검증(필수값·날짜 정합성)을 수행하는 위치로 가장 정확한 것은?"
  :choices="['브라우저 폼의 required 속성', 'AiPlanController의 메서드 진입부', 'AiPlanServiceImpl.validateRequest() (서비스 계층)', 'MyBatis 매퍼 XML']"
  :answer="2"
  explanation="검증은 트랜잭션 경계 안인 서비스 계층 validateRequest()에서 수행한다. 컨트롤러는 세션 확인·리다이렉트 같은 웹 관심사만 담당하고, 클라이언트 검증은 우회 가능하므로 최종 방어선이 될 수 없다."
/>

<QuizBox
  question="커뮤니티 본문 XSS 정화에서 jsoup Safelist(화이트리스트) 방식을 택한 핵심 이유는?"
  :choices="['블랙리스트보다 코드가 짧아서', '허용 목록에 없는 모든 요소를 자동 차단해 미지의 공격 벡터에도 안전해서', '출력 속도가 빨라서', '모든 HTML 태그를 제거하기 위해서']"
  :answer="1"
  explanation="화이트리스트는 default deny 원칙으로, 정의되지 않은 모든 태그·속성·URL 스킴을 자동 차단한다. 따라서 새로운 우회 벡터에도 기본적으로 안전하다. 본문은 서식 보존을 위해 모든 태그를 제거하지는 않는다(댓글만 Safelist.none())."
/>

<QuizBox
  question="AI 일정 입력 검증을 외부 모델(GPT) 호출 '전'에 수행하는 실용적 이점은 무엇인가?"
  explanation="잘못된 입력(빈 여행지, 종료일이 시작일보다 앞선 경우 등)으로 유료 외부 모델 호출을 낭비하지 않는다. 또한 검증→호출→저장이 @Transactional 한 단위로 묶여 저장 실패 시 롤백되고, 실패 메시지는 MessageSource로 i18n 처리된다."
/>
