---
title: "스팟 순서 관리"
owner: D
domain: "여행 코스·AI 일정"
tags: ["PLAN_SPOT"]
---

# 스팟 순서 관리

> 여행 일정 안의 방문 장소들을 순서대로 저장하고, 수정 시에는 전체 삭제 후 재삽입으로 순서 무결성을 자동 보장한다.

## 1. 한 줄 정의

하나의 여행 일정(`TRAVEL_PLAN`)에 속한 방문 장소들을 `plan_spot` 테이블에 저장하고, `visit_date`와 `visit_order`로 하루 안에서의 순서를 표현하는 기능이다.

## 2. 왜 이렇게 설계했나

여행 코스는 단순한 장소 목록이 아니라 순서가 있는 시퀀스다. 1일차 오전에 어디를 먼저 가고 그다음 어디로 가는지가 핵심 정보다. 이 순서를 안정적으로 다루기 위한 세 가지 설계 결정이 있다.

- **순서를 명시적 정수 컬럼으로** — 행의 물리적 순서나 PK 증가 순서에 의존하지 않고 `visit_order` 정수 컬럼으로 순서를 명시한다. 사용자가 중간에 장소를 끼워 넣거나 순서를 바꿔도 정수만 다시 매기면 된다.
- **날짜로 그룹을 나눔** — 2박 3일 일정이면 1일차, 2일차 안에서 각각 순서가 있다. `visit_date`로 날짜 그룹을 만들고, 그 안에서 `visit_order`가 1부터 매겨진다.
- **수정은 전체 교체(delete-then-insert)** — 개별 행을 추적해 일부만 UPDATE/INSERT/DELETE 하는 diff 방식 대신, 해당 일정의 스팟을 전부 지우고 폼에서 넘어온 목록을 처음부터 다시 넣는다. 폼 제출 한 번이 곧 일정 전체의 새 스냅샷이라는 관점이다.

:::tip 왜 delete-then-insert인가
순서를 부분 갱신하면 "3번을 1번으로 옮기고 나머지를 한 칸씩 밀기" 같은 까다로운 재배치 로직과 중간 상태의 순서 충돌(UNIQUE 제약 위반)을 직접 다뤄야 한다. 전체 삭제 후 1부터 다시 매기면 항상 빈틈 없는 1, 2, 3 순서가 보장되고 로직이 단순해진다.
:::

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 계층 | 구성요소 | 역할 |
| --- | --- | --- |
| controller | `TravelPlanController` | `/courses/insert`, `/courses/edit`, `/courses/delete` 폼 처리, 세션 로그인·소유자 검증 |
| service | `TravelPlanService` / `TravelPlanServiceImpl` | 순서 번호 매기기, 빈 행 거르기, 수정 시 전체 삭제 후 재삽입 조율 |
| mapper | `TravelPlanMapper` + `TravelPlanMapper.xml` | `insertPlanSpot`, `deletePlanSpotsByPlanId`, `getPlanSpotListByPlanId` SQL |
| vo | `PlanSpotVO`, `TravelPlanVO` | 스팟 한 건과 일정 전체(스팟 목록 포함)를 담는 값 객체 |
| table | `plan_spot`, `TRAVEL_PLAN`, `SPOT_TRAVEL` | 스팟·일정·여행지 마스터 |

`plan_spot` 테이블 핵심 구조:

```sql
CREATE TABLE plan_spot (
  plan_spot_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  plan_id      BIGINT NOT NULL,
  spot_id      VARCHAR(255) NULL,        -- SPOT_TRAVEL 참조(직접 입력 장소는 NULL)
  place_name   VARCHAR(255) NOT NULL,
  visit_date   DATE NULL,
  visit_order  INT NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plan_spot_order (plan_id, visit_date, visit_order),
  CONSTRAINT fk_plan_spot_plan FOREIGN KEY (plan_id)
      REFERENCES TRAVEL_PLAN (plan_id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_spot_spot FOREIGN KEY (spot_id)
      REFERENCES SPOT_TRAVEL (spot_id) ON DELETE CASCADE
);
```

두 가지를 기억하면 된다. `UNIQUE (plan_id, visit_date, visit_order)`는 같은 일정의 같은 날짜 안에서 순서 번호가 겹치지 못하게 막는 안전망이고, `spot_id`가 `NULL` 가능하다는 점은 마스터에 없는 장소를 사용자가 이름으로 직접 입력할 수 있다는 뜻이다(이때는 `place_name`만 채워진다).

## 4. 동작 원리(흐름·표·작은 코드)

### 생성·수정 시 순서 번호 매기기

`TravelPlanServiceImpl.insertTravelPlan`은 폼에서 넘어온 `spotList`를 순회하며 순서를 1부터 부여한다. 핵심 로직만 추리면 다음과 같다.

```java
int order = 1;
for (PlanSpotVO spot : travelPlanVO.getSpotList()) {
    // 빈 spot_id 문자열은 NULL로 정규화(직접 입력 장소)
    if (spot.getSpot_id() != null && spot.getSpot_id().trim().isEmpty()) {
        spot.setSpot_id(null);
    }
    // 이름 없는 빈 행은 건너뜀
    if (spot.getPlace_name() == null || spot.getPlace_name().trim().isEmpty()) {
        continue;
    }
    spot.setPlan_id(travelPlanVO.getPlan_id());
    if (spot.getVisit_order() == null) {   // 폼이 순서를 안 보냈으면 서버가 매김
        spot.setVisit_order(order);
    }
    order++;
    travelPlanMapper.insertPlanSpot(spot);
}
```

빈 행을 거르고, 직접 입력 장소의 빈 `spot_id`를 `NULL`로 정규화하며, 순서가 비어 있으면 서버가 채운다.

### 수정 흐름: 전체 삭제 후 재삽입

`editTravelPlan`은 일정 본문을 UPDATE한 뒤, 그 일정의 스팟을 한 번에 비우고 새 목록을 다시 넣는다.

| 단계 | 호출 | 효과 |
| --- | --- | --- |
| 1 | `getTravelPlanDetail` | 소유자·존재 확인. 없으면 그대로 종료 |
| 2 | `editTravelPlan`(UPDATE) | 제목·목적지·기간·공개여부·plan_source 갱신 |
| 3 | `deletePlanSpotsByPlanId` | 해당 plan_id의 plan_spot 전체 DELETE |
| 4 | 루프 + `insertPlanSpot` | 폼 목록을 visit_order 1부터 재삽입 |

`deletePlanSpotsByPlanId`는 `DELETE FROM plan_spot WHERE plan_id = #{value}` 단 한 줄이다. 이 전체 교체 덕분에 순서 번호가 항상 1부터 빈틈 없이 다시 매겨지고, `UNIQUE` 제약과 충돌할 일이 없다.

### 조회 시 순서 정렬

`getPlanSpotListByPlanId`는 날짜 미정 스팟을 뒤로 보내고, 날짜·순서 오름차순으로 정렬한다.

```sql
ORDER BY
  CASE WHEN visit_date IS NULL THEN 1 ELSE 0 END,
  visit_date ASC,
  visit_order ASC
```

날짜가 `NULL`인 스팟은 정렬 키가 비어 뒤죽박죽되기 쉬운데, `CASE` 식으로 항상 목록 끝에 모으도록 했다.

### 일정 삭제와 연쇄

여기에 한 가지 중요한 구분이 있다. 테이블 FK는 `ON DELETE CASCADE`라서 `TRAVEL_PLAN` 행이 **물리적으로** 지워지면 `plan_spot`도 같이 사라진다. 하지만 `deleteTravelPlan`은 물리 삭제가 아니라 소프트 삭제다.

```sql
UPDATE TRAVEL_PLAN SET is_deleted = 1, updated_at = NOW()
WHERE plan_id = #{plan_id} AND user_idx = #{user_idx} AND is_deleted = 0
```

즉 일정 삭제 시 FK 캐스케이드는 **발동하지 않고**, `plan_spot` 행은 테이블에 남는다. 다만 조회 쿼리들이 `is_deleted = 0` 조건으로 삭제된 일정을 거르므로 사용자 화면에서는 보이지 않는다. 캐스케이드는 어디까지나 일정이 하드 DELETE될 때를 대비한 데이터 정합성 안전망이다.

## 5. 구현 상태(됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 스팟 생성·수정·삭제, visit_order 순서 저장 | 구현됨 |
| 직접 입력 장소(spot_id NULL) | 구현됨 |
| 날짜·순서 정렬 조회(NULL 날짜 후순위) | 구현됨 |
| UNIQUE 제약 기반 순서 무결성 | 구현됨 |
| 일정 소프트 삭제(is_deleted) | 구현됨 |
| AI 자동 일정의 스팟 적재(`AiPlanService`, GPT-4o-mini Structured Outputs) | 구현됨(같은 plan_spot에 적재) |

:::warning 솔직한 한계
- **서비스 계층에 명시적 트랜잭션 경계가 약하다.** 수정은 UPDATE 후 DELETE 후 다중 INSERT의 다단계 작업인데, 중간 실패 시 일부만 반영될 여지가 있다. 일정 단위 작업을 `@Transactional`로 묶는 것이 개선 과제다. (AI 일정 적재 경로는 별도로 트랜잭션 롤백을 갖춘 구현이 있다.)
- **순서 변경 UI는 폼 재제출 기반**이라 드래그 앤 드롭 같은 인터랙션은 화면 레이어 책임이며, 서버는 최종 목록을 통째로 받는다.
- **소프트 삭제된 일정의 plan_spot 행은 물리적으로 남는다.** 보관·복구에는 유리하지만, 장기적으로는 정리(purge) 배치가 필요할 수 있다.
:::

## 6. 면접 답변 3단계

1. **한 문장** — 여행 일정 안의 장소들을 plan_spot 테이블에 visit_date와 visit_order로 순서까지 저장하고, 수정할 때는 해당 일정 스팟을 전부 지운 뒤 1번부터 다시 넣어 순서 무결성을 자동으로 보장합니다.
2. **설계 이유** — 순서를 부분 갱신하면 재배치 로직과 중간 순서 충돌을 직접 다뤄야 해서 복잡하고 버그가 생기기 쉽습니다. 폼 제출을 일정 전체의 새 스냅샷으로 보고 전체 교체하면 항상 빈틈 없는 순서가 보장되고, plan_id, visit_date, visit_order에 건 UNIQUE 제약이 마지막 안전망이 됩니다.
3. **트레이드오프** — 매 수정마다 전체 삭제 후 재삽입이라 변경량이 적어도 쓰기가 많고, 다단계 작업이라 트랜잭션 경계를 잘 잡아야 합니다. 데이터가 수십 건 규모인 개인 여행 일정에서는 단순함이 주는 이득이 비용을 크게 웃돕니다.

## 7. 꼬리질문+모범답안

:::details 전체 삭제 후 재삽입이면 동시성 문제는 없나요
같은 일정을 같은 사용자가 두 탭에서 동시에 저장하는 드문 경우를 제외하면 충돌 여지는 작습니다. 일정은 user_idx로 소유자가 고정돼 있고 수정 권한도 본인뿐이라 경합 주체가 사실상 한 명입니다. 그래도 안전하게 하려면 일정 단위 작업을 하나의 트랜잭션으로 묶어 DELETE와 재INSERT가 원자적으로 처리되게 해야 합니다.
:::

:::details visit_order를 안 쓰고 created_at 순으로 정렬하면 안 되나요
삽입 시점 순서와 사용자가 원하는 방문 순서는 다릅니다. 나중에 추가한 장소를 1일차 맨 앞에 넣고 싶을 수 있는데 created_at 정렬로는 표현이 안 됩니다. visit_order는 사용자 의도를 직접 담는 명시적 순서라서 재배치가 자유롭습니다.
:::

:::details UNIQUE plan_id, visit_date, visit_order 제약이 실제로 막아주는 건 무엇인가요
같은 일정의 같은 날짜 안에서 두 장소가 같은 순서 번호를 갖는 상태를 DB 차원에서 차단합니다. 애플리케이션 로직이 1부터 매기므로 정상 흐름에서는 위반이 안 나지만, 코드 버그나 비정상 입력으로 중복 순서가 생기는 것을 마지막 방어선에서 거릅니다.
:::

:::details 일정을 삭제하면 plan_spot도 바로 지워지나요
FK는 ON DELETE CASCADE지만 일정 삭제가 소프트 삭제, 즉 is_deleted 플래그 UPDATE라서 캐스케이드는 발동하지 않습니다. plan_spot 행은 남고, 조회 쿼리가 is_deleted 0 조건으로 삭제된 일정을 걸러 화면에 안 보일 뿐입니다. 캐스케이드는 하드 DELETE가 일어날 때를 위한 정합성 안전망입니다.
:::

:::details spot_id가 NULL일 수 있는 이유는요
여행지 마스터 SPOT_TRAVEL에 없는 장소를 사용자가 이름으로 직접 입력할 수 있기 때문입니다. 이 경우 spot_id는 NULL이고 place_name만 채워집니다. 서비스 계층에서 빈 문자열 spot_id를 NULL로 정규화해 FK 무결성과 일관성을 맞춥니다.
:::

## 8. 직접 말해보기

- "이 기능을 모르는 동료에게 plan_spot의 visit_date와 visit_order 두 컬럼이 왜 둘 다 필요한지" 30초로 설명해 보라.
- "수정 시 왜 diff 방식이 아니라 전체 삭제 후 재삽입을 택했는지" 트레이드오프 포함해 말해 보라.
- "일정 삭제가 소프트 삭제라 FK 캐스케이드가 안 도는데, 그래도 캐스케이드를 걸어둔 이유"를 한 문장으로 답해 보라.

## 퀴즈

<QuizBox question="plan_spot 테이블에서 하루 안의 방문 순서를 표현하는 컬럼 조합으로 가장 알맞은 것은?" :choices="['plan_spot_id 단독', 'visit_date 와 visit_order', 'created_at 단독', 'spot_id 와 place_name']" :answer="1" explanation="visit_date 로 날짜 그룹을 나누고 그 안에서 visit_order 정수로 순서를 매긴다. UNIQUE 제약도 plan_id, visit_date, visit_order 조합에 걸려 있다." />

<QuizBox question="일정 수정 시 TravelPlanServiceImpl 이 스팟을 처리하는 방식은?" :choices="['바뀐 행만 골라 부분 UPDATE 한다', '기존 스팟을 전부 삭제한 뒤 폼 목록을 1번부터 재삽입한다', '기존 스팟은 두고 새 스팟만 INSERT 한다', '순서가 바뀐 행만 visit_order 를 UPDATE 한다']" :answer="1" explanation="deletePlanSpotsByPlanId 로 해당 일정 스팟을 전부 지운 뒤 insertPlanSpot 으로 1부터 재삽입한다. 이 전체 교체로 순서가 항상 빈틈 없이 보장되고 UNIQUE 충돌이 생기지 않는다." />

<QuizBox question="여행 일정을 삭제했을 때 plan_spot 행에 실제로 일어나는 일은?" :choices="['FK 캐스케이드로 즉시 함께 삭제된다', '소프트 삭제라 캐스케이드가 안 돌고 plan_spot 행은 남으며 조회에서만 걸러진다', '트리거가 별도로 plan_spot 을 비운다', 'visit_order 가 0 으로 초기화된다']" :answer="1" explanation="deleteTravelPlan 은 is_deleted 플래그를 1로 바꾸는 소프트 삭제다. 물리 DELETE 가 아니므로 ON DELETE CASCADE 가 발동하지 않고, 조회 쿼리가 is_deleted 0 조건으로 걸러 화면에서만 사라진다." />
