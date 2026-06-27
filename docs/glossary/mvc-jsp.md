# MVC와 JSP

> 컨트롤러가 데이터를 `Model`에 담아 논리적 뷰 이름을 돌려주면, ViewResolver가 그 이름을 실제 JSP 파일로 바꿔 서버에서 HTML을 완성해 내려보내는 구조.

## 1. 한 줄 정의

**MVC**(Model–View–Controller)는 한 요청을 처리할 때 "데이터(Model) · 화면(View) · 흐름 제어(Controller)"를 세 역할로 가르는 패턴이다. TripTogether의 백엔드는 Spring MVC로 이 패턴을 구현하고, **View는 JSP**로 그린다. 컨트롤러는 HTML 문자열을 직접 만들지 않는다. 대신 `"home/home"` 같은 **논리적 뷰 이름**만 반환하고, Spring의 `InternalResourceViewResolver`가 설정된 prefix/suffix를 붙여 `/WEB-INF/views/home/home.jsp`를 찾아 렌더링한다.

이 방식은 **서버사이드 렌더링(SSR)** 이다. 브라우저가 받는 것은 이미 완성된 HTML이고, JSP 안의 `${...}`나 `<c:forEach>`는 서버에서 이미 다 풀린 뒤다. 별도의 SPA(React 등) 클라이언트는 없다.

## 2. 왜 이렇게 설계했나

- **관심사 분리**: 컨트롤러는 "어떤 데이터를 어떤 화면에 보낼지"만 결정하고, 어떻게 그려질지는 JSP가 맡는다. SQL·비즈니스 규칙은 그 아래 service·mapper로 더 내려간다([4계층 구조](/glossary/layered-architecture) 참고).
- **논리적 뷰 이름의 이점**: 컨트롤러가 `/WEB-INF/views/home/home.jsp`라는 물리 경로 대신 `"home/home"`만 알면 되므로, 뷰 디렉터리 구조가 바뀌어도 설정 한 곳(prefix/suffix)만 고치면 된다.
- **`/WEB-INF/` 아래에 둔 이유**: 서블릿 스펙상 `/WEB-INF/`는 브라우저가 URL로 **직접 접근할 수 없는** 영역이다. JSP를 여기에 두면 반드시 컨트롤러를 거쳐야만 화면이 나오므로, 인증·권한 [인터셉터](/glossary/interceptor)를 우회한 직접 접근을 막는다.
- **SSR 선택의 맥락**: 초기 표시 속도와 SEO에 유리하고, 별도 프런트 빌드 파이프라인 없이 한 WAR로 배포된다. 대신 모바일은 데스크톱 위주 레이아웃이고 반응형/SPA 전환은 향후 과제다.

:::tip "포워드"지 "리다이렉트"가 아니다
ViewResolver가 JSP로 넘기는 것은 서버 내부 **forward**다. URL은 그대로 유지되고 같은 요청·`Model`이 JSP까지 이어진다. 반대로 `return "redirect:/login"`처럼 `redirect:` 접두어를 쓰면 브라우저에 새 요청을 일으키는 리다이렉트가 된다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·설정)

뷰 리졸버는 별도 자바 코드 없이 `application.properties`의 두 줄로 동작한다. Spring Boot가 이 값으로 `InternalResourceViewResolver`를 자동 구성한다.

```properties
# application.properties
server.servlet.context-path=/TripTogether
spring.mvc.view.prefix=/WEB-INF/views/
spring.mvc.view.suffix=.jsp
```

| 구성 요소 | 실제 위치 | 역할 |
| --- | --- | --- |
| Controller | `HomeController` (`@Controller` + `@GetMapping("/")`) | URL 매핑, `Model`에 데이터 담기, 뷰 이름 반환 |
| Model | 핸들러 메서드의 `Model model` 파라미터 | View로 넘길 데이터 보관 |
| View | `/WEB-INF/views/home/home.jsp` | EL·JSTL로 HTML 생성 |
| ViewResolver | `application.properties`의 prefix/suffix | 논리 이름 → 물리 JSP 경로 |
| JSP 엔진 | embedded Tomcat + `tomcat-embed-jasper` | JSP를 서블릿으로 컴파일·실행 |
| 태그/표현식 | JSTL(`c`/`fmt`/`fn`) + `spring:message` | 반복·조건·포맷·다국어 |

JSP 패키징은 **WAR**(embedded Tomcat)다. 일반 jar 실행과 달리 JSP 컴파일을 위해 Jasper가 필요하며, `index.jsp`는 정적 진입점, 도메인 화면은 모두 `/WEB-INF/views/<도메인>/*.jsp`에 있다(`home`, `community`, `courses`, `explore`, `admin` 등).

## 4. 동작 원리 (흐름·표·작은 코드)

### 한 요청의 생애주기

```text
GET /TripTogether/  (브라우저)
   │  context-path /TripTogether 제거 → "/"
   ▼
DispatcherServlet  ── 인터셉터 체인(locale→ipBlock→…→notification) 통과
   │
   ▼
HomeController.index(Model model)
   │   model.addAttribute("popularSpots", ...);   // Model 채우기
   │   return "home/home";                          // 논리적 뷰 이름
   ▼
ViewResolver: "home/home" → /WEB-INF/views/home/home.jsp  (prefix+이름+suffix)
   │
   ▼
JSP(Jasper)가 서버에서 EL/JSTL 평가 → 완성된 HTML
   │
   ▼
브라우저는 이미 그려진 HTML만 받음 (SSR)
```

### Controller: 데이터를 Model에 담고 이름만 반환

실제 `HomeController`의 구조를 추상화하면 이렇다. 컨트롤러는 HTML을 한 글자도 만들지 않는다.

```java
@Controller
public class HomeController {
    @GetMapping("/")
    public String index(Model model) {
        model.addAttribute("popularSpots", homeService.getPopularSpots());
        model.addAttribute("popularPosts", communityService.getPopularList(4));
        return "home/home";   // → /WEB-INF/views/home/home.jsp 로 forward
    }
}
```

### View: EL과 JSTL로 Model을 화면에 푼다

JSP는 상단에서 taglib를 선언하고, `${...}`(EL)로 Model 값을 읽고, `<c:forEach>`/`<c:if>`로 반복·조건을 처리한다. TripTogether의 JSP 약 141개가 이 taglib들을 쓴다.

```jsp
<%@ taglib prefix="c"   uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt" %>
<%@ taglib prefix="fn"  uri="http://java.sun.com/jsp/jstl/functions" %>
<%@ taglib prefix="spring" uri="http://www.springframework.org/tags" %>

<c:forEach var="spot" items="${popularSpots}">
  <li>${spot.spotName}</li>           <%-- EL: Model의 popularSpots 반복 --%>
</c:forEach>

<c:if test="${empty popularPosts}">
  <p>${msg_home_empty_posts}</p>      <%-- 조건부 렌더링 --%>
</c:if>
```

### EL / JSTL 역할 요약

| 문법 | 정체 | 쓰임새 (실제 예) |
| --- | --- | --- |
| `${spot.spotName}` | EL(Expression Language) | Model·요청·세션 속성 읽기 |
| `${pageContext.request.contextPath}` | EL 내장 객체 | 링크 앞에 `/TripTogether` 붙이기 |
| `<c:forEach>` / `<c:if>` | JSTL core | 반복·조건 분기 |
| `<fmt:formatNumber>` | JSTL fmt | 숫자·날짜 포맷 |
| `<fn:length>` | JSTL functions | 컬렉션 길이 등 헬퍼 |
| `<spring:message code="...">` | Spring 태그 | [i18n](/glossary/i18n-term) 메시지 출력(4개국어) |

:::details contextPath를 왜 매번 붙일까?
앱이 `server.servlet.context-path=/TripTogether` 아래 배포되므로, 실제 URL은 `/TripTogether/explore`다. JSP에서 링크를 `/explore`로 하드코딩하면 컨텍스트가 빠져 404가 난다. 그래서 `${pageContext.request.contextPath}/explore`처럼 contextPath를 앞에 붙여 환경에 독립적인 링크를 만든다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| Spring MVC + JSP 뷰 리졸버(prefix/suffix) | 구현됨 — 전 도메인 화면이 SSR JSP |
| JSTL/EL + `spring:message` 다국어 렌더링 | 구현됨 — ko/en/ja/zh 4개국어 |
| `/WEB-INF/` 보호 + 인터셉터 체인 통합 | 구현됨 |
| 공통 레이아웃(`common/header.jsp` include) | 구현됨 — `<%@ include %>`로 헤더 재사용 |
| 반응형/모바일 최적화 | 계획 — 현재 데스크톱 위주 레이아웃 |
| SPA(React 등) 클라이언트 분리 | 계획 — 현재 순수 SSR |
| REST API용 JSON 응답(AI·SSE 등 일부) | 구현됨 — 이 경우는 JSP가 아니라 `@ResponseBody`/JSON으로 응답 |

:::warning JSP가 전부는 아니다
챗봇·AI 도우미·SSE 알림 등 일부 엔드포인트는 화면(JSP)이 아니라 JSON을 반환한다. 이때는 `@RestController`/`@ResponseBody` 경로이고 ViewResolver를 타지 않는다. "TripTogether = 전부 JSP"가 아니라 "**페이지 렌더링은 JSP, 데이터 API는 JSON**"이 정확하다.
:::

## 6. 면접 답변 3단계

1. **한 줄**: "TripTogether는 Spring MVC + JSP 기반 서버사이드 렌더링입니다. 컨트롤러가 `Model`에 데이터를 담고 논리적 뷰 이름을 반환하면, prefix/suffix 설정으로 ViewResolver가 `/WEB-INF/views/...jsp`로 포워드해 HTML을 완성합니다."
2. **왜**: "뷰 경로를 논리 이름으로 추상화해 화면 구조 변경에 강하고, JSP를 `/WEB-INF/` 아래 둬서 컨트롤러·인터셉터를 우회한 직접 접근을 막습니다. SSR이라 초기 렌더와 SEO에 유리합니다."
3. **구체화**: "예를 들어 `HomeController`는 `model.addAttribute("popularSpots", ...)` 후 `"home/home"`을 반환하고, `home.jsp`는 `<c:forEach>`와 `${spot.spotName}` EL로 그 목록을 렌더링하며 다국어는 `<spring:message>`로 처리합니다."

## 7. 꼬리질문 + 모범답안

:::details Q. forward와 redirect의 차이는?
forward는 서버 내부에서 같은 요청을 다른 리소스(JSP)로 넘기는 것이라 URL이 그대로고 `Model`이 이어집니다. redirect는 브라우저에 새 URL로 다시 요청하라고 응답(3xx)하는 것이라 URL이 바뀌고 기존 요청 속성은 사라집니다. ViewResolver의 기본 동작은 forward이며, `return "redirect:/login"`처럼 접두어로 redirect를 명시합니다.
:::

:::details Q. JSP를 왜 `/WEB-INF/` 아래에 두나요?
서블릿 스펙상 `/WEB-INF/`는 브라우저 URL로 직접 접근이 불가능한 보호 영역입니다. JSP를 여기 두면 반드시 컨트롤러를 거쳐야 화면이 나오므로, 인증·권한 인터셉터를 건너뛴 직접 호출을 막고 컨트롤러가 준비한 `Model` 없이 빈 화면이 노출되는 것도 방지합니다.
:::

:::details Q. EL의 `${...}`은 언제 평가되나요? React의 `{}`와 같나요?
다릅니다. EL은 **서버에서** JSP가 서블릿으로 실행될 때 평가돼, 브라우저가 받을 땐 이미 값이 박힌 HTML입니다. React의 `{}`는 브라우저(클라이언트)에서 평가됩니다. 즉 EL은 SSR, JSX는 CSR 쪽입니다.
:::

:::details Q. ViewResolver 설정은 어디서 하나요? 코드가 없던데요.
별도 `@Configuration` 클래스 없이 `application.properties`의 `spring.mvc.view.prefix=/WEB-INF/views/`와 `suffix=.jsp` 두 줄로 끝납니다. Spring Boot가 이 값으로 `InternalResourceViewResolver`를 자동 구성합니다. 컨트롤러가 반환한 이름 앞뒤에 이 prefix/suffix를 붙여 실제 JSP 경로를 만듭니다.
:::

:::details Q. 같은 컨트롤러에서 화면과 JSON을 둘 다 응답할 수 있나요?
네. 화면은 뷰 이름을 `String`으로 반환해 ViewResolver를 타게 하고, JSON은 메서드에 `@ResponseBody`를 붙이거나 `@RestController`를 써서 객체를 직렬화해 응답합니다. TripTogether도 페이지는 JSP, 챗봇·SSE 같은 데이터 엔드포인트는 JSON으로 나눠 씁니다.
:::

## 8. 직접 말해보기

다음을 소리 내어 설명해 보자. 막히면 위 절로 돌아가 확인한다.

- 브라우저가 `GET /TripTogether/`를 보낸 뒤 HTML을 받기까지, DispatcherServlet → Controller → ViewResolver → JSP 순으로 무엇이 일어나는가?
- `return "home/home"`이 실제 파일 경로 `/WEB-INF/views/home/home.jsp`로 바뀌는 규칙을 prefix/suffix로 설명해 보라.
- JSP를 `/WEB-INF/` 밖(예: `webapp/home.jsp`)에 두면 보안상 무엇이 문제인가?
- EL `${...}`이 React의 `{}`와 다른 점을 "어디서 평가되는가"로 한 문장에 답하라.

다음으로 읽으면 좋은 글: [인터셉터](/glossary/interceptor) · [4계층 구조](/glossary/layered-architecture) · [i18n (국제화)](/glossary/i18n-term). 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 퀴즈

<QuizBox
  question="HomeController가 return 'home/home'; 을 반환했을 때, ViewResolver가 최종적으로 찾는 실제 파일 경로는?"
  :choices="['/views/home/home', '/WEB-INF/views/home/home.jsp', '/TripTogether/home/home.jsp', '/webapp/home/home.html']"
  :answer="1"
  explanation="prefix=/WEB-INF/views/ 와 suffix=.jsp 를 논리 뷰 이름 앞뒤에 붙여 /WEB-INF/views/home/home.jsp 가 된다."
/>

<QuizBox
  question="JSP를 /WEB-INF/ 아래에 두는 주된 이유로 가장 정확한 것은?"
  :choices="['컴파일 속도가 빨라져서', '브라우저가 URL로 직접 접근할 수 없어 컨트롤러를 반드시 거치게 하려고', 'JSTL 태그가 그 폴더에서만 동작해서', '정적 리소스 캐싱을 위해']"
  :answer="1"
  explanation="/WEB-INF/ 는 서블릿 스펙상 외부 직접 접근이 차단되는 영역이라, JSP를 여기 두면 인증·권한 인터셉터를 우회한 직접 호출을 막을 수 있다."
/>

<QuizBox
  question="JSP의 EL ${...} 표현식이 평가되는 시점/위치로 옳은 것은?"
  :choices="['브라우저(클라이언트)에서 JavaScript로 평가된다', '서버에서 JSP가 실행될 때 평가되어 완성된 HTML이 전송된다', 'DB에서 SQL로 평가된다', '빌드 시점에 한 번만 평가되어 정적 파일로 고정된다']"
  :answer="1"
  explanation="EL은 서버사이드 렌더링 단계에서 평가된다. 브라우저는 이미 값이 채워진 HTML을 받는다(React의 클라이언트 측 {} 평가와 대비)."
/>
