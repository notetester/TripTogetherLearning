---
title: "찜·좋아요·지도"
owner: C
domain: "여행지 탐색·커머스"
tags: ["찜", "지도"]
---

# 찜·좋아요·지도

> 여행지를 다시 찾기 위한 찜(SPOT_FAVORITE)과 인기 신호인 좋아요(SPOT_LIKE)는 둘 다 사용자-여행지 쌍에 UNIQUE를 걸어 중복을 막고, 상세 페이지의 위치는 Google Maps API로 출발지-목적지 두 마커와 경로선으로 시각화한다.

## 1. 한 줄 정의

찜은 "내가 나중에 볼 여행지" 개인 북마크이고, 좋아요는 "이 여행지가 좋다"는 공개 인기 신호이며, 지도는 여행지 상세에서 위도·경도를 받아 출발지(서울)와 목적지를 한 화면에 그리는 위치 시각화다.

## 2. 왜 이렇게 설계했나

찜과 좋아요는 화면상 비슷해 보이지만 데이터 의미와 쓰임이 다르다. 그래서 별도 테이블로 분리했다.

- **의미 분리**: 찜은 개인의 재방문 목록(탐색 화면의 찜 탭으로 다시 모아 본다). 좋아요는 여행지의 인기 순위를 만드는 집계 신호(좋아요순 목록 정렬에 쓴다).
- **중복 방지**: 같은 사용자가 같은 여행지를 두 번 찜하거나 좋아요하는 건 의미가 없다. 그래서 둘 다 `(user_idx, spot_idx)`에 UNIQUE 제약을 둔다. 동시 요청이나 더블클릭이 와도 DB 레벨에서 한 행만 남는다.
- **토글 UX**: 같은 버튼을 다시 누르면 해제된다. 추가/삭제 두 동작을 한 엔드포인트에서 처리해 프런트가 상태를 따로 관리할 필요가 없다.
- **지도 분리**: 위치는 텍스트 주소만으로 감이 안 온다. 좌표를 가진 여행지는 지도로 보여주되, 좌표가 없으면 지도 영역 자체를 숨겨 빈 회색 박스가 뜨지 않게 한다.

:::tip 찜 테이블에는 PK가 별도로 있는데 좋아요는 왜 없나
`SPOT_FAVORITE`는 외부 노출용 `fav_id`와 PK `fav_idx`를 따로 둔다(찜 항목 자체를 식별·노출할 일이 있어서). `SPOT_LIKE`는 단순 집계 신호라 `(user_idx, spot_idx)` 복합 PK만으로 충분하다. 같은 UNIQUE 의도를 한쪽은 보조 UNIQUE 키로, 한쪽은 PK 자체로 표현한 차이다.
:::

## 3. 어떤 기술로 구현했나

실제 클래스·테이블·엔드포인트 기준이다.

| 구성 | 위치 |
| --- | --- |
| 찜 토글 API | `ExploreController` `POST /explore/favorite/{spotIdx}` |
| 좋아요 토글 API | `ExploreController` `POST /explore/like/{spotIdx}` |
| 토글 로직 | `ExploreServiceImpl.toggleFavorite` / `toggleLike` |
| SQL 매퍼 | `exploreMapper.xml` (`insertFavorite`/`deleteFavorite`/`insertLike`/`deleteLike`) |
| 찜 테이블 | `SPOT_FAVORITE` (UNIQUE `uk_user_spot` = user_idx, spot_idx) |
| 좋아요 테이블 | `SPOT_LIKE` (PK = user_idx, spot_idx) |
| 여행지·좌표 | `SPOT_TRAVEL` (`latitude`, `longitude` double) |
| 지도 키 주입 | `DetailController` `@Value("${google.maps.api-key}")` → `model` `mapsApiKey` |
| 지도 렌더 | `detail.jsp` Google Maps JS(`google.maps.Map`, `Marker`, `OverlayView`) |
| 인증 | `@RequireLogin` + `@LoginUser`(세션 `loginUser` 주입) |

좋아요는 추가 시 리워드와 연결된다. `toggleLike`는 좋아요를 새로 누른 경우, 누른 사람과 여행지 등록자가 다르면 `rewardService.awardAction`으로 실행 보상(`SPOT_LIKE_ACTION`)과 수신 보상(`SPOT_LIKE`)을 각각 적립한다(자기 여행지 좋아요는 보상 없음).

지도 API 키는 자리표시자로만 다룬다. 설정 키 이름은 `google.maps.api-key`이고, 실제 값은 `API_KEY` 형태의 환경/설정 값으로 주입한다.

## 4. 동작 원리

### 토글 흐름 (찜·좋아요 공통 패턴)

```text
사용자 버튼 클릭
  → POST /explore/favorite/{spotIdx}   (@RequireLogin 통과 필요)
  → service.toggleFavorite(spotIdx, userIdx)
      이미 있음?  → deleteFavorite → return false (해제)
      없음?       → insertFavorite → return true  (추가)
  → JSON { favorited: true/false } 응답 → 버튼 아이콘 갱신
```

서비스는 먼저 카운트로 존재 여부를 확인하고 추가/삭제를 가른다. 핵심은 INSERT가 `INSERT IGNORE`라는 점이다.

```sql
-- insertFavorite / insertLike (개념)
INSERT IGNORE INTO SPOT_FAVORITE (user_idx, spot_idx, created_at)
VALUES (userIdx, spotIdx, NOW());
```

`INSERT IGNORE`는 UNIQUE 충돌 시 에러 대신 무시한다. 즉 "확인 후 INSERT" 사이에 같은 요청이 한 번 더 들어와도, UNIQUE 제약과 IGNORE가 합쳐져 행이 두 개로 늘지 않는다. 애플리케이션 검사(선 확인)와 DB 제약(UNIQUE)이 이중 안전망을 이룬다.

### 좋아요 수 집계

목록의 좋아요 수는 캐시 컬럼이 아니라 조회 시점에 `SPOT_LIKE`를 실시간 COUNT 한다. 좋아요순 정렬도 이 실시간 카운트(`like_count_real`) 기준으로 내림차순 정렬한다. 토글이 즉시 순위에 반영되고 캐시 동기화 문제가 없다.

### 지도 렌더 흐름

| 단계 | 동작 |
| --- | --- |
| 1 | `DetailController`가 `mapsApiKey`와 spot 좌표를 모델에 담아 `detail.jsp` 전달 |
| 2 | 위도·경도가 없으면 지도 영역을 그리지 않음(안내 문구 대체) |
| 3 | 좌표가 있으면 Google Maps 로드, 목적지 마커 + 서울 마커 2개 생성 |
| 4 | 두 좌표를 `LatLngBounds`로 묶어 `fitBounds`로 자동 줌·센터 |
| 5 | 출발지-목적지 경로선과 도시 라벨(커스텀 `OverlayView`) 표시 |

서울을 기준 출발지로 두 점을 한 화면에 담아, 사용자가 "서울에서 이만큼 떨어진 곳"이라는 거리 감각을 바로 얻게 한다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨**: 찜 토글·좋아요 토글·UNIQUE 중복 방지·`INSERT IGNORE`, 탐색 화면 찜 탭(`SPOT_FAVORITE` JOIN), 좋아요순 실시간 정렬, 좋아요 적립(자기 여행지 제외), 상세 페이지 Google Maps 마커·경로·자동 줌, 좌표 없을 때 지도 숨김.
- **부분/주의**: 좋아요 수를 매 조회마다 COUNT 하므로 데이터가 매우 커지면 집계 비용이 늘 수 있다(현재 규모에서는 단순·정확함이 우선). 지도 출발지는 서울로 고정(사용자 현재 위치 기반 거리 계산은 아님).
- **계획/외부 의존**: 지도 키는 운영 환경에서 도메인 제한된 키로 분리 관리 필요(코드/문서에는 자리표시자만). 찜 기반 개인화 추천 가중치 결합은 추천 도메인 쪽 과제로 남아 있음.

:::warning 키는 절대 코드에 박지 않는다
지도 API 키는 클라이언트로 내려가는 값이라 노출 자체는 불가피하지만, 콘솔에서 HTTP 리퍼러·API 범위를 제한해야 한다. 저장소·문서에는 `API_KEY` 같은 자리표시자만 남기고 실제 값은 설정으로 주입한다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: "찜과 좋아요는 의미가 달라 테이블을 나눴고, 둘 다 사용자-여행지 쌍 UNIQUE로 중복을 막은 토글 기능입니다. 상세 페이지 위치는 Google Maps로 출발지·목적지 두 마커로 그립니다."
2. **설계 이유**: "찜은 개인 재방문 목록, 좋아요는 공개 인기 신호라 쓰임이 다릅니다. UNIQUE 제약과 INSERT IGNORE를 같이 써서 더블클릭이나 동시 요청에도 행이 중복되지 않게 했고, 좋아요 수는 실시간 COUNT로 정렬해 캐시 불일치를 없앴습니다."
3. **트레이드오프**: "좋아요를 캐시 컬럼 대신 매번 집계해 정확성과 단순함을 택했고, 규모가 커지면 캐시 컬럼+이벤트 갱신으로 바꿀 수 있습니다. 지도 출발지는 서울 고정이라 사용자 위치 기반 거리로 확장할 여지가 있습니다."

## 7. 꼬리질문 + 모범답안

:::details 동시에 같은 여행지를 두 번 찜하면 행이 둘 생기지 않나
아니요. `(user_idx, spot_idx)`에 UNIQUE 제약이 있고 INSERT가 `INSERT IGNORE`라, 두 번째 요청은 충돌해도 에러 없이 무시되어 한 행만 남습니다. 서비스의 선 확인 로직은 사용자 응답(추가/해제 표시)을 정하기 위한 것이고, 정합성의 최종 보증은 DB UNIQUE입니다.
:::

:::details 좋아요 수를 캐시 컬럼에 두지 않고 매번 COUNT 하면 느리지 않나
현재 규모에서는 `spot_idx` 인덱스로 COUNT가 충분히 빠르고, 캐시 컬럼을 두면 토글마다 증감 갱신이 필요해 불일치 위험이 생깁니다. 정확성과 단순함을 우선했고, 트래픽이 커지면 캐시 컬럼에 증감 이벤트를 반영하거나 주기적 재집계로 전환할 수 있습니다.
:::

:::details 찜과 좋아요를 한 테이블에 type 컬럼으로 합치지 않은 이유는
의미·수명·쿼리 패턴이 달라서입니다. 찜은 사용자별 목록 조회(JOIN)와 외부 노출 ID가 필요하고, 좋아요는 여행지별 집계 정렬이 주 쿼리입니다. 한 테이블에 합치면 인덱스 설계가 양쪽 모두에 어중간해지고, 한쪽에만 필요한 컬럼이 다른 쪽에서는 NULL로 남습니다.
:::

:::details 좌표가 없는 여행지는 지도를 어떻게 처리하나
위도·경도가 NULL이면 지도 초기화 자체를 건너뛰고 안내 영역으로 대체합니다. 빈 회색 박스나 깨진 지도가 뜨지 않게 하고, 불필요한 Maps API 호출도 막아 키 사용량을 아낍니다.
:::

:::details 좋아요를 누르면 누가 보상을 받나
좋아요를 누른 사람과 여행지 등록자가 다를 때만 양쪽에 적립합니다. 누른 사람에게는 실행 보상, 등록자에게는 수신 보상을 각각 줍니다. 자기 여행지에 좋아요를 눌러 보상을 자가 적립하는 악용을 막기 위해 등록자와 동일하면 보상을 건너뜁니다.
:::

## 8. 직접 말해보기

다음을 소리 내어 설명해 보자.

- 찜과 좋아요의 데이터 의미 차이와 각각의 주 쿼리(목록 조회 vs 집계 정렬)
- UNIQUE 제약 + INSERT IGNORE가 어떻게 중복을 이중으로 막는지
- 좋아요 수를 실시간 COUNT 하는 선택의 장단점과 캐시 전환 시점
- 지도에서 마커 두 개와 fitBounds를 쓰는 이유, 좌표 없을 때 처리

## 퀴즈

<QuizBox question="찜(SPOT_FAVORITE)과 좋아요(SPOT_LIKE)가 같은 사용자-여행지 쌍에 두 번 기록되지 않도록 막는 핵심 장치는?" :choices="['트랜잭션 격리 수준 상향', 'user_idx와 spot_idx에 건 UNIQUE 제약과 INSERT IGNORE', '프런트엔드 버튼 비활성화', '좋아요 수 캐시 컬럼']" :answer="1" explanation="두 테이블 모두 user_idx, spot_idx 쌍에 UNIQUE를 두고 INSERT IGNORE로 충돌을 무시해, 동시 요청이나 더블클릭에도 행이 중복되지 않는다." />

<QuizBox question="탐색 목록에서 좋아요순 정렬에 쓰이는 좋아요 수는 어떻게 구하나?" :choices="['SPOT_TRAVEL의 캐시 컬럼을 읽는다', '조회 시점에 SPOT_LIKE를 실시간 COUNT 한다', '하루 한 번 배치로 집계한다', 'Google Maps API가 계산한다']" :answer="1" explanation="좋아요 수는 캐시 컬럼이 아니라 조회 시점에 SPOT_LIKE를 실시간 COUNT 한 값(like_count_real)으로 정렬한다. 토글이 즉시 순위에 반영되고 캐시 불일치가 없다." />

<QuizBox question="여행지 상세의 Google Maps 동작 설명으로 옳은 것은?" :choices="['항상 지도를 그리고 좌표가 없으면 0,0을 찍는다', '위도 경도가 없으면 지도를 건너뛰고, 있으면 목적지와 서울 두 마커를 fitBounds로 묶는다', '좌표를 서버가 아니라 브라우저 위치 권한으로만 얻는다', '지도 키를 프런트 코드에 직접 하드코딩해 관리한다']" :answer="1" explanation="좌표가 없으면 지도를 그리지 않고 안내로 대체하며, 있으면 목적지와 출발지(서울) 마커를 LatLngBounds로 묶어 자동 줌한다. 키는 설정으로 주입하고 자리표시자만 코드에 남긴다." />
