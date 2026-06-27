# 파일 업로드 (Cloudinary)

> 사용자가 올린 이미지는 서버 디스크가 아니라 외부 CDN(Cloudinary)에 저장하고, 본문에는 secure_url만 박는다. ADR-0007의 핵심 결정이다.

## 1. 한 줄 정의

TripTogether의 이미지 업로드는 공통 `CloudinaryService`가 `MultipartFile`을 검증·업로드해 `secure_url`을 돌려주고, 커뮤니티 본문 인라인 이미지와 문의 첨부파일이 이를 공유하는 구조다. 동시에 로컬 디스크 기반 `/upload/**` 정적 서빙 경로도 설정에 남아 있다(레거시·일부 용도).

## 2. 왜 이렇게 설계했나

ADR-0007의 결정 동인은 "개인/포트폴리오 규모에서 운영 부담 0"이다.

- **운영 부담 위임**: 디스크/대역폭/백업을 Cloudinary가 맡는다. WAR를 재배포·이전해도 이미지가 영향받지 않는다.
- **변환·최적화·CDN**: `w_300,h_300,c_fill,f_auto,q_auto` 같은 URL 파라미터로 즉석 리사이즈, 글로벌 CDN 캐싱이 공짜로 따라온다.
- **DB 비대화 방지**: 초기 Phase 1은 Summernote가 base64를 본문 HTML에 박았다. 이미지가 DB row로 들어가 사이즈가 폭증하고 페이지가 무거워졌다. Phase 2에서 본문에는 외부 URL만 남기는 방식으로 전환했다.
- **서버 경유 업로드**: 클라이언트가 Cloudinary로 직접(unsigned) 올릴 수도 있지만, 권한 검증과 폴더 분리를 서버가 통제하려고 서버 경유 방식을 택했다.

후보로 자체 디스크(Option A), S3+CloudFront(C, 비용·설정 복잡), Firebase(D, Java SDK 약함)를 비교했고 무료 티어·Java SDK 단순성 때문에 Cloudinary가 선택됐다.

:::tip 트레이드오프 정직하게
Cloudinary는 외부 의존성·벤더 락인·무료 티어 한계(25 monthly credits)를 떠안는다. 마이그레이션하면 모든 URL을 재발급해야 한다. 면접에서 "왜 S3가 아니냐"를 물으면 "엔터프라이즈 안정성보다 포트폴리오 단계 비용 0과 통합 단순성을 우선했다"로 답하면 된다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 위치 | 역할 |
| --- | --- | --- |
| `CloudinaryService` | `org.triptogether.cloudinary` | 공통 업로드/조회/삭제. SDK `Cloudinary` 래핑 |
| `CommunityController#uploadInlineImage` | `community.controller` | `POST /community/inline-image` Summernote 인라인 업로드 |
| `CommunityImageScheduler` | `community.service` | Pixabay→Cloudinary 대표이미지 캐시 + 고아 이미지 정리 |
| `InquiryServiceImpl#saveFile` / `isValidImageFile` | `inquiry.service` | 문의 첨부파일 업로드·검증 |
| `WebConfig#addResourceHandlers` | `config` | `/upload/**`를 로컬 디스크에 매핑 |

- SDK: `cloudinary` Java SDK (`com.cloudinary.Cloudinary`), 외부 HTTP는 `RestTemplate`(Pixabay 다운로드).
- 자격증명은 `application.properties`의 `cloudinary.cloud-name` / `cloudinary.api-key` / `cloudinary.api-secret`로 주입(`@Value`). 공개 문서에는 자리표시자 `API_KEY` 등으로만 표기한다.
- DB 테이블: 문의 첨부는 `INQUIRY_ATTACHMENT`(`InquiryAttachmentDto`: `attachmentId`, `inquiryId`, `fileUrl`, `fileName`, `createdAt`). 커뮤니티 인라인 이미지는 **별도 테이블 없이 본문 HTML의 `<img src>`에 secure_url로만 존재**한다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 인라인 이미지 업로드 (커뮤니티)

```text
[에디터] Summernote onImageUpload 후크
  -> POST /community/inline-image (MultipartFile)
  -> CommunityService.uploadInlineImage(file)
  -> CloudinaryService.uploadImage(file, "community/inline")
  -> secure_url 반환 (https://res.cloudinary.com/.../community/inline/xxx.jpg)
  -> $.summernote('insertImage', secure_url)
  -> 본문 HTML에 외부 URL만 박힘 (DB엔 URL 텍스트만 저장)
```

폴더 규칙(ADR-0007): `community/`(대표 이미지), `community/inline/`(본문 인라인), `inquiry`(문의 첨부), `community_default`(Pixabay 대표 캐시).

### 4-2. 공통 업로드 + 확장자 검증

`CloudinaryService`는 두 진입점을 둔다. 둘 다 실패 시 예외를 던지지 않고 `null`을 반환하는 게 핵심 계약이다.

```java
// 허용 확장자 화이트리스트
Set.of(".jpg", ".jpeg", ".png", ".gif", ".webp");

uploadImage(MultipartFile file, String folder)        // 사용자 업로드
uploadImageFromBytes(byte[] bytes, folder, publicId)  // 서버측 byte[], publicId로 overwrite
```

문의 모듈은 한 단계 더 엄격하게 `isValidImageFile()`로 **MIME(`image/*`) + 확장자 + 5MB** 를 직접 검사한 뒤 `CloudinaryService.uploadImage(file, "inquiry")`를 호출한다. 스프링 멀티파트 상한은 `max-file-size=10MB`, `max-request-size=100MB`다.

### 4-3. Pixabay fallback (대표 이미지)

게시글에 대표 이미지가 없을 때 쓸 풍경 이미지를 외부에서 끌어와 Cloudinary에 캐싱한다.

```text
[앱 시작 @PostConstruct] 백그라운드 스레드 1회
[이후 24h 주기 @Scheduled]
  region(asia/europe/africa/north_america/south_america/oceania)별로:
  Pixabay API 검색 -> webformatURL 랜덤 1장 다운로드(byte[])
  -> uploadImageFromBytes(bytes, "community_default", region)  // 고정 publicId=region -> overwrite
  -> imageCache(ConcurrentHashMap)에 region->URL 보관
getRandomImage("etc")는 6개 대륙 중 랜덤
```

고정 `publicId`로 덮어쓰기 때문에 Cloudinary에 이미지가 누적되지 않는다.

### 4-4. 고아(orphan) 이미지 정리

본문 HTML에 URL만 박히는 구조라, 업로드만 하고 글을 안 올리면 Cloudinary에 고아 이미지가 쌓인다. `cleanupOrphanInlineImages()`가 처리한다.

| 단계 | 동작 |
| --- | --- |
| 1 | `listResourcesInFolder("community/inline")` — Admin API로 폴더 전수 조회(next_cursor 페이지네이션, 안전 가드 200페이지) |
| 2 | ACTIVE 게시글 본문을 jsoup으로 파싱해 사용 중 `publicId` 집합 수집 |
| 3 | 차집합 = 고아 후보 |
| 4 | 업로드 후 **24h(grace period)** 지난 것만 `deleteResource()` — 작성 중 취소 UX 보호 |

:::warning grace period가 있는 이유
방금 올린 이미지를 바로 지우면, 사용자가 글을 저장하기 전에 본문 이미지가 깨진다. 그래서 `createdAt`이 24시간 이전인 고아만 삭제한다. ADR 문서는 매일 새벽 3시 예시지만, 실제 코드는 매주 월요일 04:00 KST(`0 0 4 ? * MON`)에 돈다.
:::

### 4-5. `/upload/**` 정적 매핑

```java
// WebConfig
String fullPath = System.getProperty("user.dir").replace("\\","/") + "/" + uploadPath; // file.upload.path
registry.addResourceHandler("/upload/**").addResourceLocations("file:" + fullPath);
```

`file.upload.path`(기본 `src/main/resources/upload/`)를 `/upload/**` URL로 노출한다. 이 경로는 모든 인터셉터(locale/ipBlock/activityLog/notification 등)의 `excludePathPatterns`에 들어가 인증·로깅을 건너뛴다. ADR-0007 기준으로 사용자 이미지의 정식 저장소는 Cloudinary이고, 디스크 서빙은 Option A의 잔재로 일부만 남아 있다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Cloudinary 업로드/조회/삭제 | 구현됨 |
| 커뮤니티 인라인 이미지(`/community/inline-image`) | 구현됨 |
| 문의 첨부 업로드 + MIME/확장자/5MB 검증 | 구현됨 |
| Pixabay 대표 이미지 캐시(24h) | 구현됨 |
| 고아 이미지 주간 정리(grace 24h) | 구현됨 |
| `/upload/**` 디스크 서빙 | 설정 존재(레거시/부분 용도) |
| 확장자 검증 강화(공통 단의 MIME·크기) | `CloudinaryService` 자체는 확장자만 검사. MIME·크기 검증은 문의 모듈에서만. ADR TODO로 인라인 경로 검증 강화가 P0로 남음 |
| 클라이언트 직접(unsigned) 업로드 | 미채택(권한 검증 위해 서버 경유) |

## 6. 면접 답변 3단계

1. **한 줄**: "사용자 이미지는 디스크가 아니라 Cloudinary CDN에 올리고 본문엔 secure_url만 저장합니다. 공통 `CloudinaryService`가 업로드를 담당하고, 커뮤니티 인라인 이미지와 문의 첨부가 이를 공유합니다."
2. **설계 이유**: "초기엔 Summernote가 base64를 본문에 박아 DB가 비대해졌고, WAR 재배포 시 디스크 이미지 마이그레이션 부담도 있었습니다. ADR-0007에서 운영 부담 0·자동 변환·글로벌 CDN을 이유로 외부 CDN을 채택했습니다."
3. **트레이드오프·보완**: "대신 외부 의존성과 벤더 락인을 떠안았고, 본문에 URL만 남는 구조라 고아 이미지가 쌓입니다. 이를 jsoup으로 사용 중 publicId를 추적해 24h grace 후 주간 배치로 삭제합니다. 다만 공통 업로드 단의 MIME·크기 검증 강화는 ADR TODO로 남아 있습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 본문에 URL만 저장하고 별도 이미지 테이블을 안 두나?
인라인 이미지는 본문 HTML의 `<img src>`에 자연스럽게 박히므로, 별도 매핑 테이블 없이 본문만으로 "어떤 이미지가 쓰이는지"를 알 수 있습니다(jsoup 파싱). 대신 글을 안 올린 경우 추적이 끊겨 고아가 생기므로 정리 배치가 필요합니다. 문의 첨부는 본문이 아니라 파일 목록이라 `INQUIRY_ATTACHMENT` 테이블로 따로 관리합니다.
:::

:::details Q2. 업로드 실패 시 예외 대신 null을 반환하는 이유는?
`CloudinaryService`는 실패해도 예외를 전파하지 않고 `null`을 반환합니다. 이미지 한 장 실패가 게시글 작성 전체를 깨뜨리지 않게 하려는 의도입니다. 호출부(예: 문의 작성 루프)는 `null`이면 해당 첨부만 건너뛰고 진행합니다. 단점은 호출부가 null 체크를 빠뜨리면 빈 URL이 저장될 수 있다는 점이라, 인라인 업로드는 컨트롤러에서 에러 메시지를 응답으로 분기합니다.
:::

:::details Q3. 고아 이미지 정리의 grace period가 없으면?
방금 업로드했지만 아직 저장 안 된 이미지를 즉시 삭제하면, 사용자가 글을 저장하는 순간 본문 이미지가 404가 됩니다. 그래서 `createdAt` 기준 24h 이전 고아만 지웁니다. 또 "차집합=고아"라는 단순 로직이라, 사용 중 집합 수집(ACTIVE 게시글 파싱)이 누락되면 멀쩡한 이미지를 지울 위험이 있어 grace가 안전망 역할도 합니다.
:::

:::details Q4. Pixabay 이미지를 매번 직접 서빙하지 않고 Cloudinary로 다시 올리는 이유는?
Pixabay 원본 URL을 그대로 쓰면 외부 가용성·rate limit에 매번 노출되고 CDN 변환도 못 씁니다. region별 고정 publicId로 Cloudinary에 덮어쓰기하면 누적 없이 캐싱되고, 변환·CDN 이점을 그대로 받습니다. 즉 Pixabay는 "소스", Cloudinary는 "서빙·캐시" 역할 분리입니다.
:::

:::details Q5. 보안 측면에서 업로드 검증은 충분한가?
문의 모듈은 MIME(`image/*`)+확장자+5MB를 검사합니다. 다만 공통 `CloudinaryService.uploadImage`는 확장자 화이트리스트만 보고 MIME·크기는 검사하지 않아, 인라인 업로드 경로의 검증 강화가 ADR TODO(P0)로 남아 있습니다. 확장자만 믿으면 위장 파일을 막기 어렵다는 점을 약점으로 정직하게 말하는 게 좋습니다. 멀티파트 상한(10MB/요청 100MB)이 1차 방어선입니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 설명할 수 있으면 이 페이지를 이해한 것이다.

- 인라인 이미지가 업로드되어 본문에 박히기까지의 5단계 흐름
- `community/` vs `community/inline/` vs `inquiry` 폴더를 나눈 이유
- 고아 이미지 정의와 24h grace period가 필요한 이유
- Pixabay와 Cloudinary의 역할 분리
- 공통 업로드 단의 검증 한계와 ADR TODO

관련 문서: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="ADR-0007에서 자체 디스크(Option A) 대신 Cloudinary(Option B)를 택한 핵심 이유로 가장 거리가 먼 것은?" :choices="['디스크/대역폭/백업 운영 부담을 외부에 위임할 수 있다', 'URL 파라미터로 이미지 변환·최적화를 즉석에서 쓸 수 있다', '엔터프라이즈급 안정성과 AWS 생태계 통합이 필요했다', 'WAR 재배포·이전 시 이미지 마이그레이션 부담이 없다']" :answer="2" explanation="엔터프라이즈 안정성·AWS 통합은 Option C(S3+CloudFront)의 장점이며, 비용·설정 복잡도 때문에 탈락했다. Cloudinary 선택 동인은 운영 부담 0·변환·CDN·WAR 친화·무료 티어다." />

<QuizBox question="커뮤니티 인라인 이미지의 고아(orphan) 정리에서 업로드 직후 이미지를 바로 삭제하지 않고 24시간 grace period를 두는 이유는?" :choices="['Cloudinary 무료 티어 크레딧을 아끼려고', '글 저장 전에 업로드된 이미지를 지우면 본문 이미지가 깨지기 때문', 'jsoup 파싱이 24시간 걸리기 때문', 'Pixabay rate limit을 피하기 위해']" :answer="1" explanation="본문에 URL만 박히는 구조라, 작성 중(아직 저장 안 됨) 이미지를 즉시 지우면 글 저장 시 이미지가 404가 된다. createdAt 24h 이전 고아만 삭제해 작성 중 취소 UX를 보호한다." />

<QuizBox question="TripTogether의 이미지 업로드 구현에 대한 설명으로 옳은 것은?" :choices="['커뮤니티 인라인 이미지는 별도 이미지 테이블에 행으로 저장된다', 'CloudinaryService.uploadImage는 실패 시 예외를 던진다', 'Pixabay 원본 URL을 그대로 본문에 서빙한다', '인라인 이미지는 본문 HTML의 img src에 secure_url로만 존재하고, 사용 여부는 jsoup으로 파싱해 추적한다']" :answer="3" explanation="인라인 이미지는 별도 테이블 없이 본문 HTML에 secure_url로 박힌다. uploadImage는 실패 시 null을 반환한다. Pixabay는 소스일 뿐, Cloudinary로 다시 올려 캐싱·서빙한다." />
