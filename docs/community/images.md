---
title: "이미지 (Cloudinary·Pixabay)"
owner: B
domain: "커뮤니티·신고"
tags: ["이미지", "Cloudinary"]
---

# 이미지 (Cloudinary·Pixabay)

> 게시글 이미지는 외부 CDN(Cloudinary)에 올리고, 사진이 없는 글에는 Pixabay 풍경을 자동으로 채운다. 본문에는 URL만 박혀 DB가 가벼워진다.

## 1. 한 줄 정의

커뮤니티 게시글의 이미지 저장·서빙을 외부 CDN에 위임하고(Cloudinary), 이미지가 없는 글에는 대륙별 풍경 이미지를 자동으로 배정하는(Pixabay 24시간 캐시) 미디어 처리 모듈이다.

## 2. 왜 이렇게 설계했나

초기에는 에디터가 base64로 이미지를 본문에 직접 박았다. 이 방식은 DB 사이즈가 폭증하고, 페이지 응답이 무거워지며, 변환·캐싱 전략이 없다는 문제가 있었다(ADR-0007). 그래서 다음 원칙으로 재설계했다.

- 저장은 외부에 위임한다. 자체 디스크 저장은 대역폭·백업·WAR 재배포 시 마이그레이션 부담이 크다. Cloudinary 무료 티어로 운영 부담 0, 변환·글로벌 CDN을 즉시 얻는다.
- DB에는 URL만 남긴다. 본문 HTML과 이미지 테이블 모두 Cloudinary secure_url 문자열만 보관한다.
- 빈 화면을 막는다. 질문·팁 글처럼 사진이 없는 글도 목록 카드에서 썸네일이 비지 않도록 대륙별 기본 이미지를 자동 배정한다.

:::tip 비교
S3 + CloudFront(엔터프라이즈급)나 Firebase Storage도 후보였지만, 포트폴리오 단계에서는 비용·설정 복잡도 대비 Cloudinary의 무료 티어 + Java SDK 단순성이 가장 낮은 통합 비용을 제공했다(ADR-0007 Option B).
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 실제 이름 | 역할 |
| --- | --- | --- |
| 업로드 서비스 | `CloudinaryService` (`org.triptogether.cloudinary`) | 파일/바이트 업로드, 폴더 리소스 조회, 삭제 |
| 자동이미지 스케줄러 | `CommunityImageScheduler` | Pixabay 검색 → Cloudinary 업로드 → 인메모리 캐시 |
| 이미지 VO | `CommunityPostImageDto` | image_id, post_id, image_url, sortOrder, autoImage |
| 매퍼 | `CommunityMapper` + `CommunityMapper.xml` | insertImage, insertAutoImage, selectImageList |
| 이미지 테이블 | `COMMUNITY_POST_IMAGE` | 한 글당 여러 장, sort_order/is_auto |
| 인라인 업로드 엔드포인트 | `CommunityController.uploadInlineImage()` | POST /community/inline-image |

테이블 핵심 컬럼은 단순하다.

```text
COMMUNITY_POST_IMAGE
  image_id    PK
  post_id     FK -> COMMUNITY_POST (ON DELETE RESTRICT)
  image_url   varchar(500)   -- Cloudinary secure_url
  sort_order  int  DEFAULT 1 -- 1번이 대표(썸네일)
  is_auto     tinyint DEFAULT 0 -- 0=유저 업로드, 1=Pixabay 자동
  KEY idx_cpi_order (post_id, sort_order)
```

Cloudinary 폴더는 용도별로 나눈다. 대표/첨부 이미지는 community, 에디터 본문 인라인 이미지는 community/inline, Pixabay 자동 기본 이미지는 community_default 폴더에 들어간다. 폴더 분리는 뒤에서 설명할 고아 이미지 정리에서 결정적으로 쓰인다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 업로드 경로 두 가지

| 경로 | 폴더 | 호출 | 비고 |
| --- | --- | --- | --- |
| 본문 인라인 이미지 | community/inline | uploadInlineImage(file) | 에디터에서 삽입, 본문 HTML에 URL 박힘 |
| 대표 이미지 후보 | community | saveFile(file) | 사이드바 첨부(하위호환 경로) |

`CloudinaryService.uploadImage`는 확장자 화이트리스트(jpg/jpeg/png/gif/webp)를 검사하고, 성공 시 secure_url을, 실패 시 null을 반환한다. 예외를 위로 던지지 않고 null로 흡수해 업로드 실패가 글 작성 전체를 깨지 않게 한다.

### 글 저장 시 이미지 등록 로직

게시글을 저장하면 본문에서 추출한 이미지 URL을 sort_order 1부터 차례로 insertImage로 넣는다. 그리고 한 장도 없으면 자동 배정을 한다.

```text
sortOrder = 1
본문 이미지 URL 목록을 sort_order 오름차순으로 insertImage(is_auto=0)
if (sortOrder == 1)        // 아무 이미지도 안 들어갔다
    assignAutoImage(postId, region)   // Pixabay 자동 배정
```

`assignAutoImage`는 스케줄러 캐시에서 지역 이미지를 꺼내 insertAutoImage로 sort_order=1, is_auto=1로 저장한다. 즉 자동 이미지는 항상 대표 한 장이다.

### Pixabay 24시간 캐시 채우기

```text
앱 시작 시(@PostConstruct, 백그라운드 스레드) 1회
+ 이후 @Scheduled 24시간 주기로 6개 대륙 반복:
  1) Pixabay API 검색  q=asia landscape, image_type=photo, safesearch=true
  2) hits 중 webformatURL 랜덤 1장 선택
  3) 이미지 바이트 다운로드
  4) Cloudinary 업로드 (publicId=region 고정 → overwrite)
  5) imageCache.put(region, secureUrl)
```

대륙 키는 asia / europe / africa / north_america / south_america / oceania이며, region이 etc면 캐시에서 무작위 1장을 돌려준다. publicId를 region으로 고정해 덮어쓰므로 Cloudinary에 자동 이미지가 누적되지 않는다. 또한 캐시가 비어 있으면 getRandomImage가 null을 주고, assignAutoImage는 try-catch로 감싸 실패해도 글 저장은 정상 진행된다(자동 이미지 누락은 빈 썸네일일 뿐 치명적이지 않다).

### 본문 중복 렌더 방지

상세 화면(detail.jsp)은 대표 이미지를 상단에 한 번 더 그릴지 판단한다. 본문 inline에 이미 같은 URL이 들어 있으면 상단 렌더를 건너뛰고, 자동 이미지나 레거시 글만 상단에 표시한다. 자동 이미지인 경우 카드에 자동 이미지 안내 문구를 붙인다.

### 고아(orphan) 인라인 이미지 정리

에디터에서 이미지만 올리고 글을 저장하지 않으면 community/inline에 고아 파일이 쌓인다. 스케줄러가 매주 월요일 새벽 KST에 정리한다.

```text
1) Cloudinary community/inline 폴더 전체 리소스 조회(페이지네이션)
2) ACTIVE 게시글 본문 HTML을 jsoup으로 파싱해 사용 중 publicId 수집
3) 차집합 = 고아 후보
4) 업로드 후 24시간(grace period) 지난 고아만 삭제
```

grace period는 작성 도중 취소 UX를 보호한다. 방금 올린 이미지를 다음 청소 잡이 곧장 지우면, 잠시 글을 비공개로 두던 사용자가 이미지를 잃는다. 그래서 24시간이 지난 확실한 고아만 지운다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Cloudinary 업로드/삭제/폴더 조회 | 구현됨 |
| 본문 인라인 이미지 업로드 + 검증(확장자/MIME/5MB) | 구현됨 (`uploadInlineImage`) |
| 한 글 여러 장 + sort_order/is_auto | 구현됨 (`COMMUNITY_POST_IMAGE`) |
| Pixabay 24시간 캐시 + 대륙별 자동 이미지 | 구현됨 (`CommunityImageScheduler`) |
| 고아 인라인 이미지 주간 정리(grace 24h) | 구현됨 |
| 자체 디스크 저장(upload/community) | 일부 흔적/하위호환, 운영 경로는 Cloudinary |
| 이미지 변환 파라미터(w/h/c_fill/f_auto/q_auto) | URL 파라미터로 가능, 적용 범위는 제한적 |

:::warning 주의
인라인 업로드 검증은 컨트롤러에 인라인으로 들어가 있고, ADR-0007은 이를 공통 유틸로 추출하는 것을 P0 보완 과제로 남겨 두었다. 또한 Cloudinary 무료 티어 한계가 있어 트래픽 급증 시 유료 전환이 필요하다(벤더 락인 포함).
:::

## 6. 면접 답변 3단계

1. 한 줄: 게시글 이미지는 외부 CDN Cloudinary에 올리고 DB에는 URL만 저장하며, 사진이 없는 글에는 Pixabay 풍경을 자동 배정해 빈 썸네일을 막습니다.
2. 설계 근거: base64 본문 삽입이 DB를 부풀리고 변환·캐싱이 불가능했기 때문에, 운영 부담 0과 글로벌 CDN을 즉시 얻는 Cloudinary를 ADR로 채택했습니다.
3. 운영 디테일: 에디터에서 올렸다가 버린 고아 이미지를 주간 스케줄러가 jsoup으로 본문을 파싱해 사용 여부를 대조하고, 24시간 grace period가 지난 것만 삭제해 작성 취소 UX를 보호합니다.

## 7. 꼬리질문 + 모범답안

:::details 자동 이미지인지 유저 이미지인지 어떻게 구분하나요?
COMMUNITY_POST_IMAGE의 is_auto 컬럼으로 구분합니다. insertImage는 is_auto=0, insertAutoImage는 is_auto=1로 저장하고, sort_order 1번이 대표 이미지입니다. 자동 이미지는 항상 대표 한 장이라 화면에서 안내 문구를 붙일 수 있습니다.
:::

:::details Pixabay를 매 요청마다 호출하지 않는 이유는?
외부 API 레이트 리밋과 응답 지연 때문입니다. 앱 시작 시 1회 + 24시간 주기로 대륙별 이미지를 미리 Cloudinary에 올려 인메모리 캐시에 담아 두고, 자동 배정 시에는 캐시에서 즉시 꺼냅니다. region을 publicId로 고정 업로드해 Cloudinary에 파일이 누적되지도 않습니다.
:::

:::details 고아 이미지 정리에서 잘못 지울 위험은 어떻게 막나요?
두 가지 안전장치가 있습니다. 첫째, ACTIVE 게시글 본문을 jsoup으로 파싱해 실제 사용 중 publicId 집합을 만들어 차집합만 후보로 봅니다. 둘째, 업로드 후 24시간 grace period를 둬서 방금 올린 이미지는 보호합니다. 작성 중 취소한 사용자가 이미지를 잃지 않게 하기 위함입니다.
:::

:::details 업로드가 실패하면 글 저장은 어떻게 되나요?
CloudinaryService는 예외를 위로 던지지 않고 null을 반환합니다. 자동 이미지 배정도 try-catch로 감싸 실패 시 경고 로그만 남기고 글 저장 흐름을 계속합니다. 이미지 누락은 빈 썸네일일 뿐 글 작성 자체를 막지 않는다는 판단입니다.
:::

:::details 왜 community와 community/inline 폴더를 나눴나요?
고아 정리 스케줄러가 본문에 없는 인라인 이미지만 선별 삭제하기 위해서입니다. 대표/첨부 이미지(community)와 본문 삽입 이미지(community/inline)를 섞으면, 사용 여부 대조 대상이 모호해집니다. 폴더를 분리하면 community/inline 폴더만 전수 조회해 안전하게 정리할 수 있습니다.
:::

## 8. 직접 말해보기

- 본문에 이미지가 한 장도 없는 글이 저장될 때, 코드가 자동 이미지를 어떻게 판단하고 배정하는지 sort_order 변수 흐름으로 설명해 보세요.
- Pixabay 이미지를 region을 publicId로 고정해 업로드하면 어떤 누적 문제를 막는지 말해 보세요.
- 고아 이미지 정리에서 jsoup 파싱과 24시간 grace period가 각각 무엇을 보호하는지 구분해 설명해 보세요.

## 퀴즈

<QuizBox question="COMMUNITY_POST_IMAGE에서 Pixabay 자동추천 이미지를 유저 업로드와 구분하는 컬럼과 값은?" :choices="['sort_order 가 0', 'is_auto 가 1', 'image_url 이 null', 'post_id 가 0']" :answer="1" explanation="insertAutoImage 는 is_auto 를 1로 저장하고 sort_order 는 1로 둡니다. 유저 업로드 insertImage 는 is_auto 가 0입니다." />

<QuizBox question="Pixabay 자동 이미지를 매 요청이 아니라 24시간 주기로 미리 받아 두는 가장 큰 이유는?" :choices="['이미지 화질을 높이려고', '외부 API 지연과 레이트 리밋을 피하고 캐시에서 즉시 꺼내려고', '저작권을 회피하려고', 'DB 용량을 줄이려고']" :answer="1" explanation="CommunityImageScheduler 가 대륙별 이미지를 미리 Cloudinary 에 올려 인메모리 캐시에 담아두고, 자동 배정 시 캐시에서 즉시 반환합니다." />

<QuizBox question="고아 인라인 이미지 정리에서 24시간 grace period 를 두는 목적은?" :choices="['Cloudinary 비용 절감', '방금 업로드했지만 아직 저장 안 한 작성 중 이미지를 보호', '검색 속도 향상', '중복 이미지 제거']" :answer="1" explanation="업로드만 하고 글을 저장하지 않은 경우를 대비해, 24시간이 지난 확실한 고아만 삭제하여 작성 취소 UX 를 보호합니다." />
