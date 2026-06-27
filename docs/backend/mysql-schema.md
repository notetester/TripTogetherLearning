# MySQL 스키마

> TripTogether의 모든 도메인(인증·커뮤니티·여행 코스·문의·챗봇·관리자)은 단일 MySQL 8 스키마 위에 올라가고, **삭제는 row를 지우는 대신 상태 컬럼으로 표시(소프트 삭제)**, **연결은 FK + 캐시 카운트**, **이력은 별도 history 테이블**이라는 세 가지 공통 규칙을 따른다.

이 페이지는 특정 도메인이 아니라 4명이 만든 모든 기능이 공유하는 **데이터 저장 골격**을 다룬다. 영속성 기술 자체(매핑 방식)는 [MyBatis](/backend/mybatis), 도메인별 ER 상세는 [커뮤니티 데이터 모델](/community/data-model)·[전체 데이터 모델](/flow/data-model)에서 이어 본다.

## 1. 한 줄 정의

MySQL 8(InnoDB, `utf8mb4`) 단일 스키마에 도메인별 테이블군(`USERS`, `COMMUNITY_*`, `TRAVEL_PLAN`/`plan_spot`, `INQUIRY_*`, `CHAT_*`/`CHATBOT_*`, `ADMIN_*`)을 두고, **모든 사용자 식별은 `USERS.user_idx` FK로 모이며, 콘텐츠 삭제는 상태 컬럼으로만 표시**하는 관계형 스키마다.

## 2. 왜 이렇게 설계했나

- **사용자 중심 방사형 구조.** 게시글·댓글·여행 계획·문의·신고·지갑·알림이 전부 `USERS.user_idx`를 FK로 참조한다. 회원 한 명을 기준으로 모든 활동을 조인할 수 있어, 관리자 "회원 360 뷰" 같은 화면이 단순한 조인으로 성립한다.
- **소프트 삭제로 컨텍스트 보존.** 신고된 글을 작성자가 지워도 관리자 판단 큐에 컨텍스트가 남아야 한다(ADR-0008). 그래서 `DELETE`를 거의 쓰지 않고 `post_status`/`comment_status`/`account_status`/`is_deleted` 같은 컬럼에 `DELETED`를 마킹한다.
- **캐시 카운트로 읽기 최적화.** 목록 화면이 매번 `COUNT(*)`를 돌리지 않도록 `like_count`/`comment_count`/`view_count`/`use_count`/`co_count`를 컬럼에 들고 다닌다. 어긋나면 별도 reconcile 스케줄러로 맞춘다(ADR-0006).
- **이력은 본문과 분리.** 답변 수정/삭제(`INQUIRY_ANSWER_HISTORY`), 설정 변경(`APPLICATION_RUNTIME_SETTING_HISTORY`), 급여 변경(`SALARY_CHANGE_AUDIT`), 관리자 조치(`ADMIN_ACTION_AUDIT`)처럼 "누가 언제 무엇을 바꿨나"는 원본 테이블을 더럽히지 않고 전용 테이블에 append-only로 쌓는다.
- **운영 정책을 DB로.** 등급별 쿼터(`CHATBOT_GRADE_QUOTA`), 보상 정책(`POINT_REWARD_POLICY`), 검열 정책(`CONTENT_MODERATION_POLICY`), 런타임 설정(`APPLICATION_RUNTIME_SETTING`)을 코드 상수가 아니라 테이블에 둬서, 재배포 없이 관리자가 값을 바꾼다.

## 3. 어떤 기술로 구현했나 (실제 테이블·규칙)

| 항목 | TripTogether 구현 |
| --- | --- |
| DBMS / 엔진 | MySQL 8 / InnoDB |
| 문자셋·콜레이션 | `utf8mb4` (이모지 포함), `utf8mb4_0900_ai_ci` 또는 `utf8mb4_unicode_ci` |
| 회원 PK | `USERS.user_idx` (`bigint AUTO_INCREMENT`) — 거의 모든 테이블의 FK 허브 |
| 접속 설정 | `application.properties`의 `spring.datasource.url=jdbc:mysql://DB_HOST:3306/DB_NAME` 등, 시크릿은 외부 주입 |
| 매핑 | MyBatis `@Mapper` + `resources/mapper/*.xml` (JPA 미사용 → [MyBatis](/backend/mybatis)) |
| 마이그레이션 | 수동 SQL 패치 + `SCHEMA_MIGRATION_HISTORY` 적용 이력 테이블 |

:::warning 접속 정보는 자리표시자
실제 호스트·DB명·계정·비밀번호는 이 문서에 싣지 않는다. 위 표의 `DB_HOST`/`DB_NAME`은 자리표시자이고, 자격증명은 코드/문서가 아니라 환경변수·외부 설정으로 주입한다(→ [런타임 설정](/backend/runtime-settings)).
:::

### 도메인별 주요 테이블군

| 도메인 | 핵심 테이블 | 메모 |
| --- | --- | --- |
| 회원·인증 | `USERS`, `EMAIL_VERIFICATION` | `user_idx` 단일 PK, `account_status` 상태머신, 3종 잔액 컬럼 |
| 커뮤니티 | `COMMUNITY_POST`, `COMMUNITY_COMMENT`, `COMMUNITY_POST_LIKE`, `COMMUNITY_COMMENT_LIKE`, `COMMUNITY_POST_IMAGE` | `post_status`/`comment_status` 소프트 삭제, `like_count`/`comment_count` 캐시 |
| 태그 | `COMMUNITY_TAG`, `COMMUNITY_POST_TAG`, `COMMUNITY_TAG_RELATION` | M:N 연결 + 공출현 `co_count` |
| 여행 코스 | `TRAVEL_PLAN`, `plan_spot` | `plan_source`(MANUAL/AI), `visit_order` 순서, `is_public`/`share_token` |
| 문의 | `INQUIRY_POST`, `INQUIRY_ANSWER`, `INQUIRY_ANSWER_HISTORY`, `INQUIRY_ATTACHMENT` | `status` 상태머신, 1:1 답변, 변경 이력 분리 |
| 알림 | `MYPAGE_FEED_NOTIFICATION` | `is_read`, `target_url`, 크로스모듈 `source_type`/`source_id` |
| 신고 | `REPORT` | `target_type`/`target_id` 다형 참조, `status` 상태머신 |
| 챗봇/도우미 | `CHAT_POST`, `CHAT_COMMENT`, `CHATBOT_CONVERSATION`, `CHATBOT_MESSAGE`, `*_GRADE_QUOTA`, `*_DAILY_USAGE` | 2계층 저장, 등급 쿼터·일일 사용량 |
| 관리자·운영 | `ADMIN_ACTION_AUDIT`, `ADMIN_PERMISSION*`, `APPLICATION_RUNTIME_SETTING*`, `CONTENT_MODERATION_POLICY` | 감사·권한·정책의 DB화 |

## 4. 동작 원리 (관계·표·작은 스키마)

### 4.1 사용자 허브 — 모든 FK가 USERS로

`USERS`는 식별만 하는 게 아니라 **상태머신 + 3원 지갑 + 게이미피케이션**을 한 row에 들고 있다.

```sql
CREATE TABLE USERS (
  user_idx        bigint AUTO_INCREMENT PRIMARY KEY,   -- FK 허브
  account_status  varchar(20) DEFAULT 'ACTIVE',        -- ACTIVE/DORMANT/BLOCKED/DELETED
  member_grade    varchar(20) DEFAULT 'BRONZE',        -- BRONZE/SILVER/GOLD/DIAMOND/PLATINUM
  cash_balance    bigint DEFAULT 0,                    -- 3원 지갑: 캐시
  mileage_balance bigint DEFAULT 0,                    -- 3원 지갑: 마일리지
  point_balance   bigint DEFAULT 0,                    -- 3원 지갑: 포인트
  level_no        int    DEFAULT 1,
  exp_points      bigint DEFAULT 0,
  user_role       varchar(20) DEFAULT 'USER',          -- USER/ADMIN
  UNIQUE KEY (nickname), UNIQUE KEY (user_id), UNIQUE KEY (user_email)
);
```

콘텐츠 테이블은 작성자를 `user_idx`로 참조한다. 다만 **FK의 `ON DELETE` 동작은 도메인 의도에 따라 다르게 잡혀 있다**:

| 관계 | ON DELETE | 의도 |
| --- | --- | --- |
| `COMMUNITY_POST.user_idx` → `USERS` | `RESTRICT` | 콘텐츠가 있으면 회원 row 물리 삭제 차단(소프트 삭제로만 처리) |
| `TRAVEL_PLAN.user_idx` → `USERS` | `CASCADE` | 개인 계획은 회원과 운명공동체 |
| `ADMIN_ACTION_AUDIT.actor_user_idx` → `USERS` | `SET NULL` | 감사 로그는 행위자가 사라져도 남아야 함 |
| `plan_spot.plan_id` → `TRAVEL_PLAN` | `CASCADE` | 계획 삭제 시 스팟도 정리 |
| `COMMUNITY_COMMENT.parent_comment_id` → 자기참조 | `CASCADE` | 부모 댓글 삭제 시 대댓글 연쇄 |

:::tip 같은 "삭제"라도 층이 다르다
회원·게시글처럼 **보존이 중요한 엔티티**는 `RESTRICT` + 상태 컬럼(소프트 삭제)으로, 첨부·스팟·대댓글처럼 **부모에 종속된 자식**은 `CASCADE`로, 감사·이력처럼 **행위자와 독립적인 기록**은 `SET NULL`로 잡는다. "FK = 무조건 CASCADE"가 아니라는 점이 면접 포인트다.
:::

### 4.2 소프트 삭제 — 상태 컬럼 한 곳에 BLOCKED/DELETED를 함께 표현

별도 `deleted_at`을 추가하는 대신, 이미 있던 상태머신 컬럼에 값을 더 얹었다(ADR-0008).

| 테이블 | 컬럼 | 값 |
| --- | --- | --- |
| `COMMUNITY_POST` | `post_status` | `ACTIVE` / `BLOCKED` / `DELETED` |
| `COMMUNITY_COMMENT` | `comment_status` | `ACTIVE` / `BLOCKED` / `DELETED` |
| `USERS` | `account_status` | `ACTIVE` / `DORMANT` / `BLOCKED` / `DELETED` |
| `TRAVEL_PLAN`, `CHATBOT_CONVERSATION`, `ADMIN_TRANSLATION` | `is_deleted` | `0` / `1` (플래그형) |

조회는 보는 주체에 따라 필터가 달라진다.

```sql
-- 일반 사용자 목록: 정상만
WHERE post_status = 'ACTIVE'
-- 관리자 목록: 삭제만 제외(차단은 보여줌)
WHERE post_status <> 'DELETED'
-- 신고 판단 큐: 필터 없음(삭제된 것까지 컨텍스트로 본다)
```

### 4.3 캐시 카운트와 정합성

좋아요/댓글은 매번 집계하지 않고 부모 컬럼에 누적값을 둔다. 단, **DELETED는 카운트에서 빠진다**.

```text
댓글 작성  → COMMUNITY_COMMENT INSERT + COMMUNITY_POST.comment_count += 1
댓글 삭제  → comment_status='DELETED' + COMMUNITY_POST.comment_count -= 1
좋아요     → COMMUNITY_POST_LIKE INSERT(uq_comm_like 로 1인 1회) + like_count += 1
정합 보정  → reconcile: comment_count = COUNT(*) WHERE comment_status <> 'DELETED'
```

`COMMUNITY_POST_LIKE(post_id, user_idx)`에 UNIQUE 제약(`uq_comm_like`)이 있어 중복 좋아요가 DB 레벨에서 막힌다. 신고 `REPORT(user_idx, target_type, target_id)`의 `uq_report`도 같은 원리로 중복 신고를 차단한다.

### 4.4 M:N과 다형(polymorphic) 참조

- **태그(정통 M:N + 부가 테이블).** `COMMUNITY_POST ↔ COMMUNITY_TAG`를 `COMMUNITY_POST_TAG` 연결 테이블로 잇고, 함께 쓰인 태그 쌍은 `COMMUNITY_TAG_RELATION(tag_id_a, tag_id_b, co_count)`에 공출현 횟수로 누적한다(연관 태그 추천용).
- **신고·알림(다형 참조).** `REPORT.target_type`(`POST`/`COMMENT`/`REPLY`/`USER`) + `target_id`, `MYPAGE_FEED_NOTIFICATION.source_type` + `source_id`처럼 **FK 없이 "유형 + ID" 쌍**으로 여러 테이블을 가리킨다. DB FK로는 무결성을 강제하지 못해 애플리케이션이 책임진다(유연성 ↔ 무결성 트레이드오프).

### 4.5 여행 코스의 순서 무결성

`plan_spot`은 같은 계획·같은 날짜 안에서 방문 순서가 겹치지 않도록 복합 UNIQUE를 건다.

```sql
CREATE TABLE plan_spot (
  plan_spot_id bigint AUTO_INCREMENT PRIMARY KEY,
  plan_id  bigint NOT NULL,      -- FK → TRAVEL_PLAN (ON DELETE CASCADE)
  spot_id  varchar(255),         -- FK → SPOT_TRAVEL
  visit_date  date,
  visit_order int NOT NULL,
  UNIQUE KEY uq_plan_spot_order (plan_id, visit_date, visit_order)
);
```

### 4.6 챗봇 2계층 + 쿼터

대화방(`CHAT_POST`/`CHATBOT_CONVERSATION`)과 메시지(`CHAT_COMMENT`/`CHATBOT_MESSAGE`)를 분리해 멀티턴을 저장하고, `CHATBOT_GRADE_QUOTA`(등급별 한도) + `CHATBOT_DAILY_USAGE`(주기별 사용량 집계, `UNIQUE(user_idx, period_start)`)로 호출량을 제어한다. 사용자 메시지의 독성 판정 결과는 `ADMIN_ASSISTANT_MODERATION`에 `toxicity_score`(0.000~1.000)로 따로 적재된다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: 위 모든 테이블이 실제 스키마에 존재하고 데이터가 적재돼 동작한다. 소프트 삭제(상태/플래그), 캐시 카운트, FK의 `RESTRICT`/`CASCADE`/`SET NULL` 분기, 복합 UNIQUE(좋아요·신고·스팟 순서), 이력 테이블(`*_HISTORY`/`*_AUDIT`), 정책 테이블의 DB화, 수동 마이그레이션 이력(`SCHEMA_MIGRATION_HISTORY`)까지 구현됨.
- **부분/주의**: 캐시 카운트는 트랜잭션 경합 시 어긋날 수 있어 reconcile 스케줄러로 보정한다(완전 실시간 정합이 아니라 사후 보정). 다형 참조(`REPORT`/알림)는 DB FK가 없어 무결성을 애플리케이션이 책임진다.
- **계획/한계**: 자동화된 스키마 마이그레이션 도구(Flyway/Liquibase) 대신 **수동 SQL 패치 + 이력 테이블**을 쓴다. 소프트 삭제 누적분의 주기적 hard delete(보존기간 경과 처리)는 향후 과제(ADR-0008 TODO). 일부 테이블명이 대문자(`USERS`)와 소문자(`plan_spot`)로 섞여 있어 표기 일관성은 정리 대상.

## 6. 면접 답변 3단계

1. **한 문장**: "MySQL 8 단일 스키마이고, 모든 사용자 활동이 `USERS.user_idx`를 FK로 모이며, 콘텐츠 삭제는 row를 지우지 않고 상태 컬럼에 `DELETED`로 표시하는 소프트 삭제 구조입니다."
2. **설계 의도**: "신고·감사 컨텍스트를 보존해야 해서 소프트 삭제를 택했고, 목록 성능을 위해 `like_count`/`comment_count` 같은 캐시 카운트를 두되 어긋나면 reconcile로 맞춥니다. FK의 `ON DELETE`는 도메인 의도에 따라 보존 대상은 `RESTRICT`, 종속 자식은 `CASCADE`, 감사 로그는 `SET NULL`로 나눴습니다."
3. **구체 근거**: "예를 들어 `COMMUNITY_POST.user_idx`는 `RESTRICT`라 콘텐츠가 있는 회원은 물리 삭제가 막히고 `account_status='DELETED'`로만 처리됩니다. `plan_spot`은 `(plan_id, visit_date, visit_order)` 복합 UNIQUE로 같은 날 순서 중복을 막고, `REPORT`는 `(user_idx, target_type, target_id)` UNIQUE로 중복 신고를 DB에서 차단합니다."

## 7. 꼬리질문 + 모범답안

:::details 왜 hard delete가 아니라 소프트 삭제를 썼나요?
세 가지 이유입니다. (1) 신고된 글을 작성자가 지워도 관리자 판단 큐에 컨텍스트가 남아야 합니다. (2) 사용자 실수나 오삭제를 관리자가 `status='ACTIVE'`로 되돌릴 수 있어야 합니다. (3) 글에 댓글이 FK로 달려 있어 물리 삭제 시 연쇄·정합 문제가 생깁니다. 그래서 이미 있던 `post_status`/`comment_status` 상태머신에 `DELETED` 값을 추가하는 방식(ADR-0008)을 골랐고, `deleted_at` 별도 컬럼은 기존 `BLOCKED`와 표현이 중복돼 채택하지 않았습니다.
:::

:::details 소프트 삭제의 단점과 그 대응은?
모든 목록 쿼리에 `WHERE status='ACTIVE'`를 빠뜨리면 삭제 콘텐츠가 노출됩니다. 그래서 표준 필터를 매퍼 XML에 못 박고, status 컬럼을 인덱스에 포함시킵니다(`idx_cpd_status`). 디스크는 계속 늘기 때문에 보존기간 경과분을 주기적으로 hard delete하는 정책이 향후 과제로 남아 있습니다. 또 캐시 카운트가 DELETED를 제외하도록 맞춰야 표시 숫자가 일치합니다.
:::

:::details 캐시 카운트(`like_count`/`comment_count`)는 어떻게 틀어지고, 어떻게 맞추나요?
INSERT/DELETE와 카운트 증감이 별개 UPDATE라, 동시성·예외·중간 실패에서 어긋날 수 있습니다. 1차로 좋아요는 `(post_id, user_idx)` UNIQUE로 중복 자체를 막고, 2차로 reconcile 스케줄러가 `COUNT(*) WHERE status <> 'DELETED'`로 실제 값을 다시 계산해 덮어씁니다(ADR-0006). 즉 실시간 정확성이 아니라 "빠른 근사 + 사후 보정" 전략입니다.
:::

:::details FK의 ON DELETE를 왜 통일하지 않았나요?
삭제 의도가 엔티티마다 달라서입니다. 회원·게시글처럼 보존이 중요한 건 `RESTRICT`로 물리 삭제를 아예 막고 소프트 삭제로만 처리합니다. 여행 계획-스팟, 게시글-첨부, 부모-대댓글처럼 자식이 부모에 완전히 종속되면 `CASCADE`로 같이 정리합니다. 감사 로그(`ADMIN_ACTION_AUDIT`)·번역 이력은 행위자가 사라져도 기록은 남아야 하므로 `SET NULL`입니다. 하나로 통일하면 이 중 하나는 반드시 잘못됩니다.
:::

:::details `REPORT.target_type`/`target_id`처럼 FK 없는 다형 참조는 위험하지 않나요?
맞습니다. 한 컬럼이 게시글·댓글·유저를 번갈아 가리키므로 DB FK로 참조 무결성을 강제할 수 없습니다. 트레이드오프를 받아들인 선택입니다. 신고·알림은 여러 도메인을 한 테이블로 받아야 해서 유형+ID 쌍이 더 단순했고, 대신 무결성 검증과 대상 조회는 애플리케이션(서비스 계층)이 책임집니다. 무결성이 더 중요한 곳(좋아요·태그)은 진짜 FK + UNIQUE로 묶었습니다.
:::

:::details 운영 정책을 코드 상수가 아니라 테이블에 둔 이유는?
재배포 없이 운영값을 바꾸기 위해서입니다. 챗봇 등급 쿼터(`CHATBOT_GRADE_QUOTA`), 보상 정책(`POINT_REWARD_POLICY`), 검열 민감도(`CONTENT_MODERATION_POLICY`), 일반 런타임 설정(`APPLICATION_RUNTIME_SETTING`)을 DB에 두면 관리자가 화면에서 즉시 조정할 수 있고, 변경은 `*_HISTORY`/감사 테이블에 남아 추적됩니다. 시크릿 값은 `is_secret` 플래그로 표시해 노출을 제한합니다(→ [런타임 설정](/backend/runtime-settings)).
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 답해보고, 막히면 위 절을 다시 본다.

1. 회원 한 명을 지운다고 할 때, `COMMUNITY_POST`·`TRAVEL_PLAN`·`ADMIN_ACTION_AUDIT`에서 각각 무슨 일이 일어나며 왜 다르게 동작하는가?
2. 일반 사용자 목록, 관리자 목록, 신고 판단 큐는 `post_status`를 각각 어떻게 필터링하는가?
3. 좋아요 1인 1회와 중복 신고 차단을 DB에서 보장하는 제약은 각각 무엇인가?
4. 캐시 카운트가 어긋나는 시나리오 하나와, 그걸 맞추는 방법을 설명해보라.
5. `REPORT`의 다형 참조가 진짜 FK가 아닌 이유와, 그 대가는 무엇인가?

관련 페이지: [MyBatis](/backend/mybatis) · [런타임 설정](/backend/runtime-settings) · [소프트 삭제 용어](/glossary/soft-delete) · [커뮤니티 데이터 모델](/community/data-model) · [전체 데이터 모델](/flow/data-model) · 허브: [도메인 전체 개요](/domains) · [전체 흐름](/flow/) · [담당별 보기](/by-area/)

## 퀴즈

<QuizBox question="TripTogether에서 게시글을 '삭제'할 때 기본 동작은?" :choices="['DELETE FROM COMMUNITY_POST 로 row를 물리 삭제한다', 'post_status 컬럼을 DELETED 로 UPDATE 하고 row는 보존한다', '별도 아카이브 테이블로 INSERT 후 원본을 DELETE 한다', 'deleted_at 타임스탬프만 기록하고 status는 건드리지 않는다']" :answer="1" explanation="ADR-0008의 소프트 삭제 결정에 따라 row를 지우지 않고 post_status(또는 comment_status/account_status)에 DELETED를 마킹한다. 신고·감사 컨텍스트 보존과 복구 가능성을 위해서이며, 이미 있던 BLOCKED 상태머신 컬럼을 재사용하므로 별도 deleted_at은 채택하지 않았다." />

<QuizBox question="콘텐츠가 있는 회원의 USERS row가 물리 삭제되는 것을 막는 메커니즘으로 가장 정확한 것은?" :choices="['COMMUNITY_POST.user_idx FK의 ON DELETE RESTRICT', 'TRAVEL_PLAN.user_idx FK의 ON DELETE CASCADE', 'REPORT의 target_type 다형 참조', 'like_count 캐시 컬럼']" :answer="0" explanation="COMMUNITY_POST.user_idx → USERS 는 ON DELETE RESTRICT 라, 게시글이 남아 있는 회원 row의 물리 삭제가 차단된다. 따라서 회원은 account_status='DELETED' 소프트 삭제로만 처리된다. 반대로 TRAVEL_PLAN.user_idx 는 CASCADE, 감사 로그는 SET NULL 로 의도에 따라 다르게 잡혀 있다." />

<QuizBox question="plan_spot 테이블의 UNIQUE KEY (plan_id, visit_date, visit_order)가 보장하는 것은?" :choices="['한 사용자가 같은 스팟을 두 번 찜하지 못하게 한다', '같은 여행 계획의 같은 날짜 안에서 방문 순서 번호가 중복되지 않게 한다', '여행 계획을 공개로만 만들 수 있게 한다', '좋아요 중복을 막는다']" :answer="1" explanation="복합 UNIQUE (plan_id, visit_date, visit_order)는 동일 계획·동일 날짜 안에서 visit_order가 겹치지 않도록 보장해 일정 순서 무결성을 지킨다. 좋아요 1인 1회는 COMMUNITY_POST_LIKE(post_id, user_idx) UNIQUE, 중복 신고 차단은 REPORT(user_idx, target_type, target_id) UNIQUE가 담당한다." />
