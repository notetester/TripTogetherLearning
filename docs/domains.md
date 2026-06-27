# 도메인별 심화 — 전체 개요

> TripTogether는 **여행 올인원 플랫폼**(탐색 → 계획 → 예약 → 공유)입니다. 기능별로 모듈을 나눠 구현했고, 여기서 각 도메인으로 들어갑니다.

## 이 사이트를 쓰는 법

- **특정 기술 하나**가 궁금하면 → [용어집](/glossary/) · [백엔드](/backend/)
- **한 도메인을 깊게** 알고 싶으면 → 아래 카드에서 선택
- **내가 맡은 범위만** 보고 싶으면 → [담당별 보기 (태그 필터)](/by-area/)
- **도메인이 어떻게 연결되는지** → [전체 흐름](/flow/)

## 8개 도메인

| 도메인 | 책임 | 핵심 기술 | 담당 | 들어가기 |
| --- | --- | --- | --- | --- |
| **인증·계정·보안** | 로그인·소셜·계정복구·로그인 위험평가 | 세션·OAuth·BCrypt·WAF | A | [인증 →](/auth/) |
| **커뮤니티·신고** | 게시글·댓글·태그·이미지·신고 | Cloudinary·Perspective·3-strike | B | [커뮤니티 →](/community/) |
| **문의·알림·마이페이지** | 1:1 문의·AI초안·실시간 알림 | Claude·SSE·크로스모듈 | B | [문의·알림 →](/inquiry/) |
| **여행 코스·AI 일정** | 직접 작성·AI 일정 생성·공개 피드 | GPT·구조화 출력·PLAN_SPOT | D | [코스 →](/courses/) |
| **여행지 탐색·커머스** | 탐색·추천·항공권·결제·지갑·리워드 | Gemini·Toss·게이미피케이션 | C | [탐색·커머스 →](/explore/) |
| **AI 어시스턴트·챗봇** | 멀티턴 여행도우미·사이트 네비 챗봇 | GPT·Gemini·쿼터·모더레이션 | D | [AI 도우미 →](/assistant/) |
| **관리자·운영** | 회원·모더레이션·감사·정책·조직 | 권한그룹·감사로그·런타임설정 | A | [관리자 →](/admin/) |
| **다국어·공통** | i18n·번역·AOP·예외처리 | MessageSource·Google번역 | C | [다국어·공통 →](/i18n/) |

> "담당 A~D"는 실제 분담을 **익명 라벨**로 표시한 것입니다. [담당별 보기](/by-area/)에서 라벨/도메인으로 필터링할 수 있습니다.

## 도메인을 잇는 흐름

각 도메인을 본 뒤에는 [전체 흐름](/flow/)에서 어떻게 맞물리는지 확인하세요.

- [전체 아키텍처](/flow/architecture) — Spring Boot REST/JSP + MyBatis/MySQL + 다중 AI API
- [사용자 여정](/flow/user-journey) — 탐색 → 계획 → 예약 → 공유
- [인증·세션 흐름](/flow/auth-session-flow) · [AI 통합 맵](/flow/ai-integration-map) · [알림 SSE 흐름](/flow/notification-sse-flow)
- [모더레이션·거버넌스](/flow/moderation-governance) · [데이터 모델 전체](/flow/data-model)
- [프로젝트 전체 면접 플레이북](/flow/interview-whole-project)
