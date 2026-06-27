# ADR(MADR) 문서화

> TripTogether는 주요 아키텍처·정책 결정을 코드 옆 `docs/adr/`에 **MADR 형식**으로 기록한다. 0001~0014까지 14건이 있고, 각 문서는 "어떤 상황(Context)에서 / 무엇을 고민해(Considered Options) / 왜 이렇게 정했고(Decision Outcome) / 그 대가는 무엇인가(Consequences)"를 같은 골격으로 남긴다. 4명이 도메인을 나눠 만든 프로젝트라, 결정의 **근거와 트레이드오프**를 글로 남겨 둔 점이 면접에서 강한 신호가 된다.

이 페이지는 특정 도메인 기능이 아니라 4명이 공유하는 **의사결정 기록 관행**을 다룬다. 소프트 삭제·CSRF·AOP·i18n 같은 결정이 코드에만 흩어져 있지 않고, 왜 그렇게 했는지가 ADR로 추적된다.

## 1. 한 줄 정의

ADR(Architecture Decision Record)은 "되돌리기 어렵거나 영향 범위가 넓은 결정 하나"를 짧은 마크다운 1파일로 남기는 경량 문서이고, TripTogether는 그중 [MADR(Markdown Any Decision Records)](https://adr.github.io/madr/) 0.6 템플릿을 채택해 `docs/adr/NNNN-slug.md` 규칙으로 `0001`~`0014`를 관리한다.

## 2. 왜 이렇게 설계했나

4명이 도메인을 수직 분담하면 같은 문제를 서로 다르게 풀거나, 한 사람이 내린 결정이 다른 사람의 모듈에 영향을 줄 때 **맥락이 휘발**된다. "왜 삭제를 진짜 `DELETE`로 안 했지?", "왜 CSRF가 일부 경로에만 걸려 있지?" 같은 질문이 코드만 봐서는 풀리지 않는다. ADR은 이 휘발을 막는 장치다.

설계 의도를 정리하면 다음과 같다.

- **결정의 근거를 코드 옆에 보존** — 위키가 아니라 `docs/adr/`에 두어 PR·코드 리뷰와 같은 흐름에서 본다.
- **대안과 트레이드오프를 명시** — 채택한 안만이 아니라 버린 안(Considered Options)과 그 이유까지 적어, 나중에 "그건 검토 안 했나?"를 막는다.
- **협업 충돌 예방** — 한 사람의 결정이 공통 영역(보안·i18n·예외 처리)을 건드리면 ADR로 의도와 적용 범위를 공유한다.
- **번복 가능성을 열어 둠** — 결정이 바뀌면 문서를 지우지 않고 `Status`만 `Deprecated` / `Superseded by ADR-XXXX`로 바꿔 **결정의 역사**를 남긴다.

:::tip ADR은 "정답"이 아니라 "그때 그 맥락에서의 선택"이다
ADR의 핵심 가치는 결정이 옳았음을 증명하는 게 아니라, **결정 당시의 제약과 트레이드오프를 정직하게 박제**하는 것이다. 그래서 TripTogether의 ADR들은 채택안의 단점(Bad)도 빠짐없이 적는다. 예: ADR-0008은 소프트 삭제의 단점으로 "모든 리스트 쿼리에 `WHERE status='ACTIVE'` 필요"를 명시한다.
:::

## 3. 어떤 기술로 구현했나 (실제 파일·규칙)

도구가 아니라 **문서 규약**이다. 실제 산출물과 규칙은 다음과 같다.

| 요소 | 위치 / 규칙 | 역할 |
| --- | --- | --- |
| 표준 형식 | MADR 0.6 | 6개 고정 섹션 골격 |
| 템플릿 | `docs/adr/template.md` | 새 ADR 복사용 |
| 인덱스 | `docs/adr/README.md` | 모듈별 ADR 목록·Status 표 |
| 본문 | `docs/adr/NNNN-slug.md` | 결정 1건 = 1파일 |
| 파일명 | `0008-soft-delete-pattern.md` | 4자리 0-패딩 번호 + 영문 소문자 슬러그 |

### MADR 문서의 고정 골격

모든 ADR이 같은 섹션 순서를 따른다. 독자가 어느 문서를 펼쳐도 같은 자리에서 같은 정보를 찾는다.

```text
# ADR-NNNN: {결정 제목 — 짧고 능동형}

* Status: Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
* Date: YYYY-MM-DD
* Decision-Makers / Consulted / Informed: 담당자

## Context and Problem Statement   ← 어떤 상황에서 무슨 문제
## Decision Drivers                 ← 결정에 영향 준 핵심 요인
## Considered Options               ← 검토한 대안(채택+탈락)
## Decision Outcome                 ← 선택안 + 사유 + Consequences(Good/Bad/Neutral)
## Pros and Cons of the Options     ← 옵션별 장단점
## More Information                 ← 관련 ADR·코드 위치·참고 링크
```

### 번호 매김·생애주기 규칙

`README.md`가 정의한 규칙이다.

- **4자리 0-패딩 번호**(`0001`, `0002`, …)를 **임팩트 순서**로 부여(사후 정리 컨텍스트).
- 한 번 부여한 번호는 **재사용 금지**.
- 결정이 폐기·대체되면 본문을 지우지 않고 `Status`만 `Deprecated` / `Superseded by ADR-XXXX`로 변경.
- 새 ADR은 `Status: Proposed`로 시작 → 합의·구현 완료 시 `Accepted`.
- 관련 코드에 `// 정책: ADR-0001 참조` 식 주석으로 역참조 권장.

## 4. 동작 원리 (흐름·표·작은 코드)

### ADR 작성 워크플로우

```text
결정이 필요한 문제 발생
  → template.md 복사 → NNNN-slug.md 생성 (Status: Proposed)
  → Context / Drivers / Considered Options 작성
  → 팀 합의·구현 완료 → Status: Accepted
  → README.md 인덱스 표에 행 추가
  → 코드에 // ADR-NNNN 참조 주석 (선택)
  → 나중에 번복 시: 본문 보존 + Status: Superseded by ADR-XXXX
```

### 14개 ADR 한눈에 보기

`README.md` 인덱스를 모듈별로 정리한 것이다. 4명이 만든 여러 도메인의 결정이 한 곳에 모인다.

| ID | 결정 | 모듈 | 관련 학습 페이지 |
| --- | --- | --- | --- |
| ADR-0001 | 신고 누적 자동 제재는 BLUR까지, 그 외는 운영진 수동 판단 | 신고 | [신고 상태머신](/community/report-system) |
| ADR-0002 | 커뮤니티 글쓰기 WYSIWYG 에디터 채택 | 커뮤니티 | [게시글 유형](/community/post-types) |
| ADR-0003 | BLUR vs BLOCKED 분기 — 점진적 공개 vs 완전 숨김 | 신고 | [3-스트라이크 블러](/community/three-strike-blur) |
| ADR-0004 | 중복 신고 방지 — DB UNIQUE + 사전 체크 + 재활성화 3중 방어 | 신고 | [신고 상태머신](/community/report-system) |
| ADR-0005 | XSS 방지 — jsoup Safelist 서버측 sanitize | 보안/공통 | [독성 감지](/community/toxicity-perspective) |
| ADR-0006 | 캐시 컬럼 + Reconcile 스케줄러 — like/comment count 정합성 | 커뮤니티 | [좋아요·태그](/community/likes-tags) |
| ADR-0007 | 이미지 스토리지 — Cloudinary 외부 CDN | 인프라 | [이미지 처리](/community/images) |
| ADR-0008 | Soft Delete — `status='DELETED'` 상태 컬럼 | 보안/공통 | [소프트 삭제](/glossary/soft-delete) |
| ADR-0009 | 모더레이션 정책 외부화 — `ContentModerationPolicyVO` | 보안/공통 | [모더레이션 파이프라인](/admin/moderation-pipeline) |
| ADR-0010 | AI 모더레이션 풀 스택 — Perspective + ai_flagged + BLUR | 보안/공통 | [모더레이션 파이프라인](/admin/moderation-pipeline) |
| ADR-0011 | 권한 체크 AOP + 글로벌 예외 처리 | 보안/공통 | [AOP 권한 체크](/backend/aop-authorization) |
| ADR-0012 | Spring Security CSRF 부분 도입 + 점진 확장 | 보안/공통 | [CSRF 용어](/glossary/csrf) |
| ADR-0013 | API 응답 메시지 i18n — JSP 외 컨트롤러/서비스까지 4개 언어 | 보안/공통 | [다국어·공통](/i18n/) |
| ADR-0014 | JUnit 테스트 전략 — Service 단위 + ADR 정책 검증 | 보안/공통 | [JUnit 테스트](/infra/junit-testing) |

### 대표 ADR 4건의 결정 요약

각 ADR이 "무엇을 / 왜 / 무엇을 버렸나"를 어떻게 박제하는지 보여주는 예다.

| ADR | 채택안 | 버린 안(핵심) | 채택 사유 한 줄 |
| --- | --- | --- | --- |
| 0008 소프트 삭제 | `status` 컬럼에 `'DELETED'` 마킹 | Hard Delete / 아카이브 테이블 / `deleted_at` | 신고·감사 컨텍스트 보존 + 기존 status 컬럼 재사용으로 비용 0 |
| 0012 CSRF 부분 도입 | 일부 경로만 CSRF + 토큰 자동 첨부 | 풀 도입 / 인프라만 | 회귀 위험·협업 충돌 최소화하며 즉시 보호 확보, 단계적 확장 명시 |
| 0011 AOP 권한 | 어노테이션 + AOP + ArgumentResolver | 리플렉션 ad-hoc / URL 인터셉터 | 메서드 단위 선언적 권한, 보일러플레이트 64% 감소 |
| 0013 i18n 메시지 | 담당 모듈 컨트롤러·서비스 메시지까지 i18n | 한국어 하드코딩 유지 / 전 모듈 풀 도입 | 담당 영역 다국어 일관성 확보 + 다른 모듈 영향 0 |

:::details ADR-0012가 보여주는 "트레이드오프 정직성" 예시
ADR-0012(CSRF 부분 도입)는 채택안의 단점을 숨기지 않는다. "**부분 도입은 일관성 결여** — 같은 프로젝트에 CSRF 적용/미적용 영역이 혼재", "다른 모듈은 여전히 무방어" 등을 Bad에 적고, `Phase 1~4` 확장 계획표로 **앞으로 어떻게 메울지**까지 같이 남긴다. ADR이 "지금의 한계"와 "다음 계획"을 한 문서에 담는 좋은 사례다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: `docs/adr/`에 0001~0014가 실재하고, `template.md`와 `README.md` 인덱스가 갖춰져 있다. 14건 모두 `Status: Accepted`다. 각 ADR은 MADR 6섹션 골격을 따르며, 채택안의 단점(Bad)과 관련 ADR 교차참조, 코드 위치까지 적혀 있다.
- **연결된 검증**: ADR-0014는 "ADR 정책을 JUnit으로 검증" 전략을 정의한다. 즉 일부 결정(예: 신고 자동 제재 범위)은 문서로만 끝나지 않고 테스트로 회귀를 막는 것을 목표로 한다.
- **한계/계획**: ADR은 "사후 정리 컨텍스트"로 번호를 임팩트 순서로 매겼다고 README가 밝힌다. 즉 모든 결정이 발생 즉시 ADR로 작성된 건 아니고, 일부는 정리 시점에 소급 기록됐다. 또한 ADR-0011·0012·0013 같은 결정은 본문이 **점진적 마이그레이션(Phase 2~)을 계획**으로 남긴 상태라, 코드베이스에는 신/구 방식이 의도적으로 혼재한다. 자동 ADR 린트(형식 검사)나 ADR↔코드 양방향 추적 도구는 도입돼 있지 않다.

## 6. 면접 답변 3단계

1. **한 줄**: "주요 아키텍처·정책 결정을 코드 옆 `docs/adr/`에 MADR 형식으로 14건 남겼습니다. 각 문서는 상황(Context)·검토한 대안·선택 사유·그 결과(Consequences)를 같은 골격으로 적어, 결정의 근거와 트레이드오프를 추적할 수 있게 했습니다."
2. **왜**: "4명이 도메인을 나눠 만들다 보니 결정의 맥락이 휘발되기 쉬웠습니다. '왜 진짜 삭제 대신 소프트 삭제인가', '왜 CSRF가 일부 경로에만 걸렸나' 같은 질문이 코드만으로는 안 풀려서, 채택안뿐 아니라 **버린 대안과 그 이유**까지 적는 ADR로 의도를 박제했습니다."
3. **트레이드오프/한계**: "번호를 임팩트 순서로 매긴 '사후 정리' 방식이라 일부는 소급 기록입니다. 또 ADR-0011·0012는 본문에 점진적 마이그레이션 계획을 남긴 상태라 코드에 신/구 방식이 의도적으로 공존합니다. 형식 자동 검사 같은 자동화는 아직 없습니다."

## 7. 꼬리질문 + 모범답안

:::details Q. ADR과 그냥 위키 문서·README는 뭐가 다른가요?
ADR은 (1) **결정 1건 = 불변 1파일**이고, (2) **버린 대안과 트레이드오프**를 의무적으로 적으며, (3) 번복돼도 지우지 않고 `Status`만 바꿔 **결정의 역사**를 보존한다는 점이 다릅니다. 위키는 보통 "현재 상태"만 보여주고 과거 결정의 맥락은 덮어써집니다. ADR은 코드 옆(`docs/adr/`)에 둬서 PR·리뷰 흐름과 같이 보는 것도 의도된 차이입니다.
:::

:::details Q. 결정이 바뀌면 ADR을 삭제하면 되지 않나요?
삭제하면 안 됩니다. 과거의 결정과 그 맥락이 사라지면, 나중에 같은 문제를 다시 검토할 때 "예전에 이 안을 왜 버렸는지"를 또 모르게 됩니다. 그래서 TripTogether는 본문을 보존하고 `Status`를 `Deprecated`나 `Superseded by ADR-XXXX`로만 바꿉니다. 번호도 재사용하지 않습니다. 결정의 **연속성과 역사**를 남기는 게 ADR의 핵심 가치입니다.
:::

:::details Q. MADR 6개 섹션 중 가장 중요한 섹션 하나만 꼽는다면?
`Considered Options`와 `Decision Outcome`의 `Consequences`(특히 Bad)입니다. 채택안만 적으면 자랑글이지만, **버린 대안**과 **채택안의 단점**까지 적어야 "이 결정은 이런 제약 아래 내린 트레이드오프"라는 정직한 기록이 됩니다. 예로 ADR-0008은 소프트 삭제의 단점으로 "모든 리스트 쿼리에 status 필터 필요", "디스크 사용량 증가", "GDPR 시 hard delete 정책 필요"를 명시합니다.
:::

:::details Q. ADR-0012(CSRF)는 왜 전면 도입을 안 하고 부분 도입했나요? 그게 ADR로 어떻게 정당화되나요?
4명 공동 개발이라 전면 도입은 다른 담당자 모듈의 모든 폼/AJAX에 영향을 줘 회귀 위험과 조율 비용이 컸습니다. ADR-0012는 이를 Decision Drivers에 명시하고, 일부 경로에만 CSRF를 걸되 토큰을 기존 코드 무수정으로 자동 첨부하는 방식을 채택안으로 적었습니다. 동시에 Bad에 "일관성 결여"를 인정하고, `Phase 1~4` 확장 계획표로 메울 경로까지 문서에 남겼습니다. **결정·한계·다음 계획**이 한 문서에 있는 게 ADR의 힘입니다.
:::

:::details Q. ADR이 코드와 어긋나면(문서는 A인데 코드는 B) 어떻게 막나요?
완전히 막는 자동 도구는 없지만, TripTogether는 두 가지로 보완합니다. (1) `README.md`의 작성 가이드가 "관련 코드에 `// ADR-NNNN 참조` 주석"을 권장해 코드→문서 역참조를 남깁니다. (2) ADR-0014가 "ADR 정책을 JUnit으로 검증"하는 전략을 정의해, 일부 핵심 정책(예: 신고 자동 제재 범위)은 테스트로 회귀를 잡습니다. 한계로는 형식 린트나 양방향 추적 자동화가 아직 없다는 점을 솔직히 말하면 됩니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 30초씩 설명해 보세요.

- ADR(MADR)의 6개 고정 섹션과, 그중 `Considered Options`·`Consequences(Bad)`가 왜 결정적인지.
- 결정이 번복될 때 ADR을 **삭제하지 않고** `Status`만 바꾸는 이유(결정의 역사 보존).
- ADR-0008(소프트 삭제)을 예로, "버린 안 3개 + 채택안 + 채택안의 단점"을 한 호흡에.
- ADR-0012(CSRF 부분 도입)가 4명 공동 개발이라는 제약을 어떻게 결정과 확장 계획으로 녹였는지.
- 14건이 "사후 정리·임팩트 순서 번호"라는 점이 무슨 의미이고, 그 한계를 어떻게 솔직히 인정할지.

## 퀴즈

<QuizBox
  question="TripTogether ADR에서 결정이 번복·대체될 때의 처리 방식은?"
  :choices="['해당 ADR 파일을 삭제하고 번호를 재사용한다', '본문은 보존하고 Status만 Deprecated/Superseded by ADR-XXXX로 바꾼다', '새 ADR로 덮어쓰고 옛 파일명을 그대로 유지한다', 'README 인덱스에서만 행을 지운다']"
  :answer="1"
  explanation="ADR은 결정의 역사를 보존하기 위해 본문을 지우지 않고 Status만 변경한다. 번호도 재사용하지 않는다. 과거 맥락이 사라지면 같은 문제를 다시 검토할 때 비용이 든다."
/>

<QuizBox
  question="MADR 형식에서 '채택안이 좋다'만 적지 않고 반드시 함께 적도록 한 두 가지는?"
  :choices="['배포 일자와 담당자', '검토한 대안(Considered Options)과 채택안의 단점(Consequences의 Bad)', '코드 라인 수와 커밋 해시', 'API 명세와 DB 인덱스']"
  :answer="1"
  explanation="버린 대안과 채택안의 트레이드오프(Bad)를 함께 적어야 '제약 아래 내린 선택'이라는 정직한 기록이 된다. 예: ADR-0008은 소프트 삭제의 단점까지 명시한다."
/>

<QuizBox
  question="ADR-0012(CSRF 부분 도입)가 전면 도입 대신 부분 도입을 택한 주된 이유는?"
  :choices="['Spring Security가 부분 도입만 지원해서', '4명 공동 개발에서 다른 담당자 모듈 전체에 회귀 위험·조율 비용이 커서', 'CSRF는 일부 경로에서만 발생하는 공격이라서', '성능 저하를 막기 위해서']"
  :answer="1"
  explanation="공동 개발 맥락상 전면 도입은 타 담당자 모듈의 모든 폼/AJAX에 영향을 줘 회귀 위험이 컸다. 그래서 일부 경로만 적용 + 토큰 자동 첨부로 즉시 보호를 확보하고, Phase 1~4 확장 계획을 문서에 남겼다."
/>

---

**관련 페이지**: [AOP 권한 체크](/backend/aop-authorization) · [소프트 삭제](/glossary/soft-delete) · [CSRF](/glossary/csrf) · [JUnit 테스트](/infra/junit-testing) · [Git 협업 전략](/infra/git-workflow)

**허브**: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
