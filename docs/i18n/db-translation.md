---
title: "DB 번역 관리"
owner: C
domain: "다국어·공통"
tags: ["번역", "DB"]
---

# DB 번역 관리

> properties 파일이 UI 문구를 책임지는 정적 i18n이라면, DB 번역 관리는 사용자가 입력한 콘텐츠를 번역안·버전·원문 스냅샷까지 추적해 관리자 화면에서 운영하는 동적 i18n이다.

## 1. 한 줄 정의

DB 번역 관리는 게시글·후기 같은 **사용자 생성 콘텐츠**를 (소스타입, 소스ID, 필드, 언어쌍) 단위로 번역안으로 만들고, 각 번역안의 **개정 이력(revision)** 과 번역 시점의 **원문 스냅샷(source snapshot)** 을 분리 저장해 관리자가 자동번역과 사람 교정을 함께 운영하는 모듈이다. 핵심 클래스는 `AdminTranslationController` / `AdminTranslationServiceImpl`, 핵심 테이블은 `ADMIN_TRANSLATION`, `ADMIN_TRANSLATION_REVISION`, `ADMIN_TRANSLATION_SOURCE_SNAPSHOT` 세 개다.

## 2. 왜 이렇게 설계했나

UI 라벨은 `MessageSource` + properties 로 충분하다. 빌드 시점에 고정되고, 키 하나에 언어별 값 하나가 대응하면 끝이다. 하지만 **사용자가 런타임에 작성하는 콘텐츠**는 다르다. 원문이 수정될 수 있고, 자동번역은 품질이 들쭉날쭉하며, 사람이 손본 버전을 되돌릴 수도 있어야 한다. 그래서 정적/동적을 한 저장소에 섞지 않고 **DB 기반 별도 모듈**로 분리했다.

설계의 중심은 세 가지 분리다.

- **번역안과 개정의 분리.** 하나의 (콘텐츠, 언어쌍)에 여러 번역안(`ADMIN_TRANSLATION`)이 있을 수 있고, 각 번역안은 여러 개정(`ADMIN_TRANSLATION_REVISION`)을 누적한다. 자동번역 초안 → 사람 교정 → 재교정이 모두 개정으로 쌓이므로 이력이 사라지지 않는다.
- **원문 스냅샷의 분리.** 번역은 *그 시점의 원문*에 대한 번역이다. 원문이 나중에 바뀌면 기존 번역은 낡은(outdated) 것이 된다. 이를 판단하려고 번역할 때마다 원문을 `ADMIN_TRANSLATION_SOURCE_SNAPSHOT`에 SHA-256 해시와 함께 저장한다.
- **대표(primary) 번역안의 분리.** 같은 언어쌍에 번역안이 여럿이어도 화면에 노출할 한 건은 `is_primary`로 지정한다. 대표를 바꿔도 나머지 후보는 보존된다.

이 구조 덕분에 운영자는 "이 번역이 지금 원문과 맞는가", "이전 버전으로 되돌릴 수 있는가"를 항상 확인할 수 있다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

표준 4계층(controller → service → mapper → vo) 위에 얹혀 있다.

| 구성 요소 | 클래스 / 파일 | 역할 |
| --- | --- | --- |
| 관리자 컨트롤러 | `AdminTranslationController` (`/admin/translations`) | 조회·생성·개정·복원 REST 엔드포인트 |
| 서비스 | `AdminTranslationService` / `AdminTranslationServiceImpl` | 검증·스냅샷·자동번역 호출·대표 전환·outdated 판정 |
| 매퍼 | `AdminTranslationMapper` + `adminTranslationMapper.xml` | 세 테이블 조회·삽입·메타 갱신 SQL |
| VO | `AdminTranslationVO`, `AdminTranslationRevisionVO`, `AdminTranslationSourceSnapshotVO` | 테이블 매핑 + 화면 보조필드(`outdated`, `currentRevision`, `revisions`) |
| 요청 DTO | `AdminTranslationCreateRequest`, `AdminTranslationRevisionCreateRequest`, `AdminTranslationRestoreRequest` | 요청 본문 |
| 외부 호출 | `RestTemplate` → Google Cloud Translation v2 | 자동번역(`AUTO`) |
| 클라이언트 | `resources/js/admin/admin-translation.js` | 관리자 화면 조회·편집 UI |

세 테이블의 핵심 컬럼은 다음과 같다.

| 테이블 | 핵심 컬럼 | 의미 |
| --- | --- | --- |
| `ADMIN_TRANSLATION` | `source_type`, `source_idx`, `field_name`, `source_lang`, `target_lang`, `title`, `status`, `visibility_scope`, `is_primary`, `current_revision_idx` | 번역안 1행. 어떤 콘텐츠의 어떤 필드를 어느 언어쌍으로 번역하는가 |
| `ADMIN_TRANSLATION_REVISION` | `version_no`, `parent_revision_idx`, `source_snapshot_idx`, `translated_text`, `translation_type`, `translation_engine`, `review_status` | 번역안의 한 개정. 번역문 본문과 출처를 담음 |
| `ADMIN_TRANSLATION_SOURCE_SNAPSHOT` | `source_text`, `source_text_hash`, `snapshot_seq`, `captured_at` | 번역 시점의 원문과 SHA-256 해시 |

지원 언어는 `ko / en / ja / zh` 네 개로 화이트리스트 검증을 거치며, Google 호출 시 `zh`는 `zh-CN`으로 매핑된다. `status`는 DRAFT / PUBLISHED / ARCHIVED / LEGACY / HIDDEN, `visibility_scope`는 PUBLIC / ADMIN_ONLY / PRIVATE 로 정규화된다(기본값 DRAFT, ADMIN_ONLY).

:::tip 같은 위치 비교
정적 i18n([MessageSource·properties](/i18n/messagesource))은 키-값 테이블 하나로 끝나지만, 동적 콘텐츠는 위 세 테이블이 번역안·이력·원문을 나눠 갖는다. 같은 i18n이라도 "고정 라벨"과 "변하는 콘텐츠"는 다른 저장 전략이 필요하다는 게 핵심이다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

엔드포인트는 네 개다. 모두 `/admin/translations` 하위이며 관리자 영역이라 어드민 인터셉터 체인 뒤에서 동작한다.

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/lookup` | (소스타입, 소스ID, 필드)의 번역안 목록 + 각 번역안의 현재 개정 + outdated 여부 |
| POST | `/` | 새 번역안 생성(자동번역 또는 수동), 버전 1 개정 동시 생성 |
| POST | `/{idx}/revisions` | 기존 번역안에 새 개정 추가(사람 교정 등), 버전 증가 |
| POST | `/{idx}/restore` | 지정 개정을 현재 개정으로 되돌림 |

**생성 흐름**의 뼈대(`createTranslation`):

```text
1. 요청 검증 + 언어 정규화(ko/en/ja/zh 화이트리스트)
2. captureSnapshot: 원문 해시 계산 → 직전 스냅샷과 해시 같으면 재사용, 다르면 새 스냅샷 INSERT
3. autoTranslate?
     예  → Google v2 호출, type=AUTO, engine 기록
     아니오 → 수동 번역문 사용, type=MANUAL
4. ADMIN_TRANSLATION INSERT (대표 여부 결정)
5. ADMIN_TRANSLATION_REVISION INSERT (version_no=1, snapshot 연결)
6. 대표면 같은 언어쌍의 기존 대표 해제 → 이 번역안의 current_revision_idx 갱신
```

핵심 메서드 두 개는 다음과 같이 동작한다.

- **`captureSnapshot`** — 원문을 정규화한 뒤 SHA-256으로 해시한다. 같은 콘텐츠의 최신 스냅샷과 해시가 동일하면 새로 만들지 않고 재사용한다. 즉 원문이 안 바뀌면 스냅샷이 무한히 늘지 않는다. `snapshot_seq`는 콘텐츠별로 1부터 증가한다.
- **outdated 판정** — 조회 시 현재 원문의 해시를 다시 계산해, 현재 개정이 들고 있는 `source_text_hash`와 다르면 `outdated = true`로 표시한다. 화면은 이 플래그로 "원문이 바뀌어 번역이 낡았다"를 운영자에게 알린다.

개정 추가(`createRevision`)는 직전 개정의 번역 유형을 물려받되, 자동번역이던 것을 사람이 손보면 `POST_EDIT`로 기록한다(MANUAL은 MANUAL 유지). 복원(`restoreRevision`)은 본문을 새로 쓰지 않고 `current_revision_idx`만 과거 개정으로 바꾸는, 비파괴적 되돌리기다.

자동번역 호출 부분의 추상화:

```text
requestTranslation(text, sourceLang, targetLang):
  sourceLang == targetLang  → 원문 그대로 반환(호출 안 함)
  API 키 없음               → 예외(번역 API 키가 비어 있음)
  Google v2 POST(q, source, target, format=text)
  응답 data.translations[0].translatedText → HTML 언이스케이프 후 반환
```

생성·개정·복원은 모두 `@Transactional`이라, 스냅샷·번역안·개정·대표전환 중 하나라도 실패하면 전체가 롤백된다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| 세 테이블 스키마·매퍼 | 구현됨 |
| 조회/생성/개정/복원 4개 엔드포인트 | 구현됨 |
| 원문 스냅샷 해시·outdated 판정 | 구현됨 |
| 대표(primary) 전환·언어쌍 정규화 | 구현됨 |
| 자동번역(Google Cloud Translation v2) | 구현됨(키 주입 시 동작, 키 없으면 명시적 예외) |
| 개정 이력·비파괴 복원 | 구현됨 |
| `review_status`(NONE 등) 컬럼 | 스키마·기록은 있으나 본격 리뷰 워크플로우는 단순 단계 |
| 자동번역 품질 정량평가 | 부재(프로젝트 전반의 향후 과제) |

:::warning 보안 주의
번역 API 키는 `gcp.translate.api.key` 설정값으로 주입되며 코드·문서에 평문으로 두지 않는다. 본 학습 페이지에서도 실제 키 대신 `API_KEY` 같은 자리표시자로만 표기한다.
:::

## 6. 면접 답변 3단계

1. **무엇** — "사용자 콘텐츠의 번역을 관리자 화면에서 다루는 모듈입니다. (콘텐츠, 필드, 언어쌍) 단위로 번역안을 만들고, 자동번역 초안과 사람 교정을 같은 번역안의 개정 이력으로 쌓습니다."
2. **어떻게** — "번역할 때마다 원문을 SHA-256 해시와 함께 스냅샷으로 저장합니다. 조회 시 현재 원문 해시와 비교해 번역이 낡았는지를 outdated 플래그로 알려주고, 과거 개정으로 비파괴 복원도 됩니다."
3. **왜** — "UI 라벨은 properties로 충분하지만 변하는 콘텐츠는 이력·원문 추적이 필요해서, 정적 i18n과 분리해 DB 세 테이블로 설계했습니다."

## 7. 꼬리질문 + 모범답안

:::details properties 기반 i18n으로 콘텐츠 번역까지 처리하면 안 되나요?
properties는 빌드 시 고정되고 키마다 값 하나만 가집니다. 사용자 콘텐츠는 런타임에 생성·수정되고, 자동번역과 사람 교정이 섞이며, 이전 버전 복원이 필요합니다. 이 요구를 키-값 파일에 욱여넣으면 이력과 원문 추적이 불가능합니다. 그래서 동적 콘텐츠는 DB 모듈로 분리했습니다.
:::

:::details 원문이 바뀌면 기존 번역이 낡은 걸 어떻게 아나요?
번역 시점의 원문을 스냅샷 테이블에 SHA-256 해시로 저장합니다. 조회할 때 현재 원문의 해시를 다시 계산해, 현재 개정이 들고 있는 해시와 다르면 outdated로 표시합니다. 텍스트 전체를 비교하지 않고 해시만 비교하므로 빠르고, 같은 원문이면 스냅샷을 재사용해 중복 저장도 막습니다.
:::

:::details 같은 언어쌍에 번역안이 여러 개면 화면엔 뭐가 나가나요?
번역안마다 is_primary 플래그가 있고, 화면에는 대표 한 건만 노출합니다. 새 대표를 지정하면 같은 언어쌍의 기존 대표를 해제하는 식으로 한 건만 유지되며, 나머지 후보는 삭제되지 않고 보존됩니다. 대표 전환은 메타 갱신이라 본문을 건드리지 않습니다.
:::

:::details 자동번역과 사람 교정을 어떻게 구분하나요?
개정의 translation_type으로 구분합니다. 자동번역은 AUTO이고 engine과 version을 함께 기록합니다. 사람이 처음부터 직접 쓰면 MANUAL, 자동번역을 사람이 손보면 POST_EDIT로 기록합니다. 덕분에 어떤 번역이 기계 산출이고 어떤 게 사람 손을 거쳤는지 이력으로 남습니다.
:::

:::details 번역 도중 일부 단계가 실패하면 데이터가 깨지지 않나요?
생성·개정·복원 서비스 메서드가 모두 @Transactional입니다. 스냅샷 저장, 번역안 삽입, 개정 삽입, 대표 전환, 현재 개정 갱신이 한 트랜잭션 안에서 이뤄지므로 중간에 외부 번역 호출이 실패하거나 예외가 나면 전체가 롤백됩니다. 부분 저장으로 인한 정합성 깨짐을 막습니다.
:::

## 8. 직접 말해보기

- "정적 i18n과 DB 번역 관리를 한 문장씩으로 구분해 설명해 보세요."
- "원문이 수정됐을 때 기존 번역을 낡았다고 표시하는 메커니즘을 화이트보드 없이 말로 설명해 보세요."
- "번역안과 개정과 원문 스냅샷이 각각 왜 별도 테이블인지 한 가지 이유씩 들어 보세요."
- 더 넓게: [다국어·공통 개요](/i18n/), [Google 번역 API](/i18n/google-translation), [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)

## 퀴즈

<QuizBox question="DB 번역 관리에서 원문 스냅샷 테이블이 SHA-256 해시를 저장하는 주된 이유는?" :choices="['번역문을 암호화해 보관하기 위해', '현재 원문과 비교해 번역이 낡았는지(outdated) 판정하기 위해', '관리자 비밀번호를 검증하기 위해', '번역 API 응답을 캐싱하기 위해']" :answer="1" explanation="번역 시점 원문의 해시를 저장해 두고, 조회 시 현재 원문 해시와 비교해 다르면 outdated로 표시한다. 텍스트 전체 비교 없이 빠르게 낡음 여부를 판정한다." />

<QuizBox question="자동번역 초안을 사람이 손본 개정의 translation_type 값으로 가장 적절한 것은?" :choices="['AUTO', 'MANUAL', 'POST_EDIT', 'DRAFT']" :answer="2" explanation="처음부터 사람이 쓰면 MANUAL, 자동번역을 사람이 교정하면 POST_EDIT로 기록한다. AUTO는 기계 산출 초안을 가리킨다." />

<QuizBox question="정적 i18n(properties)과 비교했을 때 DB 번역 관리를 별도 모듈로 분리한 핵심 근거가 아닌 것은?" :choices="['콘텐츠 원문이 런타임에 수정될 수 있다', '자동번역과 사람 교정 이력을 함께 추적해야 한다', '이전 번역 버전으로 되돌릴 수 있어야 한다', 'UI 라벨 문구가 언어별로 하나씩만 필요하다']" :answer="3" explanation="언어별 값 하나면 충분한 고정 라벨은 properties로 처리한다. 변하는 콘텐츠의 원문 추적, 이력, 복원 요구가 DB 모듈 분리의 근거다." />
