---
title: "CRUD·소유권"
owner: D
domain: "여행 코스·AI 일정"
tags: ["CRUD", "소유권"]
---

# CRUD·소유권

> 여행 일정의 목록·상세·생성·수정·삭제 전체에서, 로그인 여부와 작성자 본인 여부를 매 요청 서버에서 다시 검증해 남의 일정을 보거나 고치지 못하게 막는 접근 제어 흐름.

관련 페이지: [여행 코스 도메인 개요](/courses/) · [직접 일정 작성](/courses/manual-plan) · [공개 코스 피드](/courses/public-feed) · [스팟 순서 관리](/courses/plan-spot-ordering) · [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

`/courses/**` 의 모든 진입점이 세션 `loginUser` 로 로그인 가드를 통과시키고, 수정·삭제·비공개 상세는 추가로 일정의 `user_idx` 가 현재 사용자와 같은지(소유권)를 컨트롤러와 매퍼 양쪽에서 확인하는 CRUD 접근 제어 모델이다.

## 2. 왜 이렇게 설계했나

여행 일정은 개인 자료다. 내 일정을 남이 수정·삭제하면 안 되고, 비공개 일정은 작성자만 봐야 한다. 그래서 "누가 요청했는가"와 "이 일정의 주인이 누구인가"를 분리해 매 요청 검증한다.

- **단일 소유권 키**: 모든 일정은 `TRAVEL_PLAN.user_idx` 라는 하나의 작성자 키를 가진다. 소유권 판정은 전부 이 컬럼 비교로 환원되므로, 권한 규칙이 화면마다 흩어지지 않고 한 가지로 통일된다.
- **클라이언트를 믿지 않음**: `user_idx` 는 폼이나 쿼리스트링이 아니라 세션의 `loginUser` 에서만 가져온다. 사용자가 요청 파라미터로 보내는 것은 `planId` 뿐이고, 그 일정의 주인은 서버가 정한다.
- **이중 방어(컨트롤러 + 매퍼)**: 컨트롤러에서 `isOwner` 를 한 번 판정하고, 수정·삭제 매퍼 SQL의 WHERE 절에도 `user_idx = #{user_idx}` 를 박는다. 컨트롤러 가드를 우회해도 SQL이 대상 행을 못 잡아 0건 처리된다.
- **소프트 삭제와 결합**: 삭제는 행을 지우지 않고 `is_deleted = 1` 로 표시한다(ADR-0008). 모든 조회·수정 매퍼가 `is_deleted = 0` 을 조건에 달아, 삭제된 일정은 어떤 경로로도 다시 잡히지 않는다.

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo)을 그대로 따른다.

| 계층 | 구성요소 | 역할 |
| --- | --- | --- |
| Controller | `TravelPlanController` | `/courses/my`, `/courses/detail`, `/courses/edit`, `/courses/delete` 등 진입점별 로그인·소유권 가드 |
| Service | `TravelPlanService` / `TravelPlanServiceImpl` | 조회 후 자식 스팟 로딩, 저장/수정/삭제 위임, 존재 확인 |
| Mapper | `TravelPlanMapper` + `TravelPlanMapper.xml` | WHERE 절에 `user_idx`·`is_deleted` 조건을 내장한 CRUD SQL |
| VO | `TravelPlanVO`, `PlanSpotVO` | `plan_id`·`user_idx`·`is_public`·`spotList` 매핑 |
| View | `courses/my.jsp`, `courses/detail.jsp`, `courses/edit.jsp` | `isOwner` 로 수정·삭제 버튼 노출 제어 |

데이터 모델 핵심 컬럼(`TripTogetherDB.sql`):

```sql
TRAVEL_PLAN(
  plan_id PK, user_idx FK,      -- 소유권 키
  title, destination, start_date, end_date,
  is_public DEFAULT 0,          -- 공개 여부 토글
  is_deleted DEFAULT 0,         -- 소프트 삭제 플래그
  plan_source DEFAULT MANUAL,
  created_at, updated_at)
```

`user_idx` 는 `USERS` 로의 외래키이고, `is_public` 과 `is_deleted` 는 각각 공개/삭제 상태를 나타내는 `tinyint` 플래그다.

## 4. 동작 원리(흐름·표·작은 코드)

### 진입점별 가드 매트릭스

| 경로 | 메서드 | 로그인 필요 | 소유권 검사 | 비고 |
| --- | --- | --- | --- | --- |
| `/courses/my` | GET | O | O(목록 자체가 내 것만) | `user_idx` 로 필터 조회 |
| `/courses/public` | GET | O | X | 공개 일정만 노출 |
| `/courses/detail` | GET | O | 비공개면 본인만 | `isOwner` 또는 `is_public = 1` |
| `/courses/write` `/courses/insert` | GET/POST | O | 생성이라 본인 귀속 | `user_idx` 세션 강제 |
| `/courses/edit` | GET/POST | O | O | 본인 일정만 수정 폼·저장 |
| `/courses/delete` | POST | O | O | 소프트 삭제 |

### 로그인 가드(공통 첫 관문)

모든 핸들러가 동일 패턴으로 시작한다. 세션에서 `user_idx` 를 못 얻으면 로그인 페이지로 보낸다.

```java
Long userIdx = getLoginUserIdx(session);   // 세션 loginUser 에서만 추출
if (userIdx == null) {
    redirectAttributes.addFlashAttribute("errorMessage", msg("course.error.loginRequired"));
    return "redirect:/auth/login";
}
```

### 상세 조회의 공개·소유권 분기

상세는 비공개 일정을 남이 보지 못하게 두 조건을 함께 본다. 본인이거나 공개(`is_public = 1`)일 때만 통과한다.

```java
boolean isOwner  = travelPlan.getUser_idx().equals(userIdx);
boolean isPublic = travelPlan.getIs_public() != null && travelPlan.getIs_public() == 1;
if (!isOwner && !isPublic) {                 // 남의 비공개 일정 차단
    redirectAttributes.addFlashAttribute("errorMessage", msg("course.error.privateOwnerOnly"));
    return "redirect:/courses";
}
model.addAttribute("isOwner", isOwner);       // 화면이 수정·삭제 버튼 노출에 사용
```

### 수정·삭제의 이중 방어

수정 폼은 조회 결과의 `user_idx` 가 내 것과 다르면 차단한다. 그리고 실제 수정·삭제 매퍼 SQL은 WHERE 절에 소유권과 미삭제 조건을 함께 건다. 컨트롤러를 우회해도 대상 행이 안 잡혀 변경 0건이 된다.

```xml
<!-- 수정: 본인 + 미삭제 행만 -->
<update id="editTravelPlan">
  UPDATE TRAVEL_PLAN SET title = #{title}, ..., is_public = #{is_public}
  WHERE plan_id = #{plan_id}
    AND user_idx = #{user_idx}
    AND is_deleted = 0
</update>

<!-- 삭제: 행을 지우지 않고 플래그만 세움 -->
<update id="deleteTravelPlan">
  UPDATE TRAVEL_PLAN SET is_deleted = 1, updated_at = NOW()
  WHERE plan_id = #{plan_id}
    AND user_idx = #{user_idx}
    AND is_deleted = 0
</update>
```

### is_public 토글의 의미

`is_public` 은 작성자가 켜고 끄는 공개 스위치다. 1이면 공개 피드(`/courses/public`)와 남의 상세 접근이 열리고, 0이면 작성자만 상세를 볼 수 있다. 토글 값 자체는 수정 폼에서 저장하지만, 그 값을 바꿀 수 있는 사람은 소유권 검사를 통과한 작성자뿐이다.

### 전체 삭제 흐름

```text
[브라우저] POST /courses/delete  (planId)
   │
[Controller] 세션 user_idx 없음 → /auth/login
   │          VO 에 plan_id + user_idx(세션) 세팅
   ▼
[Service] 존재 확인(getTravelPlanDetail) → 없으면 조용히 종료
   ▼
[Mapper]  UPDATE ... SET is_deleted = 1
          WHERE plan_id=? AND user_idx=? AND is_deleted=0   // 남의 것은 0건
   ▼
[결과] redirect:/courses/my  (성공 플래시)
```

## 5. 구현 상태(됨 vs Mock/계획)

:::tip 구현됨
- 모든 `/courses/**` 진입점의 로그인 가드, 상세의 공개·소유권 분기, 수정·삭제의 컨트롤러+매퍼 이중 검사가 동작한다.
- 소프트 삭제(`is_deleted = 1`)와 전 매퍼의 `is_deleted = 0` 필터가 결합돼, 삭제된 일정은 목록·상세·수정 어디서도 다시 노출되지 않는다.
- `isOwner` 플래그가 화면에 전달돼, 수정·삭제 버튼이 본인에게만 보인다.
- `is_public` 토글에 따라 공개 피드 노출과 남의 상세 접근 허용이 갈린다. ([공개 코스 피드](/courses/public-feed))
:::

:::warning 한계 · 주의점
- 권한 검사는 이 도메인 컨트롤러 안의 명시적 if 분기에 의존한다. 일부 다른 도메인이 쓰는 AOP `@RequireLogin`(`AuthorizationAspect`) 같은 선언적 가드로 통일하면 누락 위험을 더 줄일 수 있다.
- 수정·삭제는 GET 폼 조회 시점과 POST 실행 시점 사이의 상태 변화를 별도로 잠그지 않는다. 동시 편집·삭제 시점 충돌은 매퍼의 `is_deleted = 0` 조건으로 변경 0건 처리될 뿐, 사용자에게 충돌을 알리는 흐름은 향후 과제다.
- 화면은 JSP 데스크톱 레이아웃 위주이며, 모바일 반응형은 향후 과제다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "여행 일정의 모든 CRUD에서 로그인 여부와 작성자 본인 여부를 매 요청 서버에서 다시 확인해, 남의 일정을 보거나 고치지 못하게 합니다."
2. **설계 의도**: "작성자 키는 `TRAVEL_PLAN.user_idx` 하나로 통일하고, 그 값은 폼이 아니라 세션에서만 가져옵니다. 클라이언트가 보내는 건 `planId` 뿐이고 주인은 서버가 정합니다."
3. **구현 디테일**: "상세는 본인이거나 `is_public = 1` 일 때만 통과시키고, 수정·삭제는 컨트롤러에서 한 번, 매퍼 WHERE 절에서 또 한 번 `user_idx` 를 확인합니다. 삭제는 행을 지우지 않고 `is_deleted = 1` 로 두고, 모든 조회가 `is_deleted = 0` 을 조건으로 답니다."

## 7. 꼬리질문+모범답안

:::details user_idx 를 폼이 아니라 세션에서 가져오는 이유는
작성자는 보안·소유권의 기준이라 클라이언트가 바꾸면 안 됩니다. 폼이나 쿼리스트링으로 `user_idx` 를 받으면 위변조로 남의 일정을 자기 것으로 만들거나 남의 일정을 조작할 수 있습니다. 그래서 `user_idx` 는 세션 `loginUser` 에서만 추출하고, 사용자가 보내는 값은 `planId` 로 제한합니다.
:::

:::details 컨트롤러에서 이미 isOwner 를 검사하는데 매퍼 WHERE 절에 또 user_idx 를 거는 이유는
방어를 한 겹만 두면 그 겹이 뚫렸을 때 그대로 사고가 됩니다. 컨트롤러 가드는 실수로 빠질 수 있고 새 경로가 추가되며 누락될 수 있습니다. 매퍼 SQL이 `user_idx = ? AND is_deleted = 0` 을 늘 달면, 컨트롤러를 우회한 요청이 와도 대상 행을 못 잡아 변경 0건으로 끝나 데이터가 안전합니다.
:::

:::details 비공개 일정 상세는 어떻게 막나요
상세 컨트롤러가 두 불리언을 봅니다. `isOwner` 는 일정의 `user_idx` 가 현재 사용자와 같은지, `isPublic` 은 `is_public` 이 1인지입니다. 둘 다 거짓이면, 즉 남의 비공개 일정이면 목록으로 리다이렉트하고 안내 메시지를 띄웁니다. 본인이거나 공개일 때만 상세가 열립니다.
:::

:::details 삭제를 물리 삭제가 아니라 is_deleted 플래그로 하는 이유는
운영상 신고·감사·복구를 위해 데이터를 즉시 파기하지 않는 소프트 삭제 정책(ADR-0008)을 따릅니다. 삭제는 `is_deleted = 1` 로 표시만 하고, 목록·상세·수정 매퍼가 모두 `is_deleted = 0` 을 조건에 달아 사용자에게는 사라진 것처럼 보입니다. 외래키 `ON DELETE CASCADE` 로 인한 연쇄 물리 삭제도 피할 수 있습니다.
:::

:::details 로그인하지 않은 사용자가 /courses/detail 에 직접 URL 로 접근하면
모든 핸들러의 첫 관문이 세션에서 `user_idx` 를 꺼내는 로그인 가드입니다. 세션에 `loginUser` 가 없으면 `user_idx` 가 null 이 되고, 상세를 포함한 어떤 진입점이든 곧바로 `/auth/login` 으로 리다이렉트합니다. 비로그인 상태로는 일정 데이터에 도달하지 못합니다.
:::

## 8. 직접 말해보기

- "작성자를 세션에서만 가져온다"가 왜 보안적으로 중요한지 30초로 설명해 보세요.
- 컨트롤러 가드와 매퍼 WHERE 절의 **이중 방어**가 각각 무엇을 막는지 구분해 말해 보세요.
- 상세 조회에서 `isOwner` 와 `is_public` 두 조건이 어떻게 조합되는지 그림 없이 풀어 보세요.

## 퀴즈

<QuizBox question="비공개 일정의 상세 페이지를 작성자가 아닌 다른 로그인 사용자가 요청했을 때 서버의 동작으로 옳은 것은" :choices="['그냥 보여준다', 'isOwner 와 is_public 이 모두 거짓이라 목록으로 리다이렉트한다', '관리자에게 알림을 보낸다', '비공개여도 본인 여부는 안 본다']" :answer="1" explanation="상세 컨트롤러는 isOwner 또는 is_public 이 1 일 때만 통과시킨다. 남의 비공개 일정은 둘 다 거짓이라 안내 메시지와 함께 목록으로 리다이렉트한다." />

<QuizBox question="수정·삭제 매퍼 SQL의 WHERE 절에 user_idx 조건을 함께 거는 주된 이유는" :choices="['쿼리 속도를 높이려고', '컨트롤러 가드를 우회한 요청도 대상 행을 못 잡아 변경 0건이 되게 하려고', 'is_public 을 자동 계산하려고', '정렬 순서를 고정하려고']" :answer="1" explanation="컨트롤러 검사와 매퍼 검사의 이중 방어다. 매퍼가 user_idx 와 is_deleted 조건을 늘 달면 컨트롤러를 우회한 요청이 와도 남의 행을 못 잡아 안전하게 0건 처리된다." />

<QuizBox question="여행 일정 삭제 시 실제 DB에서 일어나는 일로 옳은 것은" :choices="['행이 물리적으로 삭제된다', 'is_deleted 가 1 로 바뀌고 조회 매퍼는 is_deleted = 0 만 보므로 사라진 것처럼 보인다', 'is_public 이 0 으로 바뀐다', 'plan_source 가 DELETED 로 바뀐다']" :answer="1" explanation="소프트 삭제 정책에 따라 행을 지우지 않고 is_deleted 를 1 로 표시한다. 목록·상세·수정 매퍼가 모두 is_deleted = 0 을 조건에 달아 사용자에게는 보이지 않는다." />
