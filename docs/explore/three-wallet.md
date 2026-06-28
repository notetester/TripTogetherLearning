---
title: "3원 지갑"
owner: C
domain: "여행지 탐색·커머스"
tags: ["지갑"]
---

# 3원 지갑 (캐시 · 마일리지 · 포인트)

> 한 사용자가 세 종류의 자산을 동시에 들고 다닌다. 돈으로 충전하는 캐시, 결제로 적립되는 마일리지, 활동으로 쌓이는 포인트 — 각각 충전·차감 경로와 이력 테이블을 분리해 모든 잔액 변동을 추적 가능하게 만든 자산 시스템이다.

## 1. 한 줄 정의

3원 지갑은 사용자의 자산을 **현금성 캐시(CASH)·예약 보조 마일리지(MILEAGE)·활동 보상 포인트(POINT)** 세 갈래로 나누고, 잔액은 `USERS` 한 행에 캐시하면서 모든 변동을 별도 이력 테이블에 append-only로 기록하는 구조다.

## 2. 왜 이렇게 설계했나

세 자산은 성격이 완전히 달라서 한 통에 섞으면 정책이 충돌한다.

| 자산 | 들어오는 경로 | 쓰는 경로 | 성격 |
| --- | --- | --- | --- |
| 캐시 CASH | Toss 결제 충전 | 패키지·항공권 결제 | 실제 돈 1:1, 환불 audit 필요 |
| 마일리지 MILEAGE | 충전·결제 시 적립 | 결제 일부 상계 | 보조 통화, 사용 비율 상한 |
| 포인트 POINT | 글·댓글·레벨업 보상 | 포인트 상점 구매 | 비현금, 환불 대상 아님 |

- **현금 분리**: 캐시는 실제 돈이라 환불 audit(`WALLET_REFUND_LOG`)과 충전 한도(`WALLET_LIMIT_POLICY`)가 필요하다. 활동 보상 포인트와 같은 테이블에 두면 정책이 뒤섞인다.
- **잔액 캐시 + 이력 분리**: 매번 합산하면 느리므로 현재 잔액은 `USERS.cash_balance / mileage_balance / point_balance` 에 들고, 변동은 이력 테이블에 남겨 정합성을 사후 검증한다.
- **append-only 이력**: 모든 변동에 `balance_after`(변동 후 잔액)를 같이 적어, 특정 시점 잔액을 재계산 없이 읽고 분쟁 시 추적할 수 있다.

:::tip 캐시 자산이 아니라 이력이 source of truth
`USERS`의 잔액 컬럼은 빠른 조회용 캐시다. 진짜 기록은 이력 테이블이고, 잔액은 그 합과 일치해야 한다는 불변식을 코드가 지킨다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

핵심은 `myPage` 모듈의 지갑과 `reward` 모듈의 보상이 잔액을 공유하는 구조다.

**잔액과 이력 테이블**

- `USERS.cash_balance / mileage_balance / point_balance` — 현재 잔액 캐시 (bigint)
- `USER_WALLET_HISTORY` — 캐시·마일리지 변동 이력. `asset_type`(CASH/MILEAGE), `change_type`(CHARGE/USE/REFUND/EARN/ADJUST), `amount`, `balance_after`, `related_payment_idx`
- `USER_POINT_HISTORY` — 포인트 변동 이력(별도 테이블). `change_type`(EARN/USE/REFUND/ADJUST/EXPIRE), `source_type`, `balance_after`
- `USER_PAYMENT_HISTORY` — 결제 이력. `payment_method`(CASH/MILEAGE/CASH_MILEAGE/TOSS), `used_cash`, `used_mileage`, `earned_mileage`, `payment_status`(READY/COMPLETED/CANCELLED/REFUNDED)

**정책 테이블**

- `WALLET_LIMIT_POLICY` — 회원 등급별 충전 한도(1회/일/월), `single_limit/daily_limit/monthly_limit`
- `WALLET_REWARD_POLICY` — 이벤트별 적립률/고정량(`event_type`, `reward_type`=MILEAGE/POINT, `reward_rate`, `reward_fixed`)
- `WALLET_REFUND_LOG` — 어드민 환불 audit(`refund_amount`, `toss_cancel_status`, `refunded_by_user_idx`)

**서비스·매퍼 클래스**

- `WalletServiceImpl` (myPage) — 충전·잔액 갱신·등급 재계산
- `TossPaymentsClient` — Toss 승인 확인 호출(OkHttp)
- `WalletChargeLimitAspect` — 충전 한도를 AOP로 가로채 검증
- `RewardServiceImpl` (reward) — `awardAction`으로 포인트/마일리지 적립
- `TravelPackageServiceImpl` (travelPackage) — 캐시+마일리지 혼합 결제로 차감

:::warning 포인트는 지갑 이력에 없다
`USER_WALLET_HISTORY.asset_type`은 CASH/MILEAGE만 다룬다. 포인트 변동은 `USER_POINT_HISTORY`에 따로 기록된다. 세 자산이지만 이력 테이블은 둘로 나뉘어 있다는 점이 자주 묻는 포인트다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### Toss 충전 — READY 선저장 후 승인

세션이 끊겨도 콜백이 어떤 충전인지 찾도록, 결제창을 열기 전에 READY 주문을 먼저 DB에 박는다.

```text
1. prepareTossCharge   → orderId 발급, payment_status=READY 행 INSERT
2. (사용자가 Toss 결제창에서 승인)
3. completeTossCharge   → orderId로 행을 FOR UPDATE 잠금
   - 이미 COMPLETED면 중복 적립 없이 기존 결과 반환 (멱등)
   - TossPaymentsClient.confirmPayment로 금액·상태 재검증
   - READY → COMPLETED 갱신, 캐시 지급 + 마일리지 적립
```

핵심 부수효과는 `applyChargeSideEffects` 하나에 모여 있다.

```java
long newCashBalance    = user.getCashBalance() + chargeAmount;
long newMileageBalance = user.getMileageBalance() + earnedMileage; // finalAmount / 10
walletMapper.updateWalletBalances(userIdx, newCashBalance, newMileageBalance);
// CASH/CHARGE, MILEAGE/EARN 두 건을 balance_after와 함께 이력에 INSERT
// 이어서 회원 등급 재계산
```

충전 한도는 1,000원~1,000,000원, 100원 단위라는 기본 검증 위에, 등급별 일·월 한도를 `WalletChargeLimitAspect`가 별도로 막는다. 마일리지 적립은 충전 금액의 10%(`finalAmount / 10`)다.

### 혼합 결제 — 캐시 + 마일리지 상계

패키지 예약은 마일리지로 일부를 상계하고 나머지를 캐시로 낸다.

```text
maxMileageUse = floor(totalPrice * 30% , 1000원)   // 마일리지 사용 상한
cashAmount    = totalPrice - mileageAmount
검증: 마일리지/캐시 잔액 부족 시 예외 → @Transactional 롤백
차감: updateWalletBalances(cashAfter, mileageAfter)
이력: CASH/USE 1건 (+ 마일리지 썼으면 MILEAGE/USE 1건)
결제: payment_method = mileageAmount > 0 ? CASH_MILEAGE : CASH
```

마일리지는 전체 금액의 30%까지(`MAX_MILEAGE_RATE`)만, 그것도 1,000원 단위로 내림해서 쓸 수 있다.

### 포인트 적립 — 활동 보상

글·댓글·레벨업 같은 활동은 `RewardServiceImpl.awardAction`이 정책을 조회해 포인트 또는 마일리지를 EARN으로 적립하고, `USER_POINT_HISTORY`에 `balance_after`와 함께 남긴다. 포인트는 `POINT_SHOP_ITEM` 구매(닉네임 색·뱃지 등)에 USE로 쓰인다.

### 자산별 흐름 요약

| 자산 | 충전/적립 change_type | 사용 change_type | 이력 테이블 |
| --- | --- | --- | --- |
| 캐시 | CHARGE | USE / REFUND | USER_WALLET_HISTORY |
| 마일리지 | EARN | USE / REFUND | USER_WALLET_HISTORY |
| 포인트 | EARN | USE | USER_POINT_HISTORY |

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: 3자산 잔액·이력, Toss 충전(READY 선저장·멱등 완료·승인 재검증), 캐시+마일리지 혼합 결제, 마일리지 30% 상한, 등급별 충전 한도 AOP, 환불 audit 로그, 활동 포인트 적립과 포인트 상점 구매, 충전 시 직전 달 결제 기준 회원 등급 재계산.
- **Mock**: 항공권(`flight`) 결제는 `MockFlightOfferProvider` 기반이라 외부 항공 API와 연동되지 않는다. 지갑 차감 자체는 동일 경로를 탄다.
- **계획/한계**: 포인트 만료(EXPIRE) change_type은 스키마에 있으나 자동 만료 배치는 미적용. 잔액 캐시와 이력 합의 정합성 자동 대사(reconciliation) 작업은 없음.

## 6. 면접 답변 3단계

1. **한 줄**: 사용자 자산을 캐시·마일리지·포인트 세 갈래로 나누고, 잔액은 USERS에 캐시하되 모든 변동을 balance_after와 함께 이력 테이블에 남기는 지갑입니다.
2. **설계 의도**: 실제 돈인 캐시는 환불 audit과 충전 한도가 필요하고, 활동 보상 포인트는 그런 제약이 없어서 정책이 충돌하기 때문에 자산과 이력을 분리했습니다.
3. **구현 근거**: Toss 충전은 READY 주문을 먼저 저장하고 콜백에서 orderId로 잠근 뒤 승인을 재검증해 멱등하게 처리했고, 패키지 결제는 마일리지 30% 상한 안에서 캐시와 혼합해 한 트랜잭션으로 차감합니다.

## 7. 꼬리질문 + 모범답안

:::details 잔액을 USERS에 캐시하면 이력과 어긋날 위험이 있는데 어떻게 막나요
모든 잔액 변동을 잔액 갱신과 같은 @Transactional 안에서 처리하고, 이력에 변동 후 잔액(balance_after)을 함께 적습니다. 충전·결제·환불 경로가 전부 updateWalletBalances와 insertWalletHistory를 같이 호출하므로 둘이 분리될 수 없고, 사후엔 이력의 마지막 balance_after와 USERS 잔액을 비교해 검증할 수 있습니다.
:::

:::details Toss 결제 콜백이 두 번 와도 캐시가 중복 지급되지 않는 이유는
완료 처리에서 orderId로 결제 행을 FOR UPDATE로 잠그고, 이미 COMPLETED 상태면 잔액을 건드리지 않고 기존 결과만 반환합니다. 또 READY 상태 행만 COMPLETED로 갱신하는 조건부 UPDATE를 쓰기 때문에, 갱신 영향 행이 0이면 이미 처리된 건으로 보고 멱등하게 빠져나옵니다.
:::

:::details 마일리지로 결제 전액을 낼 수 없게 한 이유는
마일리지는 결제 적립으로 생기는 보조 통화라 전액 사용을 허용하면 현금 유입 없이 무한 순환할 수 있습니다. 그래서 전체 금액의 30%까지, 1,000원 단위로 내림해서만 상계하도록 상한을 뒀습니다. 나머지는 캐시로 내야 하고, 캐시 잔액이 부족하면 예외로 트랜잭션을 롤백합니다.
:::

:::details 포인트와 마일리지를 굳이 따로 둔 이유는
마일리지는 결제 금액의 일부를 상계하는 준현금이라 결제·환불 흐름에 묶이고, 포인트는 커뮤니티 활동 보상이라 상점 구매에만 쓰입니다. 환불 대상 여부와 발생 원천이 달라서 이력 테이블도 USER_WALLET_HISTORY와 USER_POINT_HISTORY로 분리했습니다.
:::

:::details 충전 한도는 어디서 검증하나요
기본 범위(1,000원~1,000,000원, 100원 단위)는 서비스에서 검증하고, 회원 등급별 1회·일·월 한도는 WalletChargeLimitAspect가 AOP로 가로채 WALLET_LIMIT_POLICY와 대조합니다. 한도 정책을 충전 본 로직에서 떼어내 횡단 관심사로 분리한 구조입니다.
:::

## 8. 직접 말해보기

- 캐시·마일리지·포인트가 각각 어디서 들어오고 어디에 쓰이는지 표 없이 한 번에 설명해 보세요.
- Toss 충전이 READY 행을 먼저 저장하는 이유와, 콜백이 멱등해지는 메커니즘을 이어서 말해 보세요.
- 패키지 혼합 결제에서 마일리지 상한과 캐시 부족 처리, 그리고 트랜잭션 롤백이 왜 한 묶음인지 설명해 보세요.

관련 문서: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="3원 지갑에서 포인트 변동은 어느 테이블에 기록되는가" :choices="['USER_WALLET_HISTORY', 'USER_POINT_HISTORY', 'USER_PAYMENT_HISTORY', 'WALLET_REWARD_POLICY']" :answer="1" explanation="캐시와 마일리지는 USER_WALLET_HISTORY에, 포인트는 별도의 USER_POINT_HISTORY에 기록된다. asset_type 컬럼은 CASH와 MILEAGE만 다룬다." />

<QuizBox question="Toss 충전 콜백이 두 번 들어와도 캐시가 중복 지급되지 않게 하는 핵심 장치는" :choices="['결제 금액을 매번 0으로 초기화', 'orderId로 행을 잠그고 이미 COMPLETED면 기존 결과만 반환하는 멱등 처리', '세션에 충전 여부를 저장', '캐시 잔액을 매번 이력에서 다시 합산']" :answer="1" explanation="completeTossCharge는 orderId로 결제 행을 잠그고, 이미 COMPLETED면 잔액을 건드리지 않고 기존 결과만 반환한다. READY 상태만 갱신하는 조건부 UPDATE로 멱등성을 보장한다." />

<QuizBox question="패키지 예약의 캐시 마일리지 혼합 결제에서 마일리지 사용에 적용되는 제약은" :choices="['전체 금액의 30퍼센트까지 1000원 단위로만 사용', '제한 없이 전액 사용 가능', '캐시 잔액과 무관하게 우선 차감', '포인트로만 상계 가능']" :answer="0" explanation="MAX_MILEAGE_RATE에 따라 전체 금액의 30퍼센트까지, 1000원 단위로 내림해서만 마일리지로 상계할 수 있고 나머지는 캐시로 낸다. 잔액 부족 시 트랜잭션이 롤백된다." />
