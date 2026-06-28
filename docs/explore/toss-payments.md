---
title: "Toss 결제"
owner: C
domain: "여행지 탐색·커머스"
tags: ["Toss", "결제"]
---

# Toss 결제

> 내 지갑 캐시 충전을 Toss Payments로 실결제하고, 캐시·마일리지 혼합결제와 등급 할인으로 패키지·항공권을 구매하는 흐름.

## 1. 한 줄 정의

TripTogether의 결제는 두 단계로 분리된다. (1) Toss Payments로 원화(KRW)를 받아 사이트 내부 화폐인 **캐시**로 충전하고, (2) 충전된 캐시와 적립된 마일리지를 섞어 상품(패키지·항공권)을 구매한다. 외부 결제 PG는 충전 한 곳에만 붙고, 실제 상품 결제는 내부 지갑 잔액 차감으로만 이뤄진다.

## 2. 왜 이렇게 설계했나

- **PG 연동 표면 최소화.** 외부 PG(Toss)는 충전 1군데에만 연결한다. 패키지·항공권 등 상품 결제가 늘어도 PG 승인·취소 코드를 매번 다시 짤 필요가 없다. 상품 쪽은 캐시/마일리지 잔액 차감이라는 단순 산술만 다룬다.
- **사이트 화폐로 정책을 통제.** 등급 할인, 마일리지 적립, 충전 한도 같은 비즈니스 정책을 KRW 흐름에서 떼어 캐시·마일리지 위에 얹는다. 정책은 DB 정책 테이블로 운영되고 코드 배포 없이 조정 가능하다.
- **결제 검증 책임 분리.** 충전 금액·한도·중복 적립 검증은 백엔드가, 실제 카드 승인은 Toss가 담당한다. 브라우저에서 위변조될 수 있는 값은 서버가 다시 한번 검증한다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 구분 | 구현체 |
| --- | --- |
| 충전 컨트롤러 | `WalletController` (`/wallet/**`) |
| 충전 서비스 | `WalletService` / `WalletServiceImpl` |
| Toss API 클라이언트 | `TossPaymentsClient` (RestTemplate, 승인·취소) |
| 충전 한도 검증 | `WalletChargeLimitAspect` (AOP @Before) |
| 결제 이력 테이블 | `USER_PAYMENT_HISTORY` |
| 자산 변동 이력 | `USER_WALLET_HISTORY` |
| 잔액 컬럼 | `USERS.cash_balance` / `USERS.mileage_balance` |
| 등급·할인 정책 | `MEMBER_GRADE_POLICY`, `WALLET_LIMIT_POLICY` |
| 환불 audit | `WALLET_REFUND_LOG` + `AdminRefundService` |
| 상품 혼합결제 | `TravelPackageServiceImpl`, `FlightServiceImpl` |

핵심 결제 테이블 `USER_PAYMENT_HISTORY`의 주요 컬럼은 다음과 같다.

| 컬럼 | 의미 |
| --- | --- |
| payment_type | CHARGE / PURCHASE / REFUND |
| payment_method | CASH / MILEAGE / CASH_MILEAGE / TEST |
| original_amount | 할인 전 원금액 |
| discount_rate / discount_amount | 등급 할인율과 할인 금액 |
| final_amount | 최종 결제 금액 |
| used_cash / used_mileage | 차감한 캐시·마일리지 |
| earned_mileage | 적립 마일리지 |
| payment_status | READY / COMPLETED / CANCELLED / REFUNDED |
| toss_order_id / toss_payment_key | Toss 주문번호·결제키 (각각 UNIQUE) |

`toss_order_id`와 `toss_payment_key`에 UNIQUE 제약이 걸려 있어 동일 주문·결제키가 두 번 기록되는 것을 DB 차원에서 막는다.

## 4. 동작 원리(흐름·표·작은 코드)

충전은 **READY 선기록 → Toss 결제창 → success 콜백 승인확인 → COMPLETED 전환** 순서로 흐른다. 콜백이 세션에 의존하지 않도록, 결제창을 열기 전에 `orderId`로 READY 상태 주문을 DB에 먼저 박아둔다.

| 단계 | 메서드 | 핵심 동작 |
| --- | --- | --- |
| 1. 준비 | `prepareTossCharge` | orderId 생성, payment_status=READY로 선기록 |
| 2. 결제창 | 프런트 Toss SDK | clientKey로 결제창 호출, successUrl/failUrl 지정 |
| 3. 성공 콜백 | `completeTossCharge` | orderId로 READY 건 잠금조회, Toss 승인확인 후 COMPLETED |
| 4. 실패 콜백 | `cancelPendingTossCharge` | 남은 READY 건 삭제 |

승인 확인 단계에서 위변조·중복을 막는 검증이 핵심이다.

```text
// completeTossCharge 의 방어 로직 (요약)
1) orderId 로 READY 건을 SELECT ... FOR UPDATE 로 잠금
2) 이미 COMPLETED면 → 기존 결과 그대로 반환 (중복 적립 차단)
3) 콜백으로 넘어온 amount 와 DB final_amount 일치 확인
4) TossPaymentsClient.confirmPayment 로 Toss 승인확인 호출
5) 응답 totalAmount / orderId / status(DONE) 재검증
6) updateReadyTossPaymentAsCompleted 로 READY → COMPLETED 갱신
   (갱신 0건이면 동시성 충돌로 보고 다시 COMPLETED 여부 확인)
```

`TossPaymentsClient.confirmPayment`는 Toss 승인 API에 `paymentKey`, `orderId`, `amount`를 보내고, 시크릿 키를 `Basic` 인증 헤더로 Base64 인코딩해 전달한다.

```text
POST https://api.tosspayments.com/v1/payments/confirm
Authorization: Basic base64(SECRET_KEY:)
body: { paymentKey, orderId, amount }
```

충전이 COMPLETED로 확정되면 부수효과(`applyChargeSideEffects`)가 한 트랜잭션 안에서 처리된다.

1. `USERS.cash_balance` 증가, 적립 마일리지(`final_amount / 10`)만큼 `mileage_balance` 증가
2. `USER_WALLET_HISTORY`에 CASH CHARGE, MILEAGE EARN 행 기록
3. `RewardService.awardAction`으로 결제 경험치 지급
4. 직전 달 결제 총액 기준으로 `recalculateMemberGrade` 등급 재계산

**혼합결제(캐시+마일리지)와 등급 할인**은 상품 결제 쪽에서 일어난다. 항공권 조회 시 `FlightServiceImpl`이 사용자 등급의 `MEMBER_GRADE_POLICY.discount_rate`를 읽어 `discount_amount`를 내림 계산하고, 할인 후 금액의 일정 비율까지만 마일리지 사용을 허용한다. 결제 시 `payment_method`는 마일리지를 썼으면 `CASH_MILEAGE`, 아니면 `CASH`로 기록된다.

```text
discount_amount = floor(original_amount * discount_rate / 100)
final_amount    = max(0, original_amount - discount_amount)
used_cash + used_mileage = final_amount
```

**충전 한도**는 `WalletChargeLimitAspect`가 AOP `@Before`로 충전 진입 직전에 검사한다. `WALLET_LIMIT_POLICY`에서 등급별 1회/일/월 한도를 읽되, 정책 행이 없거나 NULL 컬럼이면 무제한으로 보고 통과시키는 **fail-open** 정책이다. 정책 조회가 실패해도 결제 자체는 막지 않는다.

**환불**은 관리자 전용이다. `AdminRefundService`가 `TossPaymentsClient.cancelPayment`로 Toss 취소를 호출하고, 결과를 `WALLET_REFUND_LOG`에 환불 사유·처리 관리자와 함께 audit으로 남긴다.

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현됨
- Toss Payments 실연동 충전: READY 선기록 → 승인확인 → COMPLETED 전환, 중복 적립·금액 위변조 방어
- 캐시+마일리지 혼합결제, 등급별 할인율 적용(패키지·항공권 결제 경로)
- 등급별 충전 한도 AOP 검증, 충전 시 마일리지 적립·등급 자동 재계산
- 관리자 환불 + Toss 취소 호출 + 환불 audit 로그
:::

:::warning Mock 또는 주의
- **항공권 상품 자체는 Mock 프로바이더**다. 외부 항공 API와 미연동이라 항공권 결제는 가짜 오퍼 데이터 위에서 동작한다. 단, 결제·할인·마일리지 로직 자체는 실제 지갑을 차감한다.
- 충전 금액의 마일리지 적립률(`final_amount / 10`, 10%)은 코드 상수다. 일부 적립 정책은 `WALLET_REWARD_POLICY`로 분리되어 있으나 충전 적립률 자체는 코드에 고정.
- 결제 키는 **샌드박스(test) 키**를 전제로 한다. 운영 키는 별도 주입이 필요하다.
:::

`application.properties`에는 자리표시자 형태로 키가 들어간다. 실제 키는 공개 저장소에 올리지 않는다.

```properties
toss.payments.client-key=TOSS_CLIENT_KEY
toss.payments.secret-key=TOSS_SECRET_KEY
app.base-url=http://DB_HOST/TripTogether
```

## 6. 면접 답변 3단계

1. **한 줄.** "TripTogether 결제는 Toss로 캐시를 충전하고, 그 캐시와 마일리지를 섞어 상품을 사는 2단계 구조입니다. 외부 PG는 충전 한 곳에만 붙입니다."
2. **설계 의도.** "PG 연동 표면을 충전 한 군데로 좁혀, 상품이 늘어도 승인·취소 코드를 재작성하지 않습니다. 등급 할인·마일리지·한도 같은 정책은 사이트 화폐 위에서 DB 정책으로 운영합니다."
3. **방어 포인트.** "충전은 결제창을 열기 전에 READY 주문을 DB에 선기록하고, success 콜백에서 행을 잠근 뒤 Toss 승인확인과 금액 재검증을 거쳐야만 COMPLETED로 바뀝니다. orderId·paymentKey UNIQUE 제약과 이미-COMPLETED 단락 처리로 중복 적립을 막습니다."

## 7. 꼬리질문+모범답안

:::details 결제창을 열기 전에 READY 행을 먼저 기록하는 이유는?
success 콜백이 세션에 의존하지 않게 하기 위해서다. 콜백은 Toss가 리다이렉트로 부르는데, 다른 탭·세션 만료 상황에서도 `orderId`만으로 어떤 충전 건인지 DB에서 정확히 복원할 수 있어야 한다. 그래서 결제창 호출 직전에 READY 주문을 박아두고, 콜백에서 그 행을 잠가 처리한다.
:::

:::details 같은 success 콜백이 두 번 호출되면 캐시가 두 배로 적립되지 않나?
막혀 있다. 콜백 진입 시 orderId로 행을 `FOR UPDATE` 잠금조회하고, 상태가 이미 COMPLETED면 적립을 다시 하지 않고 기존 결과만 반환한다. READY → COMPLETED 갱신이 0건이면 동시성 충돌로 보고 다시 COMPLETED 여부를 확인한다. 추가로 `toss_order_id`·`toss_payment_key` UNIQUE 제약이 DB 차원의 마지막 방어선이다.
:::

:::details 브라우저가 보내는 amount를 그대로 믿어도 되나?
안 된다. 콜백 amount는 위변조될 수 있어 세 번 검증한다. (1) DB에 선기록된 final_amount와 일치, (2) Toss 승인확인 응답 totalAmount와 일치, (3) 응답 status가 DONE인지 확인. 셋 중 하나라도 어긋나면 예외로 막는다. 금액·문자열 파싱도 컨트롤러에서 한 번 더 서버 검증한다.
:::

:::details 충전 한도 정책이 DB 조회에 실패하면 결제를 막나 통과시키나?
통과시킨다. `WalletChargeLimitAspect`는 fail-open으로 설계됐다. 정책 행이 없거나 NULL 컬럼이면 무제한으로 보고, 정책 조회 자체가 예외로 실패해도 경고 로그만 남기고 결제를 진행한다. 한도는 부가 정책이지 결제의 필수 조건이 아니라는 판단이다.
:::

:::details 등급 할인은 충전 때 적용되나 구매 때 적용되나?
구매 때 적용된다. 충전은 KRW를 그대로 캐시로 바꾸는 1:1 흐름이라 할인 개념이 없다. 할인은 상품 결제 경로에서 사용자 등급의 `MEMBER_GRADE_POLICY.discount_rate`를 읽어 `discount_amount`를 내림 계산하고, 할인 후 `final_amount`를 캐시+마일리지로 채운다.
:::

## 8. 직접 말해보기

- 충전의 4단계(준비·결제창·성공·실패)를 메서드 이름과 함께 1분 안에 설명해 보자.
- "왜 PG를 충전 한 곳에만 붙였나"를 상품 결제 확장 관점에서 논거를 들어 말해 보자.
- 중복 콜백·금액 위변조를 각각 어떤 메커니즘으로 막는지 구분해서 설명해 보자.
- 등급 할인과 혼합결제가 동작하는 결제 경로가 충전과 어떻게 다른지 대비해 보자.

## 퀴즈

<QuizBox question="TripTogether 결제 구조에서 외부 PG(Toss)가 직접 연결되는 지점은 어디인가?" :choices="['패키지 구매 결제', '항공권 구매 결제', '내 지갑 캐시 충전', '마일리지 적립']" :answer="2" explanation="외부 PG는 캐시 충전 한 곳에만 붙는다. 패키지·항공권 상품 결제는 충전된 캐시와 마일리지의 내부 잔액 차감으로만 처리된다." />

<QuizBox question="충전 success 콜백에서 캐시 중복 적립을 막는 방식으로 옳지 않은 것은?" :choices="['orderId로 행을 잠금 조회한다', '이미 COMPLETED면 기존 결과만 반환한다', 'toss_order_id에 UNIQUE 제약이 있다', '콜백마다 새 결제 행을 무조건 INSERT 한다']" :answer="3" explanation="콜백은 새 행을 만들지 않고, 미리 선기록된 READY 행을 잠가 COMPLETED로 갱신한다. 이미 COMPLETED면 적립을 반복하지 않고 단락 처리한다." />

<QuizBox question="WalletChargeLimitAspect가 충전 한도 정책 조회에 실패했을 때의 동작은?" :choices="['결제를 즉시 차단한다', '경고 로그만 남기고 결제를 통과시킨다 (fail-open)', '관리자에게 알림을 보낸다', '한도를 0으로 적용한다']" :answer="1" explanation="한도 검증은 부가 정책이라 fail-open으로 설계됐다. 정책이 없거나 조회가 실패하면 결제를 막지 않고 진행한다." />
