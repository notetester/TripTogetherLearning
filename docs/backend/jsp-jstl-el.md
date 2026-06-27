# JSP · JSTL · EL

> TripTogether의 화면은 컨트롤러가 넘긴 모델을 서버에서 JSP로 렌더링한다. 반복·조건은 JSTL 태그(`c:forEach`/`c:if`)로, 값 출력은 EL(`${...}`)로 처리하고, 자바 스크립틀릿(`<% %>`)은 쓰지 않는다.

이 페이지는 특정 도메인의 화면이 아니라, 4명이 만든 모든 도메인의 JSP가 공통으로 따르는 **서버 사이드 뷰 렌더링 규약**을 다룬다. 커뮤니티 목록, 관리자 테이블, 여행 코스 작성 화면 등 모든 화면이 동일한 태그 라이브러리와 EL 규칙 위에서 만들어진다.

## 1. 한 줄 정의

JSP(JavaServer Pages)는 **embedded Tomcat의 Jasper 엔진이 서버에서 HTML로 컴파일·렌더링하는 뷰 템플릿**이고, JSTL은 그 안에서 자바 코드 없이 반복·조건·포맷·메시지를 표현하는 표준 태그 라이브러리, EL(`${...}`)은 모델 객체의 값을 꺼내 출력하는 표현 언어다. 셋이 묶여 `/WEB-INF/views/**/*.jsp` 화면을 구성한다.

## 2. 왜 이렇게 설계했나

- **서버 세션 인증 + 다국어 콘텐츠 중심이라 서버 렌더링이 단순했다.** 화면 대부분이 로그인 세션과 i18n 메시지를 서버에서 적용해 완성된 HTML로 내려가는 편이 SPA보다 구현 비용이 낮았다. (동적 상호작용이 필요한 챗봇·AI 일정·SSE 알림만 같은 MVC 위에서 JSON API로 분리했다 → [Spring MVC](/backend/spring-mvc).)
- **스크립틀릿(`<% %>`) 금지, JSTL/EL만 사용.** 뷰에 자바 로직을 넣으면 테스트 불가·재사용 불가·XSS 사고가 늘어난다. 분기·반복은 `c:if`/`c:forEach` 태그로, 값은 EL로만 다뤄 뷰를 선언적으로 유지한다.
- **EL과 JS의 문법 충돌을 규칙으로 못박았다.** EL `${...}`와 JS 템플릿 리터럴·정규식 `{}`가 같은 파일에서 부딪히면 Jasper가 EL로 오해해 깨진다. 그래서 `onclick`에 EL 직접 삽입 금지, JS 정규식 중괄호는 유니코드 이스케이프 같은 팀 규칙을 둔다(아래 4절).
- **다국어는 코드가 아니라 메시지 키로.** 화면 문자열을 하드코딩하지 않고 `spring:message`로 키를 참조해, 한 JSP가 4개국어(ko/en/ja/zh)를 동시에 지원한다.

## 3. 어떤 기술로 구현했나 (실제 설정·태그)

| 요소 | TripTogether 구현 |
| --- | --- |
| 뷰 위치 | `/WEB-INF/views/{module}/*.jsp` (URL 직접 접근 불가, 컨트롤러 경유) |
| 뷰 리졸버 | `InternalResourceViewResolver` — prefix `/WEB-INF/views/`, suffix `.jsp` |
| JSP 컴파일 | `tomcat-embed-jasper` (WAR 패키징, embedded Tomcat) |
| 코어 태그 | `c:` — `http://java.sun.com/jsp/jstl/core` (`forEach`, `if`, `choose`, `set`, `url`) |
| 포맷 태그 | `fmt:` — `formatDate`, `formatNumber` |
| 함수 태그 | `fn:` — `length`, `escapeXml` |
| 다국어 태그 | `spring:` — `<spring:message code="..."/>` (MessageSource 연동) |
| 표현 언어 | EL `${...}` — 모델·세션·`param`·`pageContext` 접근 |
| 조각 재사용 | `<%@ include file="../common/header.jsp" %>` (정적 include), `.jspf` 프래그먼트 |

모든 화면 JSP 상단은 동일한 taglib 선언으로 시작한다(코드베이스 전체에서 `c:`/`spring:` 133회, `fn:` 99회, `fmt:` 97회 사용).

```jsp
<%@ page contentType="text/html;charset=UTF-8" language="java" %>
<%@ taglib prefix="c"      uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="fmt"    uri="http://java.sun.com/jsp/jstl/fmt" %>
<%@ taglib prefix="fn"     uri="http://java.sun.com/jsp/jstl/functions" %>
<%@ taglib prefix="spring" uri="http://www.springframework.org/tags" %>
```

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 렌더링 흐름

```text
@Controller 메서드 return "community/list"
  → InternalResourceViewResolver
      → /WEB-INF/views/community/list.jsp
  → Jasper 가 JSP → 서블릿 컴파일 (최초 1회)
      → EL ${post.title}     : 모델/세션 값 치환
      → c:forEach / c:if      : 반복·조건 전개
      → spring:message        : 현재 Locale 메시지로 치환
  → 완성된 HTML 응답
```

### 4.2 EL 출력과 JSTL 반복·조건

EL은 게터를 점 표기로 호출한다(`post.title` → `getTitle()`). 출력 전 사용자 입력은 `fn:escapeXml`로 정화해 XSS를 막는다.

```jsp
<c:if test="${not empty popularList}">
  <c:forEach var="post" items="${popularList}">
    <c:set var="isBlocked"  value="${post.postStatus eq 'BLOCKED'}"/>
    <c:set var="isBlurred"  value="${(post.reportCount >= reportThreshold or post.aiFlagged) and !isAdminMode}"/>
    <c:choose>
      <c:when test="${isBlurred}"> ...블러 처리... </c:when>
      <c:otherwise>
        <img src="${pageContext.request.contextPath}${post.thumbUrl}"
             alt="${fn:escapeXml(post.title)}" loading="lazy">
      </c:otherwise>
    </c:choose>
  </c:forEach>
</c:if>
```

| 의도 | 태그/문법 | 실제 사용 예 |
| --- | --- | --- |
| 반복 | `<c:forEach var items>` | 게시글·댓글·관리자 테이블 행 |
| 단일 조건 | `<c:if test>` | `not empty`, 권한 분기 |
| 다중 분기 | `<c:choose><c:when><c:otherwise>` | 블러/정상, 상태별 라벨 |
| 지역 변수 | `<c:set var value>` | 파생 플래그(`isBlurred`) 사전 계산 |
| 날짜 포맷 | `<fmt:formatDate pattern>` | `pattern="yyyy.MM.dd HH:mm:ss"` |
| 길이/정화 | `fn:length`, `fn:escapeXml` | 검색값·카운트 출력 |
| 다국어 | `<spring:message code>` | 모든 화면 문자열 |

### 4.3 다국어 메시지: 키만 쓰고 문자열은 안 쓴다

화면 상단에서 메시지를 `var`로 미리 뽑아두고(특히 JS로 넘길 값은 `javaScriptEscape="true"`), 본문에서 `${...}`로 참조한다. → [MessageSource](/i18n/messagesource), [LocaleResolver](/i18n/locale-resolver)

```jsp
<spring:message var="msg_delete_confirm" code="community.admin.delete.confirm"
                javaScriptEscape="true"/>
<button type="button">${msg_community_title}</button>
```

### 4.4 EL × JS 충돌 회피 규칙 (팀 규칙)

여기서 다루는 세 규칙은 TripTogether AGENTS 문서에 명시된 JSP/EL 작성 규칙이며, EL `${...}`와 JS가 같은 파일에 공존할 때 Jasper 파싱이 깨지는 것을 막는다.

**(1) `onclick` 안에 `${...}` 직접 삽입 금지 → `data-id` 속성으로 분리.**
EL을 인라인 핸들러 인자에 직접 박으면 따옴표·이스케이프가 꼬이고 XSS 표면이 넓어진다. 값은 `data-*` 속성에 담고, JS가 DOM에서 읽는다.

```jsp
<!-- ❌ 지양: onclick 인자에 EL 직접 -->
<button onclick="actionPost('${p.postId}','block')">차단</button>

<!-- ✅ 권장: data-id 로 값 분리, JS가 읽음 -->
<button data-id="${p.postId}"
        onclick="actionPost(this.getAttribute('data-id'), 'block')">차단</button>
```

```js
// 체크된 행의 id 수집 — DOM 속성에서만 읽는다
var ids = Array.from(document.querySelectorAll('.row-check:checked'))
               .map(function (cb) { return cb.getAttribute('data-id'); });
```

**(2) JS 정규식의 중괄호 `{}` → 유니코드 `{`/`}` 로 이스케이프.**
정규식의 `{n}`을 그대로 두면 Jasper가 EL `${...}` 조각으로 오인할 수 있어, 코스 작성 화면 등에서 중괄호를 유니코드로 쓴다.

```js
// {0},{1} 플레이스홀더 치환 — 중괄호를 유니코드로
return template.replace(/{(\d+)}/g, function (_, index) { /* ... */ });
```

**(3) EL 삼항 안에 EL 중첩 금지 → `<c:if>`/`<c:set>`으로 분리.**
복잡한 조건은 EL 한 줄에 욱여넣지 말고 `c:set`으로 파생 플래그를 만든 뒤 `c:if`/`c:choose`로 분기한다(위 4.2의 `isBlurred` 패턴).

**(보너스) 이미지 경로는 항상 contextPath 기준.** 컨텍스트 경로가 `/TripTogether`라 절대경로를 직접 쓰면 깨진다.

```jsp
<img src="${pageContext.request.contextPath}/upload/community/UUID.jpg">
```

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: `InternalResourceViewResolver` 기반 JSP 서버 렌더링, JSTL `c:`/`fmt:`/`fn:` + `spring:message` 4개국어, `data-id`/유니코드 이스케이프/`c:set` 분리 등 EL×JS 충돌 회피 규칙, `fn:escapeXml` 출력 정화, `.jspf`/`include` 조각 재사용, `pageContext.request.contextPath` 경로 규칙.
- **부분 적용**: 모든 사용자 입력 출력에 `fn:escapeXml`을 빠짐없이 적용하는 것은 화면별로 편차가 있다(본문 HTML은 별도로 jsoup 정화 → [Perspective/정화 흐름](/community/toxicity-perspective)).
- **계획/한계**: 뷰는 **JSP 데스크톱 레이아웃 위주**이며 반응형/모바일·SPA 전환은 향후 과제다. 화면 컴포넌트 단위 테스트 체계는 없고, 검증은 컨트롤러/서비스 계층에 의존한다.

## 6. 면접 답변 3단계

1. **한 문장**: "화면은 컨트롤러가 넘긴 모델을 서버에서 JSP로 렌더링하고, 반복·조건은 JSTL 태그로, 값 출력은 EL로 처리합니다. 스크립틀릿은 쓰지 않습니다."
2. **설계 의도**: "서버 세션 인증과 다국어 콘텐츠가 중심이라 서버 렌더링이 단순했고, 화면 문자열은 하드코딩 대신 `spring:message` 키로 참조해 한 JSP가 4개국어를 지원하게 했습니다. 동적인 챗봇·AI 일정·SSE만 같은 MVC 위에서 JSON API로 분리했습니다."
3. **구체 근거**: "EL `${...}`와 JS가 같은 파일에서 충돌하지 않도록 팀 규칙을 뒀습니다. `onclick`에 EL을 직접 박지 않고 `data-id` 속성에 담아 JS가 `getAttribute`로 읽고, JS 정규식의 중괄호는 `{`/`}`로 이스케이프하고, 복잡한 조건은 `c:set`으로 파생 플래그를 만들어 `c:if`로 분기합니다. 출력은 `fn:escapeXml`로 정화합니다."

## 7. 꼬리질문 + 모범답안

:::details JSP가 `/WEB-INF/views/` 아래 있는 이유는?
`/WEB-INF`는 서블릿 스펙상 클라이언트가 URL로 직접 접근할 수 없는 영역입니다. 그래서 JSP를 여기 두면 반드시 컨트롤러(`@Controller`)를 거쳐야만 렌더링돼, 권한 검사나 모델 준비 없이 뷰가 노출되는 것을 막습니다. 매핑은 `InternalResourceViewResolver`가 prefix `/WEB-INF/views/` + suffix `.jsp`로 처리합니다.
:::

:::details 왜 스크립틀릿(`<% %>`)을 안 쓰고 JSTL/EL만 쓰나요?
뷰에 자바 로직이 섞이면 재사용·테스트가 어렵고, 출력 시 이스케이프를 빠뜨려 XSS가 나기 쉽습니다. 분기는 `c:if`/`c:choose`, 반복은 `c:forEach`, 값 출력은 EL로 선언적으로 다루면 뷰가 단순해지고, 사용자 입력은 `fn:escapeXml`로 정화하는 지점을 명확히 둘 수 있습니다.
:::

:::details `onclick`에 `${...}`를 직접 쓰면 뭐가 문제인가요?
두 가지입니다. 첫째 보안 — EL 값에 따옴표나 스크립트가 섞이면 인라인 핸들러 문자열이 깨지거나 주입 표면이 생깁니다. 둘째 파싱 — EL과 JS가 한 속성에 엉키면 다루기 까다롭습니다. 그래서 값은 `data-id` 같은 `data-*` 속성에 담고, JS가 `this.getAttribute('data-id')`로 읽도록 분리합니다. 실제 관리자 테이블의 차단/삭제 버튼이 이 패턴을 씁니다.
:::

:::details JS 정규식의 `{}`를 `{`로 바꾸는 이유는?
Jasper가 JSP를 파싱할 때 `${...}`를 EL로 해석하는데, JS 정규식의 `{n}` 같은 중괄호가 EL 조각으로 오인돼 컴파일이 깨질 수 있습니다. 정규식 중괄호를 유니코드 `{`(`{`)·`}`(`}`)로 쓰면 정규식 의미는 그대로면서 EL 충돌을 피합니다. 코스 작성 화면의 플레이스홀더 치환 정규식이 그 예입니다.
:::

:::details 화면 문자열을 어떻게 4개국어로 보여주나요?
하드코딩하지 않고 `<spring:message code="..."/>`로 메시지 키만 참조합니다. 현재 Locale(`SessionLocaleResolver`, 기본 한국어)에 맞는 properties에서 값을 찾아 치환합니다. JS로 넘길 메시지는 `javaScriptEscape="true"`로 뽑아 따옴표·개행을 안전하게 처리합니다. 자세한 흐름은 i18n 문서를 보면 됩니다.
:::

:::details EL `${not empty list}`와 `${list.size() > 0}` 중 무엇을 쓰나요?
`not empty`를 선호합니다. null과 빈 컬렉션·빈 문자열을 한 번에 안전하게 판별하고, 컬렉션이 null이어도 NPE 없이 false가 됩니다. 길이가 필요하면 `fn:length(list)`를 씁니다. 복잡한 조건은 EL 한 줄에 중첩하지 말고 `c:set`으로 파생 변수를 만들어 가독성을 확보합니다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 답해보고, 막히면 위 절을 다시 본다.

1. 컨트롤러가 `return "community/list"`를 했을 때 어떤 파일이, 어떤 설정으로 렌더링되는지 말해보라.
2. 반복·단일조건·다중분기를 각각 어떤 JSTL 태그로 처리하는가? 예를 들어보라.
3. `onclick`에 EL을 직접 쓰지 않는 이유 두 가지와, 대신 쓰는 패턴을 말해보라.
4. JS 정규식의 `{}`를 유니코드로 이스케이프하는 이유는 무엇인가?
5. 한 JSP가 4개국어를 지원하는 방식과, 문자열을 하드코딩하지 않는 이유는?

관련 페이지: [Spring MVC](/backend/spring-mvc) · [Spring Boot](/backend/spring-boot) · [예외 처리](/backend/exception-handling) · [MessageSource](/i18n/messagesource) · [LocaleResolver·언어전환](/i18n/locale-resolver) · 허브: [도메인 전체 개요](/domains) · [전체 흐름](/flow/) · [담당별 보기](/by-area/)

## 퀴즈

<QuizBox question="TripTogether JSP에서 게시글 리스트를 화면에 반복 출력할 때 표준적으로 쓰는 태그는?" :choices="['스크립틀릿 for 루프 (&lt;% for ... %&gt;)', 'JSTL c:forEach', 'EL ${list.each}', 'spring:message']" :answer="1" explanation="반복은 JSTL 코어 태그 c:forEach var items 로 처리한다. 스크립틀릿(자바 코드)은 쓰지 않는 것이 규칙이고, 값 출력만 EL ${...}로, 다국어 문자열은 spring:message로 처리한다." />

<QuizBox question="버튼의 onclick에 EL ${p.postId}를 직접 넣는 대신 TripTogether가 따르는 규칙은?" :choices="['EL을 JS 변수에 먼저 대입한다', 'data-id 속성에 값을 담고 JS가 getAttribute로 읽는다', 'onclick 대신 href에 EL을 넣는다', 'scriptlet으로 id를 출력한다']" :answer="1" explanation="onclick 인자에 EL을 직접 박으면 따옴표·이스케이프가 꼬이고 주입 표면이 생긴다. 값은 data-id 같은 data-* 속성에 담고 JS가 this.getAttribute('data-id')로 읽어 분리한다. 관리자 테이블의 차단/삭제 버튼이 이 패턴을 쓴다." />

<QuizBox question="JSP 안의 JS 정규식에서 중괄호를 { } 유니코드로 쓰는 이유는?" :choices="['정규식 성능을 높이려고', '브라우저 호환성 때문에', 'Jasper가 정규식의 {n}을 EL ${...} 조각으로 오인해 컴파일이 깨지는 것을 막으려고', 'JSTL 함수 충돌 때문에']" :answer="2" explanation="Jasper는 ${...}를 EL로 파싱하는데, JS 정규식의 {n} 같은 중괄호가 EL로 오인돼 깨질 수 있다. 중괄호를 유니코드({/})로 쓰면 정규식 의미는 유지하면서 EL 충돌을 피한다." />
