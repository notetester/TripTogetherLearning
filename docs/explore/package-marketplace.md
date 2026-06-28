---
title: "패키지 마켓플레이스"
owner: C
domain: "여행지 탐색·커머스"
tags: ["패키지", "마켓플레이스"]
---

# 패키지 마켓플레이스

> 판매자가 여행 패키지를 등록하면 관리자 승인을 거쳐 사용자가 예약하는, 상태 기계 기반의 위탁판매 커머스 모듈.

## 1. 한 줄 정의

패키지 마켓플레이스는 BUSINESS/PARTNER 권한 판매자가 여행 상품을 등록하고, 관리자가 DRAFT → PENDING → APPROVED 흐름으로 검수해 노출하며, 일반 사용자가 캐시·마일리지 지갑으로 예약·취소하는 모듈이다. 핵심 테이블은 TRAVEL_PACKAGE, TRAVEL_PACKAGE_BOOKING, TRAVEL_PACKAGE_REVISION, TRAVEL_PACKAGE_REVIEW_HISTORY 네 개다.

## 2. 왜 이렇게 설계했나

마켓플레이스는 "판매자가 올린 콘텐츠를 즉시 노출하면 안 된다"는 신뢰 문제를 다룬다. 게시글과 달리 패키지는 결제가 걸려 있어 잘못된 상품이 노출되면 금전 피해로 이어진다. 그래서 세 가지 설계 원칙을 적용했다.

- **상태 기계로 노출을 통제**한다. 판매자가 작성한 상품은 곧바로 사용자에게 보이지 않고, 관리자가 APPROVED로 바꾼 것만 목록에 뜬다.
- **승인 후 수정은 별도 리비전 흐름**으로 분리한다. 이미 승인되어 판매 중인 상품을 판매자가 임의로 바꾸면 사용자가 본 내용과 실제가 달라진다. 그래서 APPROVED 상태 상품의 수정은 원본을 건드리지 않고 TRAVEL_PACKAGE_REVISION에 별도 제안으로 쌓아 다시 검수받게 한다.
- **결제·취소는 트랜잭션으로 원자화**한다. 지갑 차감, 결제 이력, 예약 행 생성이 하나라도 실패하면 전부 롤백되어야 잔액과 예약이 어긋나지 않는다.

:::tip
패키지는 "공고가 아니라 거래"라는 점이 커뮤니티 게시글과 가장 큰 차이다. 그래서 소프트삭제 상태값(post_status 등) 대신, 결제·검수를 모두 표현하는 독립 status 컬럼(package_status, booking_status, revision_status)을 따로 둔다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo) 구조를 그대로 따른다.

| 레이어 | 클래스/파일 | 역할 |
| --- | --- | --- |
| Controller | `TravelPackageController` (`/packages`) | 목록·판매자 관리·예약·취소 엔드포인트 |
| Service | `TravelPackageServiceImpl` | 검증, 상태 전이, 결제·환불 트랜잭션 |
| Mapper | `TravelPackageMapper` (+ `TravelPackageMapper.xml`) | 패키지·예약·리비전·이력 SQL |
| 지갑 연동 | `WalletMapper` (myPage 모듈) | 잔액 잠금·차감·환불, 결제·지갑 이력 |
| 권한 | `UsersVO.canManagePackage()` / `canApprovePackage()` → `UserRole` | 판매자/관리자 역할 판정 |

핵심 테이블:

- `TRAVEL_PACKAGE` — 상품. `package_status`(DRAFT/PENDING/APPROVED/REJECTED/BLOCKED/DELETED), `seller_user_idx`, `spot_idx`, 가격·인원·기간, `booking_count` 캐시.
- `TRAVEL_PACKAGE_BOOKING` — 예약. `booking_status`(BOOKED/CANCELLED/COMPLETED), `used_cash`, `used_mileage`, `booking_no` 유니크.
- `TRAVEL_PACKAGE_REVISION` — 승인 후 수정 제안. `revision_status`(PENDING/APPROVED/REJECTED).
- `TRAVEL_PACKAGE_REVIEW_HISTORY` — 관리자 검수 이력(previous_status, new_status, review_reason).

판매자 자격은 `BUSINESS_ACCOUNT_APPLICATION`(사업자 신청 → 관리자 승인 → 역할 부여)으로 얻는다. `UserRole`에서 패키지 관리 가능 역할은 BUSINESS/PARTNER, 승인 가능 역할은 ADMIN/SUPERADMIN이다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 상품 상태 전이

```text
[판매자]  작성 ──save──> DRAFT ──submit──> PENDING
                          ^                    |
                          | reject             | approve
                          └──── REJECTED <──────┘
[관리자]                                APPROVED ──(판매 중)
승인 상품 수정 → REVISION(PENDING) → 관리자 승인 시 본문에 반영
```

전이 규칙은 서비스가 강제한다. 수정과 제출은 DRAFT/REJECTED에서만 허용되고, 승인·반려는 PENDING에서만 가능하다. 매퍼 UPDATE의 WHERE 절이 상태를 다시 검사하므로, 화면 우회로 잘못된 전이를 시도해도 `updated == 0`이 되어 예외로 막힌다.

```java
// updatePackage: 승인된 상품은 원본을 고치지 않고 리비전으로 우회
if (STATUS_APPROVED.equals(currentPackage.getPackageStatus())) {
    createRevisionRequest(sellerUserIdx, form);  // TRAVEL_PACKAGE_REVISION INSERT
    return;
}
```

### 예약 결제 흐름 (bookPackage, 단일 트랜잭션)

| 단계 | 동작 |
| --- | --- |
| 1 | `selectApprovedPackageForUpdate` — APPROVED + 기간 미만료 + 여행지 활성 상품을 FOR UPDATE 잠금 |
| 2 | 인원 검증(min_people ~ max_people), 총액 = 단가 × 인원 (오버플로 방지 multiplyExact) |
| 3 | `selectUserByIdxForUpdate` — 사용자 지갑 잠금. 마일리지 사용 상한은 총액의 30퍼센트, 1000원 단위 내림 |
| 4 | 잔액 검증 후 지갑 차감, 결제 이력(sourceType TRAVEL_PACKAGE) + 지갑 이력 기록 |
| 5 | 예약 행 INSERT(booking_no는 PKG- 접두 UUID), booking_count 증가 |

마일리지는 총액의 30퍼센트까지만, 나머지는 캐시로 결제하는 혼합결제다. 결제 수단은 마일리지 사용 여부에 따라 CASH 또는 CASH_MILEAGE로 기록된다.

### 취소·환불 (cancelPackageBooking)

BOOKED 상태 예약만 취소 가능하다. 예약과 지갑을 모두 FOR UPDATE로 잠근 뒤, 사용했던 캐시·마일리지를 그대로 되돌리고 booking_status를 CANCELLED로 바꾸며 booking_count를 감소시킨다. 환불 지갑 이력은 changeType REFUND로 별도 기록되어 결제 차감(USE)과 구분된다.

:::warning
현재 취소는 **전액 환불**이다. 출발일까지 남은 기간에 따른 취소 수수료나 부분 환불 정책은 구현되어 있지 않다. 매퍼 WHERE 절도 시간 조건 없이 booking_status = BOOKED만 검사한다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 기능 | 상태 |
| --- | --- |
| 판매자 등록·임시저장·승인요청(DRAFT/PENDING) | 구현됨 |
| 관리자 승인/반려 + 검수 이력 | 구현됨 |
| 승인 상품 수정 → 리비전 검수 | 구현됨 |
| 사용자 목록·검색·예약(캐시+마일리지 혼합) | 구현됨 |
| 예약 취소 + 지갑 환불 | 구현됨 (전액 환불) |
| 기간 만료·여행지 비활성 상품 노출 제외 | 구현됨 |
| 패키지 대표 이미지 업로드 | 구현됨 (로컬 파일 저장, 확장자 화이트리스트) |
| 취소 수수료·부분 환불 | 미구현 (계획) |
| 외부 결제 PG 직접 연동 | 자체 지갑 시뮬레이션 (캐시·마일리지 기반) |
| BLOCKED/DELETED 상태 운영 흐름 | 컬럼·필터는 존재, 일부 전환은 부분 구현 |

핵심 거래 흐름은 동작하지만, 실제 환불 정책과 외부 결제망 연동은 향후 과제다.

## 6. 면접 답변 3단계

1. **한 문장** — "판매자가 올린 여행 패키지를 관리자가 승인해야 노출되고, 사용자는 캐시·마일리지 지갑으로 예약·취소하는 위탁판매 커머스 모듈을 만들었습니다."
2. **설계 포인트** — "상품 노출을 status 기반 상태 기계로 통제했고, 승인 후 수정은 원본을 직접 바꾸지 않고 리비전 테이블로 분리해 재검수하게 했습니다. 결제·환불은 지갑과 예약을 함께 잠그는 단일 트랜잭션으로 묶어 잔액 정합성을 보장했습니다."
3. **한계 인정** — "취소는 현재 전액 환불만 되고 수수료·부분 환불 정책과 외부 PG 연동은 다음 단계로 남겨뒀습니다."

## 7. 꼬리질문 + 모범답안

:::details 승인된 패키지를 판매자가 수정하면 어떻게 되나요
원본 TRAVEL_PACKAGE는 그대로 두고 TRAVEL_PACKAGE_REVISION에 PENDING 제안을 만듭니다. 이미 PENDING 리비전이 있으면 중복 생성을 막습니다. 관리자가 승인하면 그 리비전 내용이 본문에 반영되고, 반려하면 본문은 변하지 않습니다. 판매 중 상품의 표시 내용과 검수 내용이 어긋나지 않게 하기 위한 분리입니다.
:::

:::details 동시에 같은 예약을 두 번 취소하거나 잔액을 두 번 차감하면요
예약과 사용자 지갑을 모두 SELECT FOR UPDATE로 잠근 뒤 처리합니다. 취소 UPDATE의 WHERE 절이 booking_status = BOOKED를 다시 확인하므로, 먼저 커밋된 취소가 상태를 CANCELLED로 바꾸면 두 번째 시도는 updated 0이 되어 예외로 막힙니다. 결제도 같은 방식으로 지갑을 잠가 이중 차감을 방지합니다.
:::

:::details 마일리지로 전액 결제할 수 있나요
없습니다. 마일리지 사용 상한은 총액의 30퍼센트이고 1000원 단위로 내림 적용합니다. 나머지는 캐시로 결제하는 혼합결제 구조라, 마일리지만으로는 결제가 완료되지 않습니다.
:::

:::details 만료된 패키지는 어떻게 처리되나요
package_status는 APPROVED로 남아 있어도, 사용자 목록·예약 조회 SQL이 end_date 기준으로 만료 상품을 제외합니다. 예약 시점에도 selectApprovedPackageForUpdate가 기간과 여행지 활성 여부를 다시 검사해, 화면 목록과 실제 예약 가능 여부의 시차를 막습니다.
:::

:::details 누가 패키지를 등록할 수 있나요
일반 USER는 등록할 수 없습니다. BUSINESS_ACCOUNT_APPLICATION으로 사업자 신청을 하고 관리자가 승인해 BUSINESS 또는 PARTNER 역할을 받은 사용자만 가능합니다. 컨트롤러는 매 요청마다 canManagePackage로 역할을 확인하고, 승인 권한은 ADMIN/SUPERADMIN으로 분리되어 있습니다.
:::

## 8. 직접 말해보기

- 패키지가 사용자에게 노출되기까지 거치는 상태를 순서대로 말해보세요.
- 승인 후 수정을 리비전으로 분리한 이유를 한 문장으로 설명해보세요.
- 예약 결제에서 FOR UPDATE 잠금이 무엇을 막는지 설명해보세요.
- 이 모듈의 현재 한계 두 가지와 개선 방향을 말해보세요.

## 퀴즈

<QuizBox question="패키지가 사용자 목록에 노출되려면 package_status가 어떤 값이어야 하는가" :choices="['DRAFT', 'PENDING', 'APPROVED', 'REJECTED']" :answer="2" explanation="판매자 작성은 DRAFT, 검수 요청은 PENDING이며, 관리자가 APPROVED로 바꾼 상품만 사용자 목록과 예약 조회에 노출된다." />

<QuizBox question="이미 APPROVED 상태인 패키지를 판매자가 수정하면 일어나는 일은" :choices="['원본 TRAVEL_PACKAGE가 즉시 변경된다', 'TRAVEL_PACKAGE_REVISION에 PENDING 제안이 생기고 재검수를 받는다', '수정이 차단되어 아무 일도 없다', '자동으로 REJECTED로 바뀐다']" :answer="1" explanation="승인된 상품은 원본을 직접 고치지 않고 리비전 테이블에 PENDING 제안으로 쌓여 관리자 재검수를 거친다. 검수 내용과 판매 중 표시 내용의 불일치를 막기 위함이다." />

<QuizBox question="예약 결제와 취소 환불에서 잔액 정합성을 보장하는 핵심 기법은" :choices="['예약 후 배치 작업으로 잔액을 재계산한다', '예약과 지갑을 FOR UPDATE로 잠그고 단일 트랜잭션으로 처리한다', '프런트엔드에서 잔액을 검증한다', '캐시와 마일리지를 별도 DB에 저장한다']" :answer="1" explanation="bookPackage와 cancelPackageBooking 모두 예약과 사용자 지갑을 SELECT FOR UPDATE로 잠근 뒤 차감 또는 환불을 단일 트랜잭션으로 수행해 이중 차감과 동시 취소를 막는다." />
