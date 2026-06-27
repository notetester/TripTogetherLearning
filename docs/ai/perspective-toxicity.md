# Perspective 독성 감지

> 사용자 입력의 혐오·욕설·비방을 Google Perspective API 로 점수화하고, 자동 차단 대신 비동기 플래그 + BLUR + 관리자 검토로 흡수한다.

이 페이지는 TripTogether 의 AI 콘텐츠 모더레이션 축을 다룬다. 4인 공동 개발 프로젝트에서 커뮤니티·문의·AI 도우미 메시지가 동일한 독성 감지 패턴을 공유하므로, 특정 도메인이 아니라 횡단 관심사(cross-cutting concern)로 이해하는 것이 정확하다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

Google Perspective API 로 텍스트의 TOXICITY 점수(0.0~1.0)를 받아, 정책 임계값을 넘으면 콘텐츠를 즉시 차단하지 않고 `ai_flagged` 플래그를 세워 일반 사용자에게 BLUR 로 가리고 관리자가 최종 판단하는 비동기 모더레이션 파이프라인이다.

## 2. 왜 이렇게 설계했나

설계 결정은 ADR-0010(AI 모더레이션 풀 스택 파이프라인)에 기록되어 있다. 핵심 제약 세 가지가 구조를 결정했다.

- **응답 지연 회피.** Perspective API 호출은 네트워크 왕복으로 수 초가 걸릴 수 있다. 글 작성 요청을 동기로 대기시키면 사용자 체감 지연이 커진다. 그래서 INSERT 는 즉시 끝내고 독성 검사는 비동기로 분리했다.
- **거짓 양성 비용.** AI 점수는 정상 문장을 독성으로 오판할 수 있다. 점수만 보고 자동 차단하면 정상 콘텐츠가 사라진다. 그래서 AI 신호를 강제 차단이 아니라 약한 시그널로 다루고, 인간(관리자)이 최종 결정한다. 이는 신고 자동차단을 금지한 ADR-0001 의 Human-in-the-Loop 철학을 AI 시그널에도 일관 적용한 것이다.
- **점진적 공개.** 차단(blind) 대신 BLUR(가림 후 펼침)를 택해, 일반 사용자에게는 가려 보여주되 관리자에게는 원본과 해제 도구를 제공한다.

:::tip 핵심 통찰
AI 출력을 의사결정의 최종 권한이 아니라 인간 판단을 돕는 입력으로 다룬다. 이 한 문장이 전체 모더레이션 설계 철학이며 면접에서 가장 강한 어필 포인트다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

외부 API 한 곳을 감싸는 단일 서비스가 세 도메인의 진입점을 공유한다.

| 레이어 | 클래스 / 테이블 | 역할 |
|---|---|---|
| 외부 연동 | `PerspectiveService` | Perspective API 호출, raw 점수 반환, 비동기 플래그 |
| 정책 | `ModerationPolicyService`, `ContentModerationPolicyVO` | 민감도 레벨을 임계값으로 변환 |
| 정책 저장 | `CONTENT_MODERATION_POLICY` 테이블 | 단일 행, toxicity_level enum STRICT/NORMAL/LOOSE |
| 커뮤니티 플래그 | `community_post.ai_flagged`, `community_comment.ai_flagged` | 게시글·댓글 감지 결과 |
| 문의 플래그 | `inquiry_post.ai_flagged` | 문의 본문 감지 결과 |
| AI 도우미 기록 | `ADMIN_ASSISTANT_MODERATION` 테이블, `AdminAssistantModerationVO` | 챗 메시지 독성 판정 결과 누적 |
| 배치 스캔 | `AdminAssistantModerationScheduler`, `AdminAssistantModerationServiceImpl` | 미판정 메시지 주기 스캔 |

호출 진입점은 각 도메인 컨트롤러다. `CommunityController` 는 글·댓글·대댓글 작성 시 `checkAndFlagPostAsync` / `checkAndFlagCommentAsync` 를, `InquiryController` 는 문의 작성·수정 시 `checkAndFlagInquiryAsync` 를 호출한다.

정책은 민감도 레벨을 숫자 임계값으로 환산한다. 코드에 박힌 매핑은 다음과 같다.

```text
STRICT  -> 0.6   (낮은 점수도 독성으로 간주, 엄격)
NORMAL  -> 0.8   (기본값)
LOOSE   -> 0.9   (높은 점수만 독성, 관대)
```

Perspective 요청 본문은 검사 텍스트, 언어 ko, 요청 속성 TOXICITY 로 구성하고, 응답에서 attributeScores.TOXICITY.summaryScore.value 경로의 숫자를 점수로 추출한다.

## 4. 동작 원리 (흐름·표·작은 코드)

두 갈래의 흐름이 있다. 사용자 작성 콘텐츠는 비동기 즉시 검사, AI 도우미 메시지는 배치 스캔이다. 도우미(assistant) 모듈은 타 담당 영역이라 무수정 원칙상 ask 내부에 검사 코드를 넣지 못해, 별도 스케줄러가 미판정 메시지를 주기적으로 훑는 방식을 택했다.

작성 콘텐츠 흐름:

```text
[작성/컨트롤러] INSERT 즉시 완료
   -> checkAndFlag...Async (@Async, 응답 차단 안 함)
   -> getToxicityScore 로 raw 점수
   -> 점수 >= 정책 임계값 이면 isToxic = true
   -> flagPostAsToxic / flagInquiryAsToxic -> ai_flagged = 1
   -> 다음 렌더링 시 일반 사용자 BLUR, 관리자 원본 + 해제 버튼
   -> 관리자 클릭 -> clearBlur -> ai_flagged = 0
```

판정 로직의 추상 형태:

```java
Double score = getToxicityScore(text);   // 실패 또는 빈 텍스트면 null
if (score == null) return false;          // fail-safe: 막지 않고 통과
double threshold = policy.getToxicityThreshold();
return score >= threshold;                // 임계값 이상이면 독성
```

:::warning fail-safe 방향
API 호출이 실패하거나 점수가 null 이면 `isToxic` 은 false 를 반환한다. 즉 외부 장애가 사용자 작성을 막지 않는다. 안전을 차단이 아니라 통과 쪽으로 기울인 의도적 선택이며, 차단형 정책이라면 반대 방향이 맞다는 점을 면접에서 구분해 설명할 수 있어야 한다.
:::

AI 도우미 메시지 흐름은 배치다.

| 항목 | 값 |
|---|---|
| 트리거 | 스케줄러, 최초 기동 1분 후 시작, 이후 5분 간격 |
| 배치 크기 | 한 번에 최대 50건 (API 쿼터 보호) |
| 호출 간격 | 200ms 대기 |
| 저장 | `ADMIN_ASSISTANT_MODERATION` 에 is_inappropriate, toxicity_score 기록 |
| 중복 방지 | chat_comment_idx UNIQUE, 빈 내용도 비독성으로 한 번 기록해 재스캔 차단 |

배치 경로는 raw 점수를 소수 셋째 자리까지 반올림해 점수 컬럼(decimal(4,3))에 보관하므로, 단순 통과/차단이 아니라 관리자가 점수 자체를 검토할 수 있다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
|---|---|
| Perspective API 연동, 점수 추출 | 구현됨 |
| 정책 임계값 외부화 (DB 단일 행, 민감도 enum) | 구현됨 |
| 커뮤니티 게시글·댓글 비동기 플래그 | 구현됨 |
| 문의 본문 비동기 플래그 | 구현됨 |
| AI 도우미 메시지 배치 스캔 + 점수 기록 | 구현됨 |
| 일반 사용자 BLUR + 관리자 해제(JSP/JS) | 구현됨 (ADR-0010 풀 스택) |
| 비동기 호출 실패 시 재시도 정책 | 미구현 (실패하면 플래그 미갱신, 별도 정책 필요) |
| 독성 외 속성(위협·모욕 등 다속성) 활용 | 미구현 (현재 TOXICITY 단일 속성만 요청) |
| AI 판정 품질 정량평가 | 미구현 (프로젝트 공통 과제) |

:::details 왜 코드만으로는 BLUR 가 안 보이나
ADR-0010 이 명시하듯 이 기능은 DB 컬럼 -> 서비스 -> JSP 렌더링 -> JS 액션까지 걸친 풀 스택이다. Java 서비스만 읽으면 플래그 세팅까지만 보이고 가림 UI 는 JSP/JS 에 있어, 코드 분석 도구가 미구현으로 오판하기 쉽다. 실제로는 일관되게 동작한다.
:::

## 6. 면접 답변 3단계

1. **한 줄.** 사용자 입력을 Perspective API 로 독성 점수화하고, 자동 차단 대신 비동기로 플래그를 세워 BLUR 처리한 뒤 관리자가 최종 판단하는 Human-in-the-Loop 모더레이션입니다.
2. **설계 의도.** 동기 호출은 응답을 지연시키고 자동 차단은 거짓 양성 비용이 크기 때문에, 비동기 검사 + 약한 시그널 + 인간 검토로 두 비용을 동시에 회피했습니다. 이 결정은 ADR-0010 에 기록돼 있습니다.
3. **확장.** 커뮤니티 게시글·댓글·문의가 동일 패턴을 공유하고, 타 담당 영역인 AI 도우미 메시지는 무수정 원칙상 별도 스케줄러로 배치 스캔합니다. 임계값은 DB 단일 행 정책으로 외부화해 운영 중 민감도를 조정할 수 있습니다.

## 7. 꼬리질문 + 모범답안

:::details 왜 동기가 아니라 비동기인가
Perspective 호출은 수 초가 걸릴 수 있어 작성 응답을 그만큼 지연시킵니다. INSERT 는 즉시 끝내고 검사를 @Async 로 분리하면 사용자 체감 지연이 0 이며, 검사 결과는 다음 렌더링에 반영됩니다. 약간의 지연 동안 미플래그 상태로 노출될 수 있다는 트레이드오프가 있지만, 관리자 검토가 안전망이라 수용 가능했습니다.
:::

:::details 점수가 임계값을 넘으면 바로 숨기지 왜 BLUR 인가
AI 는 거짓 양성을 냅니다. 정상 문장을 독성으로 오판해 자동 삭제하면 복구가 어렵습니다. BLUR 는 일반 사용자에게 가리되 펼칠 수 있게 하고 관리자에게는 원본과 해제 도구를 줘서, 오판 비용을 인간 검토로 흡수합니다. 신고 자동차단을 금지한 ADR-0001 과 같은 철학입니다.
:::

:::details API 호출이 실패하면 어떻게 되나
fail-safe 로 통과 처리합니다. 점수가 null 이면 isToxic 은 false 를 반환해 작성을 막지 않습니다. 외부 장애가 정상 사용을 차단하지 않게 하려는 의도입니다. 다만 실패 시 재시도 정책이 없어 그 글은 미플래그로 남는 한계가 있고, 이는 후속 과제로 인지하고 있습니다.
:::

:::details 임계값은 어떻게 정하고 바꾸나
CONTENT_MODERATION_POLICY 단일 행에 toxicity_level 을 STRICT/NORMAL/LOOSE enum 으로 두고, 정책 VO 가 각각 0.6/0.8/0.9 로 환산합니다. 코드 배포 없이 운영 중에 민감도를 조정할 수 있고, 정책 외부화는 ADR-0009 의 결정입니다.
:::

:::details AI 도우미 메시지는 왜 검사 방식이 다른가
도우미 모듈은 타 담당 영역이라 무수정 원칙상 ask 내부에 검사 코드를 넣지 못했습니다. 그래서 미판정 메시지를 5분 간격으로 최대 50건씩 스캔하는 스케줄러를 분리하고, 결과를 ADMIN_ASSISTANT_MODERATION 에 점수까지 적재해 관리자 모니터링에 씁니다. 같은 PerspectiveService 를 재사용하되 진입 방식만 배치로 바꾼 것입니다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 1~2분 답해 보자. 막히면 위 섹션으로 돌아간다.

- 사용자가 욕설 댓글을 작성한 순간부터 일반 사용자가 가려진 댓글을 보기까지의 전체 경로를, 호출하는 메서드와 바뀌는 컬럼 이름까지 포함해 설명해 보라.
- 이 시스템이 자동 차단을 피하고 BLUR 와 관리자 검토를 택한 이유를, 거짓 양성과 응답 지연 두 비용으로 나눠 말해 보라.
- 작성 콘텐츠와 AI 도우미 메시지의 검사 방식이 다른 이유와, 그럼에도 동일하게 재사용하는 구성요소가 무엇인지 짚어 보라.

이어 보기: [Claude 문의 초안](/ai/claude-inquiry) · [다중 AI 모델 통합](/ai/multi-model) · [모더레이션·거버넌스 흐름](/flow/moderation-governance) · [커뮤니티 독성 처리](/community/toxicity-perspective)

## 퀴즈

<QuizBox question="TripTogether 의 Perspective 독성 감지가 임계값 초과 콘텐츠에 적용하는 기본 처리는 무엇인가" :choices="['즉시 영구 삭제', '자동 계정 정지', 'ai_flagged 플래그 후 일반 사용자 BLUR 및 관리자 검토', '작성 자체를 동기 차단']" :answer="2" explanation="자동 차단 대신 ai_flagged 를 세워 일반 사용자에게는 BLUR 로 가리고 관리자가 원본을 보고 최종 판단한다. ADR-0010 의 Human-in-the-Loop 설계다." />

<QuizBox question="Perspective API 호출이 실패해 점수가 null 일 때 isToxic 의 동작은" :choices="['true 를 반환해 일단 차단한다', 'false 를 반환해 작성을 막지 않는다 (fail-safe)', '예외를 던져 작성 요청을 실패시킨다', '재시도를 무한 반복한다']" :answer="1" explanation="외부 장애가 사용자 작성을 막지 않도록 점수 null 이면 false 를 반환해 통과시킨다. 안전을 통과 쪽으로 기울인 의도적 선택이다." />

<QuizBox question="작성 콘텐츠와 달리 AI 도우미 메시지를 별도 스케줄러로 배치 스캔하는 주된 이유는" :choices="['Perspective API 가 채팅을 지원하지 않아서', '도우미 모듈이 타 담당 영역이라 무수정 원칙상 ask 내부에 검사 코드를 넣을 수 없어서', '챗 메시지는 독성이 없다고 가정해서', '실시간 검사가 법으로 금지되어서']" :answer="1" explanation="도우미는 타 담당 영역이라 무수정이므로 ask 내부에 삽입할 수 없다. 대신 미판정 메시지를 5분 간격 최대 50건씩 스캔해 ADMIN_ASSISTANT_MODERATION 에 적재한다." />
