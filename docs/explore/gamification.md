---
title: "게이미피케이션"
owner: C
domain: "여행지 탐색·커머스"
tags: ["포인트", "레벨"]
---

# 게이미피케이션 (포인트·경험치·레벨·상점)

> 글·댓글·리뷰·결제 같은 활동을 포인트와 경험치로 환산해 자동 지급하고, 누적 경험치로 레벨을 자동 승급하며, 모인 포인트로 프로필 꾸미기 아이템을 사는 보상 루프.

## 1. 한 줄 정의

게이미피케이션은 사용자의 정상 활동(커뮤니티 글·댓글, 여행지 리뷰, 캐시 충전 결제 등)을 정책 기반으로 포인트와 경험치로 환산해 지급하고, 누적 경험치가 임계치를 넘으면 레벨을 올리며, 모은 포인트로 포인트 상점에서 닉네임 색·뱃지 같은 꾸미기 아이템을 구매·장착하게 하는 보상 시스템이다.

## 2. 왜 이렇게 설계했나

핵심 설계 결정은 보상 규칙을 코드가 아니라 DB 정책 테이블에 둔 것이다.

- **정책 외부화**: 어떤 행동에 몇 포인트·몇 경험치를 줄지를 `POINT_REWARD_POLICY` / `EXP_REWARD_POLICY` 행으로 관리한다. 배포 없이 관리자가 값을 바꾸면 즉시 반영된다.
- **레벨 공식의 분리**: 레벨 임계치는 하드코딩한 표가 아니라 `EXP_LEVEL_POLICY`의 성장 공식(QUADRATIC / EXPONENTIAL / HYBRID)으로 계산한다. 특정 레벨만 손봐야 할 때는 `EXP_LEVEL_OVERRIDE`로 그 레벨의 필요 누적 경험치를 수동 지정해 공식보다 우선시킨다.
- **중복 지급 방지**: 같은 글을 두 번 저장하거나 재시도가 발생해도 보상이 중복으로 나가면 안 된다. 그래서 지급 전에 항상 이력 테이블(`USER_POINT_HISTORY`, `USER_EXP_HISTORY`)을 (reward_code, source_id)로 조회해 이미 준 적이 있으면 건너뛴다.
- **원장(ledger) 방식**: 잔액만 갱신하지 않고 모든 변동을 이력 행으로 남긴다. 잔액은 캐시이고 이력이 진실의 원천이라, 사후 감사·환불·재계산이 가능하다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

지급 엔진은 단일 진입점 `RewardServiceImpl.awardAction(...)`이다. 각 도메인 서비스가 활동을 마친 뒤 이 메서드를 호출한다.

| 구분 | 테이블 / 클래스 | 역할 |
| --- | --- | --- |
| 지급 진입점 | `RewardServiceImpl#awardAction` | 포인트·경험치 동시 지급, 레벨 재계산 |
| 포인트 지급 정책 | `POINT_REWARD_POLICY` | reward_code별 FIXED / PER_AMOUNT 값 |
| 경험치 지급 정책 | `EXP_REWARD_POLICY` | reward_code별 경험치 값 |
| 레벨 성장 공식 | `EXP_LEVEL_POLICY` | policy_mode + 계수로 누적 경험치 임계치 |
| 레벨 수동 보정 | `EXP_LEVEL_OVERRIDE` | 특정 레벨의 필요 누적 경험치 강제 |
| 레벨업 보상 | `LEVEL_UP_REWARD_POLICY` | 레벨 도달 시 POINT / MILEAGE / CASH / ITEM |
| 포인트 이력 | `USER_POINT_HISTORY` | EARN / USE / REFUND, balance_after |
| 경험치 이력 | `USER_EXP_HISTORY` | exp_amount, level_after, exp_after |
| 레벨업 수령 이력 | `USER_LEVEL_UP_REWARD_HISTORY` | 정책별 1회 지급 보장 |
| 상점 | `ShopServiceImpl`, `POINT_SHOP_ITEM` | 아이템 구매·장착 |
| 보유 / 장착 | `USER_POINT_ITEM_INVENTORY`, `USER_POINT_ITEM_EQUIP` | 인벤토리, 슬롯별 장착 |

활동을 보상으로 부르는 호출부(reward_code)는 다음과 같다.

- `CommunityServiceImpl`: 게시글 작성 시 COMMUNITY_POST, 댓글 작성 시 COMMUNITY_COMMENT
- `ExploreServiceImpl`: 여행지 리뷰 등에서 SPOT_REVIEW 계열
- `WalletServiceImpl`: 캐시 충전 결제 시 PAYMENT (충전액을 amountBasis로 전달)

## 4. 동작 원리 (흐름·표·작은 코드)

`awardAction(userIdx, rewardCode, sourceId, amountBasis, detailMessage)` 한 번의 처리 흐름:

```text
1. 사용자 행을 selectUserByIdxForUpdate 로 잠금 (동시성 보호)
2. reward_code 로 포인트·경험치 정책 각각 조회
3. (userIdx, rewardCode, sourceId) 이력 카운트 → 이미 지급이면 스킵
4. 금액 계산
     FIXED      → reward_value 그대로
     PER_AMOUNT → (amountBasis / unit_amount) * reward_value
5. 포인트 잔액·경험치 가산, 경험치로 새 레벨 resolveLevel 재계산
6. 레벨이 올랐으면 구간 전체의 레벨업 보상 지급 (중복 방지)
7. 사용자 잔액·레벨 한 번에 update + 이력 행 insert
8. 레벨업 시 알림(FeedNotification) 푸시
```

전체가 `@Transactional`이라 잔액 갱신과 이력 저장이 한 트랜잭션으로 묶인다. 한쪽만 반영되는 상태는 생기지 않는다.

레벨 계산은 누적 경험치를 레벨 2부터 위로 훑으며 임계치를 넘는 가장 높은 레벨을 찾는다. 임계치는 오버라이드가 있으면 그 값을, 없으면 공식을 쓴다.

| policy_mode | 누적 경험치 임계치 공식 (step = L - 1) |
| --- | --- |
| QUADRATIC | a·step^2 + b·step + c |
| EXPONENTIAL | base · rate^step |
| HYBRID | 전환 레벨 전은 2차식, 이후는 지수식 |

레벨업 보상은 9에서 12처럼 한 번에 여러 레벨이 오르는 경우까지 고려해 prev~next 구간의 모든 활성 정책을 처리하고, `USER_LEVEL_UP_REWARD_HISTORY`의 (user, policy) 유니크 제약으로 정책당 1회만 지급한다. ITEM 보상은 인벤토리에 적립되고, POINT / MILEAGE / CASH는 해당 지갑 잔액에 누적된다.

상점 구매(`ShopServiceImpl#purchaseItem`)는 사용자 행과 아이템 행을 잠근 뒤 포인트 잔액을 검사하고, 부족하면 거절한다. 성공 시 포인트 차감(USE 이력), 구매 이력, 인벤토리 적립이 한 트랜잭션으로 처리된다. 장착(`equipItem`)은 item_type을 NICKNAME_COLOR / NICKNAME_EFFECT / PROFILE_BADGE / BUBBLE_STYLE 슬롯으로 매핑하고, 슬롯당 1개만 장착되도록 (user, slot) 유니크 제약을 둔다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 행동별 포인트·경험치 자동 지급, (reward_code, source_id) 기반 중복 방지
- 정책 기반 레벨 자동 승급(QUADRATIC / EXPONENTIAL / HYBRID + 오버라이드)
- 다단계 레벨업 구간 일괄 보상, 정책당 1회 지급 보장
- 포인트 상점 구매·인벤토리·슬롯 장착, 포인트 잔액 검증
- 레벨업 알림 푸시, 정책 변경 후 전체 회원 레벨 재동기화(synchronizeUserLevels), 소급 지급(grantMissingLevelUpRewards)
:::

:::warning 한계·주의
- 잔액(point_balance, exp_points 등)은 USERS 테이블의 캐시 컬럼이다. 진실의 원천은 이력 테이블이며, 캐시가 어긋나면 재동기화 메서드로 맞춘다.
- PAYMENT 보상은 실제 결제(Toss) 충전 흐름과 연동되지만, 외부 항공권 등 일부 상위 도메인은 Mock이라 거기서 파생되는 보상도 그 한계를 따른다.
- 중복 방지는 source_id가 있을 때만 동작한다. source_id가 null이면 카운트 검사를 건너뛰므로, 1회성으로 가정되는 reward_code에만 null을 쓴다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: 사용자의 활동을 DB 정책 기준으로 포인트·경험치로 환산해 자동 지급하고, 누적 경험치로 레벨을 올리며 포인트로 꾸미기 아이템을 사게 하는 보상 루프를 만들었습니다.
2. **설계 의도**: 보상 값과 레벨 공식을 코드가 아니라 정책 테이블로 빼서 배포 없이 운영이 조정할 수 있게 했고, 모든 변동을 이력으로 남기는 원장 구조에 (reward_code, source_id) 중복 방지를 더해 재시도에도 이중 지급이 없게 했습니다.
3. **트레이드오프**: 잔액을 캐시로 들고 있어 조회는 빠르지만 이력과 어긋날 수 있어, 정책 변경 시 전체 회원 레벨·보상을 다시 맞추는 재동기화·소급 지급 경로를 별도로 두었습니다.

## 7. 꼬리질문 + 모범답안

:::details 같은 글에 보상이 두 번 나가지 않는다는 걸 어떻게 보장하나요
지급 전에 이력 테이블을 (userIdx, reward_code, source_id)로 카운트해 0이 아니면 건너뜁니다. 글 ID나 댓글 ID를 source_id로 쓰므로 같은 대상에는 한 번만 지급됩니다. 트랜잭션과 사용자 행 잠금으로 동시 호출도 막습니다.
:::

:::details 레벨 임계치를 표로 박지 않고 공식으로 둔 이유는
표를 박으면 레벨 상한을 넓히거나 곡선을 조정할 때마다 데이터 수정이 커집니다. EXP_LEVEL_POLICY의 2차식·지수식·혼합식 계수만 바꾸면 전 구간이 한 번에 바뀝니다. 특정 레벨만 예외로 두고 싶을 때는 EXP_LEVEL_OVERRIDE로 그 레벨만 강제 지정해 공식보다 우선시킵니다.
:::

:::details 9레벨에서 12레벨로 한 번에 뛰면 중간 레벨 보상은 어떻게 되나요
새 레벨을 다시 계산한 뒤 prev와 next 사이 구간의 모든 활성 레벨업 정책을 조회해 처리합니다. 각 정책은 USER_LEVEL_UP_REWARD_HISTORY의 user, policy 유니크로 1회만 지급되므로 건너뛴 레벨의 보상도 빠짐없이, 중복 없이 받습니다.
:::

:::details 포인트 잔액이 이력과 어긋나면 어떻게 복구하나요
잔액은 캐시이고 이력이 원장입니다. 레벨 쪽은 synchronizeUserLevels로 누적 경험치를 기준으로 전체 회원 레벨을 재계산하고, 뒤늦게 추가된 레벨업 정책은 grantMissingLevelUpRewards로 이력에 없는 보상만 골라 소급 지급합니다.
:::

:::details 상점에서 포인트가 부족한데 구매가 되는 경우는 없나요
purchaseItem이 사용자 행과 아이템 행을 잠근 상태에서 잔액과 가격을 비교해, 부족하면 예외로 거절합니다. 차감·구매 이력·인벤토리 적립이 한 트랜잭션이라 일부만 반영되는 상태도 없습니다. 중복 구매 불가 아이템은 보유 수량을 먼저 검사합니다.
:::

## 8. 직접 말해보기

- awardAction 한 번이 호출되면 어떤 순서로 무엇이 일어나는지 8단계로 설명해 보세요.
- FIXED 정책과 PER_AMOUNT 정책의 금액 계산 차이를, 결제 보상을 예로 설명해 보세요.
- 레벨 공식 3가지(QUADRATIC / EXPONENTIAL / HYBRID)와 오버라이드의 관계를 설명해 보세요.
- 포인트 상점 구매가 트랜잭션 안에서 어떤 정합성을 보장하는지 말해 보세요.

## 퀴즈

<QuizBox question="awardAction에서 같은 활동에 보상이 중복 지급되는 것을 막는 핵심 장치는 무엇인가?" :choices="['사용자 행을 잠그는 것만으로 충분하다', '지급 전에 이력 테이블을 reward_code와 source_id로 조회해 이미 있으면 건너뛴다', '관리자가 수동으로 매번 승인한다', '포인트 잔액이 음수가 되면 막는다']" :answer="1" explanation="포인트·경험치 이력 테이블을 userIdx, reward_code, source_id 조합으로 카운트해 이미 지급한 활동이면 건너뛴다. 행 잠금과 트랜잭션은 동시성 보호를 더할 뿐 중복 방지의 핵심은 이력 조회다." />

<QuizBox question="레벨 임계치를 결정하는 우선순위로 옳은 것은?" :choices="['항상 EXP_LEVEL_POLICY 공식만 사용한다', '해당 레벨에 EXP_LEVEL_OVERRIDE가 있으면 그 값을 쓰고 없으면 공식으로 계산한다', '포인트 잔액으로 레벨을 정한다', '레벨업 보상 정책 개수로 정한다']" :answer="1" explanation="getRequiredTotalExp는 먼저 오버라이드 맵을 확인해 해당 레벨이 있으면 그 누적 경험치를 우선 적용하고, 없을 때만 policy_mode 공식으로 계산한다." />

<QuizBox question="포인트 상점 구매 처리가 한 트랜잭션으로 보장하는 것이 아닌 것은?" :choices="['포인트 잔액 차감', '구매 이력 기록', '인벤토리 적립', '외부 항공권 실시간 발권']" :answer="3" explanation="purchaseItem은 잔액 차감, USE 포인트 이력, 구매 이력, 인벤토리 적립을 한 트랜잭션으로 처리한다. 항공권 발권은 게이미피케이션과 무관하며 해당 프로바이더는 Mock 상태다." />

---

더 보기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
