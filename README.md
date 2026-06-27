# TripTogether Learning

TripTogether(여행 올인원 플랫폼) 팀 프로젝트에서 **실제로 사용한 기술**을, 면접에서 막힘없이 설명하기 위해 만든 학습 사이트입니다.
[VitePress](https://vitepress.dev) 기반 정적 문서 사이트이고, GitHub Pages로 배포합니다.

> 목표: "써봤어요"가 아니라 **"어디에, 왜, 어떻게 썼고, 무엇이 어려웠는지"** 까지.

## 구성

| 영역 | 내용 |
| --- | --- |
| 용어집 | API·DTO/VO·세션·OAuth·AOP·소프트삭제 등 기초 용어 |
| 백엔드 | Spring Boot 4 · MyBatis · JSP/JSTL · 인터셉터 · AOP · 예외 처리 |
| **도메인별 심화** | 인증 / 커뮤니티·신고 / 문의·알림 / 여행코스·AI일정 / 탐색·커머스 / AI어시스턴트·챗봇 / 관리자·운영 / 다국어·공통 |
| AI | GPT-4o-mini · Gemini 2.5 Flash · Claude Haiku · Perspective · Google 번역 |
| 전체 흐름 | 아키텍처 · 사용자 여정 · 인증/세션 · AI 통합 · SSE 알림 · 거버넌스 |
| 인프라 | Maven/WAR · Tomcat · Git · ADR · JUnit |
| 퀴즈 | 객관식/주관식 자가 점검 |

각 페이지는 `정의 → 왜 → 어떤 기술 → 동작 원리 → 구현 상태 → 면접 답변 3단계 → 꼬리질문 → 퀴즈` 순서입니다.

## 담당 태그 필터

페이지마다 frontmatter로 `owner`(담당 A~D, 익명) · `domain` · `tags` 가 붙습니다.
[담당별 보기](docs/by-area/index.md) 페이지의 `<TagBrowser>` 컴포넌트가 빌드 타임에 모든 frontmatter를 수집해, **담당/도메인/키워드로 필터링**해 자기 범위만 한 번에 보여줍니다.

## 로컬 실행

```bash
npm install
npm run docs:dev      # 개발 서버
npm run docs:build    # 정적 빌드
npm run docs:preview  # 빌드 미리보기
```

## 배포 (GitHub Pages)

`main` 브랜치에 push하면 `.github/workflows/deploy.yml`이 빌드 후 Pages에 배포합니다.
최초 1회 **Settings → Pages → Source → GitHub Actions** 지정 필요.
배포 주소: `https://notetester.github.io/TripTogetherLearning/`

## ⚠️ 공개 저장소 주의

실제 비밀번호·API 키·DB 호스트/IP·**팀원 실명** 등 민감정보는 **절대 넣지 않습니다.**
도메인은 중립적으로 서술하고, 담당은 익명 라벨(A~D)로만 표시합니다.
