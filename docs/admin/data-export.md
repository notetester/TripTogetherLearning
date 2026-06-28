---
title: "데이터 내보내기 (Excel)"
owner: A
domain: "관리자·운영"
tags: ["Excel", "내보내기"]
---

# 데이터 내보내기 (Excel)

> 관리자 목록 화면의 데이터를 Apache POI 로 만든 .xlsx 또는 UTF-8 BOM 을 붙인 .csv 로 내려받는 기능이다. 핵심은 단순 파일 생성이 아니라, 화면에서 보던 것과 같은 검색 조건을 서버에서 다시 풀어 전체·검색결과·선택 항목이라는 세 가지 범위를 일관되게 추출하는 데 있다.

## 1. 한 줄 정의

관리자가 회원·기업 계정 신청·이메일 인증 이력·관리자 역량(급여) 표 같은 운영 데이터를 화면의 검색 조건과 선택 상태를 유지한 채 Excel(.xlsx) 또는 CSV 파일로 내려받아 외부에서 보고·감사·일괄 편집에 쓸 수 있게 하는 데이터 추출 계층이다.

## 2. 왜 이렇게 설계했나

운영 데이터는 화면에서 보는 것만으로는 부족하다. 정산 보고, 감사 증빙, 외부 검토, 일괄 수정 같은 작업은 결국 파일로 떨어진 표를 필요로 한다. 그래서 내보내기는 부가 기능이 아니라 관리자 도구의 기본 출구다. 설계의 핵심 결정은 네 가지다.

첫째, **추출 범위를 세 가지로 명시**했다. `scope` 파라미터로 all(전체)·search(현재 검색결과)·selected(체크한 항목)를 구분한다. 화면에서 필터를 걸어 좁혀 본 결과를 그대로 파일로 받고 싶을 때와, 필터를 무시하고 전수를 받고 싶을 때는 의도가 다르다. 이를 한 엔드포인트에서 분기로 처리해 호출 측 UI 가 같은 버튼으로 세 경우를 모두 표현하게 했다.

둘째, **검색 조건을 페이징과 분리**했다. 화면 목록은 20건씩 페이지로 끊어 보지만, 내보내기는 그 페이지가 아니라 조건에 맞는 전체를 받아야 한다. 그래서 export 전용 조회 메서드(예: findMembersForExport)는 같은 검색 조건을 받되 페이지 제한을 풀고 전체를 한 번에 가져온다. 급여 표 내보내기는 더 직접적이어서 page 를 1, pageSize 를 Integer.MAX_VALUE 로 강제해 전 행을 끌어온다.

셋째, **Excel 과 CSV 를 둘 다 제공**했다. `format` 파라미터로 갈라지며 기본값은 csv 다. CSV 는 가볍고 어디서나 열리지만 한글 깨짐과 인용 처리에 약하고, Excel 은 헤더 스타일·시트명·숫자형 셀을 제대로 표현하지만 라이브러리(POI) 의존이 생긴다. 두 경로를 같은 데이터로 만들어 사용자가 용도에 맞게 고르게 했다.

넷째, **CSV 의 한글 깨짐을 BOM 으로** 막았다. Excel for Windows 는 BOM 없는 UTF-8 CSV 를 시스템 기본 인코딩으로 잘못 읽어 한글이 깨진다. 그래서 CSV 본문 맨 앞에 UTF-8 BOM 문자를 직접 넣고 바이트는 UTF-8 로 인코딩한다.

:::tip Excel 과 CSV 를 나눈 이유
같은 데이터라도 출력은 둘로 갈린다. 감사관에게 보내거나 셀 서식이 필요하면 .xlsx, 다른 시스템에 다시 넣거나 스크립트로 처리할 거면 .csv. 한 데이터 소스에서 두 포맷을 빌드하는 빌더 메서드를 쌍으로 두는 방식이 이 선택지를 깔끔하게 표현한다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 책임 | 구성요소 |
| --- | --- |
| 회원/기업신청/이메일이력 내보내기 엔드포인트 | `AdminController` 의 exportMembers, exportBusinessApplications, exportEmailVerificationRequests, exportEmailVerificationTokens |
| 범위별 데이터 조회 | `AdminService` 의 getMembersForExport / getMembersByIds (search · all · selected 분기) |
| Excel 바이트 생성 | `AdminController` 의 buildMemberExcel 등 build...Excel (XSSFWorkbook 사용) |
| CSV 바이트 생성 | `AdminController` 의 buildMemberCsv 등 build...Csv (BOM + csvVal 이스케이프) |
| 관리자 역량(급여) 내보내기 | `SuperAdminController` 의 salaryExport, `SalaryExcelExporter` 유틸 |
| 관리자 역량(급여) 업로드 파싱 | `SalaryExcelImporter` (헤더 검증 + 셀 타입 변환) |
| 라이브러리 | Apache POI poi-ooxml 5.5.1, XSSFWorkbook / WorkbookFactory |

POI 는 두 갈래로 쓰인다. `XSSFWorkbook` 은 .xlsx 를 메모리에서 만들어 `ByteArrayOutputStream` 으로 직렬화하고, 업로드 파싱에서는 `WorkbookFactory.create(inputStream)` 으로 사용자가 올린 파일을 읽어 행을 검증한다. 따라서 같은 헤더 정의가 내보내기와 업로드 양쪽에 공유되어, 내려받은 파일을 편집해 다시 올리는 왕복(round-trip)이 성립한다.

## 4. 동작 원리 (흐름·표·작은 코드)

회원 목록 내보내기 요청의 흐름은 다음과 같다.

| 단계 | 동작 |
| --- | --- |
| 1. 요청 | GET /admin/members/export 에 scope, format, search 조건, selectedIds 가 붙어 들어온다 |
| 2. 범위 분기 | scope 가 all 이면 빈 조건으로 전체, selected 면 ID 목록으로, 그 외엔 search 조건으로 조회 |
| 3. 데이터 적재 | 페이지 제한 없는 export 전용 매퍼로 전체 행을 메모리에 적재 |
| 4. 포맷 분기 | format 이 excel 이면 build...Excel, 아니면 build...Csv |
| 5. 응답 | Content-Disposition attachment 헤더와 알맞은 Content-Type 으로 byte 배열 반환 |

selected 범위의 ID 파싱은 방어적이다. 콤마로 자르고 공백을 버린 뒤 정규식으로 숫자만 통과시키고 중복을 제거한다. 즉 사용자가 보낸 selectedIds 문자열에 숫자 아닌 토큰이 끼어도 무시한다.

```java
// AdminController.parseSelectedMemberIds (요지)
Arrays.stream(selectedIds.split(","))
      .map(String::trim)
      .filter(s -> !s.isEmpty())
      .filter(s -> s.matches("\\d+"))   // 숫자만 허용
      .map(Long::parseLong)
      .distinct();
```

CSV 빌드의 핵심은 BOM 과 셀 이스케이프다. 본문 첫 글자로 BOM 을 넣고, 각 값은 콤마·따옴표·줄바꿈이 있으면 따옴표로 감싸고 내부 따옴표를 두 번으로 늘린다(RFC 4180).

```java
// csvVal: 콤마/따옴표/줄바꿈 포함 시 따옴표로 감싸고 내부 따옴표는 이중화
if (s.contains(",") || s.contains("\"") || s.contains("\n"))
    s = "\"" + s.replace("\"", "\"\"") + "\"";
```

Excel 빌드는 POI 로 시트를 만들고 0번 행에 헤더, 이후 행에 데이터를 채운 뒤 ByteArrayOutputStream 으로 직렬화한다. 숫자 컬럼은 문자열이 아니라 숫자형 셀로 넣어 Excel 에서 그대로 계산에 쓸 수 있게 한다.

```java
// build...Excel (요지)
try (XSSFWorkbook wb = new XSSFWorkbook();
     ByteArrayOutputStream out = new ByteArrayOutputStream()) {
    Sheet sheet = wb.createSheet("회원목록");
    Row h = sheet.createRow(0);                 // 헤더 행
    for (int i = 0; i < headers.length; i++)
        h.createCell(i).setCellValue(headers[i]);
    // ... 데이터 행 채우기 (숫자는 숫자형 셀)
    wb.write(out);
    return out.toByteArray();
}
```

관리자 역량(급여) 내보내기는 별도 유틸 `SalaryExcelExporter` 가 맡는다. 헤더 스타일(굵게·회색 배경)을 입히고 컬럼 폭을 고정하며, 날짜는 정해진 포맷으로 문자열화한다. 같은 헤더 배열을 `SalaryExcelImporter` 가 그대로 가지고 있어, 업로드 시 1번째 컬럼부터 순서가 기대 헤더와 정확히 일치하는지 검증한다. 한 컬럼이라도 어긋나면 몇 번째 컬럼에서 무엇을 기대했는지 알려주며 거부한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::warning 정직한 현재 상태
- 구현됨: 회원·기업 계정 신청·이메일 인증 요청/토큰 내보내기(CSV + Excel 양쪽), scope 세 분기(all · search · selected), CSV UTF-8 BOM 과 RFC 4180 이스케이프, 관리자 역량 표 Excel 내보내기와 업로드(헤더 검증 포함 왕복).
- 부분/주의: 대용량을 전제로 한 스트리밍 모델(SXSSFWorkbook) 은 쓰지 않고 XSSFWorkbook 으로 메모리에 전체를 만든다. 급여 내보내기는 pageSize 를 Integer.MAX_VALUE 로 강제해 전 행을 한 번에 적재한다. 현재 데이터 규모에서는 충분하지만 행이 매우 커지면 메모리 압박 가능성이 있다.
- 계획/향후: 비동기 대량 내보내기, 진행률 표시, 내보내기 행위 자체의 감사 로그 표준화(사유 코드)는 향후 과제다.
:::

## 6. 면접 답변 3단계

1. 한 줄: 관리자 목록을 화면의 검색 조건과 선택 상태를 유지한 채 Apache POI 로 만든 .xlsx 또는 BOM 붙인 .csv 로 내려받는 데이터 추출 기능입니다.
2. 설계 근거: 전체·검색결과·선택의 세 범위를 scope 파라미터 하나로 분기하고, 목록의 페이징과 분리된 export 전용 조회로 조건에 맞는 전수를 받습니다. CSV 한글 깨짐은 UTF-8 BOM 으로 막고, Excel 은 POI XSSFWorkbook 으로 헤더 스타일과 숫자형 셀까지 표현합니다.
3. 트레이드오프: 지금은 XSSFWorkbook 으로 전체를 메모리에 만드는데 현재 규모에선 단순하고 충분하지만, 행이 커지면 SXSSFWorkbook 스트리밍이나 비동기 내보내기로 전환할 여지를 남겨 뒀습니다.

## 7. 꼬리질문 + 모범답안

::: details scope 가 all 과 search 로 갈리는데, search 일 때는 화면에서 보던 20건만 받나요
아니요. 목록 화면의 페이징과 내보내기 조회는 분리돼 있습니다. search 범위는 같은 검색 조건을 export 전용 매퍼(findMembersForExport)에 넘기되 페이지 제한 없이 조건에 맞는 전체 행을 가져옵니다. 화면에서 좁힌 필터는 그대로 적용되지만, 보이던 한 페이지가 아니라 그 조건의 전수가 파일에 담깁니다.
:::

::: details CSV 인데 한글이 안 깨지게 하려고 무엇을 했나요
CSV 본문 맨 앞에 UTF-8 BOM 문자를 직접 넣고, 전체를 UTF-8 바이트로 인코딩합니다. Windows Excel 은 BOM 이 없으면 UTF-8 CSV 를 시스템 기본 인코딩으로 잘못 읽어 한글이 깨지는데, BOM 이 있으면 UTF-8 로 인식합니다. 또 값 안에 콤마·따옴표·줄바꿈이 있으면 따옴표로 감싸고 내부 따옴표를 이중화해 컬럼이 밀리지 않게 합니다.
:::

::: details 선택 항목 내보내기에서 selectedIds 에 이상한 값이 들어오면요
파싱 단계에서 콤마로 자른 뒤 공백을 버리고 정규식으로 숫자 토큰만 통과시키고 중복을 제거합니다. 숫자가 아닌 문자열은 그 자리에서 걸러지므로 잘못된 입력이 조회로 흘러가지 않습니다. 결과적으로 SQL 에 들어가는 ID 목록은 항상 정수만 남습니다.
:::

::: details Excel 을 만들 때 왜 파일로 저장하지 않고 byte 배열로 돌려주나요
요청-응답 한 사이클에서 바로 다운로드시키기 때문입니다. XSSFWorkbook 을 ByteArrayOutputStream 에 write 해서 byte 배열을 만들고, Content-Disposition attachment 헤더와 spreadsheet Content-Type 으로 응답 본문에 실어 보냅니다. 서버 디스크에 임시 파일을 남기지 않아 정리 부담과 동시 요청 충돌이 없습니다.
:::

::: details 내려받은 급여 Excel 을 편집해서 다시 올리면 동작하나요
네, 왕복이 설계의 핵심입니다. SalaryExcelExporter 와 SalaryExcelImporter 가 같은 헤더 배열을 공유합니다. 업로드 시 WorkbookFactory 로 파일을 읽어 1번째 컬럼부터 헤더 순서가 기대값과 정확히 일치하는지 검증하고, 한 칸이라도 어긋나면 몇 번째 컬럼에서 무엇을 기대했는지 알려주며 거부합니다. 이메일이 빈 행은 건너뛰고, 셀은 타입(문자열·숫자·수식)에 따라 안전하게 문자열로 변환합니다.
:::

## 8. 직접 말해보기

- scope 의 all · search · selected 세 가지가 각각 어떤 사용자 의도를 표현하는지, 그리고 search 가 목록 페이징과 어떻게 다른지 한 문단으로 설명해 보라.
- CSV 한글 깨짐을 막기 위한 BOM 처리와, 콤마·따옴표가 든 값의 이스케이프 규칙을 코드 없이 말로 풀어 보라.
- 내보내기와 업로드가 같은 헤더 정의를 공유함으로써 어떤 왕복 시나리오가 가능해지는지, 그리고 그때 무결성을 어떻게 지키는지 설명해 보라.

## 퀴즈

<QuizBox question="회원 내보내기 엔드포인트에서 화면 검색결과가 아니라 필터를 무시한 전체를 받고 싶을 때 scope 값으로 옳은 것은" :choices="['search', 'all', 'selected', 'page']" :answer="1" explanation="scope 가 all 이면 빈 검색 조건으로 전체를 조회하고, search 는 현재 검색 조건의 전수, selected 는 체크한 ID 목록만 조회한다." />

<QuizBox question="CSV 내보내기에서 Windows Excel 의 한글 깨짐을 막기 위해 본문 맨 앞에 넣는 것은 무엇인가" :choices="['UTF-8 BOM', '시트 헤더 스타일', 'XSSFWorkbook 인스턴스', 'Content-Disposition 헤더']" :answer="0" explanation="본문 첫 글자로 UTF-8 BOM 을 넣고 전체를 UTF-8 바이트로 인코딩해야 BOM 없는 UTF-8 을 시스템 기본 인코딩으로 잘못 읽는 문제를 막는다." />

<QuizBox question="급여 표 내려받기와 업로드 사이의 왕복이 성립하는 핵심 이유로 옳은 것은" :choices="['업로드는 검증 없이 모든 행을 그대로 반영한다', 'Exporter 와 Importer 가 같은 헤더 배열을 공유하고 업로드 시 컬럼 순서 일치를 검증한다', '업로드는 CSV 만 받고 Excel 은 받지 않는다', '내보내기는 한 페이지만 받는다']" :answer="1" explanation="SalaryExcelExporter 와 SalaryExcelImporter 가 동일한 헤더 정의를 공유하고, 업로드 시 1번째 컬럼부터 순서가 기대 헤더와 정확히 일치하는지 검증해 헤더가 어긋나면 거부한다." />

---

더 보기: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · [관리자 운영 개요](/admin/) · [감사 로그](/admin/audit-logs)
