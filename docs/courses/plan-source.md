---
title: "plan_source (MANUAL/AI)"
owner: D
domain: "여행 코스·AI 일정"
tags: ["plan_source"]
---

# plan_source (MANUAL/AI)

> 같은 여행일정 테이블에서 직접 작성한 코스와 AI가 생성한 코스를 한 컬럼으로 구분하는 출처 플래그.

## 1. 한 줄 정의

`plan_source`는 `TRAVEL_PLAN` 한 행의 일정이 사용자가 손으로 짠 것인지(`MANUAL`) AI가 만든 것인지(`AI`)를 표시하는 출처(provenance) 구분 컬럼이다. 직접 작성과 AI 생성을 **별도 테이블로 나누지 않고** 하나의 일정 모델 안에서 출처만 다르게 기록한다.

## 2. 왜 이렇게 설계했나

직접 작성 일정과 AI 일정은 화면에 보여줄 때 사실상 같은 구조다. 둘 다 제목·목적지·기간을 가지고, 날짜별 장소 목록(`plan_spot`)을 순서대로 펼친다. 차이는 "누가 채웠나"뿐이다.

- **단일 모델 + 출처 플래그**: 테이블을 둘로 쪼개면 목록 조회·상세 조회·공개 피드·수정·삭제를 전부 두 벌씩 만들어야 한다. 한 테이블에 `plan_source` 한 컬럼만 두면 조회/렌더링 로직을 공유하고, 필요할 때만 출처로 분기하거나 배지를 다르게 보여줄 수 있다.
- **안전한 기본값**: 컬럼은 `NOT NULL DEFAULT MANUAL`이다. 출처를 빠뜨려도 직접 작성으로 떨어지므로, 일반 작성 경로가 별도 처리 없이도 안전하게 동작한다.
- **출처는 보존, 권한·공개는 별도 컬럼**: `plan_source`는 "어떻게 만들어졌나"만 책임진다. 소유권은 `user_idx`, 공개 여부는 `is_public`, 생존 여부는 `is_deleted`가 따로 관리한다. 관심사를 분리해 두면 AI 일정도 직접 작성과 똑같이 공개/비공개를 토글하고 수정·삭제할 수 있다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 이름 | 역할 |
| --- | --- | --- |
| 테이블 | `TRAVEL_PLAN` | 일정 헤더. `plan_source varchar(20) NOT NULL DEFAULT MANUAL` |
| 테이블 | `plan_spot` | 날짜별 장소. `plan_id` FK + `visit_date` + `visit_order` |
| VO | `TravelPlanVO` | `private String plan_source;` 필드 보유 |
| 컨트롤러 | `TravelPlanController` | 직접 작성 경로. `/courses/insert`에서 plan_source를 MANUAL로 세팅 |
| 컨트롤러 | `AiPlanController` | AI 경로. `/courses/ai/generate` |
| 서비스 | `TravelPlanServiceImpl` | 일정 CRUD, 장소 재삽입 |
| 서비스 | `AiPlanServiceImpl` | AI 응답을 일정으로 저장. plan_source를 AI로 세팅 |
| 매퍼 | `TravelPlanMapper` (+ `TravelPlanMapper.xml`) | insert/조회/공개 피드 SQL |

핵심은 **출처 값을 컨트롤러/서비스가 명시적으로 박는다**는 점이다. 사용자 입력 폼이 plan_source를 직접 정하지 않는다.

```java
// 직접 작성 경로 — TravelPlanController.insertTravelPlan
travelPlanVO.setUser_idx(userIdx);
travelPlanVO.setPlan_source("MANUAL");
travelPlanService.insertTravelPlan(travelPlanVO);
```

```java
// AI 경로 — AiPlanServiceImpl.generateAndSavePlan
travelPlanVO.setIs_public(0);
travelPlanVO.setShare_token(null);
travelPlanVO.setPlan_source("AI");   // 출처를 AI로 고정
travelPlanService.insertTravelPlan(travelPlanVO);
```

## 4. 동작 원리 (흐름·표·작은 코드)

두 경로가 같은 `insertTravelPlan`으로 합류하되, 들어가는 `plan_source` 값만 다르다.

| 경로 | 진입점 | plan_source | 장소 출처 | spot_id |
| --- | --- | --- | --- | --- |
| 직접 작성 | `POST /courses/insert` | MANUAL | 사용자가 입력한 장소(또는 `SPOT_TRAVEL` 선택) | 선택 시 매핑, 자유 입력은 null |
| AI 생성 | `POST /courses/ai/generate` | AI | GPT가 만든 자유 장소명 | 항상 null |

AI 경로의 장소 저장은 의도적으로 `spot_id`를 비운다. AI가 만든 장소명은 실제 `SPOT_TRAVEL` 마스터와 매칭하지 않는 자유 텍스트이기 때문이다.

```java
// AiPlanServiceImpl.savePlanSpots — AI 장소는 spot_id 없이 place_name만 저장
planSpotVO.setPlan_id(planId);
planSpotVO.setSpot_id(null);              // 마스터 미매칭
planSpotVO.setPlace_name(spot.getName());
planSpotVO.setVisit_date(visitDate);
planSpotVO.setVisit_order(spot.getVisitOrder());
```

**목록·공개·여행상태별 분류 흐름**

- 내 일정 목록 `getTravelList`: `user_idx`로 본인 것만, `is_deleted = 0` 필터, `created_at DESC` 정렬. plan_source는 SELECT 결과에 함께 실려 화면에서 배지로 구분 가능.
- 공개 피드 `getPublicTravelList`: `is_public = 1 AND is_deleted = 0` 조건으로 모은 뒤 `USERS`와 조인해 작성자 닉네임을 붙인다. 여기서도 plan_source가 그대로 노출되어 MANUAL/AI를 함께 보여줄 수 있다.
- 상세 접근 가드 `detail`: 소유자거나(`isOwner`) 공개(`is_public == 1`)일 때만 열람 허용. 둘 다 아니면 비공개 타인 일정으로 보고 차단.

```java
// TravelPlanController.detail — 공개/비공개 + 소유권 분류
boolean isOwner  = travelPlan.getUser_idx().equals(userIdx);
boolean isPublic = travelPlan.getIs_public() != null && travelPlan.getIs_public() == 1;
if (!isOwner && !isPublic) {
    // 비공개 + 타인 => 접근 거부
    return "redirect:/courses";
}
```

여행 상태(예정/진행/종료)는 별도 상태 컬럼이 아니라 `start_date`·`end_date`와 오늘 날짜를 비교해 분류한다. plan_source는 이 시점 분류와 독립적이라, AI 일정도 직접 작성 일정과 똑같이 기간 기준으로 다뤄진다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- `plan_source` 컬럼과 MANUAL/AI 양방향 저장 경로 모두 동작.
- AI 일정은 GPT-4o-mini Structured Outputs(JSON Schema, strict=true)로 받은 응답을 `AiPlanResponseDTO`로 역직렬화해 `@Transactional`로 일정+장소를 함께 저장. 중간 실패 시 롤백.
- 내 목록/공개 피드/상세 가드/수정/삭제(소프트삭제 `is_deleted = 1`) 모두 동작.
:::

:::warning 한계·계획
- DB에 `plan_source` 값 자체에 대한 CHECK 제약은 없다. MANUAL/AI 두 값은 애플리케이션 코드가 보장한다.
- 수정 저장 시 폼에서 plan_source가 비어 오면 MANUAL로 보정한다. 즉 AI 일정을 편집 후 저장할 때 출처가 유지되려면 폼이 값을 함께 넘겨야 한다(현재는 빈 값이면 MANUAL로 떨어질 수 있는 지점).
- "AI 일정만 보기" 같은 plan_source 기준 전용 필터 화면은 아직 없다. 목록 쿼리는 출처로 분기하지 않고 전체를 내려준 뒤 화면에서 배지로 구분한다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "직접 작성과 AI 생성 일정을 같은 테이블에 담고, `plan_source` 한 컬럼(MANUAL/AI)으로 출처만 구분했습니다."
2. **설계 이유**: "두 일정의 데이터 구조와 렌더링이 사실상 동일해서, 테이블을 쪼개는 대신 출처 플래그로 통합했습니다. 조회·공개·수정·삭제 로직을 한 벌만 유지하면서, 필요할 때 배지나 분기로 출처를 구분합니다. 기본값을 MANUAL로 둬서 일반 작성 경로는 별도 처리가 없어도 안전합니다."
3. **확장**: "공개 여부는 `is_public`, 소유권은 `user_idx`, 생존은 `is_deleted`가 따로 책임지므로 출처와 권한·공개를 독립적으로 다룰 수 있습니다. AI 일정도 직접 작성과 똑같이 공개/비공개를 토글하고 편집할 수 있습니다."

## 7. 꼬리질문 + 모범답안

:::details 직접 작성과 AI 일정을 왜 한 테이블에 두었나
구조가 거의 같기 때문이다. 둘 다 제목·목적지·기간 헤더에 날짜별 장소 목록을 가진다. 테이블을 나누면 CRUD와 조회·공개 로직을 이중으로 유지해야 하고 공개 피드에서 둘을 합치기도 번거롭다. 출처는 `plan_source` 한 컬럼으로만 구분하고 나머지는 공유하는 편이 유지보수에 유리하다고 판단했다.
:::

:::details plan_source 값을 사용자 폼이 정하지 않는 이유는
출처는 신뢰할 수 있는 서버 경로가 결정해야 하기 때문이다. 직접 작성 컨트롤러는 무조건 MANUAL, AI 생성 서비스는 무조건 AI로 박는다. 폼 입력에 맡기면 위변조 여지가 생기고, 출처라는 사실 기록의 의미가 흐려진다.
:::

:::details AI 일정의 장소는 왜 spot_id가 비어 있나
AI가 생성한 장소명은 자유 텍스트라 실제 `SPOT_TRAVEL` 마스터와 매칭되지 않는다. 그래서 `place_name`만 저장하고 `spot_id`는 null로 둔다. 반대로 직접 작성에서 마스터 장소를 골랐다면 `spot_id`가 채워진다. 같은 `plan_spot` 테이블이지만 출처에 따라 매핑 여부가 달라진다.
:::

:::details 공개 피드에서 MANUAL과 AI를 구분해 보여줄 수 있나
공개 피드 쿼리는 `is_public = 1 AND is_deleted = 0`으로 거른 뒤 `plan_source`도 함께 SELECT한다. 따라서 화면에서 출처별 배지를 붙이거나 정렬·강조를 다르게 줄 수 있다. 현재는 동일 목록에 함께 노출하고, 출처 전용 필터 화면은 향후 과제로 남겨 두었다.
:::

:::details 출처 값에 잘못된 문자열이 들어가면
DB CHECK 제약은 없어서 컬럼 차원의 방어는 없다. 대신 값을 채우는 경로가 코드상 MANUAL/AI 두 곳뿐이라 애플리케이션이 불변식을 보장한다. 더 엄격히 하려면 enum이나 CHECK 제약, 혹은 저장 전 화이트리스트 검증을 추가하는 것이 개선 방향이다.
:::

## 8. 직접 말해보기

- `plan_source`가 무엇을 구분하고, 왜 테이블을 나누지 않았는지 30초로 설명해 보라.
- 직접 작성과 AI 생성이 같은 `insertTravelPlan`으로 합류하는데, 두 경로의 차이를 입력값 관점에서 말해 보라.
- 공개/비공개·소유권·출처·생존이 각각 어느 컬럼의 책임인지 한 문장씩 말해 보라.
- AI 일정의 `spot_id`가 null인 이유를 마스터 테이블 관점에서 설명해 보라.

관련 페이지: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="TRAVEL_PLAN의 plan_source 컬럼이 구분하는 것은 무엇인가?" :choices="['일정의 공개 여부', '일정이 직접 작성인지 AI 생성인지(출처)', '일정의 삭제 여부', '일정 소유자 식별자']" :answer="1" explanation="plan_source는 MANUAL과 AI 두 값으로 일정의 출처를 구분한다. 공개 여부는 is_public, 삭제 여부는 is_deleted, 소유자는 user_idx가 따로 담당한다." />

<QuizBox question="AI 경로에서 생성된 장소가 plan_spot에 저장될 때 spot_id가 null인 이유로 가장 적절한 것은?" :choices="['AI 일정은 장소를 저장하지 않기 때문', 'AI가 만든 자유 장소명은 SPOT_TRAVEL 마스터와 매칭되지 않기 때문', 'spot_id 컬럼이 존재하지 않기 때문', 'visit_order가 spot_id를 대신하기 때문']" :answer="1" explanation="AI가 생성한 장소명은 자유 텍스트라 실제 SPOT_TRAVEL 마스터와 매칭하지 않으므로 place_name만 저장하고 spot_id는 비워 둔다." />

<QuizBox question="직접 작성 경로에서 plan_source 값은 어떻게 정해지는가?" :choices="['사용자가 폼에서 직접 선택한다', 'DB 트리거가 자동으로 채운다', 'TravelPlanController가 서버에서 MANUAL로 세팅한다', 'AI 응답이 결정한다']" :answer="2" explanation="출처는 신뢰 가능한 서버 경로가 결정한다. 직접 작성 컨트롤러는 plan_source를 MANUAL로, AI 서비스는 AI로 명시적으로 세팅한다." />
