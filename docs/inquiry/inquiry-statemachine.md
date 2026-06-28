---
title: "문의 상태머신"
owner: B
domain: "문의·알림·마이페이지"
tags: ["상태머신"]
---

# 문의 상태머신

> 문의 한 건의 생애주기를 상태 컬럼 하나와 전환 전용 엔드포인트로 통제한다. 누가 어떤 상태에서 무엇을 할 수 있는지가 모두 상태값에 묶여 있다.

## 1. 한 줄 정의

`INQUIRY_POST.status` 값(PENDING, IN_PROGRESS, COMPLETED, USER_COMPLETED, CANCELLED, DELETE_REQUESTED, PRIVATE_REQUESTED, PUBLIC_REQUESTED)을 사용자 액션과 운영진 액션이 단계적으로 바꿔 가며, 각 전환마다 권한과 현재 상태를 검증하는 구조다.

## 2. 왜 이렇게 설계했나

고객 문의는 단순 게시글이 아니라 SLA가 있는 처리 대상이다. 작성 직후 자유롭게 고칠 수 있어야 하지만, 운영진이 답변을 단 뒤에는 내용이 흔들리면 안 된다. 또 사용자가 스스로 종료하거나 삭제를 원하더라도 운영 기록은 남겨야 한다. 이 요구를 만족시키려면 상태마다 허용 동작이 달라야 했다.

- 상태를 하나의 컬럼으로 모으면, 수정·삭제·답변 가능 여부를 if 한 줄(현재 상태 비교)로 일관되게 강제할 수 있다.
- 전환 시각을 별도 컬럼(in_progress_at, completed_at 등)에 남겨, 처리 소요 시간 같은 운영 지표를 사후 집계할 수 있다.
- 사용자 요청(삭제·공개전환)과 운영진 승인을 분리해, 사용자가 일방적으로 데이터를 지우지 못하게 했다(ADR-0008 소프트삭제 원칙과 같은 철학의 운영 안전장치).

## 3. 어떤 기술로 구현했나(실제 클래스·테이블)

| 계층 | 구현체 | 역할 |
| --- | --- | --- |
| Controller | `InquiryController` (/inquiry/**) | 전환 엔드포인트, 권한·상태 가드 |
| Service | `InquiryService` / `InquiryServiceImpl` | 전환 로직, 트랜잭션 |
| Mapper | `InquiryMapper` + `InquiryMapper.xml` | 상태·시각 UPDATE |
| 테이블 | `INQUIRY_POST` | 본문 + status + 전환 시각 컬럼 |
| 테이블 | `INQUIRY_ANSWER` | 문의당 답변 1건(uq_inquiry_answer) |
| 테이블 | `INQUIRY_ANSWER_HISTORY` | 답변 수정·삭제 이전 본문 보존 |
| 테이블 | `INQUIRY_ATTACHMENT` | 첨부 이미지 메타 |

`category` 컬럼은 service, payment, account, bug, etc 다섯 유형을 가진다(기본값 etc). 권한 판정은 세션 속성 loginUser를 통해 이뤄지고, 운영진 전용 엔드포인트 일부는 AOP 어노테이션 `@RequireAdmin`(AuthorizationAspect)으로, 일부는 컨트롤러 내부 isAdmin 검사로 처리된다(ADR-0011).

## 4. 동작 원리(흐름·표·작은 코드)

상태별 허용 액션과 전환 결과는 다음과 같다.

| 현재 상태 | 액션(엔드포인트) | 행위자 | 다음 상태 |
| --- | --- | --- | --- |
| PENDING | edit / delete | 본인 또는 운영진 | 유지 / 삭제 |
| PENDING | answer | 운영진 | IN_PROGRESS 또는 COMPLETED |
| PENDING, IN_PROGRESS | cancel | 본인 | CANCELLED |
| IN_PROGRESS, COMPLETED | user-complete | 본인 | USER_COMPLETED |
| COMPLETED | delete-request | 본인 | DELETE_REQUESTED |
| DELETE_REQUESTED | delete-cancel | 본인 | COMPLETED |
| DELETE_REQUESTED | delete-approve | 운영진 | 삭제 |
| 임의 | visibility-request | 본인 | PRIVATE_REQUESTED 또는 PUBLIC_REQUESTED |
| 요청 상태 | visibility-approve | 운영진 | COMPLETED |
| CANCELLED | delete | 본인 또는 운영진 | 삭제 |

핵심은 두 가지다. 첫째, 수정과 삭제는 상태로 잠근다. 답변이 달려 IN_PROGRESS 이상이 되면 본문 수정은 막힌다.

```java
// InquiryController.edit
if (!"PENDING".equals(inquiry.getStatus())) {
    // 답변 이후에는 수정 불가 → 400
}
// delete 는 PENDING 또는 CANCELLED 에서만 허용
```

둘째, 답변 등록은 complete 플래그로 분기한다. 단순 답변이면 IN_PROGRESS, 완료 답변이면 COMPLETED로 바꾼다.

```java
// InquiryServiceImpl.writeAnswer
inquiryMapper.insertAnswer(answer);
inquiryMapper.updateStatus(inquiryId, complete ? "COMPLETED" : "IN_PROGRESS");
```

전환 시각은 `updateStatusWithTime` 매퍼가 CASE 식으로 해당 컬럼만 갱신한다. 예를 들어 status가 COMPLETED 또는 USER_COMPLETED면 completed_at에 NOW를 채우고 나머지 시각 컬럼은 그대로 둔다. 답변이 달리면 작성자에게 FeedNotification이 자동 발행된다(sourceType은 inquiry, targetUrl은 NotificationUrlBuilder.inquiry로 생성).

공개전환은 사용자가 visibility-request로 PRIVATE_REQUESTED 또는 PUBLIC_REQUESTED를 만들고, 운영진이 visibility-approve를 호출하면 `approveVisibility`가 is_private 값을 바꾸고 상태를 COMPLETED로 되돌린다.

## 5. 구현 상태(됨 vs Mock/계획)

- 됨: 전체 상태머신, 본인 PENDING 수정·삭제 가드, user-complete / cancel / delete-request / delete-cancel / delete-approve, 공개전환 요청·승인, 답변 1건 제약, 답변 수정·삭제 이력 보존, 도배 방지(운영 정책 기반 시간창·개수), 첨부 이미지 검증(확장자·MIME·5MB).
- 됨: 작성·수정 시 Perspective 독성 비동기 검사 후 ai_flagged 설정, 운영진 BLUR 해제(clear-blur).
- 계획/주의: 상태 전환은 단일 status 컬럼 기반이라 동시 요청 시 낙관적 잠금 같은 동시성 제어는 없다. 첨부 검증 유틸의 공통화(파일 화이트리스트)는 TODO로 남아 있다. 상태 전환을 enum 타입으로 강타입화하지 않고 문자열 상수로 비교한다.

## 6. 면접 답변 3단계

1. 한 줄: 문의는 status 컬럼 하나로 생애주기를 표현하고, 각 전환 엔드포인트가 권한과 현재 상태를 동시에 검증합니다.
2. 설계 의도: 답변 이후 본문 변경을 막고, 사용자의 삭제·공개전환은 요청과 운영진 승인을 분리해 데이터가 일방적으로 사라지지 않게 했습니다.
3. 구현 근거: PENDING에서만 edit이 허용되고, answer는 complete 플래그로 IN_PROGRESS와 COMPLETED를 분기하며, updateStatusWithTime이 상태별 시각 컬럼을 CASE로 갱신합니다.

## 7. 꼬리질문+모범답안

:::details 답변을 단 뒤에 사용자가 본문을 못 고치게 하는 근거는?
edit 엔드포인트가 현재 status가 PENDING이 아니면 400을 반환합니다. 답변 등록 시 상태가 IN_PROGRESS 이상으로 올라가므로, 답변 맥락과 어긋나는 본문 변조를 구조적으로 차단합니다.
:::

:::details 사용자가 직접 문의를 지우지 못하게 한 이유와 방식은?
완료된 문의는 운영 기록이므로 즉시 삭제를 막습니다. 사용자는 COMPLETED 상태에서 delete-request로 DELETE_REQUESTED를 만들 수만 있고, 실제 삭제는 운영진의 delete-approve에서 수행됩니다. 사용자는 delete-cancel로 다시 COMPLETED로 되돌릴 수 있습니다.
:::

:::details USER_COMPLETED와 COMPLETED를 굳이 나눈 이유는?
완료의 주체를 구분하기 위해서입니다. COMPLETED는 운영진이 완료 처리한 것이고, USER_COMPLETED는 사용자가 IN_PROGRESS 또는 COMPLETED 상태에서 스스로 종료한 것입니다. 두 경우 모두 completed_at에 시각을 남기지만 상태값으로 출처를 구분할 수 있습니다.
:::

:::details 전환 시각 컬럼이 여러 개인데 한 번의 UPDATE로 어떻게 관리하나?
updateStatusWithTime 매퍼가 각 시각 컬럼을 CASE 식으로 갱신합니다. 새 status에 해당하는 컬럼에만 NOW를 넣고 나머지는 기존값을 유지하므로, 단일 쿼리로 상태와 시각을 일관되게 기록합니다.
:::

:::details 도배성 문의는 어떻게 막나?
작성 시 운영 정책의 시간창과 최대 개수를 읽어, 해당 시간창 내 동일 사용자의 최근 문의 수가 한도 이상이면 IllegalStateException을 던지고 컨트롤러가 429를 반환합니다. 정책값은 코드 상수가 아니라 운영 설정에서 가져옵니다.
:::

## 8. 직접 말해보기

- 문의가 PENDING에서 시작해 삭제되기까지 거칠 수 있는 상태 경로를 화이트보드 없이 말로 순서대로 설명해 보라.
- 사용자 삭제 요청과 운영진 승인을 분리한 설계가 어떤 사고를 막는지 한 문장으로 정리해 보라.
- answer 엔드포인트의 complete 플래그가 false일 때와 true일 때 상태와 알림이 어떻게 달라지는지 비교해 보라.

## 관련 문서

- [AI 답변 초안(Claude)](/inquiry/ai-draft-claude)
- [첨부·비공개 워크플로우](/inquiry/attachments-visibility)
- [도메인 전체 개요](/domains)
- [담당별 보기](/by-area/)
- [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="문의 본문 수정(edit)이 허용되는 status는 무엇인가?" :choices="['PENDING', 'IN_PROGRESS', 'COMPLETED', 'DELETE_REQUESTED']" :answer="0" explanation="edit 엔드포인트는 현재 status가 PENDING이 아니면 400을 반환한다. 답변이 달려 IN_PROGRESS 이상이 되면 본문 수정은 막힌다." />

<QuizBox question="사용자가 COMPLETED 상태에서 delete-request를 호출하면 status는 어떻게 되는가?" :choices="['바로 삭제된다', 'DELETE_REQUESTED 로 바뀌고 운영진 승인을 기다린다', 'CANCELLED 로 바뀐다', 'PENDING 으로 되돌아간다']" :answer="1" explanation="사용자는 즉시 삭제할 수 없다. delete-request는 DELETE_REQUESTED 상태를 만들고, 실제 삭제는 운영진의 delete-approve에서 수행된다. 사용자는 delete-cancel로 COMPLETED 복원도 가능하다." />

<QuizBox question="운영진이 answer를 등록할 때 complete=true 로 보내면 문의 status는 무엇이 되는가?" :choices="['PENDING', 'IN_PROGRESS', 'COMPLETED', 'USER_COMPLETED']" :answer="2" explanation="writeAnswer는 complete 플래그가 true면 COMPLETED, false면 IN_PROGRESS로 상태를 바꾼다. 두 경우 모두 답변 1건이 INQUIRY_ANSWER에 저장되고 작성자에게 알림이 발행된다." />
