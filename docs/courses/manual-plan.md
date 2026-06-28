---
title: "직접 일정 작성"
owner: D
domain: "여행 코스·AI 일정"
tags: ["코스"]
---

# 직접 일정 작성

> 사용자가 제목·대표 목적지·여행 기간·방문 장소를 직접 채워 여행 일정을 만드는 기능. AI 생성 일정과 같은 테이블에 저장하되 `plan_source = MANUAL` 로 출처를 구분한다.

관련 페이지: [여행 코스 도메인 개요](/courses/) · [스팟 순서 관리](/courses/plan-spot-ordering) · [AI 일정 생성(GPT)](/courses/ai-plan-gpt) · [plan_source 구분](/courses/plan-source) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

`/courses/write` 폼에서 입력한 마스터 정보(제목·목적지·기간·공개 여부)와 N개의 방문 장소를, 부모 한 건(`TRAVEL_PLAN`) + 자식 N건(`plan_spot`)으로 한 번의 POST 요청에 저장하는 사용자 주도 일정 작성 흐름이다.

## 2. 왜 이렇게 설계했나

여행 일정은 본질적으로 **마스터-디테일** 구조다. 일정 하나에 제목·기간 같은 단일 속성이 있고, 그 아래에 순서를 가진 방문 장소가 여러 개 매달린다. 이를 두 테이블로 정규화하면 장소 추가·삭제·재정렬이 마스터에 영향을 주지 않는다.

- **AI 일정과 한 모델 공유**: 직접 작성이든 AI 생성이든 결과물은 똑같은 "일정"이다. 그래서 별도 테이블을 만들지 않고 `TRAVEL_PLAN` 하나를 공유하며, 출처만 `plan_source` 컬럼(`MANUAL` / `AI`)으로 구분한다. 목록·상세·삭제·소유권 로직을 한 벌만 유지하면 된다. ([plan_source 구분](/courses/plan-source))
- **순서를 데이터로 고정**: 방문 장소의 순서는 화면 정렬이 아니라 `plan_spot.visit_order` 정수 컬럼으로 영속화한다. 일자별 동선이 흐트러지지 않게 `(plan_id, visit_date, visit_order)` 에 유니크 제약을 둔다.
- **세션 인증 + 서버 강제 출처**: 누가 만들었는지는 클라이언트를 믿지 않는다. `user_idx` 는 세션의 `loginUser` 에서, `plan_source = MANUAL` 은 컨트롤러가 직접 세팅한다. 폼이 보낸 값으로 출처를 덮어쓰지 않는다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo)을 그대로 따른다.

| 계층 | 구성요소 | 역할 |
| --- | --- | --- |
| Controller | `TravelPlanController` | `GET /courses/write` 폼 노출, `POST /courses/insert` 저장 |
| Service | `TravelPlanService` / `TravelPlanServiceImpl` | 마스터 저장 후 자식 장소 루프 삽입, 빈 행 스킵·순서 채번 |
| Mapper | `TravelPlanMapper` + `TravelPlanMapper.xml` | `insertTravelPlan`, `insertPlanSpot` |
| VO | `TravelPlanVO`, `PlanSpotVO` | 폼 바인딩·DB 매핑 객체 |
| View | `courses/write.jsp` | 입력 폼·동적 장소 행·입력 요약 패널 |

데이터 모델(`TripTogetherDB.sql`):

```sql
-- 마스터: 일정 한 건
TRAVEL_PLAN(
  plan_id PK, user_idx FK, title, destination,
  start_date, end_date, is_public, share_token,
  plan_source DEFAULT MANUAL, is_deleted DEFAULT 0,
  created_at, updated_at)

-- 디테일: 방문 장소 N건
plan_spot(
  plan_spot_id PK, plan_id FK, spot_id,
  place_name NOT NULL, visit_date, visit_order NOT NULL,
  created_at,
  UNIQUE (plan_id, visit_date, visit_order))
```

`plan_spot.plan_id` 는 `TRAVEL_PLAN` 으로 `ON DELETE CASCADE` 라, 일정을 지우면 장소가 같이 정리된다. `spot_id` 는 탐색 도메인의 `SPOT_TRAVEL` 을 참조하는 선택 외래키이고, 직접 작성에서 장소를 손으로 입력하면 `spot_id` 없이 `place_name` 만 채울 수 있다.

## 4. 동작 원리(흐름·표·작은 코드)

### 폼 입력 항목(`/courses/write`)

| 화면 입력 | 폼 필드명 | 매핑 컬럼 |
| --- | --- | --- |
| 제목 | `title` | `TRAVEL_PLAN.title` |
| 대표 목적지 | `destination` | `TRAVEL_PLAN.destination` |
| 시작일 / 종료일 | `start_date` / `end_date` | 동일 컬럼(`yyyy-MM-dd`) |
| 공개 토글 | `is_public`(hidden, 0/1) | `TRAVEL_PLAN.is_public` |
| 방문 장소 행 | `spotList[i].place_name` 등 | `plan_spot.*` |

방문 장소는 동적으로 추가되는 행이고, 각 행은 장소명(`place_name`)·방문일(`visit_date`)·순서(`visit_order`)를 가진다. JSP 스크립트가 제출 직전에 행을 다시 인덱싱해 `spotList[0].place_name`, `spotList[1].visit_order` 형태의 이름을 부여하므로, 스프링이 이를 `TravelPlanVO.spotList` 의 `List<PlanSpotVO>` 로 바인딩한다.

### 저장 흐름

```text
[브라우저] POST /courses/insert  (title, destination, 기간, is_public, spotList[])
   │
[Controller] 세션에서 user_idx 확보 → 없으면 /auth/login 리다이렉트
   │          travelPlanVO.setUser_idx(userIdx)
   │          travelPlanVO.setPlan_source("MANUAL")   // 서버가 출처 강제
   ▼
[Service] insertTravelPlan(): 마스터 1건 insert → 생성된 plan_id 회수
   │       spotList 루프:
   │         - place_name 비면 그 행은 스킵
   │         - spot_id 가 빈 문자열이면 null 로 정규화
   │         - visit_order 없으면 1부터 자동 채번
   │         - 각 행에 plan_id 세팅 후 insertPlanSpot
   ▼
[결과] redirect:/courses/my  (성공 플래시 메시지)
```

핵심 코드(컨트롤러 — 출처를 서버에서 고정):

```java
travelPlanVO.setUser_idx(userIdx);
travelPlanVO.setPlan_source("MANUAL");
travelPlanService.insertTravelPlan(travelPlanVO);
return "redirect:/courses/my";
```

핵심 코드(서비스 — 빈 행 스킵 + 순서 채번):

```java
int order = 1;
for (PlanSpotVO spot : travelPlanVO.getSpotList()) {
    if (spot.getPlace_name() == null || spot.getPlace_name().trim().isEmpty())
        continue;                       // 장소명 없는 행은 무시
    spot.setPlan_id(travelPlanVO.getPlan_id());
    if (spot.getVisit_order() == null)
        spot.setVisit_order(order);     // 누락 시 입력 순서대로
    order++;
    travelPlanMapper.insertPlanSpot(spot);
}
```

`insertTravelPlan` 매퍼는 `useGeneratedKeys` 로 새 `plan_id` 를 VO에 돌려받기 때문에, 같은 요청 안에서 자식 장소들이 그 `plan_id` 를 곧바로 참조할 수 있다.

### 입력 요약 패널

폼 화면에는 입력값을 실시간으로 모아 보여주는 요약 박스가 있다. 제목·목적지·기간·장소 개수를 화면에서 바로 확인시켜, 제출 전에 빠진 항목을 사용자가 스스로 잡게 하는 UX 장치다. 서버 검증을 대신하지는 않는다.

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현됨
- `/courses/write` 폼, `/courses/insert` 저장, 마스터+장소 동시 삽입까지 동작한다.
- `plan_source = MANUAL` 서버 강제, 빈 장소 행 스킵, `visit_order` 자동 채번, 로그인 가드, 성공/실패 플래시 메시지 모두 구현되어 있다.
- 공개 토글(`is_public`)과 그에 따른 공개 피드 노출도 동작한다. ([공개 코스 피드](/courses/public-feed))
:::

:::warning 한계 · 주의점
- `insertTravelPlan` 서비스 메서드에 메서드 단위 `@Transactional` 이 명시돼 있지 않다. 같은 흐름의 **AI 일정 생성** 경로는 트랜잭션 롤백을 적용한다 — 직접 작성 경로도 마스터 insert 후 장소 루프 중간 실패 시 부분 저장 위험이 있어 보강 여지가 있다(코드 확인 후 판단 권장).
- 화면은 JSP 데스크톱 레이아웃 위주다. 모바일 반응형은 향후 과제.
- 장소를 손으로 입력하면 좌표·정규 주소가 없는 자유 텍스트라, 지도 표시 품질은 `spot_id` 연결 여부에 좌우된다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "사용자가 제목·기간·방문 장소를 직접 입력해 여행 일정을 만드는 기능으로, 일정 한 건과 방문 장소 여러 건을 마스터-디테일로 한 번에 저장합니다."
2. **설계 의도**: "AI 생성 일정과 결과물이 같으니 테이블을 공유하고 `plan_source` 컬럼으로 출처만 구분합니다. 작성자와 출처는 폼 값을 믿지 않고 세션·서버에서 강제합니다."
3. **구현 디테일**: "POST 한 번에 마스터를 먼저 넣어 `plan_id` 를 받고, 그 키로 방문 장소를 루프 삽입합니다. 장소명이 빈 행은 스킵하고 순서 컬럼이 비면 입력 순서대로 채번합니다. `(plan_id, visit_date, visit_order)` 유니크 제약으로 동선 순서를 데이터로 고정합니다."

## 7. 꼬리질문+모범답안

:::details 왜 일정과 장소를 두 테이블로 나눴나요
일정은 단일 속성(제목·기간)을 갖고 방문 장소는 순서를 가진 1대다 집합이라 본질이 다릅니다. 정규화하면 장소 추가·삭제·재정렬이 마스터에 영향을 주지 않고, 외래키 + ON DELETE CASCADE 로 일정 삭제 시 장소가 자동 정리됩니다.
:::

:::details plan_source 를 폼에서 받지 않고 서버에서 세팅하는 이유는
출처는 보안·집계의 기준이라 클라이언트가 바꾸면 안 됩니다. 직접 작성 경로의 컨트롤러는 무조건 MANUAL 로 세팅하고, 작성자 user_idx 도 세션에서만 가져옵니다. 폼 위변조로 출처나 소유자를 바꿀 수 없습니다.
:::

:::details visit_order 를 클라이언트가 안 보내면 어떻게 되나요
서비스가 입력 순서를 따라 1부터 채번합니다. 즉 순서 누락이 곧 저장 실패가 아니라, 사용자가 배열한 순서가 그대로 visit_order 로 굳어집니다. 명시적으로 순서를 보내면 그 값을 존중합니다.
:::

:::details 마스터는 저장됐는데 장소 삽입 중 하나가 실패하면
현재 직접 작성 서비스 메서드에는 메서드 단위 트랜잭션 선언이 분명하지 않아 부분 저장 위험이 있습니다. 같은 도메인의 AI 일정 경로는 롤백을 적용하므로, 직접 작성도 동일하게 트랜잭션 경계를 명시해 마스터와 장소를 원자적으로 묶는 것이 개선점입니다.
:::

:::details 빈 장소 행을 그냥 막지 않고 스킵하는 이유는
폼에서 행을 추가했다가 비워 두는 일이 흔합니다. 빈 행을 에러로 처리하면 사용자 경험이 나빠지므로, 장소명이 없는 행은 조용히 건너뛰고 채워진 행만 저장합니다. place_name 은 DB에서 NOT NULL 이라 빈 값이 새어 들어가면 안 되기도 합니다.
:::

## 8. 직접 말해보기

- 직접 일정 작성이 AI 일정 생성과 **무엇을 공유하고 무엇이 다른지** 30초로 설명해 보세요.
- POST 한 번에 마스터와 자식 N건을 저장하는 **순서**를 그림 없이 말로 풀어 보세요.
- "작성자와 출처를 서버에서 강제한다"는 말의 **보안적 의미**를 면접관에게 설명해 보세요.

## 퀴즈

<QuizBox question="직접 작성한 일정의 출처를 나타내는 TRAVEL_PLAN 컬럼 값은 무엇인가" :choices="['plan_source 가 AI', 'plan_source 가 MANUAL', 'is_public 이 1', 'share_token 이 NULL']" :answer="1" explanation="직접 작성 경로의 컨트롤러가 plan_source 를 MANUAL 로 서버에서 강제 세팅한다. AI 생성 경로는 같은 컬럼에 AI 를 넣어 출처를 구분한다." />

<QuizBox question="방문 장소 저장 흐름에서 마스터 일정을 먼저 저장하는 핵심 이유는 무엇인가" :choices="['공개 토글을 먼저 정해야 해서', '생성된 plan_id 를 받아 자식 장소가 참조해야 해서', 'visit_order 를 미리 알아야 해서', '세션 검증을 나중에 하려고']" :answer="1" explanation="마스터 insert 시 useGeneratedKeys 로 새 plan_id 를 회수하고, 같은 요청 안에서 자식 plan_spot 들이 그 plan_id 를 외래키로 참조해 삽입된다." />

<QuizBox question="방문 장소 행에서 visit_order 값이 비어 있을 때 서비스의 동작으로 옳은 것은" :choices="['저장을 중단하고 에러를 던진다', '그 행을 무조건 건너뛴다', '입력 순서대로 1부터 자동 채번한다', 'NULL 그대로 저장한다']" :answer="2" explanation="서비스는 visit_order 가 null 이면 루프 순서를 따라 1부터 채번한다. plan_spot.visit_order 는 NOT NULL 이라 빈 값이 그대로 들어갈 수 없다." />
