---
title: "첨부·비공개 워크플로우"
owner: B
domain: "문의·알림·마이페이지"
tags: ["첨부", "비공개"]
---

# 첨부·비공개 워크플로우

> 문의 첨부파일은 Cloudinary URL로 저장되어 상세 화면에서 직접 노출되고, 비공개 글은 작성자와 운영진만 열람하며, 공개·비공개 전환은 유저 요청 후 운영진 승인을 거친다.

이 페이지는 TripTogether `inquiry` 모듈의 두 축, **첨부파일 처리**와 **공개 범위(visibility) 워크플로우**를 다룬다. 둘 다 권한 분리(작성자 vs 운영진)와 상태 머신을 공유한다.

## 1. 한 줄 정의

- **첨부**: 문의 작성·수정 시 업로드한 이미지를 Cloudinary에 올려 `INQUIRY_ATTACHMENT.file_url`로 저장하고, 상세 화면이 그 URL을 그대로 렌더링한다.
- **비공개**: `INQUIRY_POST.is_private` 플래그(0 공개 / 1 비공개)로 열람 범위를 좁히고, 전환은 유저가 요청(`PRIVATE_REQUESTED` / `PUBLIC_REQUESTED`)하면 운영진이 승인해 확정한다.

## 2. 왜 이렇게 설계했나

문의 게시판은 결제·계정·버그 같은 민감 정보를 다룬다. 그래서 두 가지 분리가 핵심이었다.

- **열람 권한 분리**: 공개 글은 누구나 목록에서 보지만, 비공개 글은 본문을 작성자와 운영진만 본다. 목록 자체는 노출하되 상세 진입에서 막는 방식이라, 검색·통계는 유지하면서 내용만 보호한다.
- **전환을 양방향 승인제로**: 유저가 임의로 공개/비공개를 즉시 바꾸면 운영진이 처리 중인 글의 가시성이 흔들린다. 그래서 유저는 **요청만** 남기고, 운영진이 최종 확정한다. 삭제 요청(`DELETE_REQUESTED`)도 같은 철학이다 — 답변 완료 글은 유저가 바로 못 지우고 요청 후 승인받는다.
- **첨부는 외부 CDN 위임**: 이미지 바이트를 WAR 내부나 서버 디스크에 두지 않고 Cloudinary에 위임한다(ADR-0007). 덕분에 별도 다운로드 스트리밍 컨트롤러 없이, 저장된 URL을 `a`·`img` 태그로 바로 제공한다.

:::tip 소프트삭제와의 관계
문의 글 자체는 상태 머신(`status`) 기반이고, 첨부는 글 삭제 시 FK `ON DELETE CASCADE`로 함께 제거된다. 공통 소프트삭제 패턴(ADR-0008)은 커뮤니티·댓글에 적용되며, 문의 첨부는 물리 삭제 경로를 쓴다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성요소 | 실제 식별자 |
| --- | --- |
| 컨트롤러 | `InquiryController` (`/inquiry/**`) |
| 서비스 | `InquiryService` / `InquiryServiceImpl` |
| 매퍼 | `InquiryMapper` + `resources/mapper/InquiryMapper.xml` |
| 첨부 VO | `InquiryAttachmentDto` (attachmentId, inquiryId, fileUrl, fileName) |
| 글 VO | `InquiryPostDto` (isPrivate, status, visibilityRequestedAt 등) |
| 첨부 테이블 | `INQUIRY_ATTACHMENT` (file_url, file_name, FK inquiry_id CASCADE) |
| 글 테이블 | `INQUIRY_POST` (is_private, status, visibility_requested_at, delete_requested_at) |
| 이미지 업로드 | `CloudinaryService.uploadImage(file, inquiry)` |
| 독성 검사 | `PerspectiveService.checkAndFlagInquiryAsync` (Google Perspective TOXICITY) |

핵심 엔드포인트:

- `GET /inquiry/{inquiryId}` — 상세. 비공개 가드 + `attachmentList` 모델 주입
- `POST /inquiry/{inquiryId}/visibility-request` — 유저 전환 요청 (type=public/private)
- `POST /inquiry/{inquiryId}/visibility-approve` — 운영진 승인 (`@RequireAdmin` 동등 권한 체크)
- `POST /inquiry/{inquiryId}/edit` — 수정 시 신규 첨부 추가

## 4. 동작 원리 (흐름·표·작은 코드)

**첨부 업로드 → 노출 흐름**

```text
작성/수정 폼 (multipart images[])
  → InquiryServiceImpl.addAttachment(file)
    → isValidImageFile()  // MIME=image/*, 확장자 jpg/png/gif/webp, 5MB 이하
    → CloudinaryService.uploadImage(file, inquiry)  → file_url
    → INQUIRY_ATTACHMENT insert
  → 상세 JSP가 a href=file_url / img src=file_url 로 직접 렌더
```

검증을 통과 못 한 파일은 예외 없이 조용히 무시되고 warn 로그만 남는다(작성 흐름을 막지 않기 위함).

**비공개 열람 가드** (상세 컨트롤러)

```java
if (inquiry.getIsPrivate() == 1 && !admin
        && !loginUserIdx.equals(inquiry.getUserIdx())) {
    return "redirect:/inquiry/list"; // 작성자도 운영진도 아니면 차단
}
```

**공개·비공개 전환 상태 머신**

| 단계 | 호출자 | status 변화 | 비고 |
| --- | --- | --- | --- |
| 비공개 요청 | 작성자 | -> PRIVATE_REQUESTED | visibility_requested_at 스탬프 |
| 공개 요청 | 작성자 | -> PUBLIC_REQUESTED | 동일 |
| 승인 | 운영진 | is_private 갱신 + status -> COMPLETED | `approveVisibility` |

요청 상태는 `INQUIRY_POST.status` 컬럼에 그대로 저장되고, `updateStatusWithTime`이 상태별 타임스탬프를 CASE로 함께 찍는다. 승인 시 `approveVisibility(inquiryId, type)`가 `is_private`를 0/1로 바꾸고 status를 COMPLETED로 되돌린다 — 두 갱신이 같은 `@Transactional` 안에서 묶인다.

**독성 검사**: 작성·수정 직후 `checkAndFlagInquiryAsync(inquiryId, title + content)`를 비동기로 돌려, Perspective TOXICITY 점수가 정책 임계값 이상이면 `ai_flagged=1`을 세팅한다. 운영진은 `/inquiry/{id}/clear-blur`로 해제한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::warning 정직한 구분
- **됨**: 첨부 업로드·검증·Cloudinary 저장·상세 노출, 비공개 열람 가드, 공개/비공개 요청·승인, 삭제 요청·승인, 답변 이력 보존, Perspective 비동기 독성 플래그.
- **부분/계획**: 상세 화면 편집 모드는 첨부 **삭제** 버튼이 `/inquiry/attachment/{id}/delete`를 호출하지만, 이에 대응하는 컨트롤러 매핑은 아직 없다. 서비스 메서드 `removeAttachment`는 존재하나 엔드포인트 미연동 상태다.
- **계획**: ADR-0007에 명시된 파일 검증 TODO(서버 측 MIME/확장자/크기 화이트리스트의 공통 유틸 추출)는 현재 `InquiryServiceImpl` 내부 메서드로만 존재한다. 별도 인증이 걸린 다운로드 스트리밍 엔드포인트는 없고, 첨부는 공개 Cloudinary URL로 제공된다.
:::

## 6. 면접 답변 3단계

1. **한 문장**: 문의 첨부는 Cloudinary URL로 저장해 상세에서 직접 노출하고, 비공개 글은 작성자와 운영진만 열람하며 공개·비공개 전환은 유저 요청 후 운영진 승인으로 확정합니다.
2. **설계 이유**: 민감한 문의 내용을 보호하려고 열람 권한을 분리하고, 가시성 변경이 운영 처리와 충돌하지 않도록 즉시 변경 대신 요청·승인 2단계로 만들었습니다.
3. **구체 근거**: 상세 컨트롤러가 is_private와 로그인 유저 idx를 비교해 가드하고, visibility-request가 status를 PRIVATE_REQUESTED/PUBLIC_REQUESTED로 바꾼 뒤 approveVisibility가 트랜잭션 안에서 is_private와 status를 함께 갱신합니다.

## 7. 꼬리질문 + 모범답안

:::details 비공개 글인데 목록에는 왜 노출되나요
열람 차단은 상세 진입에서만 합니다. 목록은 제목 등 최소 정보만 보이고, 본문·답변·첨부는 상세에서 is_private 가드로 막습니다. 검색·통계·정렬은 유지하면서 내용만 보호하려는 의도적 분리입니다.
:::

:::details 유저가 바로 공개·비공개를 못 바꾸게 한 이유는
운영진이 처리 중인 글의 가시성이 임의로 흔들리면 응대 일관성이 깨집니다. 그래서 유저는 요청 상태만 남기고 운영진이 승인해 확정합니다. 삭제 요청도 같은 승인제라 완료된 글을 유저가 바로 지울 수 없습니다.
:::

:::details 첨부 다운로드 권한은 어떻게 거나요
현재는 Cloudinary 공개 URL로 제공해 URL을 아는 사람은 접근할 수 있습니다. 비공개 글의 본문은 가드로 막지만 첨부 URL 자체는 별도 인증이 없으므로, 인증된 프록시 다운로드 엔드포인트 도입이 향후 보안 과제입니다.
:::

:::details 잘못된 파일을 올리면 어떻게 되나요
isValidImageFile에서 MIME image 접두사, 확장자 화이트리스트(jpg/png/gif/webp), 5MB 한도를 검사합니다. 실패하면 예외 없이 건너뛰고 warn 로그만 남겨 작성 흐름을 막지 않습니다. ADR-0007에 공통 유틸 추출 TODO로 기록돼 있습니다.
:::

:::details 상태 컬럼 하나에 요청 상태까지 넣는 이유는
PRIVATE_REQUESTED 같은 요청도 처리 상태와 같은 status 컬럼에 저장하고, updateStatusWithTime이 상태별 타임스탬프를 CASE로 찍습니다. 별도 요청 테이블 없이 단일 상태 머신으로 처리 흐름과 요청 흐름을 한 곳에서 추적하려는 단순화입니다.
:::

## 8. 직접 말해보기

- 비공개 글 상세 진입을 막는 조건 세 가지(is_private, 운영진 여부, 작성자 idx 일치)를 코드 흐름으로 설명해 보라.
- 공개 전환을 요청한 순간부터 운영진 승인까지 status와 is_private가 어떻게 변하는지 단계별로 말해 보라.
- 첨부 다운로드의 현재 보안 한계와 개선안을 한 문단으로 정리해 보라.

## 퀴즈

<QuizBox question="문의 비공개 글의 상세 본문을 열람할 수 있는 대상은 누구인가" :choices="['모든 로그인 유저', '작성자와 운영진만', '운영진만', '같은 카테고리 작성자']" :answer="1" explanation="상세 컨트롤러는 is_private 가 1이고 운영진도 작성자도 아니면 목록으로 리다이렉트한다. 즉 작성자와 운영진만 본문을 본다." />

<QuizBox question="유저가 공개에서 비공개로 전환을 요청하면 INQUIRY_POST status는 먼저 무엇이 되는가" :choices="['바로 is_private 가 1', 'PRIVATE_REQUESTED', 'COMPLETED', 'DELETE_REQUESTED']" :answer="1" explanation="visibility-request 는 status 를 PRIVATE_REQUESTED 로 바꾸고 timestamp 만 찍는다. 실제 is_private 변경은 운영진 approveVisibility 에서 일어난다." />

<QuizBox question="문의 첨부 이미지는 어디에 저장되고 어떻게 노출되는가" :choices="['서버 디스크에 저장 후 다운로드 스트리밍 엔드포인트로 제공', 'DB BLOB 에 바이트 저장', 'Cloudinary 에 올린 뒤 저장된 URL 을 상세 화면에서 직접 렌더', 'Base64 로 인코딩해 본문에 삽입']" :answer="2" explanation="CloudinaryService.uploadImage 로 업로드하고 file_url 을 INQUIRY_ATTACHMENT 에 저장한 뒤, 상세 JSP 가 그 URL 을 a 와 img 태그로 직접 렌더한다. 별도 스트리밍 컨트롤러는 없다." />
