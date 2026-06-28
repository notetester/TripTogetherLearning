---
title: "공개 코스 피드"
owner: D
domain: "여행 코스·AI 일정"
tags: ["공개피드"]
---

# 공개 코스 피드

> 사용자가 만든 여행 일정 중 is_public이 1인 것만 별도 피드로 모아 보여주고, 상세 화면에서는 소유자가 아니면 비공개 코스 열람과 수정을 모두 막는다.

이 페이지는 [여행 코스·AI 일정 도메인](/domains) 중 공개 코스 피드를 다룬다. 전체 흐름은 [전체 흐름](/flow/), 담당자 단위 정리는 [담당별 보기](/by-area/)에서 볼 수 있다.

## 1. 한 줄 정의

`TRAVEL_PLAN` 테이블의 일정 중 `is_public = 1`인 것만 `/courses/public` 피드로 노출하고, 코스 상세에서는 소유자 여부(`isOwner`)와 공개 여부(`isPublic`)를 조합해 열람 권한을 가르며, 열람자에게는 수정 버튼을 숨기는 기능이다.

## 2. 왜 이렇게 설계했나

- **개인 일정과 공유 일정의 분리**: 일정은 기본이 비공개(`is_public` 기본값 0)다. 사용자가 명시적으로 공개로 전환한 코스만 다른 사람이 참고할 수 있어야 하므로, 내 목록(`/courses/my`)과 공개 피드(`/courses/public`)를 다른 조회 경로로 나눴다.
- **즉시 공개**: 공개 전환에 별도 승인 단계를 두지 않는다. `is_public`이 1이 되는 순간 피드 쿼리(`WHERE tp.is_public = 1`)에 바로 잡혀 피드에 노출된다. 게시 워크플로 없이 토글 한 번으로 공유가 끝난다.
- **상세 열람은 두 갈래 권한**: 공개 피드를 거치지 않고 코스 상세 URL로 직접 들어오는 경로가 있으므로, 상세 단계에서 다시 권한을 검사한다. 소유자는 비공개여도 자기 코스를 보고, 비소유자는 공개 코스만 본다.
- **소프트삭제 일관성**: ADR-0008(소프트삭제)에 따라 삭제는 행을 지우지 않고 `is_deleted`로 표시한다. 피드와 상세 쿼리 모두 `is_deleted = 0` 조건을 걸어, 삭제된 코스가 공개 피드에 남는 사고를 막는다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

TripTogether 공통 4계층(controller → service → mapper → vo)을 그대로 따른다.

| 계층 | 구현체 |
| --- | --- |
| Controller | `TravelPlanController` (`/courses/**`) |
| Service | `TravelPlanService` 인터페이스 + `TravelPlanServiceImpl` |
| Mapper | `TravelPlanMapper` (`@Mapper`) + `resources/mapper/TravelPlanMapper.xml` |
| VO | `TravelPlanVO`, `PlanSpotVO` |
| 테이블 | `TRAVEL_PLAN`, `PLAN_SPOT`, `USERS`(닉네임 조인) |
| 뷰 | JSP `courses/public`, `courses/detail` |

핵심 컬럼 (`TRAVEL_PLAN`):

| 컬럼 | 역할 |
| --- | --- |
| `plan_id` | PK |
| `user_idx` | 작성자 (USERS FK). 소유권 판정 기준 |
| `is_public` | tinyint. 0 비공개(기본값), 1 공개 |
| `share_token` | 공유 토큰 (UNIQUE). 토큰 기반 공유용 컬럼 |
| `plan_source` | MANUAL 또는 AI. 직접 작성인지 AI 생성인지 |
| `is_deleted` | 0 또는 1. 소프트삭제 플래그 |

:::tip is_public과 share_token의 차이
`is_public`은 누구에게나 보이는 공개 피드 노출 여부이고, `share_token`은 비공개 코스를 링크로만 공유하기 위한 별도 컬럼이다. 현재 공개 피드 경로는 `is_public`만 사용한다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

**엔드포인트**

| 동작 | 메서드·경로 | 권한 |
| --- | --- | --- |
| 공개 피드 목록 | GET `/courses/public` | 로그인 필요 |
| 코스 상세 | GET `/courses/detail?planId=` | 로그인 + 소유자 또는 공개 |
| 내 코스 목록 | GET `/courses/my` | 로그인 + 본인 |

**공개 피드 쿼리** (`getPublicTravelList`): 작성자 닉네임을 함께 보여주려고 `USERS`를 조인하고, 공개이면서 삭제되지 않은 행만 최신순으로 모은다.

```sql
SELECT tp.plan_id, tp.title, tp.destination, tp.is_public,
       u.nickname AS nickname
FROM TRAVEL_PLAN tp
INNER JOIN USERS u ON tp.user_idx = u.user_idx
WHERE tp.is_public = 1
  AND tp.is_deleted = 0
ORDER BY tp.created_at DESC
```

**상세 권한 판정**: 상세 조회는 `planId`로 단건을 가져온 뒤 컨트롤러에서 권한을 계산한다. 여기서 중요한 점은, 상세 단건 쿼리(`getTravelPlanDetailByPlanId`)는 `is_deleted = 0`만 거르고 `is_public`은 거르지 않는다는 것이다. 공개 여부 판단을 SQL이 아니라 컨트롤러가 책임지기 때문에, 비공개라도 소유자는 통과시킬 수 있다.

```java
boolean isOwner  = travelPlan.getUser_idx().equals(userIdx);
boolean isPublic = travelPlan.getIs_public() != null
                   && travelPlan.getIs_public() == 1;

// 비소유자가 비공개 코스에 접근하면 차단
if (!isOwner && !isPublic) {
    return "redirect:/courses"; // 에러 메시지와 함께 되돌림
}
model.addAttribute("isOwner", isOwner);
```

**열람자에게 수정 버튼 숨김**: 상세 JSP에는 `isOwner` 플래그가 함께 전달된다. 다른 사람의 공개 코스를 열람하는 비소유자에게는 `isOwner`가 false이므로 수정·삭제 버튼이 렌더링되지 않는다. 즉 권한은 두 겹이다 — 화면에서 버튼을 숨기고(`isOwner`), 서버 수정 엔드포인트에서도 작성자 본인만 통과시킨다.

권한 조합을 정리하면 다음과 같다.

| 코스 상태 | 소유자 | 비소유자 |
| --- | --- | --- |
| 공개(is_public=1) | 열람 가능 + 수정 버튼 노출 | 열람 가능 + 수정 버튼 숨김 |
| 비공개(is_public=0) | 열람 가능 + 수정 버튼 노출 | 차단(코스 메인으로 리다이렉트) |

**다른 코스 참고 흐름**: 비소유자는 공개 피드에서 마음에 드는 코스를 열어보고, 직접 작성 또는 AI 일정 생성으로 자기 코스를 새로 만든다. 공개 코스를 그대로 복제해 가져오는 기능은 아직 없고, 열람과 참고까지가 현재 범위다.

## 5. 구현 상태 (됨 vs Mock/계획)

- 구현됨: `is_public = 1` 즉시 피드 노출, 작성자 닉네임 조인, 최신순 정렬, 소프트삭제 제외.
- 구현됨: 상세에서 `isOwner` / `isPublic` 조합 권한 판정, 비소유자 비공개 차단, 열람자 수정 버튼 미노출.
- 구현됨: 챗봇 컨텍스트용 공개 코스 키워드 검색(`searchPlansByKeywords`)도 같은 `is_public = 1` 기준을 공유한다.
- 계획/미구현: 공개 코스 복제·가져오기, 좋아요·즐겨찾기 같은 피드 상호작용, 페이지네이션(현재는 전체를 한 번에 조회). `share_token` 기반 링크 공유는 컬럼만 준비되어 있다.

:::warning 상세 쿼리는 공개 여부를 거르지 않는다
공개 여부 필터링이 상세 SQL이 아니라 컨트롤러에 있다. 이 설계 덕에 소유자는 비공개 코스도 볼 수 있지만, 권한 검사 코드가 빠지면 비공개가 노출될 수 있는 구조다. 그래서 차단 로직(`!isOwner && !isPublic`)이 핵심 안전장치다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: 일정은 기본 비공개이고, `is_public`을 1로 켠 코스만 공개 피드에 모여 다른 사용자가 참고할 수 있게 했습니다.
2. **설계 의도**: 내 목록과 공개 피드를 다른 조회 경로로 나눠 개인 일정과 공유 일정을 분리하고, 상세에서는 소유자 여부와 공개 여부를 조합해 권한을 다시 검사했습니다.
3. **트레이드오프**: 공개 전환에 승인 단계를 두지 않아 토글 즉시 노출되는 단순함을 택했고, 그 대신 상세 단계의 권한 차단 로직과 소프트삭제 필터가 정합성을 책임지도록 했습니다.

## 7. 꼬리질문 + 모범답안

:::details 비공개 코스 URL을 직접 입력하면 다른 사람이 볼 수 있나요?
못 봅니다. 상세 컨트롤러에서 소유자가 아니고 공개도 아니면(`!isOwner && !isPublic`) 코스 메인으로 리다이렉트합니다. 공개 피드 목록에 안 나오는 것과 별개로, 상세 진입 시점에 한 번 더 막습니다.
:::

:::details 공개 여부 필터를 상세 SQL에 넣지 않은 이유는?
소유자는 자기 비공개 코스를 봐야 하기 때문입니다. SQL에서 `is_public = 1`을 강제하면 소유자도 비공개 코스를 못 보게 됩니다. 그래서 단건 조회는 삭제 여부만 거르고, 공개 판정은 컨트롤러가 소유권과 함께 처리합니다.
:::

:::details 열람자에게 수정 버튼을 어떻게 숨기나요? 그게 보안인가요?
상세 모델에 `isOwner` 플래그를 넘겨 JSP에서 비소유자에게는 버튼을 렌더링하지 않습니다. 다만 버튼 숨김은 UX이고 실제 보안은 서버 수정 엔드포인트가 작성자 본인만 통과시키는 검사입니다. 화면과 서버 양쪽에서 막는 이중 방어입니다.
:::

:::details 공개로 바꾸면 언제 피드에 나오나요? 승인이 필요한가요?
승인 없이 즉시 나옵니다. 피드 쿼리가 `is_public = 1`을 기준으로 매번 조회하므로, 값이 1이 되는 순간 다음 피드 조회부터 노출됩니다.
:::

:::details 삭제한 코스가 공개 피드에 남지 않게 어떻게 보장하나요?
삭제는 소프트삭제라 행이 남지만 `is_deleted`가 1이 됩니다. 피드 쿼리와 상세 쿼리 모두 `is_deleted = 0` 조건을 걸어 삭제된 코스를 제외합니다.
:::

## 8. 직접 말해보기

- 공개 피드와 내 코스 목록을 왜 다른 경로로 나눴는지, 각각 어떤 조건으로 조회하는지 말해보세요.
- 비공개 코스 상세에 비소유자가 접근했을 때 어떤 일이 벌어지는지 코드 흐름으로 설명해보세요.
- 수정 버튼 숨김이 보안이 아니라 UX인 이유와, 실제 보안은 어디서 보장되는지 구분해 말해보세요.

## 퀴즈

<QuizBox question="공개 코스 피드 목록(getPublicTravelList)이 조회하는 코스의 조건으로 맞는 것은?" :choices="['is_public = 1 이고 is_deleted = 0', 'is_public 값과 무관하게 모든 코스', 'plan_source = AI 인 코스만', '본인이 작성한 코스만']" :answer="0" explanation="공개 피드 쿼리는 is_public = 1 그리고 is_deleted = 0 조건을 걸고 최신순으로 조회한다." />

<QuizBox question="비소유자가 비공개 코스 상세에 접근하면 어떻게 되는가?" :choices="['열람과 수정 모두 가능하다', '열람만 가능하고 수정은 막힌다', '차단되어 코스 메인으로 리다이렉트된다', '소유자에게 알림이 간다']" :answer="2" explanation="컨트롤러에서 소유자도 공개도 아니면(NOT isOwner AND NOT isPublic) 코스 메인으로 리다이렉트해 접근을 막는다." />

<QuizBox question="다른 사람의 공개 코스를 열람할 때 수정 버튼이 안 보이는 이유는?" :choices="['JSP에 전달된 isOwner 플래그가 false라서 버튼을 렌더링하지 않기 때문', '공개 코스는 누구나 수정할 수 있어서', '브라우저가 자동으로 숨겨서', 'is_deleted 가 1이라서']" :answer="0" explanation="상세 모델에 넘긴 isOwner 가 false면 비소유자에게 수정 버튼이 렌더링되지 않는다. 다만 실제 보안은 서버 수정 엔드포인트가 작성자만 통과시키는 검사로 보장한다." />
