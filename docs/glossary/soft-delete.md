# 소프트 삭제 (Soft Delete)

> 행(row)을 실제로 지우지 않고 `status` 컬럼을 `DELETED`로 바꿔 "삭제된 것처럼" 다룬다 — 신고 이력·감사·복구·참조무결성을 지키기 위한 선택.

- [도메인 전체 개요](/domains)
- [담당별 보기](/by-area/)
- [전체 흐름](/flow/)

## 1. 한 줄 정의

소프트 삭제는 `DELETE FROM ...`(물리 삭제) 대신 상태 컬럼(`post_status`, `comment_status`, `account_status`)을 `'DELETED'`로 UPDATE 해서 데이터를 보존한 채 사용자 시야에서만 감추는 패턴이다. TripTogether에서는 ADR-0008로 표준화되어 있다.

## 2. 왜 이렇게 설계했나

물리 삭제는 단순하지만 팀 프로젝트에서 다음 네 가지를 동시에 깨뜨린다. 이 네 가지가 곧 설계 동기다.

| 깨지는 것 | 물리 삭제의 문제 | 소프트 삭제의 해법 |
|---|---|---|
| 신고/감사 컨텍스트 | 신고된 글을 작성자가 지우면 어드민 판단 큐에서 사라짐 | row가 살아 있어 신고 게시판이 그대로 동작 |
| 복구 | 사용자 실수 삭제를 되돌릴 수 없음 | 어드민이 `status='ACTIVE'`로 되돌리기 가능 |
| 참조무결성(FK) | 글 삭제 시 FK 연쇄로 댓글·좋아요까지 증발 | row 유지 → FK가 깨지지 않음 |
| 캐시 컬럼 정합성 | `comment_count`, `like_count`가 어긋남 | DELETED를 카운트에서 제외해 자연스럽게 일치 |

특히 신고 자동차단을 금지한 ADR-0001(사람이 검토하는 판단 큐)이 직접적인 동기다. 어드민이 신고 글을 검토하는 사이 작성자가 삭제해도 컨텍스트가 보존되어야 한다.

:::tip 왜 `deleted_at` 타임스탬프가 아니라 status 값인가
이미 `post_status`에 `BLOCKED`(어드민 차단, ADR-0003) 같은 상태가 있었다. 별도 `deleted_at` 컬럼을 추가하면 "차단"과 "삭제"가 서로 다른 메커니즘으로 표현되어 분기가 늘어난다. 기존 상태 머신 컬럼에 `'DELETED'` 값 하나를 더하는 비용이 가장 낮았다. (ADR-0008 Option D 기각 사유)
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

상태 컬럼을 가진 핵심 테이블과 값 매트릭스:

| 테이블 | 컬럼 | 가질 수 있는 값 | 의미 |
|---|---|---|---|
| `COMMUNITY_POST` | `post_status` | `ACTIVE` / `BLOCKED` / `DELETED` | 정상 / 어드민 차단 / 삭제 |
| `COMMUNITY_COMMENT` | `comment_status` | `ACTIVE` / `BLOCKED` / `DELETED` | 동일 |
| `USERS` | `account_status` | `ACTIVE` / `DORMANT` / `BLOCKED` / `DELETED` | 활성 / 휴면 / 차단 / 탈퇴 |

- 각 status 컬럼은 인덱스가 있다 (`idx_cpd_status`, `idx_cc_status`). 모든 리스트 쿼리가 이 컬럼으로 필터하므로 인덱스가 없으면 풀스캔이 된다.
- FK는 `ON DELETE RESTRICT`로 묶여 있다 (`fk_cp_user`, `fk_cc_post`, `fk_cc_user`). 물리 삭제를 시도하면 DB가 막는다 — 소프트 삭제를 강제하는 안전장치이기도 하다.

구현 위치:

- 게시글 삭제: `CommunityServiceImpl.deletePost()` → `CommunityMapper`의 UPDATE (`SET post_status='DELETED'`)
- 댓글 삭제: `CommunityServiceImpl.deleteComment()` → `SET comment_status='DELETED'`
- 회원 탈퇴/차단 상태: `AuthServiceImpl`가 로그인 시 `account_status='DELETED'`를 검사 (`ACCOUNT_DELETED` 사유로 거부)
- 표준 필터·캐시 재계산: `src/main/resources/mapper/CommunityMapper.xml`

## 4. 동작 원리 (흐름·표·작은 코드)

### 삭제 트랜잭션

```text
deleteComment(commentId, loginUser)
  ├─ 권한 검사 (작성자 본인 또는 어드민)
  ├─ UPDATE comment_status='DELETED'            // 물리 삭제 아님
  └─ 글의 comment_count 감소 (또는 reconcile)   // 캐시 정합성
```

### 조회 시점 — 호출자에 따라 필터가 다르다

같은 데이터라도 누가 보느냐에 따라 노출 범위가 달라진다. 이게 소프트 삭제의 핵심이자 함정이다.

| 보는 주체 | WHERE 절 | 보이는 것 |
|---|---|---|
| 일반 사용자 리스트 | `post_status = 'ACTIVE'` | 정상 글만 |
| 어드민 리스트 | `post_status IN ('ACTIVE','BLOCKED')` | 차단 글 포함, 삭제 글 제외 |
| 신고 게시판 컨텍스트 | status 필터 없음 | 삭제 글 포함 전부 |

실제 매퍼에서 댓글 트리 카운트도 같은 규칙을 따른다 (`CommunityMapper.xml`):

```sql
-- 댓글 수 캐시 재계산: DELETED 만 제외
cp.comment_count = (
  SELECT COUNT(*) FROM COMMUNITY_COMMENT
  WHERE post_id = cp.post_id AND comment_status != 'DELETED'
)
```

`comment_count`는 `ACTIVE + BLOCKED`를 포함하고 `DELETED`만 뺀다. 그래서 사용자에게 보이는 댓글 수가 자연스럽게 맞는다. 이 재계산은 카운터 캐시 정합성(ADR-0006)과 짝을 이룬다.

:::warning 가장 흔한 사고
리스트 쿼리 하나에서 `WHERE status='ACTIVE'`를 빠뜨리면 삭제된 콘텐츠가 사용자에게 그대로 노출된다. 소프트 삭제는 "지웠다"는 보장을 애플리케이션 쿼리에 위임하기 때문에, 새 조회 경로를 추가할 때마다 필터를 반드시 함께 넣어야 한다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: 게시글·댓글의 `DELETED` 마킹, 어드민/사용자/신고 컨텍스트별 필터 분기, `comment_count` 등 캐시 재계산에서 DELETED 제외, `account_status='DELETED'` 로그인 차단, FK `ON DELETE RESTRICT`로 물리 삭제 방어.
- 계획/미구현: 어드민 콘솔의 "DELETED 콘텐츠 복구 UI"는 정책상 복구가 가능하다는 것이지 전용 화면이 완비된 단계는 아니다. GDPR 대응을 위한 "일정 기간 경과 DELETED row의 물리 삭제(예: 6개월 후 hard delete)" 배치는 향후 과제로 ADR에 명시되어 있다. 검색 인덱싱 도입 시 DELETED 제외 로직도 미래 작업이다.

## 6. 면접 답변 3단계

1. 정의: "콘텐츠 삭제를 물리 삭제 대신 `status` 컬럼을 `DELETED`로 바꾸는 소프트 삭제로 처리했습니다."
2. 이유: "신고된 글을 작성자가 지워도 어드민 판단 큐의 컨텍스트가 보존되어야 했고, FK 연쇄 삭제와 캐시 카운트 어긋남을 피해야 했습니다. 이미 `post_status`에 `BLOCKED` 같은 상태가 있어 값 하나만 추가하면 됐습니다."
3. 트레이드오프: "대신 모든 리스트 쿼리에 `WHERE status='ACTIVE'` 필터가 필요하고, 누락하면 삭제 콘텐츠가 노출되는 위험이 있어 인덱스와 함께 규약으로 관리합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 소프트 삭제하면 필터를 빠뜨려 삭제 데이터가 노출되는 위험이 있는데 어떻게 막나요
주체별로 표준 쿼리 패턴을 고정했습니다 — 사용자는 `= 'ACTIVE'`, 어드민은 `IN ('ACTIVE','BLOCKED')`, 신고 컨텍스트는 필터 없음. status 컬럼에 인덱스(`idx_cpd_status` 등)를 둬 필터가 성능을 깎지 않게 했고, 향후엔 매퍼 공통 fragment나 리포지토리 기본 필터로 누락 자체를 줄이는 방향을 검토할 수 있습니다.
:::

:::details Q2. `DELETED`와 `BLOCKED`를 굳이 같은 컬럼에 둔 이유는요
둘 다 "사용자에게 안 보이거나 제한된" 상태로, 같은 상태 머신 안에서 표현하는 게 일관적입니다. `BLOCKED`는 어드민 차단(ADR-0003), `DELETED`는 삭제로 의미는 다르지만, 어드민 리스트는 `IN ('ACTIVE','BLOCKED')`처럼 한 컬럼으로 범위를 표현할 수 있어 분기가 단순해집니다. 별도 `deleted_at` 컬럼을 두면 차단/삭제가 서로 다른 메커니즘이 되어 오히려 복잡해집니다.
:::

:::details Q3. 캐시된 comment_count는 소프트 삭제와 어떻게 정합성을 맞추나요
삭제는 댓글 status를 `DELETED`로 바꾸면서 글의 `comment_count`를 함께 감소시킵니다. 그리고 재계산 쿼리는 `comment_status != 'DELETED'`로 실제 행 수를 다시 세어 드리프트를 보정합니다(ADR-0006). 카운트가 `ACTIVE + BLOCKED`를 포함하고 DELETED만 빼므로, 사용자 화면에 보이는 수와 캐시가 일치합니다.
:::

:::details Q4. FK가 ON DELETE RESTRICT인데 소프트 삭제와 무슨 관계인가요
`COMMUNITY_POST`, `COMMUNITY_COMMENT`가 `USERS`를 `ON DELETE RESTRICT`로 참조합니다. 즉 물리 삭제를 시도하면 DB가 거부합니다. 이건 소프트 삭제를 코드 규약뿐 아니라 스키마 레벨에서도 강제하는 안전장치입니다. 댓글은 부모 댓글을 `ON DELETE CASCADE`로 두지만, 부모 댓글도 실제로는 물리 삭제하지 않고 `DELETED` 마킹하므로 CASCADE가 발동하지 않습니다.
:::

:::details Q5. 회원 탈퇴는 어떻게 처리되나요
`USERS.account_status`를 `DELETED`로 바꿉니다. `AuthServiceImpl`가 로그인 시 `account_status='DELETED'`면 `ACCOUNT_DELETED` 사유로 인증을 거부합니다. 작성한 글·댓글의 FK가 깨지지 않으므로 탈퇴 후에도 커뮤니티 글의 작성자 참조가 유지됩니다. 다만 개인정보 보호상 일정 기간 후 물리 삭제 정책은 별도 과제로 남아 있습니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 1분 안에 설명할 수 있으면 충분히 이해한 것이다.

- 물리 삭제가 깨뜨리는 네 가지(신고/감사, 복구, FK, 캐시)와 각각을 소프트 삭제가 어떻게 막는지
- 사용자·어드민·신고 컨텍스트의 WHERE 절이 어떻게 다른지, 그리고 왜 다른지
- `comment_count`가 `DELETED`를 제외하는 이유와 그게 캐시 정합성과 어떻게 이어지는지
- `ON DELETE RESTRICT`가 소프트 삭제를 스키마 레벨에서 강제한다는 점

## 퀴즈

<QuizBox question="TripTogether에서 게시글을 '삭제'할 때 실제로 일어나는 일은?" :choices="['DELETE FROM COMMUNITY_POST 로 행을 제거한다', 'post_status 컬럼을 DELETED 로 UPDATE 한다', '별도 아카이브 테이블로 행을 옮긴다', 'deleted_at 타임스탬프만 기록한다']" :answer="1" explanation="ADR-0008에 따라 물리 삭제 대신 post_status='DELETED' 로 UPDATE 하는 소프트 삭제를 사용한다. 기존 상태 머신 컬럼을 재사용하므로 추가 컬럼이 필요 없다." />

<QuizBox question="어드민 리스트 조회의 WHERE 절로 가장 적절한 것은?" :choices="['post_status = ACTIVE', 'post_status = DELETED', 'post_status IN (ACTIVE, BLOCKED)', '필터 없음 (모든 상태)']" :answer="2" explanation="어드민 리스트는 차단(BLOCKED) 글은 보되 삭제(DELETED) 글은 제외한다. 일반 사용자는 ACTIVE 만, 신고 컨텍스트는 필터 없이 전부 본다." />

<QuizBox question="comment_count 캐시 재계산 시 어떤 댓글을 카운트에서 제외하는가?" :choices="['BLOCKED 댓글만', 'DELETED 댓글만', 'ACTIVE 를 제외한 전부', '대댓글(parent_comment_id 있는 것) 전부']" :answer="1" explanation="재계산 쿼리는 comment_status != 'DELETED' 로 센다. 즉 ACTIVE 와 BLOCKED 는 포함하고 DELETED 만 제외하여 사용자 표시 수와 일치시킨다." />
