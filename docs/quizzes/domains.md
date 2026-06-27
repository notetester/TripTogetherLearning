# 도메인 퀴즈

> TripTogether의 핵심 도메인(인증·커뮤니티·코스·탐색·문의·관리자)을 실제 클래스·테이블·정책 기준으로 점검합니다. 답을 외우지 말고 **왜 그렇게 설계했는지**를 설명할 수 있는지 확인하세요.

## 1. 한 줄 정의

이 페이지는 8개 도메인을 가로지르는 **확인용 퀴즈**입니다. 개념 설명은 각 도메인 페이지에서 다루고, 여기서는 면접에서 자주 검증되는 설계 결정과 안전 불변식을 골라 10문항으로 묶었습니다.

## 2. 왜 이 문항들인가

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트라, 면접에서 "네가 직접 짠 게 맞냐"를 가르는 질문은 대개 **경계 처리**에 몰립니다. 외부 AI가 거짓 ID를 뱉을 때, 사용자가 권한 없는 글을 고치려 할 때, 신고가 중복으로 들어올 때 — 시스템이 어떻게 방어하는지가 핵심입니다. 그래서 단순 암기형이 아니라 **불변식(invariant)과 폴백(fallback)**을 묻는 문항으로 구성했습니다.

## 3. 어떤 근거로 출제했나

각 문항은 실제 소스의 클래스·테이블에 대응합니다.

| 도메인 | 근거 클래스 / 테이블 | 핵심 포인트 |
| --- | --- | --- |
| 인증 | `AuthorizationAspect`, `LoginUserArgumentResolver`, 세션 `loginUser` | AOP 권한 + @LoginUser 자동 주입 |
| 커뮤니티 | `POST`, `COMMENT`(parent_comment_id), `TAG_RELATION`(co_count) | 대댓글·채택·태그 공출현 |
| 코스 | `AiPlanServiceImpl`, `TRAVEL_PLAN`(plan_source), `PLAN_SPOT`(visit_order) | Structured Outputs + 트랜잭션 롤백 |
| 탐색 | `RecommendService`, `SPOT`, 3단 폴백 | DB 캐시 → Gemini → 트렌딩 |
| 문의 | `InquiryController`, `INQUIRY_POST`(status) | PENDING → ANSWERED 상태머신 |
| 관리자 | `ADMIN_ACTION_AUDIT`, `APPLICATION_RUNTIME_SETTING` | 감사로그 + DB 우선 런타임 설정 |

## 4. 출제 전 핵심 정리(흐름·표)

문항을 풀기 전 다음 다섯 가지를 떠올리면 됩니다.

1. **권한은 컨트롤러가 아니라 AOP에서 막는다** — `@RequireLogin`/`@RequireAdmin`이 붙은 핸들러를 `AuthorizationAspect`가 가로채 세션 `loginUser`를 검사한다.
2. **삭제는 행을 지우지 않는다** — `post_status`/`comment_status`/`account_status` 같은 상태 컬럼으로 소프트 삭제(ADR-0008)한다.
3. **AI가 만든 ID는 믿지 않는다** — 코스(GPT)·탐색(Gemini) 모두 후보 집합 밖의 식별자는 저장 단계에서 버린다.
4. **상태 전이는 한 방향** — 문의는 PENDING에서 ANSWERED로 가고, 사용자는 PENDING일 때만 수정할 수 있다.
5. **운영 정책은 코드가 아니라 DB에 있다** — `APPLICATION_RUNTIME_SETTING`이 우선이라 재배포 없이 바꾼다.

| 도구/모델 | 쓰는 도메인 | 무엇에 |
| --- | --- | --- |
| GPT-4o-mini | 어시스턴트, 코스 | 멀티턴 대화, AI 일정(JSON Schema strict) |
| Gemini 2.5 Flash | 공통 챗봇, 탐색 | 사이트 네비, 개인화 추천 |
| Claude Haiku | 문의 | 관리자 답변 초안 |
| Perspective API | 커뮤니티, 관리자 | 독성(TOXICITY) 점수 |

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 정직한 구분
- **구현됨:** 인증·커뮤니티·코스 AI 일정·탐색 추천·문의 상태머신·관리자 감사로그·SSE 알림 등 핵심 도메인 대부분.
- **Mock:** 항공권 프로바이더(`FlightOfferProvider` 인터페이스 뒤에 Mock 구현, 실제 외부 항공 API 미연동).
- **계획:** AI 응답 품질 정량평가 체계 부재, 모바일 반응형/SPA, Swagger 문서.
:::

이 페이지의 문항은 전부 **구현된 기능** 기준입니다. 항공권 Mock 여부 자체를 묻는 문항 하나만 예외적으로 포함합니다.

## 6. 면접 답변 3단계

도메인 질문을 받으면 이 골격으로 답하세요.

1. **책임 한 줄** — 이 도메인이 무엇을 보장하는가(예: 코스 도메인은 AI가 만든 일정을 안전하게 저장한다).
2. **핵심 메커니즘** — 어떤 클래스·테이블·정책으로 그 보장을 이루는가(예: Structured Outputs로 스키마를 강제하고 @Transactional로 부분 저장을 막는다).
3. **경계 처리** — 무엇이 잘못될 수 있고 어떻게 막는가(예: LLM이 없는 spot을 만들면 후보 검증에서 걸러진다).

## 7. 꼬리질문 + 모범답안

:::details Q1. 권한 체크를 컨트롤러 if 문이 아니라 AOP로 뺀 이유는?
모든 핸들러에 같은 검사 코드를 복붙하면 빠뜨리는 곳이 생기고, 정책이 바뀌면 전부 고쳐야 합니다. `@RequireLogin`/`@RequireAdmin` 애너테이션 + `AuthorizationAspect` 한 곳으로 모으면 적용 범위가 선언적으로 보이고, 미인증은 한 지점에서 일관되게 거부됩니다. 권한 통과 후에는 `@LoginUser`(`LoginUserArgumentResolver`)가 세션 사용자를 자동 주입해 컨트롤러가 깔끔해집니다(ADR-0011).
:::

:::details Q2. AI 일정 생성에서 트랜잭션을 거는 이유는?
일정 하나는 `TRAVEL_PLAN` 한 행과 `PLAN_SPOT` 여러 행으로 나뉘어 저장됩니다. 중간에 실패하면 제목만 있고 스팟이 없는 깨진 일정이 남습니다. `@Transactional`로 묶어 한 건이라도 실패하면 전부 롤백하므로, 사용자는 완전한 일정 아니면 아무것도 보지 않습니다.
:::

:::details Q3. LLM이 추천한 여행지 ID가 실제 DB에 없으면?
탐색 추천은 먼저 후보 집합을 DB에서 만들고, Gemini가 고른 spot_idx 중 그 후보에 있는 것만 유효로 인정합니다. 환각으로 없는 ID가 와도 저장 전에 버려지고, 결과가 부족하면 트렌딩 폴백으로 정확히 채웁니다. 즉 외부 모델 출력을 **신뢰 경계 밖 입력**으로 취급합니다.
:::

:::details Q4. 문의를 본인이 아무 때나 수정 못 하게 한 이유는?
답변이 달린 뒤(ANSWERED) 질문을 바꾸면 답변과 질문이 어긋나 운영 기록이 깨집니다. 그래서 `InquiryController`는 PENDING 상태이고 작성자 본인일 때만 수정/삭제를 허용합니다. 상태머신이 PENDING에서 ANSWERED로만 가는 단방향이라는 점과 짝을 이룹니다.
:::

:::details Q5. 운영 설정을 코드 상수가 아니라 DB에 둔 이유는?
챗봇 쿼터, IP 차단 같은 값은 운영 중 자주 바뀝니다. `APPLICATION_RUNTIME_SETTING`에 두고 DB 값을 우선하면 재배포 없이 즉시 반영되고, `is_secret` 플래그로 민감 값은 노출도 막습니다. 코드는 기본값만 갖고 실제 운영값은 DB가 이깁니다.
:::

## 8. 직접 말해보기

다음 세 가지를 소리 내어 30초씩 설명해 보세요.

- 인증 도메인에서 "권한 없는 사용자가 관리자 API를 호출하면" 무슨 일이 일어나는지 클래스 이름을 넣어 설명.
- 코스와 탐색이 **각각 다른 AI 모델**을 쓰는 이유와, 두 도메인이 공통으로 쓰는 안전 장치(후보 검증) 하나.
- 커뮤니티 신고가 **자동으로 사용자를 차단하지 않는** 이유(ADR-0001)와, 대신 무엇을 하는지.

## 퀴즈

<QuizBox question="권한이 필요한 핸들러에 RequireAdmin이 붙어 있을 때 미인증 요청을 가로채 거부하는 주체는?" :choices="['각 컨트롤러의 if 분기', 'AuthorizationAspect (AOP)', 'JSP 화면 레이어', 'MySQL 트리거']" :answer="1" explanation="RequireLogin과 RequireAdmin은 AuthorizationAspect가 핸들러 실행 전에 가로채 세션 loginUser를 검사한다. 권한 검사를 한 지점으로 모아 누락을 막는다(ADR-0011)." />

<QuizBox question="게시글이나 댓글을 삭제했을 때 TripTogether가 실제로 하는 일은?" :choices="['행을 즉시 DELETE 한다', 'post_status 또는 comment_status 같은 상태 컬럼을 바꿔 소프트 삭제한다', '파일로 백업만 하고 그대로 둔다', 'Cloudinary에서만 지운다']" :answer="1" explanation="ADR-0008 소프트 삭제 패턴에 따라 상태 컬럼으로 표시만 바꾼다. 복구와 감사, 통계 일관성을 위해 행은 남긴다." />

<QuizBox question="AI 일정 생성에서 TRAVEL_PLAN 한 행과 PLAN_SPOT 여러 행을 묶어 Transactional로 처리하는 이유는?" :choices="['속도를 높이려고', '중간 실패 시 제목만 있고 스팟이 없는 깨진 일정이 남는 것을 막으려고', 'Gemini 호출을 줄이려고', '관리자 승인을 받으려고']" :answer="1" explanation="여러 테이블에 나눠 저장하므로 한 건이라도 실패하면 전부 롤백해야 부분 저장으로 깨진 일정이 남지 않는다." />

<QuizBox question="탐색 추천에서 Gemini가 DB에 없는 spot_idx를 추천했을 때 결과는?" :choices="['그대로 사용자에게 노출된다', '후보 집합에 없으므로 버려지고 부족분은 트렌딩 폴백으로 채워진다', '서버가 오류를 던지고 멈춘다', '관리자에게 자동 신고된다']" :answer="1" explanation="추천은 DB 후보 집합 안의 spot_idx만 유효로 인정한다. 외부 모델 출력을 신뢰 경계 밖 입력으로 다루고, 부족하면 트렌딩으로 정확히 채운다." />

<QuizBox question="여행지 추천이 따르는 3단 폴백 순서로 옳은 것은?" :choices="['Gemini 먼저 그다음 DB 캐시 마지막 관리자', 'DB 캐시 먼저 그다음 Gemini 마지막 트렌딩', '트렌딩 먼저 그다음 Gemini 마지막 DB', '항상 Gemini 단일 호출']" :answer="1" explanation="DB 캐시에서 먼저 찾고, 없으면 Gemini로 개인화 추천을 만들고, 그래도 부족하면 트렌딩으로 채운다. 외부 API 실패에도 화면이 비지 않게 한다." />

<QuizBox question="1대1 문의를 작성자가 수정 또는 삭제할 수 있는 조건은?" :choices="['언제나 가능하다', '상태가 PENDING이고 본인일 때만 가능하다', 'ANSWERED가 된 뒤에만 가능하다', '관리자만 가능하다']" :answer="1" explanation="InquiryController는 status가 PENDING이고 작성자 본인일 때만 수정과 삭제를 허용한다. 답변이 달린 뒤 질문이 바뀌면 기록이 어긋나기 때문이다." />

<QuizBox question="챗봇 등급별 일일 쿼터나 IP 차단 같은 운영 값을 재배포 없이 바꿀 수 있는 근거는?" :choices="['값이 JSP에 하드코딩돼 있어서', 'APPLICATION_RUNTIME_SETTING 테이블 값을 DB 우선으로 읽어서', '서버를 매번 재시작해서', 'OkHttp 캐시 때문에']" :answer="1" explanation="런타임 설정은 DB 우선이라 코드 기본값보다 DB 값이 이긴다. is_secret 플래그로 민감 값 노출도 통제한다." />

<QuizBox question="커뮤니티 신고가 접수돼도 시스템이 사용자를 자동으로 차단하지 않는 것은 어떤 결정 때문인가?" :choices="['ADR-0001 신고 자동 차단 금지', 'Cloudinary 정책', 'Toss Payments 규정', 'i18n 설정']" :answer="0" explanation="ADR-0001은 신고만으로 자동 차단하면 악용 위험이 크다고 보고 자동 차단을 금지한다. 대신 모더레이션과 관리자 검토 워크플로우로 처리한다." />

<QuizBox question="항공권 도메인의 현재 구현 상태로 옳은 것은?" :choices="['실제 외부 항공 API와 완전 연동됨', 'FlightOfferProvider 인터페이스 뒤의 Mock 프로바이더이며 외부 항공 API는 미연동', '아예 기능이 없다', '관리자만 쓸 수 있다']" :answer="1" explanation="항공권은 FlightOfferProvider 추상 인터페이스를 두고 Mock 구현으로 동작한다. 실제 외부 항공 API 연동은 미구현 상태다." />

<QuizBox question="문의 답변 초안, 멀티턴 여행 도우미, 사이트 네비 챗봇에 쓰이는 AI 모델을 도메인과 바르게 짝지은 것은?" :choices="['문의는 Gemini 어시스턴트는 Claude 챗봇은 GPT', '문의는 Claude Haiku 어시스턴트는 GPT-4o-mini 챗봇은 Gemini 2.5 Flash', '셋 다 GPT-4o-mini', '셋 다 Gemini 2.5 Flash']" :answer="1" explanation="문의 답변 초안은 Claude Haiku, 멀티턴 어시스턴트는 GPT-4o-mini, 공통 사이트 네비 챗봇은 Gemini 2.5 Flash를 쓴다. 도메인 특성에 맞춰 모델을 분리했다." />

---

더 깊게 보려면: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
