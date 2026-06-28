---
title: "네이티브 광고"
owner: B
domain: "커뮤니티·신고"
tags: ["광고"]
---

# 네이티브 광고

> 커뮤니티 목록·상세 흐름 안에 배너를 자연스럽게 끼워 넣고, 노출과 클릭을 서버에서 카운트해 UX를 해치지 않고 수익화한다.

## 1. 한 줄 정의

네이티브 광고는 `AD_CAMPAIGN` 테이블에 등록한 배너를 **슬롯 코드**별로 한 건씩 골라 커뮤니티 화면에 콘텐츠처럼 삽입하고, **노출(view) / 클릭(click)** 을 서버 카운터로 집계하는 경량 사내 광고 모듈이다. 외부 광고 네트워크 SDK 없이 자체 DB와 엔드포인트만으로 구성된다.

## 2. 왜 이렇게 설계했나

별도 광고 SDK를 붙이면 클라이언트 스크립트 의존, 트래킹 픽셀, 개인정보 이슈가 따라온다. TripTogether는 사내 패키지·항공권·커뮤니티 같은 자체 자산을 홍보하는 용도가 핵심이라, 무거운 외부 네트워크 대신 **DB 한 테이블 + 공개 엔드포인트 두 개**로 끝내는 쪽을 택했다.

설계의 중심 개념은 **슬롯(slot)** 이다. 화면의 특정 위치를 `slot_code`라는 문자열로 추상화해 두면, 광고 콘텐츠와 노출 위치가 분리된다. 관리자는 어떤 광고를 어느 슬롯에 걸지만 정하고, 코드는 슬롯 코드만 알면 된다. 새 노출 위치가 필요하면 서비스 인터페이스에 상수 한 줄을 추가하는 식으로 확장한다.

또 하나의 원칙은 **UX 비침습**이다. 광고는 목록·상세의 자연스러운 자리에 한 건만 들어가고(전면 광고·팝업 없음), 노출 집계는 사용자가 실제로 배너를 봤을 때만 fire-and-forget으로 보낸다. 광고 트래킹 실패가 본 화면 렌더링을 막지 않도록 카운트 증가는 try/catch로 감싸 삼킨다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo)에 그대로 얹혀 있다.

| 구성 요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 테이블 | `AD_CAMPAIGN` | 캠페인 1행 = 배너 1개 |
| VO | `AdCampaignVO` | 테이블 매핑 + `creatorNickname`(JOIN 전용) |
| 서비스 | `AdCampaignService` / `AdCampaignServiceImpl` | 슬롯 선택·트래킹·CRUD, 슬롯 코드 상수 보유 |
| 매퍼 | `AdCampaignMapper` + `AdCampaignMapper.xml` | 조회·증분 SQL |
| 공개 컨트롤러 | `AdPublicController` | 클릭 리다이렉트, 노출 집계 |
| 관리자 컨트롤러 | `AdminAdController` (`/admin/ads`) | 캠페인 CRUD·활성토글·이미지 업로드 |
| 노출 소비처 | `CommunityController` | 슬롯에서 광고 골라 모델에 주입 |
| 클라이언트 | `resources/js/common/ad-impression.js` | IntersectionObserver 노출 트래킹 |

`AD_CAMPAIGN`의 핵심 컬럼:

```text
ad_id, slot_code, title, image_url,
link_url, link_type(NONE/EXTERNAL/INTERNAL),
link_target_type(package/community/courses/explore/flight/shop/mypage/inquiry),
link_target_id,
start_at, end_at, is_active, sort_order,
view_count, click_count, created_by
KEY idx_ad_slot_active (slot_code, is_active)
KEY idx_ad_period (start_at, end_at)
```

현재 하드코딩된 슬롯은 두 개다. `community_list_top`(목록 상단)과 `community_detail_bottom`(상세 하단)이며, `AdCampaignService`의 `SLOT_COMMUNITY_LIST_TOP` / `SLOT_COMMUNITY_DETAIL_BOTTOM` 상수로 참조한다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 노출 선택 — pickForSlot

`CommunityController`는 화면을 렌더링할 때 슬롯 코드로 광고 한 건을 요청한다.

```java
model.addAttribute("currentAd",
    adCampaignService.pickForSlot(AdCampaignService.SLOT_COMMUNITY_LIST_TOP));
```

`pickForSlot`은 활성·기간 필터를 통과한 후보 중 하나를 고른다. 매퍼 `selectActiveBySlot`이 조건을 SQL로 거른다.

```text
WHERE slot_code = #{slotCode}
  AND is_active = 1
  AND (start_at IS NULL OR start_at <= NOW())   -- null = 즉시 시작
  AND (end_at   IS NULL OR end_at   >  NOW())   -- null = 무기한
ORDER BY sort_order ASC, created_at DESC
```

같은 `sort_order` 광고가 여러 개면 편향을 막기 위해 `ThreadLocalRandom`으로 그중 하나를 무작위 선택한다. 후보가 없으면 null을 반환하고, JSP는 `currentAd`가 비면 배너 영역 자체를 그리지 않는다.

### 노출 집계 — impression

배너가 그려지면 JSP가 `data-ad-id`를 심고, `ad-impression.js`가 IntersectionObserver로 **배너가 화면에 50% 이상 처음 들어온 순간** 단 한 번 POST를 쏜다.

```js
fetch(CTX + '/ad/' + adId + '/impression', {
    method: 'POST', keepalive: true
}).catch(function () {});
// 관찰 후 observer.unobserve → 한 배너당 1회만 집계
```

`AdPublicController.impression`이 받아 `view_count = view_count + 1`을 실행한다. 스크롤로 지나치지 않은 광고는 노출로 치지 않아, 단순 렌더 카운트보다 실제 viewability에 가깝다.

### 클릭 처리 — click 리다이렉트

배너 링크는 광고 원본 URL이 아니라 `/ad/{adId}/click`을 가리킨다. 컨트롤러가 클릭을 +1 하고 `link_type`에 따라 목적지를 정해 302로 보낸다.

| link_type | 동작 |
| --- | --- |
| `EXTERNAL` | `link_url`로 리다이렉트(비면 홈) |
| `INTERNAL` | `link_target_type` + `link_target_id`를 내부 라우트로 매핑 |
| `NONE` | 카운트만 +1, 홈으로 |

`INTERNAL`은 타입별로 분기한다. 예를 들어 `community`+id면 `/community/{id}`, id가 없으면 목록 `/community`로 보낸다. `package` 타입은 패키지 직접 진입 페이지가 없어, 클릭 시점에 해당 패키지의 `spot_idx`를 조회해 `/detail/{spotIdx}?openPackage={id}`로 보내 모달을 자동으로 연다. 조회 실패 시 `/packages` 목록으로 폴백한다.

링크 마크업에는 `rel="noopener sponsored"`, `target="_blank"`를 붙여 광고임을 표시하고 새 탭으로 연다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- `AD_CAMPAIGN` 테이블·VO·매퍼·서비스 전체
- 관리자 CRUD(`/admin/ads`): 등록·수정·활성 토글·삭제·Cloudinary 이미지 업로드
- 슬롯 기반 선택(`pickForSlot`) + 기간·활성 필터 + 동률 랜덤
- 커뮤니티 목록 상단/상세 하단 두 슬롯 실삽입
- 노출(IntersectionObserver)·클릭(302 리다이렉트) 서버 집계
- `EXTERNAL`/`INTERNAL`/`NONE` 링크 분기와 내부 라우트 매핑
:::

:::warning 제한·계획
- **슬롯은 커뮤니티 2곳에 하드코딩.** 슬롯 코드를 서비스 상수로 정의하므로 다른 도메인으로 늘리려면 코드 추가가 필요하다(런타임 설정 기반 슬롯 관리는 미구현).
- **타깃팅 없음.** 사용자 관심사·이력 기반 개인화 없이 슬롯 단위 단순 순환이다.
- **집계 단위가 단순 카운터.** `view_count`/`click_count` 누적 정수만 있고, 일자별·사용자별 트래킹 테이블이나 CTR 리포트 화면은 없다.
- **중복 클릭/노출 방지는 클라이언트측 1회 관찰뿐.** 서버측 어뷰징 방지(IP·세션 dedupe)는 별도 미구현.
:::

## 6. 면접 답변 3단계

1. **한 문장:** "커뮤니티 화면의 정해진 위치에 사내 배너를 콘텐츠처럼 끼워 넣고, 노출과 클릭을 서버에서 카운트하는 자체 네이티브 광고 모듈을 만들었습니다."
2. **설계 의도:** "외부 광고 SDK 없이 DB 한 테이블과 공개 엔드포인트 두 개로 끝내고, 화면 위치를 슬롯 코드로 추상화해 광고와 노출 위치를 분리했습니다. 노출은 IntersectionObserver로 실제 본 광고만 집계해 UX를 해치지 않게 했습니다."
3. **결과·한계:** "관리자가 캠페인을 등록하면 기간·활성 필터를 거쳐 슬롯에 자동 노출되고 클릭은 link_type에 따라 외부·내부 라우트로 리다이렉트됩니다. 다만 슬롯은 커뮤니티 두 곳에 하드코딩이고 개인화 타깃팅은 없어, 슬롯 동적화와 리포트가 다음 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details 노출 카운트를 서버 렌더 시점이 아니라 클라이언트 IntersectionObserver로 한 이유는?
서버에서 광고를 골라 모델에 넣는 순간 카운트하면, 스크롤로 한 번도 보지 못한 배너까지 노출로 잡혀 viewability가 과대 집계됩니다. IntersectionObserver로 배너가 화면에 50% 이상 처음 들어온 순간 한 번만 POST를 보내면 실제 본 노출에 더 가깝고, 한 배너당 unobserve로 1회만 집계됩니다.
:::

:::details 클릭을 광고 원본 URL로 직접 링크하지 않고 /ad/{id}/click을 경유시키는 이유는?
원본 URL로 직접 링크하면 클릭을 셀 방법이 없습니다. 서버 엔드포인트를 한 번 경유시키면 click_count를 올린 뒤 link_type에 따라 외부 URL이나 내부 라우트로 302 리다이렉트할 수 있어, 집계와 라우팅 분기를 한곳에서 처리합니다. INTERNAL 타입은 link_target_type과 id를 내부 경로로 매핑해, 광고가 사내 패키지나 게시글로 자연스럽게 이어집니다.
:::

:::details 같은 슬롯에 광고가 여러 개면 어떻게 한 개를 고르나?
selectActiveBySlot가 활성·기간 조건을 SQL로 거른 뒤 sort_order ASC, created_at DESC로 정렬합니다. 우선순위가 같은 sort_order가 여러 건이면 ThreadLocalRandom으로 그중 하나를 무작위 선택해, 항상 같은 광고만 노출되는 편향을 막습니다.
:::

:::details 광고 트래킹이 실패하면 사용자 화면은 어떻게 되나?
노출·클릭 증분은 서비스에서 try/catch로 감싸 예외를 로그만 남기고 삼킵니다. 클라이언트의 impression fetch도 catch로 무시하고 keepalive로 비동기 전송합니다. 트래킹 실패가 본 화면 렌더링이나 클릭 리다이렉트를 막지 않게 해, 광고 부가 기능 때문에 핵심 흐름이 깨지지 않도록 했습니다.
:::

:::details 슬롯을 더 많은 화면으로 확장하려면?
현재 슬롯 코드는 AdCampaignService에 상수로 정의돼 있고 커뮤니티 두 곳에서만 소비합니다. 새 위치를 추가하려면 슬롯 코드 상수를 정의하고, 해당 컨트롤러에서 pickForSlot으로 광고를 모델에 주입한 뒤 JSP에 data-ad-id 배너와 impression 스크립트를 붙이면 됩니다. 다만 슬롯이 코드 의존이라, 장기적으로는 런타임 설정 테이블 기반으로 슬롯을 동적 관리하는 게 개선 방향입니다.
:::

## 8. 직접 말해보기

- 슬롯이라는 추상화가 광고와 노출 위치를 어떻게 분리하는지 한 문장으로 설명해 보세요.
- pickForSlot이 후보를 거르는 세 가지 조건(활성·기간·정렬)과 동률 처리 방식을 말해 보세요.
- 노출 집계가 단순 서버 렌더 카운트보다 정확한 이유를 viewability 관점에서 설명해 보세요.
- link_type 세 가지(EXTERNAL/INTERNAL/NONE)의 클릭 동작 차이를 예로 들어 보세요.
- 현재 구조의 한계 두 가지와 각각의 개선 방향을 말해 보세요.

## 퀴즈

<QuizBox question="커뮤니티 화면에서 노출할 광고 한 건을 슬롯 코드로 골라 주는 서비스 메서드는?" :choices="['increaseView', 'pickForSlot', 'selectAll', 'resolveClickTarget']" :answer="1" explanation="pickForSlot이 활성·기간 필터를 통과한 후보 중 sort_order 정렬 후 동률이면 ThreadLocalRandom으로 한 건을 선택한다." />

<QuizBox question="광고 노출(impression) 집계가 서버 렌더 시점이 아니라 클라이언트에서 일어나는 방식으로 옳은 것은?" :choices="['페이지 로드 시 무조건 1회 카운트', '버튼 클릭 시 카운트', 'IntersectionObserver로 배너가 화면에 처음 들어온 순간 1회 POST', '스크롤 픽셀마다 카운트']" :answer="2" explanation="ad-impression.js가 IntersectionObserver로 배너가 viewport에 처음 들어온 순간 한 번만 POST를 보내고 unobserve 한다. 실제 본 노출만 집계해 viewability에 가깝다." />

<QuizBox question="배너 링크가 광고 원본 URL이 아니라 /ad/{id}/click 을 경유하는 가장 큰 이유는?" :choices="['보안 토큰을 붙이려고', '클릭을 +1 집계한 뒤 link_type에 따라 외부·내부로 리다이렉트하려고', '이미지를 캐싱하려고', '로그인 여부를 검사하려고']" :answer="1" explanation="엔드포인트를 경유시키면 click_count를 올린 뒤 link_type(EXTERNAL/INTERNAL/NONE)에 맞게 302 리다이렉트할 수 있어, 집계와 라우팅 분기를 한곳에서 처리한다." />
