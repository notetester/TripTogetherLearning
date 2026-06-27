# 데이터 모델 전체

> 약 120여 개 테이블이 회원을 중심으로 도메인별 군집을 이루고, 소프트 삭제 상태 컬럼과 USERS 참조 FK, 감사 이력 테이블이라는 세 가지 공통 규칙으로 일관되게 묶인다.

## 1. 한 줄 정의

TripTogether의 데이터 모델은 **단일 회원 테이블 USERS를 허브로 삼아 14~15개 도메인이 각자의 테이블군을 가지는 MySQL 스키마**다. 모든 도메인은 물리 삭제 대신 상태 컬럼으로 소프트 삭제하고, 운영성 변경은 별도 이력 테이블에 감사 기록을 남긴다.

## 2. 왜 이렇게 설계했나

- **회원 중심(USERS 허브):** 핵심 단위가 사용자다. 게시글, 코스, 문의, 지갑, 신고, 권한 등 거의 모든 테이블이 `user_idx`(BIGINT, AUTO_INCREMENT PK)를 FK로 참조한다. 사용자 한 명의 활동을 가로질러 조회하는 회원 360 뷰가 자연스럽게 가능해진다.
- **소프트 삭제 우선(ADR-0008):** 신고, 통계, 감사 추적 때문에 데이터를 물리적으로 지우면 안 되는 경우가 많다. 그래서 도메인마다 상태 컬럼(`post_status`, `comment_status`, `account_status`, `is_deleted`, `spot_active`)을 두고 값만 바꾼다.
- **감사 우선:** 관리자/운영 행위는 되돌리거나 책임을 추적할 수 있어야 한다. 그래서 설정, 권한, 급여, 정책 변경마다 `*_HISTORY` 또는 `*_AUDIT` 테이블이 짝으로 존재한다.
- **MyBatis 친화:** JPA가 아니라 MyBatis(`@Mapper` + XML)를 쓰므로, 복잡한 다중 도메인 조인과 캐시 컬럼(`like_count`, `comment_count`)을 SQL에서 직접 통제하기 쉽게 정규화와 비정규화를 섞었다.

## 3. 어떤 기술로 구현했나(실제 테이블)

DB는 MySQL, 매핑은 MyBatis(`resources/mapper/*.xml`), 자바 쪽은 도메인별 `vo` 객체다. 도메인별 대표 테이블군은 다음과 같다.

| 도메인 | 대표 테이블 | 핵심 상태/특이 컬럼 |
| --- | --- | --- |
| 회원/인증 | `USERS`, `USER_SOCIAL`, `EMAIL_VERIFICATION` | `account_status`, `member_grade`, `level_no`, `exp_points` |
| 커뮤니티 | `COMMUNITY_POST`, `COMMUNITY_COMMENT`, `COMMUNITY_POST_LIKE`, `COMMUNITY_TAG` 계열 | `post_status`, `comment_status`, `parent_comment_id`, `like_count` 캐시 |
| 코스 | `TRAVEL_PLAN`, `plan_spot` | `plan_source`(MANUAL/AI), `is_public`, `visit_order`, `is_deleted` |
| 탐색 | `SPOT_TRAVEL`, `SPOT_REVIEW`, `SPOT_FAVORITE`, `SPOT_RECOMMEND`, `SPOT_VIEW_LOG` | `spot_active`, `rating_avg`/`review_count` 캐시 |
| 문의 | `INQUIRY_POST`, `INQUIRY_ANSWER`, `INQUIRY_ANSWER_HISTORY`, `INQUIRY_ATTACHMENT` | `status`(PENDING/IN_PROGRESS/COMPLETED) |
| 챗봇/도우미 | `CHATBOT_CONVERSATION`, `CHATBOT_MESSAGE`, `CHAT_POST`, `CHAT_COMMENT` | `is_deleted`, `is_inappropriate` |
| 신고/모더레이션 | `REPORT`, `ADMIN_ASSISTANT_MODERATION` | `target_type`/`target_id`, `source_type`/`source_id` |
| 지갑/리워드 | `USER_WALLET_HISTORY`, `USER_POINT_HISTORY`, `USER_PAYMENT_HISTORY`, `POINT_SHOP_ITEM` | `asset_type`(CASH/MILEAGE), `change_type` |
| 관리자/운영 | `ADMIN_ACTION_AUDIT`, `APPLICATION_RUNTIME_SETTING`, `ADMIN_PERMISSION`, `IP_BLOCKLIST` | `action_type`/`domain`/`actor`, `is_secret` |

:::tip 잔액은 어디에 사는가
회원의 3원 지갑 잔액(`cash_balance`, `mileage_balance`, `point_balance`)은 USERS에 캐시되어 있고, 변동 한 건 한 건은 `USER_WALLET_HISTORY`(`balance_after`로 시점 잔액 보존)에 적재된다. 현재값은 빠르게, 흐름은 추적 가능하게 라는 의도다.
:::

## 4. 동작 원리(흐름·표·작은 코드)

### 4-1. USERS 허브와 FK 참조 정책

FK는 무조건 CASCADE가 아니다. 데이터 의미에 따라 삭제 정책을 다르게 건다.

| 참조 관계 | ON DELETE | 의도 |
| --- | --- | --- |
| `COMMUNITY_POST.user_idx → USERS` | RESTRICT | 글 쓴 회원을 함부로 못 지우게 막아 데이터 무결성 보호 |
| `plan_spot.plan_id → TRAVEL_PLAN` | CASCADE | 코스가 사라지면 하위 스팟도 함께 정리 |
| `COMMUNITY_COMMENT.parent_comment_id → 자기 자신` | CASCADE | 부모 댓글 삭제 시 대댓글 트리 정리 |
| `ADMIN_ACTION_AUDIT.actor_user_idx → USERS` | SET NULL | 행위자가 빠져도 감사 기록 자체는 보존 |
| `USER_WALLET_HISTORY.user_idx → USERS` | RESTRICT | 금전 이력은 회원 삭제로 사라지면 안 됨 |

핵심 패턴: **콘텐츠/금전 = RESTRICT(보존), 종속 하위행 = CASCADE(정리), 감사/행위자 = SET NULL(기록 유지)**.

### 4-2. 소프트 삭제 상태 컬럼 규약

도메인마다 컬럼 이름은 다르지만 의미는 같다. 조회 쿼리는 항상 활성 상태만 거른다.

```sql
-- 게시글 목록: 삭제/차단된 글 제외
WHERE post_status = ACTIVE

-- 댓글 목록: 삭제 댓글 제외
WHERE comment_status != DELETED

-- 코스 피드: 소프트 삭제 제외 + 공개만
WHERE is_deleted = 0 AND is_public = 1
```

상태값 예시: 게시글은 ACTIVE/BLOCKED/DELETED, 댓글은 ACTIVE/DELETED, 계정은 ACTIVE/DORMANT/BLOCKED/DELETED, 문의는 PENDING/IN_PROGRESS/COMPLETED.

### 4-3. 다형 참조(신고가 여러 대상을 가리키는 법)

신고는 게시글, 댓글, 유저 어느 것이든 대상이 될 수 있다. 그래서 **(타입, ID) 쌍으로 가리키는 다형 참조**를 쓴다. DB FK로는 못 묶으므로 애플리케이션이 무결성을 책임진다.

```text
REPORT.target_type = POST | COMMENT | REPLY | USER
REPORT.target_id   = 대상의 PK
REPORT.source_type = COMMUNITY | INQUIRY ...   (출처 모듈)
REPORT.source_id   = 컨텍스트 ID (예: 댓글이 속한 글 ID)
```

같은 패턴이 `MYPAGE_FEED_NOTIFICATION`(`source_type`/`source_id` + `target_url`)과 번역 테이블(`source_type`/`source_idx`/`field_name`)에도 반복된다.

### 4-4. 감사·이력의 짝 패턴

운영 데이터는 본체 테이블과 이력 테이블이 한 쌍을 이룬다.

| 본체 | 이력/감사 | 무엇을 남기나 |
| --- | --- | --- |
| `APPLICATION_RUNTIME_SETTING` | `APPLICATION_RUNTIME_SETTING_HISTORY` | 설정값 변경 + `actor_user_idx` |
| `INQUIRY_ANSWER` | `INQUIRY_ANSWER_HISTORY` | 답변 수정 이력 |
| `TRAVEL_PACKAGE` | `TRAVEL_PACKAGE_REVISION` | 패키지 승인 전후 버전 |
| (모든 관리자 행위) | `ADMIN_ACTION_AUDIT` | `action_type`/`domain`/`actor`/`target`/`reason_code` |

## 5. 구현 상태(됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 도메인별 테이블군·FK·소프트 삭제·감사 이력 | 구현됨. 실제 스키마(`TripTogetherDB.sql`)에 반영 |
| 3원 지갑(캐시/마일리지/포인트)·이력 적재 | 구현됨 |
| 캐시 컬럼(`like_count`, `comment_count`, `rating_avg`) | 구현됨. 애플리케이션이 동기화 책임 |
| 항공권 구매 시뮬레이션 `FLIGHT_PURCHASE_SIMULATION` | Mock 프로바이더 기반(실제 외부 항공 API 미연동) |
| 챗봇 다형 대화 저장(회원/익명 XOR) | 구현됨(`user_idx`와 익명 세션 식별자 둘 중 하나) |
| ERD 자동 문서/마이그레이션 자동화 | 부분(수동 SQL + `SCHEMA_MIGRATION_HISTORY`). 전용 마이그레이션 툴은 향후 과제 |

:::warning DB FK가 막아주지 않는 무결성
다형 참조(`REPORT`, 알림, 번역)는 외래키 제약을 걸 수 없다. 대상이 실제로 존재하는지, 삭제된 대상을 가리키지 않는지는 **서비스 계층이 검증**해야 한다. 면접에서 이 트레이드오프를 짚으면 좋다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** TripTogether 데이터 모델은 회원 USERS를 허브로 14~15개 도메인이 테이블군을 이루고, 소프트 삭제 상태 컬럼과 감사 이력 테이블을 전 도메인 공통 규칙으로 씁니다.
2. **왜:** 신고와 통계 때문에 데이터를 물리 삭제하면 안 되고(ADR-0008), 운영 행위는 추적 가능해야 해서 본체와 이력 테이블을 짝으로 뒀습니다. FK 삭제 정책은 콘텐츠는 RESTRICT, 하위행은 CASCADE, 감사 행위자는 SET NULL로 구분했습니다.
3. **트레이드오프:** 신고나 알림처럼 여러 대상을 가리키는 다형 참조는 FK로 못 묶어서 서비스 계층이 무결성을 책임지고, 잔액 같은 값은 USERS에 캐시하고 변동은 이력 테이블로 보존하는 식으로 조회 속도와 추적성을 동시에 잡았습니다.

## 7. 꼬리질문+모범답안

:::details 모든 FK를 ON DELETE CASCADE로 통일하지 않은 이유는?
삭제 의미가 도메인마다 다르기 때문입니다. 게시글이나 지갑 이력은 회원이 사라져도 보존해야 하므로 RESTRICT로 회원 삭제 자체를 막고, 코스의 plan_spot처럼 본질적으로 종속된 하위행은 CASCADE로 함께 정리합니다. 감사 로그의 행위자는 SET NULL로 기록만 남깁니다. CASCADE로 통일하면 연쇄 삭제로 감사 추적과 통계가 무너집니다.
:::

:::details 좋아요 수를 COMMUNITY_POST_LIKE를 매번 COUNT하지 않고 like_count로 캐시한 이유는?
목록 화면에서 글마다 좋아요를 실시간 집계하면 N+1 카운트 쿼리가 발생합니다. 그래서 COMMUNITY_POST.like_count에 캐시하고, 좋아요 추가/취소 시점에만 증감합니다. 대가는 캐시와 실제 행 수가 어긋날 수 있다는 점이라, 증감 로직을 한 트랜잭션에 묶어 일관성을 유지합니다.
:::

:::details 신고 REPORT가 게시글과 댓글을 동시에 가리킬 수 있는데 FK 없이 어떻게 무결성을 지키나요?
target_type과 target_id 두 컬럼으로 가리키는 다형 참조라 DB 외래키를 걸 수 없습니다. 그래서 서비스 계층에서 신고 접수 시 대상 존재 여부를 확인하고, 같은 신고자의 중복 신고를 막으며, 상태머신으로 IN_REVIEW에서 RESOLVED 또는 DISMISSED로만 전이하도록 통제합니다. 무결성 책임이 DB에서 애플리케이션으로 이동한 형태입니다.
:::

:::details 회원의 잔액을 USERS에 두는데 변동 이력 테이블도 따로 둔 이유는?
현재 잔액은 결제나 화면에서 자주 읽으므로 USERS.cash_balance처럼 캐시해 빠르게 조회합니다. 동시에 모든 변동을 USER_WALLET_HISTORY에 change_type과 balance_after로 적재해, 정산과 환불 추적, 분쟁 대응이 가능하게 합니다. 빠른 현재값과 추적 가능한 흐름을 둘 다 만족시키는 절충입니다.
:::

:::details 설정이나 권한 같은 운영 테이블마다 HISTORY 테이블을 둔 이유는?
런타임 설정이나 권한은 운영자가 바꾸는 민감한 값이라 누가 언제 무엇을 바꿨는지 되짚을 수 있어야 합니다. 그래서 본체 테이블 옆에 *_HISTORY 또는 ADMIN_ACTION_AUDIT을 두고 actor와 변경 전후, 사유 코드를 남깁니다. 사고 대응과 권한 오남용 감사의 근거가 됩니다.
:::

## 8. 직접 말해보기

- USERS를 허브라고 부르는 이유를 FK 참조 예시 두 개로 설명해 보세요.
- post_status, comment_status, account_status가 다른 컬럼인데 같은 설계 의도를 공유한다는 점을 설명해 보세요.
- REPORT의 target_type/target_id가 왜 FK가 아니라 다형 참조인지, 그 대가는 무엇인지 말해 보세요.
- 잔액 캐시(USERS)와 변동 이력(USER_WALLET_HISTORY)의 역할 분담을 한 문장으로 요약해 보세요.

더 보기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [전체 아키텍처](/flow/architecture)

## 퀴즈

<QuizBox question="TripTogether 데이터 모델에서 거의 모든 도메인 테이블이 공통으로 참조하는 허브 테이블은?" :choices="['COMMUNITY_POST', 'USERS', 'TRAVEL_PLAN', 'REPORT']" :answer="1" explanation="회원 PK인 user_idx를 게시글 코스 문의 지갑 신고 권한 등 대부분의 테이블이 FK로 참조한다. 회원을 중심으로 활동을 가로질러 조회하는 회원 360 뷰가 이 구조에서 나온다." />

<QuizBox question="이 스키마의 FK 삭제 정책에 대한 설명으로 가장 옳은 것은?" :choices="['모든 FK가 ON DELETE CASCADE로 통일되어 있다', '콘텐츠와 금전 이력은 RESTRICT로 보존하고 종속 하위행은 CASCADE로 정리하며 감사 행위자는 SET NULL로 기록을 남긴다', '모든 FK가 RESTRICT라 어떤 행도 삭제할 수 없다', 'FK 제약을 전혀 쓰지 않고 애플리케이션이 전부 처리한다']" :answer="1" explanation="삭제 의미에 따라 정책을 나눈다. 게시글과 지갑 이력은 RESTRICT, 코스의 plan_spot 같은 종속행은 CASCADE, 감사 로그의 actor는 SET NULL이다." />

<QuizBox question="REPORT 테이블이 게시글 댓글 유저를 모두 가리킬 수 있도록 쓰는 설계 기법과 그 대가로 옳은 것은?" :choices="['단일 FK로 묶어 DB가 무결성을 보장한다', 'target_type과 target_id 다형 참조를 쓰며 FK를 못 거는 대신 서비스 계층이 무결성을 책임진다', '대상마다 별도 신고 테이블을 만들어 조인으로 합친다', '트리거로 모든 무결성을 DB에서 강제한다']" :answer="1" explanation="다형 참조는 타입과 ID 쌍으로 여러 대상을 가리킨다. DB FK로 묶을 수 없으므로 대상 존재 확인과 중복 방지 같은 무결성은 애플리케이션이 담당한다." />
