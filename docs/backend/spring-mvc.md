# Spring MVC

> TripTogether의 모든 HTTP 요청은 `DispatcherServlet` 하나가 받아 핸들러(`@Controller` 메서드)에 위임하고, 결과를 JSP 뷰 또는 JSON으로 렌더링한다.

이 페이지는 특정 도메인이 아니라 4명이 만든 모든 도메인 컨트롤러가 공통으로 올라타는 **요청 처리 골격**을 다룬다. 인증·신고·여행 코스·탐색·AI 어시스턴트 등 모든 기능의 컨트롤러는 여기서 설명하는 동일한 MVC 파이프라인 위에서 동작한다.

## 1. 한 줄 정의

Spring MVC는 **프론트 컨트롤러(`DispatcherServlet`) 하나가 요청을 받아** → 적절한 핸들러 메서드(`@Controller`/`@RestController`)로 디스패치하고 → 반환값을 `ViewResolver`(JSP) 또는 메시지 컨버터(JSON)로 변환해 응답하는 서블릿 기반 웹 프레임워크다.

## 2. 왜 이렇게 설계했나

- **단일 진입점(Front Controller).** 인증, IP 차단, 활동 로그, 다국어 같은 횡단 관심사를 컨트롤러마다 중복 구현하지 않고, `DispatcherServlet` 앞단의 **인터셉터 체인** 한 곳에 모은다. 그래서 TripTogether는 8단계 인터셉터(`locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification`)를 컨트롤러와 분리해 운영한다.
- **페이지(JSP)와 API(JSON)를 같은 프레임워크로.** 이 프로젝트는 JSP 서버 렌더링이 기본이지만, 챗봇·AI 일정 생성·알림처럼 AJAX가 필요한 곳은 같은 컨트롤러 모델에서 `@ResponseBody`/`@RestController`로 JSON을 반환한다. 뷰 기술이 달라도 핸들러 작성 방식은 통일된다.
- **선언적 매핑.** `@RequestMapping`/`@GetMapping`/`@PostMapping`으로 URL ↔ 메서드를 어노테이션으로 묶어, web.xml 같은 외부 설정 없이 라우팅을 코드 옆에 둔다.
- **확장 포인트가 표준화돼 있다.** 파라미터 주입(`HandlerMethodArgumentResolver`), 예외 변환(`@RestControllerAdvice`), 뷰 결정(`ViewResolver`)이 모두 인터페이스로 열려 있어, `@LoginUser` 자동 주입 같은 팀 공통 규칙을 프레임워크 위에 자연스럽게 얹었다.

## 3. 어떤 기술로 구현했나 (실제 클래스·설정)

| 요소 | TripTogether 구현 |
| --- | --- |
| 프론트 컨트롤러 | `DispatcherServlet` (Spring Boot가 자동 등록, embedded Tomcat) |
| 패키징/서버 | `war` + `tomcat-embed-jasper` (JSP 컴파일용 Jasper 포함) |
| 컨텍스트 경로 | `server.servlet.context-path=/TripTogether` |
| 페이지 핸들러 | `@Controller` — 예: `TravelPlanController`, `AuthController` |
| API 핸들러 | `@RestController` — 예: `ChatbotController`, `NotificationSseController` |
| 뷰 리졸버 | `spring.mvc.view.prefix=/WEB-INF/views/`, `suffix=.jsp` (InternalResourceViewResolver) |
| MVC 공통 설정 | `WebConfig implements WebMvcConfigurer` |
| 파라미터 주입 | `LoginUserArgumentResolver` (`addArgumentResolvers`로 등록) |
| 전역 예외 | `GlobalExceptionHandler` (`@RestControllerAdvice`) |
| 인터셉터 등록 | `WebConfig.addInterceptors(...)` |

`WebConfig`는 `WebMvcConfigurer`를 구현해 세 가지를 등록한다. (1) `/upload/**`를 파일 시스템 디렉터리로 매핑하는 정적 리소스 핸들러, (2) `@LoginUser` 주입용 ArgumentResolver, (3) 경로별 인터셉터 체인.

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {
  @Override public void addArgumentResolvers(List<HandlerMethodArgumentResolver> r) {
    r.add(loginUserArgumentResolver);          // @LoginUser UsersVO 자동 주입
  }
  @Override public void addInterceptors(InterceptorRegistry reg) {
    reg.addInterceptor(loginInterceptor).addPathPatterns("/mypage/**", "/inquiry/**", ...);
    reg.addInterceptor(adminInterceptor).addPathPatterns("/admin/**");
    // ... locale / ipBlock / activityLog / notification 등
  }
}
```

:::tip @Controller vs @RestController
`@Controller` 메서드가 `String`을 반환하면 그 값은 **뷰 이름**으로 해석돼 JSP로 포워딩된다. `@RestController`(= `@Controller` + `@ResponseBody`) 메서드의 반환값은 메시지 컨버터(Jackson)를 거쳐 **응답 본문(JSON)** 이 된다. 한 `@Controller` 안에서도 메서드에 `@ResponseBody`를 붙이면 그 메서드만 JSON을 반환한다 — `AuthController`의 `GET /login`은 뷰(`auth/login`)를, `POST /login`은 `@ResponseBody`로 JSON을 반환한다.
:::

## 4. 동작 원리 (흐름·코드)

요청 한 건이 처리되는 큰 흐름:

```text
HTTP 요청
  → (embedded Tomcat) DispatcherServlet
    → HandlerMapping        : URL → @GetMapping/@PostMapping 메서드 결정
    → [인터셉터 preHandle]   : locale·ipBlock·login·admin ... 통과/차단
    → HandlerAdapter        : 파라미터 바인딩
        - @RequestParam / @ModelAttribute / @PathVariable / @RequestBody
        - @LoginUser UsersVO  ← LoginUserArgumentResolver 가 세션에서 주입
    → 컨트롤러 메서드 실행
    → 반환값 처리
        - "courses/main"  → ViewResolver → /WEB-INF/views/courses/main.jsp
        - "redirect:/..."  → 302 리다이렉트
        - 객체 + @ResponseBody → Jackson → JSON
    → [인터셉터 postHandle / afterCompletion]
  → HTTP 응답
```

**페이지 반환(뷰 이름).** 문자열 `"courses/main"`이 `prefix`/`suffix`와 합쳐져 `/WEB-INF/views/courses/main.jsp`로 포워딩된다.

```java
@Controller
@RequestMapping("/courses")
public class TravelPlanController {
  @GetMapping({"", "/"})
  public String coursesMain() { return "courses/main"; }          // → JSP 뷰

  @GetMapping("/list")
  public String listRedirect() { return "redirect:/courses"; }    // → 302
}
```

**폼 바인딩 + 리다이렉트 후 플래시 메시지.** `@ModelAttribute`가 폼 필드를 DTO로 바인딩하고, 결과 메시지는 `RedirectAttributes`의 플래시 속성으로 한 번만 노출한다 (PRG 패턴).

```java
@PostMapping("/generate")
public String generatePlan(@ModelAttribute("requestDTO") AiPlanRequestDTO dto,
                           HttpSession session, RedirectAttributes ra) {
  // ... aiPlanService.generateAndSavePlan(dto, userIdx);
  ra.addFlashAttribute("successMessage", msg("course.message.aiCreateSuccess"));
  return "redirect:/courses/my";
}
```

**API 반환(JSON).** `@RestController`에서 `@RequestBody`로 요청 본문을 객체로 받고, 반환 객체를 그대로 JSON 직렬화한다.

```java
@RestController
@RequestMapping("/chatbot")
public class ChatbotController {
  @PostMapping("/ask")
  public ChatbotResponseVO ask(@RequestBody ChatbotRequestVO req, HttpSession s) {
    return chatbotService.ask(req, /* loginUser */ ..., /* anonSessionId */ ..., /* ip */ ...);
  }
}
```

**커스텀 파라미터 주입.** 세션의 `loginUser`를 컨트롤러 파라미터로 끌어오는 보일러플레이트를 ArgumentResolver가 흡수한다. `@RequireLogin`/`@RequireAdmin`이 붙은 메서드는 AOP(`AuthorizationAspect`)가 먼저 차단하므로 본문에서 `user`를 non-null로 가정해도 안전하다.

```java
@Component
public class LoginUserArgumentResolver implements HandlerMethodArgumentResolver {
  @Override public boolean supportsParameter(MethodParameter p) {
    return p.hasParameterAnnotation(LoginUser.class)
        && UsersVO.class.isAssignableFrom(p.getParameterType());
  }
  @Override public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                                          NativeWebRequest req, WebDataBinderFactory f) {
    HttpSession session = ((HttpServletRequest) req.getNativeRequest(...)).getSession(false);
    Object u = session == null ? null : session.getAttribute("loginUser");
    return (u instanceof UsersVO) ? u : null;     // 비로그인이면 null
  }
}
```

**전역 예외 변환.** AJAX 메서드에서 던진 도메인 예외를 표준 JSON으로 바꾼다 (HTTP 상태 코드는 예외가 들고 있는 값 사용).

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
  @ExceptionHandler(BusinessException.class)
  public ResponseEntity<Map<String,Object>> handle(BusinessException e) {
    return ResponseEntity.status(e.getHttpStatus())
        .body(Map.of("success", false, "message", e.getMessage()));
  }
}
```

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: `DispatcherServlet` + `@Controller`/`@RestController` 라우팅, JSP `InternalResourceViewResolver`(`/WEB-INF/views/*.jsp`), `@LoginUser` 커스텀 ArgumentResolver, 경로별 인터셉터 체인, `@ModelAttribute`/`@RequestParam`/`@RequestBody` 바인딩, `redirect:` + 플래시 속성(PRG), Jackson JSON 직렬화.
- **부분 적용**: `GlobalExceptionHandler`(`@RestControllerAdvice`)는 **AJAX/`@ResponseBody` 메서드 대상 시범 적용** 단계다. 일반 페이지 컨트롤러는 도메인 예외를 직접 던지지 않고 `try/catch` + `redirect` + 플래시 메시지로 처리하는 곳이 많다.
- **계획/한계**: API 문서 자동화(**Swagger/OpenAPI 부재**). 뷰는 JSP **데스크톱 레이아웃 위주**이며 반응형/SPA는 향후 과제. `@Valid` 기반 선언적 검증은 일부에만 적용돼 있고, 상당수 검증이 서비스 계층의 명령형 코드로 처리된다(→ [입력 검증](/backend/validation) 참고).

## 6. 면접 답변 3단계

1. **한 문장**: "모든 HTTP 요청을 `DispatcherServlet` 하나가 받아 `@Controller` 메서드로 디스패치하고, 반환값을 JSP 뷰 또는 JSON으로 렌더링하는 프론트 컨트롤러 구조입니다."
2. **설계 의도**: "인증·IP 차단·다국어 같은 횡단 관심사를 컨트롤러에서 떼어 `DispatcherServlet` 앞단의 인터셉터 체인에 모으려고 이 구조를 택했습니다. 덕분에 컨트롤러는 도메인 로직에만 집중하고, 페이지(JSP)와 API(JSON)를 동일한 핸들러 모델로 작성합니다."
3. **구체 근거**: "예를 들어 `WebConfig`가 `WebMvcConfigurer`를 구현해 8단계 인터셉터와 `@LoginUser` 자동 주입용 `LoginUserArgumentResolver`를 등록합니다. 페이지는 `return \"courses/main\"`처럼 뷰 이름을 돌려 `/WEB-INF/views/courses/main.jsp`로 포워딩되고, 챗봇 같은 API는 `@RestController`에서 객체를 반환해 Jackson이 JSON으로 직렬화합니다."

## 7. 꼬리질문 + 모범답안

:::details DispatcherServlet은 정확히 무슨 일을 하나요?
프론트 컨트롤러입니다. 들어온 요청에 대해 (1) `HandlerMapping`으로 어떤 컨트롤러 메서드가 처리할지 찾고, (2) 인터셉터 `preHandle`을 실행하고, (3) `HandlerAdapter`로 파라미터를 바인딩해 메서드를 호출하고, (4) 반환값을 `ViewResolver`(뷰 이름) 또는 메시지 컨버터(`@ResponseBody`)로 변환한 뒤, (5) `postHandle`/`afterCompletion`까지 돌립니다. 라우팅·횡단 처리·렌더링의 조립을 한 곳에서 책임집니다.
:::

:::details `@Controller`와 `@RestController` 차이는? 한 클래스에서 섞을 수 있나요?
`@RestController`는 `@Controller` + `@ResponseBody`입니다. `@Controller` 메서드가 `String`을 반환하면 뷰 이름으로 해석돼 JSP로 포워딩되지만, `@ResponseBody`가 붙으면 반환값이 응답 본문(JSON)이 됩니다. 메서드 단위로 `@ResponseBody`를 붙이면 한 `@Controller` 안에서도 섞을 수 있습니다 — 실제로 `AuthController`의 `GET /login`은 JSP 뷰를, `POST /login`은 JSON을 반환합니다.
:::

:::details 뷰 이름 `"courses/main"`이 실제 파일로 어떻게 연결되나요?
`InternalResourceViewResolver`가 `application.properties`의 `spring.mvc.view.prefix=/WEB-INF/views/`와 `suffix=.jsp`를 앞뒤로 붙여 `/WEB-INF/views/courses/main.jsp`로 포워딩합니다. `/WEB-INF` 아래라 URL로 직접 접근할 수 없고 반드시 컨트롤러를 거쳐야 합니다. `redirect:` 접두어가 붙으면 뷰 렌더링 대신 302 리다이렉트를 내보냅니다.
:::

:::details 인증 같은 공통 처리는 컨트롤러마다 넣나요?
아니요. 두 층으로 나눕니다. 경로 단위(예: `/admin/**` 전체 차단)는 `WebConfig`에 등록한 **인터셉터**가, 메서드 단위(`@RequireLogin`/`@RequireAdmin`)는 **AOP**(`AuthorizationAspect`)가 진입 직전에 검사합니다. 세션 사용자 객체 자체는 `@LoginUser` ArgumentResolver가 파라미터로 주입해, 컨트롤러 본문에는 세션 접근 코드가 거의 남지 않습니다.
:::

:::details 컨트롤러에서 던진 예외는 어떻게 응답으로 바뀌나요?
`@RestControllerAdvice`인 `GlobalExceptionHandler`가 `BusinessException`을 잡아 예외가 들고 있는 HTTP 상태와 `{success:false, message:...}` JSON으로 변환합니다. 다만 이건 현재 AJAX/`@ResponseBody` 메서드 대상의 시범 적용 단계라, 일반 페이지 컨트롤러는 `try/catch` 후 플래시 메시지와 함께 `redirect` 하는 방식을 함께 씁니다.
:::

:::details 왜 SPA(REST 전용)가 아니라 JSP 서버 렌더링을 골랐나요?
프로젝트가 다국어 콘텐츠와 서버 세션 인증 중심이라, 화면 대부분은 서버에서 i18n 메시지를 적용해 JSP로 렌더링하는 편이 단순했습니다. 동적 상호작용이 필요한 챗봇·AI 일정·알림(SSE)만 같은 MVC 위에서 JSON API로 빼서 점진적으로 비동기화했습니다. 한계로는 데스크톱 위주 레이아웃과 API 문서(Swagger) 부재가 있어 향후 과제로 둡니다.
:::

## 8. 직접 말해보기

다음 질문에 소리 내어 답해보고, 막히면 위 절을 다시 본다.

1. 요청 하나가 `DispatcherServlet` → 응답까지 거치는 단계를 순서대로 말해보라.
2. 같은 `@Controller`에서 어떤 메서드는 JSP를, 어떤 메서드는 JSON을 반환하게 만드는 차이는 무엇인가?
3. `return "courses/main"`이 어떤 파일로 이어지는지, 그걸 결정하는 설정 두 개는 무엇인가?
4. 세션 로그인 사용자를 컨트롤러 파라미터로 받기 위해 TripTogether가 추가한 확장 포인트는 무엇이고, AOP 권한 체크와 어떻게 역할이 나뉘는가?

관련 페이지: [Spring Boot](/backend/spring-boot) · [JSP·JSTL·EL](/backend/jsp-jstl-el) · [인터셉터 체인](/backend/interceptors) · [AOP 권한 체크](/backend/aop-authorization) · [@LoginUser 리졸버](/backend/login-user-resolver) · [예외 처리](/backend/exception-handling) · 허브: [도메인 전체 개요](/domains) · [전체 흐름](/flow/) · [담당별 보기](/by-area/)

## 퀴즈

<QuizBox question="@Controller 메서드가 String 'courses/main'을 반환했을 때 기본적으로 일어나는 일은?" :choices="['JSON 문자열 courses/main 이 응답 본문으로 나간다', 'ViewResolver가 prefix/suffix를 붙여 /WEB-INF/views/courses/main.jsp로 포워딩한다', '302 리다이렉트로 /courses/main 으로 이동한다', '404를 반환한다']" :answer="1" explanation="@ResponseBody가 없는 @Controller 메서드의 String 반환값은 뷰 이름으로 해석된다. InternalResourceViewResolver가 spring.mvc.view.prefix(/WEB-INF/views/)와 suffix(.jsp)를 붙여 JSP로 포워딩한다. JSON으로 내보내려면 @ResponseBody나 @RestController가 필요하다." />

<QuizBox question="TripTogether에서 세션의 loginUser를 컨트롤러 파라미터(@LoginUser UsersVO)로 자동 주입하는 Spring MVC 확장 포인트는?" :choices="['HandlerInterceptor', 'HandlerMethodArgumentResolver (LoginUserArgumentResolver)', 'ViewResolver', '@RestControllerAdvice']" :answer="1" explanation="파라미터 바인딩 단계에서 HandlerMethodArgumentResolver를 구현한 LoginUserArgumentResolver가 세션에서 loginUser를 꺼내 주입한다. WebConfig.addArgumentResolvers()로 등록한다. 인터셉터는 요청 전후 횡단 처리, ViewResolver는 뷰 결정, @RestControllerAdvice는 예외 변환 역할이다." />

<QuizBox question="@RestController에 대한 설명으로 옳은 것은?" :choices="['@Controller와 무관한 별도 어노테이션이다', '@Controller + @ResponseBody 와 같아서 반환값이 메시지 컨버터를 거쳐 응답 본문(JSON)이 된다', 'JSP 뷰만 반환할 수 있다', '세션을 사용할 수 없다']" :answer="1" explanation="@RestController = @Controller + @ResponseBody. 따라서 메서드 반환 객체가 Jackson 같은 메시지 컨버터를 통해 JSON 본문으로 직렬화된다. ChatbotController가 그 예다. 일반 @Controller에서도 메서드에 @ResponseBody를 붙이면 같은 효과를 낸다." />
