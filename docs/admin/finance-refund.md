---
title: "매출·환불"
owner: A
domain: "관리자·운영"
tags: ["매출", "환불"]
---

# 매출·환불

> 운영자가 회원 지갑 자산을 한눈에 집계하고, 토스로 충전된 결제를 안전하게 전액 환불하는 화면. 핵심은 환불이 단순 잔액 차감이 아니라 외부 결제 취소 + 잔액 차감 + 변동 이력 + audit 로그를 하나의 트랜잭션으로 묶는 것이다.

이 페이지는 TripTogether 관리자 도메인 중 내지갑(Finance) 대시보드와 결제 환불 처리를 다룬다. TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트이고, 매출·환불은 그중 운영(Admin) 축에 속한다. 사용자 측 결제·지갑은 커머스 도메인이 만들고, 관리자 측 환불·정책은 운영 도메인이 그 데이터를 운영성 권한으로 다룬다.

## 1. 한 줄 정의

매출·환불은 회원 지갑(캐시·마일리지·포인트) 자산을 집계해 보여주는 운영 대시보드와, 토스로 충전된 캐시 결제를 운영자가 전액 환불(외부 취소 + 잔액 차감 + 이력·audit 기록을 한 트랜잭션으로) 처리하는 기능이다.

## 2. 왜 이렇게 설계했나

- **환불은 돈이 움직이는 작업이라 부분 실패가 가장 위험하다.** 외부 결제는 취소됐는데 우리 DB 잔액은 그대로 남거나, 반대로 잔액만 깎고 외부 취소가 안 되는 상태는 절대 만들면 안 된다. 그래서 환불 로직 전체를 단일 `@Transactional`로 묶어, 어느 단계에서 예외가 나면 우리 측 변경을 전부 롤백한다.
- **읽기 권한과 쓰기 권한의 경계를 명확히 한다.** 대시보드 조회(읽기)와 환불 실행(돈 차감)은 위험도가 다르다. 그래서 조회는 FINANCE_ADMIN 계열이 보되, 환불 실행은 FINANCE_OPERATOR 권한으로 분리하고, 매퍼·컨트롤러도 조회용(`AdminFinanceMapper`)과 환불용(`AdminRefundMapper`)으로 나눴다.
- **기존 결제 코드는 건드리지 않는다.** 사용자 충전 로직(WalletService)을 수정하면 회귀 위험이 크다. 그래서 환불은 별도 서비스에서 토스 취소만 추가로 호출하고, 잔액·이력 갱신은 환불 전용 매퍼로만 수행한다.
- **모든 환불은 추적 가능해야 한다.** 누가, 언제, 어떤 결제를, 얼마를, 무슨 사유로 환불했는지를 `WALLET_REFUND_LOG`에 별도 audit으로 남긴다. 회원의 잔액 변동 이력(`USER_WALLET_HISTORY`)과는 목적이 다르다 — 하나는 회원 가계부, 하나는 운영 감사 기록이다.
- **잔액이 음수가 되지 않게 방어한다.** 회원이 이미 환불 대상 금액을 다 써버린 경우라도 잔액을 0 밑으로 내리지 않도록, 차감 SQL에서 `GREATEST(cash_balance - amount, 0)`로 바닥을 막는다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

전형적인 4계층(controller to service to mapper to vo)으로 구현돼 있고, 조회/환불을 의도적으로 분리했다.

| 계층 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| Controller | `AdminFinanceController` (`/admin/finance`) | 통합 대시보드(자산 집계 + 회원 목록 + 권한별 위젯), 회원 상세 |
| Controller | `AdminRefundController` (`/admin/finance/refund`) | 환불 후보 목록 + 환불 실행(POST) |
| Service | `AdminFinanceService` / `AdminFinanceServiceImpl` | 자산 집계 통계, 회원 목록·페이징, 회원 상세 이력 |
| Service | `AdminRefundService` / `AdminRefundServiceImpl` | 환불 후보 조회, 환불 실행 트랜잭션, 최근 audit 조회 |
| 외부 연동 | `TossPaymentsClient` | 토스 결제 취소(cancelPayment) 호출 |
| Mapper | `AdminFinanceMapper` (read), `AdminRefundMapper` (운영성 write) | 집계·후보·상태갱신·잔액차감·이력·audit SQL |
| 통계 DTO | `AdminFinanceStatsDto` | 총 캐시·마일리지·포인트, 회원 수, 오늘/30일 충전 합계 |
| 결제 DTO | `WalletPaymentDto` | `USER_PAYMENT_HISTORY` 한 건(유형·상태·토스키·금액) |
| audit VO | `WalletRefundLogVO` | `WALLET_REFUND_LOG` 한 건(금액·사유·토스취소상태·처리자) |

핵심 테이블은 네 개다.

| 테이블 | 역할 | 환불 시 변화 |
| --- | --- | --- |
| `USERS` | 3원 지갑 잔액 보유(`cash_balance`/`mileage_balance`/`point_balance`) | `cash_balance` 차감 |
| `USER_PAYMENT_HISTORY` | 결제/충전 이력(type CHARGE/PURCHASE/REFUND, status READY/COMPLETED/REFUNDED) | status를 COMPLETED to REFUNDED, `cancelled_at` 기록 |
| `USER_WALLET_HISTORY` | 회원 자산 변동 가계부(asset_type CASH 등) | REFUND 행 1건 추가(음수 amount) |
| `WALLET_REFUND_LOG` | 운영 환불 audit 로그 | 행 1건 추가(처리자·사유·토스취소상태) |

::: tip 조회와 쓰기를 굳이 매퍼까지 나눈 이유
`AdminRefundMapper` 주석에 적혀 있듯, 분리 이유는 read-only 조회와 돈을 움직이는 운영성 write의 권한 경계를 코드 레벨에서 분명히 하기 위함이다. 환불처럼 위험한 쓰기가 일반 조회 매퍼에 섞여 있으면 권한·리뷰 관점에서 위험하다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### 대시보드 집계

`AdminFinanceController.dashboard`는 세션의 `adminPermissions`를 읽어 권한별로 다른 위젯을 채운다. SUPER_ADMIN 또는 FINANCE_OPERATOR면 최근 환불 audit 위젯을, FINANCE_POLICY_ADMIN이면 한도·적립 정책 위젯을 추가로 내려준다. 자산 집계는 `AdminFinanceStatsDto`에 총 캐시·마일리지·포인트와 회원 수, 오늘/지난 30일 충전 합계를 담는다.

### 환불 후보 선정

환불 대상은 아무 결제나가 아니다. `selectRefundCandidates`는 다음 조건만 후보로 올린다.

```sql
WHERE payment_type   = CHARGE       -- 충전 결제만 (구매·환불 제외)
  AND payment_status = COMPLETED    -- 정상 완료 건만
ORDER BY paid_at DESC LIMIT 200
```

### 환불 실행 단계 (단일 트랜잭션)

`AdminRefundServiceImpl.refundPayment`가 `@Transactional` 안에서 순서대로 수행한다.

| 단계 | 동작 | 실패 시 |
| --- | --- | --- |
| 0 | 입력 검증(paymentIdx·adminUserIdx·reason 필수) | IllegalArgumentException |
| 1 | 결제 단건 조회 후 type CHARGE / status COMPLETED 재확인 | IllegalStateException, 전체 롤백 |
| 2 | 토스 결제 취소(`tossPaymentKey`가 있을 때만 `cancelPayment` 호출) | 취소 실패 시 예외 to 전체 롤백 |
| 3 | `USER_PAYMENT_HISTORY` status를 REFUNDED로, `cancelled_at` 기록 | updated가 0이면 이미 환불됨으로 보고 예외 |
| 4 | `USERS.cash_balance` 차감(바닥 0 방어) | 트랜잭션 일부 |
| 5 | `USER_WALLET_HISTORY`에 REFUND 변동 행 추가(음수 금액 + 변동후 잔액) | 트랜잭션 일부 |
| 6 | `WALLET_REFUND_LOG`에 audit 로그 추가 후 반환 | 트랜잭션 일부 |

토스 취소 상태값은 audit에 그대로 기록한다.

```java
if (tossPaymentKey != null && !blank) {
    tossPaymentsClient.cancelPayment(tossPaymentKey, reason);
    tossCancelStatus = "CANCELED";        // 실결제 취소 성공
} else {
    tossCancelStatus = "SKIPPED_NON_TOSS"; // 토스키 없는 테스트/내부 충전
}
```

즉 `toss_cancel_status` 컬럼은 CANCELED(실결제 취소됨) 또는 SKIPPED_NON_TOSS(토스 미연동 건이라 외부 취소 생략) 두 값으로 무엇이 실제로 외부 취소됐는지를 추적한다.

### 상태 전이

```text
COMPLETED  --환불 실행-->  REFUNDED   (역전 불가, markPaymentRefunded는 COMPLETED 조건부 UPDATE)
```

`markPaymentRefunded`의 UPDATE는 `WHERE ... AND payment_status = COMPLETED` 조건을 달아, 동시에 두 번 환불 요청이 들어와도 두 번째는 영향 행 0건이 되어 `이미 환불됨` 예외로 막힌다. 이것이 가벼운 동시성 방어 역할을 한다.

## 5. 구현 상태 (됨 vs Mock/계획)

::: warning 정직한 범위
- **됨:** 자산 집계 대시보드, 권한별 위젯, 환불 후보 조회, 단일 트랜잭션 환불(토스 취소 + 잔액 차감 + 변동 이력 + audit), 음수 잔액 방어, COMPLETED 조건부 상태 갱신, 최근 환불 audit 조회.
- **부분/주의:** 환불은 캐시 충전(CHARGE) 전액 환불만 지원한다. 부분 환불·구매(PURCHASE) 환불·마일리지/포인트 환불 UI 흐름은 이 컨트롤러 범위 밖이다.
- **Mock/외부:** 토스 결제 취소는 실제 외부 API 호출 경로(`TossPaymentsClient.cancelPayment`)지만, 키가 없는 내부·테스트 충전은 SKIPPED_NON_TOSS로 외부 호출을 건너뛴다. 항공권 등 일부 커머스는 Mock 프로바이더라 환불 대상에 직접 연결되지 않는다.
- **계획:** 부분 환불, 환불 사유 코드 표준화, 환불 한도/승인 워크플로우는 향후 과제.
:::

## 6. 면접 답변 3단계

1. **한 문장:** 운영자가 토스로 충전된 캐시 결제를 환불하면, 외부 결제 취소와 우리 DB의 잔액 차감·변동 이력·감사 로그를 하나의 트랜잭션으로 처리해 부분 실패가 없도록 만든 기능입니다.
2. **설계 의도:** 돈이 움직이는 작업이라 외부 취소만 되고 잔액이 안 깎이는 식의 불일치가 가장 위험합니다. 그래서 전 과정을 `@Transactional`로 묶고, 잔액은 0 밑으로 안 내려가게 방어하며, 상태 갱신을 COMPLETED 조건부 UPDATE로 만들어 중복 환불을 막았습니다.
3. **확장:** 누가 언제 무엇을 왜 환불했는지는 회원 가계부와 별개로 `WALLET_REFUND_LOG` audit에 남겨, 운영 감사와 분쟁 대응이 가능하도록 했습니다. 조회와 환불 매퍼를 분리해 권한 경계도 코드로 드러냈습니다.

## 7. 꼬리질문 + 모범답안

::: details Q1. 환불 도중 토스 취소는 됐는데 그다음 DB 갱신이 실패하면 어떻게 되나요?
토스 취소 호출은 트랜잭션 안에서 이뤄지고, 그 뒤 단계에서 예외가 나면 우리 DB 변경(상태·잔액·이력·audit)은 전부 롤백됩니다. 다만 외부 토스 취소 자체는 이미 외부 시스템에서 일어난 일이라 자동 롤백되지 않습니다. 그래서 토스 취소를 먼저 하되, 그 이후 단계는 우리 DB 쓰기뿐이라 실패 가능성이 낮고, 만약 불일치가 생기면 audit 로그와 토스 콘솔을 대조해 운영자가 수동 정합을 맞추는 구조입니다. 더 엄밀히는 보상 트랜잭션이 필요하지만 현재 범위에서는 단일 트랜잭션 + audit로 추적성을 확보했습니다.
:::

::: details Q2. 같은 결제에 환불 버튼이 두 번 눌리면요?
상태 갱신 쿼리가 payment_status가 COMPLETED일 때만 REFUNDED로 바꾸는 조건부 UPDATE라, 두 번째 요청은 영향 행이 0건이 됩니다. 서비스는 영향 행 0을 이미 환불되었을 수 있음 예외로 처리해 두 번째 환불을 막습니다. 후보 조회 자체도 COMPLETED 건만 올리므로 1차 필터가 한 번 더 걸립니다.
:::

::: details Q3. 회원이 환불 대상 금액을 이미 다 써버렸으면 잔액이 음수가 되지 않나요?
차감 SQL이 cash_balance를 GREATEST(cash_balance - amount, 0)으로 갱신해 0 밑으로는 내려가지 않습니다. 다만 이 경우 회수 못 한 차액이 생기므로, 변동 이력과 audit에는 환불 전액이 그대로 기록되어 운영자가 차이를 인지할 수 있습니다. 정책상 마이너스 잔액을 허용할지는 별도 의사결정 사항입니다.
:::

::: details Q4. USER_WALLET_HISTORY와 WALLET_REFUND_LOG는 뭐가 다른가요?
USER_WALLET_HISTORY는 회원 관점의 자산 변동 가계부입니다. 환불이면 asset_type CASH, change_type REFUND로 음수 금액과 변동 후 잔액이 남습니다. WALLET_REFUND_LOG는 운영 관점의 감사 로그로, 어떤 결제를 누가(처리 관리자) 무슨 사유로 얼마 환불했고 토스 취소 상태가 무엇이었는지를 남깁니다. 같은 사건을 회원 가계부와 운영 감사 두 시점에서 따로 기록하는 것입니다.
:::

::: details Q5. 왜 조회 매퍼와 환불 매퍼를 분리했나요?
조회는 read-only지만 환불은 잔액을 차감하는 운영성 write입니다. 위험도가 다른 작업을 한 매퍼에 섞으면 권한 부여와 코드 리뷰가 어려워집니다. 매퍼를 AdminFinanceMapper(읽기)와 AdminRefundMapper(쓰기)로 나누면 환불 권한(FINANCE_OPERATOR)과의 경계가 코드에서 바로 드러나, 누가 무엇을 할 수 있는지가 명확해집니다.
:::

## 8. 직접 말해보기

다음 질문에 막힘 없이 답할 수 있으면 이 페이지를 이해한 것이다.

- 환불 한 건이 거치는 6단계를 순서대로 말해보라. 각 단계가 어느 테이블을 건드리는가.
- 토스 취소가 CANCELED일 때와 SKIPPED_NON_TOSS일 때는 각각 어떤 결제이고, 그 차이가 audit에 왜 중요한가.
- 같은 결제에 환불이 동시에 두 번 들어와도 한 번만 처리되는 이유를 SQL 한 줄로 설명해보라.
- 환불을 단일 트랜잭션으로 묶었을 때 자동으로 롤백되는 것과 안 되는 것(외부 토스 취소)을 구분해 말해보라.

## 퀴즈

<QuizBox question="AdminRefundServiceImpl.refundPayment에서 환불 후보가 되려면 결제는 어떤 유형과 상태여야 하나?" :choices="['payment_type가 PURCHASE이고 status가 READY','payment_type가 CHARGE이고 status가 COMPLETED','payment_type가 REFUND이고 status가 REFUNDED','payment_type가 CHARGE이고 status가 CANCELLED']" :answer="1" explanation="후보 조회와 환불 실행 모두 충전 결제(CHARGE)이면서 정상 완료(COMPLETED)인 건만 대상으로 한다." />

<QuizBox question="결제 상태를 REFUNDED로 바꾸는 markPaymentRefunded UPDATE에 WHERE payment_status = COMPLETED 조건을 단 주된 효과는?" :choices="['환불 금액을 자동 계산한다','토스 취소를 건너뛴다','중복 환불 요청 시 두 번째는 영향 행 0건이 되어 막힌다','마일리지를 함께 적립한다']" :answer="2" explanation="COMPLETED 조건부 UPDATE라 이미 REFUNDED가 된 건은 갱신되지 않아, 동시·중복 환불을 가볍게 방어한다." />

<QuizBox question="환불 audit를 남기는 테이블과, 그 목적으로 가장 적절한 것은?" :choices="['USERS 테이블에 회원 잔액만 갱신','WALLET_REFUND_LOG에 처리자·사유·토스취소상태를 남겨 운영 감사용','USER_PAYMENT_HISTORY를 삭제해 흔적 제거','POINT_SHOP_ITEM에 환불 사유 기록']" :answer="1" explanation="WALLET_REFUND_LOG는 누가 언제 무엇을 왜 환불했는지와 토스 취소 상태를 남기는 운영 감사 로그로, 회원 가계부인 USER_WALLET_HISTORY와 목적이 다르다." />

---

관련 문서: [관리자 도메인 전체 개요](/admin/) · [관리자 대시보드](/admin/dashboard) · [회원 360 뷰](/admin/member-360) · [감사 로그](/admin/audit-logs) · [3원 지갑(캐시·마일리지·포인트)](/explore/three-wallet) · [Toss 결제](/explore/toss-payments) · 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
