# 기초 용어집 개요

> 도메인 심화로 들어가기 전에, 모든 페이지에서 반복되는 백엔드 기초 용어를 먼저 한 곳에 모았습니다. 여기를 통과하면 도메인 글이 훨씬 빨리 읽힙니다.

TripTogether는 **국내 여행 올인원 플랫폼**(탐색 → 계획 → 예약 → 공유)이고, 4명이 도메인을 나눠 개발한 팀 프로젝트입니다. 기술 스택은 **Spring Boot 4.0.6 / Java 21 / MyBatis / MySQL / JSP**이며, 세션 인증·소프트 삭제·AOP 권한·4개국어 i18n 같은 공통 토대 위에 약 14~15개 모듈이 올라가 있습니다. 이 용어집은 그 공통 토대를 이루는 단어들의 사전입니다.

## 1. 왜 용어부터 시작하나

면접에서 무너지는 지점은 보통 "기능 설명"이 아니라 **그 기능을 떠받치는 단어의 정의**입니다. "OAuth로 소셜 로그인을 붙였습니다"까지는 누구나 말하지만, "그럼 세션과 OAuth는 무슨 관계죠?"에서 갈립니다.

- **도메인 글이 용어를 전제로 쓰여 있습니다.** 커뮤니티 글은 `소프트 삭제`를, AI 일정 글은 `트랜잭션`과 `구조화 출력`을, 인증 글은 `세션`·`BCrypt`·`OAuth`를 이미 안다고 가정합니다.
- **같은 단어가 도메인마다 다시 등장합니다.** `인터셉터`·`AOP`·`DTO/VO`는 한 도메인의 지식이 아니라 프로젝트 전체의 문법입니다. 한 번 정확히 잡아두면 8개 도메인에서 재사용됩니다.
- **"왜 이걸 썼나"를 말하려면 정의가 정확해야 합니다.** MyBatis를 "JPA 대신 SQL을 직접 쓰는 매퍼"로 정의할 수 있어야, "왜 JPA를 안 썼나"라는 꼬리질문에 답이 나옵니다.

:::tip 이 용어집의 원칙
일반론으로 끝내지 않고, **TripTogether 코드에 실제로 존재하는 클래스·테이블·컬럼**으로 설명합니다. 예) 세션 → 세션 속성 `loginUser`(`UsersVO`), 소프트 삭제 → `account_status`·`post_status`·`is_deleted` 컬럼, AOP → `AuthorizationAspect`. 추상 개념과 우리 구현을 항상 붙여서 봅니다.
:::

## 2. 용어 지도 — 무엇을 다루나

용어를 따로 외우지 말고 **계층별로** 묶어 보면 머리에 들어옵니다. TripTogether의 요청 한 건이 위에서 아래로 흐르며 만나는 순서이기도 합니다.

| 묶음 | 용어 | 한 줄 |
| --- | --- | --- |
| **통신 규약** | [API](/glossary/api) · [REST](/glossary/rest) · [HTTP 메서드·상태코드](/glossary/http-methods) · [JSON](/glossary/json) | 클라이언트와 서버가 주고받는 약속 |
| **요청 가로채기** | [세션/쿠키](/glossary/session-cookie) · [인터셉터](/glossary/interceptor) · [AOP](/glossary/aop) · [CSRF](/glossary/csrf) | "누구인지·권한 있는지"를 컨트롤러 앞에서 판정 |
| **인증·보안** | [OAuth](/glossary/oauth) · [BCrypt](/glossary/bcrypt) | 소셜 로그인과 비밀번호 해싱 |
| **서버 구조** | [4계층 구조](/glossary/layered-architecture) · [MVC와 JSP](/glossary/mvc-jsp) · [DTO/VO](/glossary/dto-vo) | 코드가 책임별로 나뉘는 방식 |
| **데이터** | [ORM과 MyBatis](/glossary/mybatis-orm) · [트랜잭션](/glossary/transaction) · [소프트 삭제](/glossary/soft-delete) | DB에 안전하게 읽고 쓰기 |
| **사용자 경험** | [SSE](/glossary/sse) · [i18n(국제화)](/glossary/i18n-term) | 실시간 알림과 4개국어 |

:::details 이 단어들이 TripTogether 어디에 박혀 있나
- **세션** → 로그인 성공 시 세션 속성 `loginUser`에 `UsersVO` 저장, 이후 인터셉터·`@LoginUser`가 이를 사용
- **인터셉터** → `locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification` 체인
- **AOP** → `@RequireLogin`·`@RequireAdmin` 애너테이션을 `AuthorizationAspect`가 가로채 권한 판정
- **트랜잭션** → AI 일정 저장(`AiPlanServiceImpl`)에서 `@Transactional`로 부분 실패 시 전체 롤백
- **소프트 삭제** → 행을 지우지 않고 `account_status`·`post_status`·`comment_status`·`is_deleted` 같은 상태 컬럼으로 표시(ADR-0008)
- **SSE** → 알림을 `SseEmitter` 서버 푸시로 전달, 사용자 한 명이 여러 탭이면 `List<SseEmitter>`
:::

## 3. 권장 학습 순서

위에서 아래로 한 번 훑으면, 어떤 도메인 글을 펴도 막히지 않습니다. 각 항목은 5~10분이면 충분합니다.

1. **통신 규약 먼저** — [API](/glossary/api) → [REST](/glossary/rest) → [HTTP 메서드·상태코드](/glossary/http-methods) → [JSON](/glossary/json). 서버가 "무엇을 주고받는지"의 언어.
2. **서버가 어떻게 나뉘는지** — [4계층 구조](/glossary/layered-architecture) → [DTO/VO](/glossary/dto-vo) → [MVC와 JSP](/glossary/mvc-jsp). 모든 도메인 코드의 뼈대.
3. **데이터 다루기** — [ORM과 MyBatis](/glossary/mybatis-orm) → [트랜잭션](/glossary/transaction) → [소프트 삭제](/glossary/soft-delete). "JPA 안 쓴 이유"가 여기서 나옵니다.
4. **요청을 가로채는 공통 장치** — [세션/쿠키](/glossary/session-cookie) → [인터셉터](/glossary/interceptor) → [AOP](/glossary/aop). 인증·권한·로깅이 어떻게 컨트롤러 앞에서 처리되는지.
5. **인증·보안** — [OAuth](/glossary/oauth) → [BCrypt](/glossary/bcrypt) → [CSRF](/glossary/csrf). 인증 도메인을 보기 전 준비운동.
6. **마무리 두 개** — [SSE](/glossary/sse)(실시간 알림) → [i18n(국제화)](/glossary/i18n-term)(4개국어).

:::tip 다음 행선지
- 용어가 잡혔으면 → [도메인 전체 개요](/domains)에서 8개 도메인 중 하나로
- "내가 맡은 범위만" → [담당별 보기](/by-area/)
- "도메인끼리 어떻게 연결되나" → [전체 흐름](/flow/)
- 더 깊은 백엔드 설명 → [백엔드 개요](/backend/)
:::

## 4. 이 용어집을 읽는 자세

- **정의 → 왜 → 우리 코드** 순서로 외우세요. 면접관은 정의만으로는 만족하지 않고 "왜 그걸 선택했나"와 "어디에 썼나"를 묻습니다.
- **비교쌍을 노리세요.** DTO vs VO, ORM(JPA) vs MyBatis, 인터셉터 vs AOP, 세션 vs 토큰 — 면접 단골은 거의 다 "둘의 차이"입니다.
- **구현됨 vs Mock/계획을 정직하게.** 예를 들어 항공권은 실제 외부 API가 아니라 **Mock 프로바이더**이고, AI 응답 품질의 **정량 평가 체계는 아직 없습니다**. 이런 경계를 아는 것 자체가 신뢰를 줍니다.

## 5. 단골 면접 질문 5개

이 용어집을 다 읽고 나면 아래 다섯 개에 막힘없이 답할 수 있어야 합니다. 괄호 안은 답이 들어 있는 페이지입니다.

1. **"JPA를 두고 왜 MyBatis를 썼나요?"** — SQL을 직접 제어하고 복잡한 조회 쿼리를 다루기 위해. ([ORM과 MyBatis](/glossary/mybatis-orm))
2. **"인증을 토큰이 아니라 세션으로 한 이유는?"** — JSP 기반 서버 렌더링 웹앱이라 서버 세션(`loginUser`)이 자연스럽고, 인터셉터·`@LoginUser`와 맞물립니다. ([세션/쿠키](/glossary/session-cookie))
3. **"인터셉터와 AOP의 역할 차이는?"** — 인터셉터는 HTTP 요청 전후(로케일·IP차단·로그인·알림)를, AOP는 메서드 단위 횡단 관심사(`@RequireLogin`/`@RequireAdmin` 권한)를 담당합니다. ([인터셉터](/glossary/interceptor) · [AOP](/glossary/aop))
4. **"데이터를 진짜 지우지 않고 상태 컬럼으로 두는 이유는?"** — 복구·감사·연관 데이터 보존을 위해서. `account_status`·`post_status`·`is_deleted`로 표시합니다(ADR-0008). ([소프트 삭제](/glossary/soft-delete))
5. **"비밀번호는 어떻게 저장하나요?"** — 평문 저장 금지, `BCryptPasswordEncoder`로 솔트가 포함된 단방향 해시를 저장합니다. ([BCrypt](/glossary/bcrypt))

:::warning 정직하게 선을 그어야 하는 한 가지
"전부 다 됐다"고 말하지 마세요. **항공권은 Mock 프로바이더**(외부 항공 API 미연동), **AI 응답 품질 정량평가는 미구현**, **모바일은 JSP 데스크톱 레이아웃 위주**입니다. 이 한계를 먼저 밝히는 답변이 오히려 더 높은 점수를 받습니다.
:::

## 퀴즈

<QuizBox
  question="이 용어집을 도메인 심화보다 먼저 읽도록 배치한 핵심 이유는?"
  :choices="['용어가 도메인 글보다 분량이 많아서', '도메인 글이 세션·소프트삭제·트랜잭션 같은 공통 용어를 이미 안다고 전제하고 쓰여 있어서', '용어집에만 실제 코드가 들어 있어서', 'VitePress가 알파벳 순서로 정렬하기 때문에']"
  :answer="1"
  explanation="커뮤니티·인증·AI 일정 등 도메인 글은 소프트 삭제, 세션, 트랜잭션 같은 기초 용어를 전제로 작성되어 있습니다. 그래서 공통 용어를 먼저 잡으면 8개 도메인 전체가 빠르게 읽힙니다."
/>

<QuizBox
  question="TripTogether에서 인터셉터와 AOP가 맡는 책임을 가장 정확히 구분한 것은?"
  :choices="['둘 다 SQL 매핑을 담당한다', '인터셉터는 HTTP 요청 전후 처리(로케일·IP차단·로그인·알림), AOP는 메서드 단위 권한 등 횡단 관심사를 담당한다', '인터셉터는 비밀번호 해싱, AOP는 결제를 담당한다', 'AOP는 JSP 렌더링, 인터셉터는 트랜잭션을 담당한다']"
  :answer="1"
  explanation="인터셉터 체인(locale→ipBlock→...→notification)은 HTTP 요청 전후를 가로채고, AOP의 AuthorizationAspect는 @RequireLogin·@RequireAdmin 같은 메서드 단위 권한 판정(횡단 관심사)을 담당합니다."
/>

<QuizBox
  question="면접에서 TripTogether의 구현 상태를 정직하게 말할 때 '아직 한계'로 밝혀야 하는 항목으로 옳은 것은?"
  :choices="['세션 로그인이 동작하지 않는다', '항공권은 Mock 프로바이더이고 AI 응답 품질 정량평가 체계가 아직 없다', 'MySQL 대신 파일로 데이터를 저장한다', '소프트 삭제가 구현되지 않았다']"
  :answer="1"
  explanation="핵심 기능 대부분은 구현되어 있지만, 항공권은 실제 외부 API가 아닌 Mock 프로바이더이고 AI 응답 품질의 정량평가 체계는 향후 과제입니다. 모바일도 데스크톱 JSP 레이아웃 위주입니다."
/>
