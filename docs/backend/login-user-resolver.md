# @LoginUser 리졸버

> 컨트롤러 파라미터에 `@LoginUser UsersVO user` 한 줄만 쓰면, 세션의 로그인 사용자가 자동으로 주입된다. 세션 캐스팅 보일러플레이트가 사라진다.

TripTogether는 4명이 도메인을 나눠 만든 팀 프로젝트이고, 인증은 **세션 기반**(세션 속성 `loginUser`에 `UsersVO` 저장)이다. 이 페이지는 세션에서 사용자를 꺼내는 일을 표준화한 `@LoginUser` + `LoginUserArgumentResolver`를 다룬다. 권한 검증(`@RequireLogin`/`@RequireAdmin`)과 짝을 이루며, 둘 다 ADR-0011에서 결정됐다.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 1. 한 줄 정의

`@LoginUser`는 컨트롤러 파라미터용 마커 어노테이션이고, `LoginUserArgumentResolver`는 그 어노테이션이 붙은 `UsersVO` 파라미터에 **HTTP 세션 속성 `loginUser`를 꺼내 자동 주입**하는 Spring MVC `HandlerMethodArgumentResolver` 구현체다.

## 2. 왜 이렇게 설계했나

마이그레이션 전에는 로그인 사용자가 필요한 모든 메서드가 같은 코드를 복사했다.

```java
// Before — 메서드마다 반복
HttpSession session = request.getSession(false);
UsersVO user = (session != null)
        ? (UsersVO) session.getAttribute("loginUser")   // 매번 캐스팅
        : null;
if (user == null) { /* 401 응답 직접 작성 */ }
```

이 패턴의 문제는 ADR-0011에 정리돼 있다.

- **세션 키 문자열 중복** — `"loginUser"`가 수십 군데에 흩어져 오타 한 번이면 조용히 `null`.
- **반복 캐스팅** — `(UsersVO)` 캐스팅과 `instanceof` 검사를 메서드마다 다시 씀.
- **시그니처가 의도를 숨김** — 파라미터 목록에 `HttpSession session`만 보여서, 이 메서드가 로그인 사용자를 쓴다는 사실이 본문을 읽어야 드러남.

해결책은 **관심사 분리**다. "세션에서 사용자를 꺼낸다"는 한 곳(`LoginUserArgumentResolver`)에 모으고, 컨트롤러는 `@LoginUser UsersVO user`라고 **선언만** 한다. 의존성이 시그니처에 명시되어 테스트와 코드 리뷰가 쉬워진다.

:::tip 권한 검증과는 별개 관심사다
주입(누구인지 꺼내기)과 인가(접근해도 되는지 막기)는 분리돼 있다. 리졸버는 **막지 않는다** — 비로그인이면 `null`을 줄 뿐이다. 차단은 `@RequireLogin`/`@RequireAdmin`(AOP)이나 `LoginInterceptor`(URL 패턴)가 담당한다. 자세히는 [권한 AOP](/backend/aop-authorization).
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구성 요소 | 클래스 / 위치 | 역할 |
| --- | --- | --- |
| 파라미터 마커 | `common.annotation.LoginUser` (`@Target(PARAMETER)`, `@Retention(RUNTIME)`) | 주입 대상 표시 |
| 리졸버 | `common.resolver.LoginUserArgumentResolver` | `HandlerMethodArgumentResolver` 구현, `@Component` |
| 주입 타입 | `auth.vo.UsersVO` | 세션에 저장된 로그인 사용자 VO (`userIdx`, `hasAdminRole()` 등) |
| MVC 등록 | `config.WebConfig#addArgumentResolvers` | 리졸버를 MVC 리졸버 체인에 추가 |
| 세션 속성 키 | `"loginUser"` | 로그인 성공 시 `AuthController`가 세션에 저장 |

리졸버 등록은 `WebConfig`가 `WebMvcConfigurer`를 구현해 처리한다.

```java
@Override
public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
    resolvers.add(loginUserArgumentResolver);   // 생성자 주입된 @Component 빈
}
```

별도의 DB 테이블은 없다. 사용자 식별 정보는 로그인 시점에 `USERS` 행을 읽어 `UsersVO`로 세션에 올려둔 값을 재사용한다.

## 4. 동작 원리 (흐름·표·작은 코드)

리졸버 본체는 두 메서드뿐이다.

```java
@Override
public boolean supportsParameter(MethodParameter parameter) {
    return parameter.hasParameterAnnotation(LoginUser.class)
            && UsersVO.class.isAssignableFrom(parameter.getParameterType());
}

@Override
public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mav,
                              NativeWebRequest webRequest, WebDataBinderFactory binder) {
    HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);
    if (request == null) return null;
    HttpSession session = request.getSession(false);   // 없으면 새로 만들지 않음
    if (session == null) return null;
    Object loginUser = session.getAttribute("loginUser");
    return (loginUser instanceof UsersVO) ? loginUser : null;
}
```

요청 한 건의 처리 순서:

| 단계 | 주체 | 동작 |
| --- | --- | --- |
| 1 | DispatcherServlet | 핸들러 메서드의 각 파라미터를 순회 |
| 2 | `supportsParameter` | `@LoginUser`가 붙고 타입이 `UsersVO`면 `true` |
| 3 | `resolveArgument` | 세션 속성 `loginUser`를 읽어 반환 (없으면 `null`) |
| 4 | 컨트롤러 | 주입된 `user`로 본문 실행 |

설계상 두 가지 안전 선택에 주목할 만하다.

- `getSession(false)` — 세션이 없을 때 **새 세션을 만들지 않는다**. 단순 조회에 불필요한 세션 생성을 피한다.
- `instanceof UsersVO` — 캐스팅 전에 타입을 확인해 `ClassCastException` 대신 `null`을 반환한다.

실제 사용 예 (`InquiryController`의 운영진 메서드):

```java
@PostMapping("/{inquiryId}/answer/edit")
@ResponseBody
@RequireAdmin                                   // AOP가 먼저 비로그인/비운영진 차단
public ResponseEntity<?> editAnswer(@PathVariable Long inquiryId,
                                    @RequestParam String content,
                                    @LoginUser UsersVO user) {   // 여기서 자동 주입
    inquiryService.updateAnswer(inquiryId, content, user.getUserIdx());
    return ResponseEntity.ok(Map.of("success", true));
}
```

:::warning null 가능성을 잊지 말 것
권한 어노테이션 **없이** `@LoginUser`만 쓰면 비로그인 요청에서 `user`가 `null`이다. 그래서 보통 `@RequireLogin`/`@RequireAdmin`과 함께 쓴다 — AOP가 먼저 차단하므로 본문에서는 `user`를 non-null로 가정해도 안전하다. 어노테이션이 없다면 컨트롤러가 직접 `null` 체크를 해야 한다.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `@LoginUser` + 리졸버 + `WebConfig` 등록 | 구현됨 |
| `getSession(false)` / `instanceof` 안전 처리 | 구현됨 |
| `@RequireLogin`/`@RequireAdmin` AOP 차단과 연계 | 구현됨 (ADR-0011) |
| 전 컨트롤러 일괄 적용 | **점진 마이그레이션 중** — 일부 메서드만 적용, 나머지는 아직 세션 직접 접근 |
| 기존 `getLoginUserIdx`/`isAdmin` 헬퍼 제거 | 계획 (마이그레이션 후반 단계) |

ADR-0011은 메서드 단위로 점진 적용하는 전략을 명시한다. 즉 같은 코드베이스 안에 신패턴(`@LoginUser`)과 구패턴(세션 직접 캐스팅)이 **의도적으로 공존**한다. 회귀 위험을 줄이려는 선택이며, 면접에서 "왜 한 번에 안 바꿨나"를 물으면 이 점을 짚으면 된다.

## 6. 면접 답변 3단계

1. **한 줄** — "세션 기반 인증이라 로그인 사용자를 세션에서 꺼내 쓰는데, 그 캐스팅 보일러플레이트를 `HandlerMethodArgumentResolver`로 한 곳에 모아 `@LoginUser UsersVO user` 한 줄로 주입되게 했습니다."
2. **설계 의도** — "주입(누구인지)과 인가(막을지)를 분리했습니다. 리졸버는 비로그인이면 `null`만 주고, 차단은 `@RequireLogin`/`@RequireAdmin` AOP가 합니다. 덕분에 컨트롤러 시그니처만 봐도 의존성과 권한 요구가 드러납니다."
3. **트레이드오프** — "전면 교체 대신 메서드 단위 점진 마이그레이션을 택해 구패턴과 공존시킵니다. 회귀 위험은 낮추지만 두 패턴이 섞여 있는 과도기 비용은 감수합니다."

## 7. 꼬리질문 + 모범답안

:::details 인터셉터로도 로그인 사용자를 request에 넣을 수 있는데 왜 ArgumentResolver를 썼나?
인터셉터는 URL 패턴 단위라 "이 메서드가 사용자를 쓴다"는 사실을 메서드 시그니처에 표현하지 못합니다. ArgumentResolver는 파라미터 단위라 타입(`UsersVO`)과 의도(`@LoginUser`)가 시그니처에 그대로 드러나고, 테스트 시 값을 바로 넘기기도 쉽습니다. 실제로 `LoginInterceptor`는 URL 차단용으로 따로 두고, 사용자 주입은 리졸버가 맡는 식으로 역할을 나눴습니다.
:::

:::details 비로그인 상태에서 `@LoginUser`를 쓰면 어떻게 되나?
리졸버가 `null`을 주입합니다 — 예외를 던지지 않습니다. 주입과 인가가 분리돼 있기 때문입니다. 그래서 보통 `@RequireLogin`이나 `@RequireAdmin`을 함께 붙여 AOP가 진입 전에 `UnauthorizedException`(401)/`ForbiddenException`(403)으로 차단합니다. 그 경우 본문에서는 `user`가 항상 non-null이라고 가정할 수 있습니다.
:::

:::details `getSession(false)`로 한 이유는?
`true`면 세션이 없을 때 새로 만들어버립니다. 사용자 조회는 부수효과 없이 끝나야 하므로, 없으면 만들지 않고 그냥 `null`을 반환하도록 `false`를 썼습니다. 불필요한 세션 생성과 그에 따른 메모리·쿠키 발급을 막습니다.
:::

:::details `instanceof UsersVO` 검사를 굳이 넣은 이유는?
세션 속성은 `Object`라 키가 같아도 타입이 다른 값이 들어있을 수 있습니다. 바로 캐스팅하면 `ClassCastException` 위험이 있어, `instanceof`로 확인 후 아니면 `null`을 반환해 방어적으로 처리했습니다. Java 패턴에서 `instanceof`가 false면 안전하게 빠집니다.
:::

:::details 이걸 Spring Security로 대체하면?
Security를 도입하면 `@AuthenticationPrincipal`이 같은 역할을 합니다. 이 프로젝트는 Security를 비밀번호 해싱(BCrypt)·부분 CSRF 등 제한적으로만 쓰고 인증 흐름은 세션 직접 관리라, 동등한 표현력을 커스텀 리졸버로 확보한 사례입니다. "선언적 보안의 작은 자작 버전"이라고 설명할 수 있습니다.
:::

## 8. 직접 말해보기

- `@LoginUser`와 `@RequireLogin`의 책임이 어떻게 다른지 한 문장으로 설명해 보세요.
- 리졸버가 `null`을 반환하는 두 가지 경우를 코드 흐름으로 짚어 보세요. (세션 없음 / 타입 불일치)
- "왜 인터셉터가 아니라 ArgumentResolver인가"에 30초로 답해 보세요.
- 점진 마이그레이션의 장점과 비용을 각각 하나씩 들어 보세요.

## 퀴즈

<QuizBox question="LoginUserArgumentResolver가 비로그인 요청에서 user 파라미터에 주입하는 값은?" :choices="['UnauthorizedException을 던진다', 'null을 주입한다', '빈 UsersVO 객체를 만든다', '로그인 페이지로 리다이렉트한다']" :answer="1" explanation="리졸버는 주입만 담당하고 차단하지 않는다. 세션이 없거나 타입이 안 맞으면 null을 반환한다. 실제 차단은 @RequireLogin/@RequireAdmin AOP의 몫이다." />

<QuizBox question="resolveArgument에서 request.getSession(false)를 쓴 이유로 가장 적절한 것은?" :choices="['세션을 강제로 무효화하려고', '세션이 없을 때 새로 만들지 않으려고', 'JSESSIONID 쿠키를 갱신하려고', '관리자 세션만 조회하려고']" :answer="1" explanation="인자 false는 '세션이 없으면 새로 만들지 말라'는 의미다. 단순 조회에서 불필요한 세션 생성을 피하기 위함이다." />

<QuizBox question="supportsParameter가 true를 반환하는 조건은?" :choices="['파라미터 타입이 HttpSession인 경우', '@LoginUser가 붙고 타입이 UsersVO에 할당 가능한 경우', '@RequireAdmin이 메서드에 붙은 경우', '세션에 loginUser 속성이 존재하는 경우']" :answer="1" explanation="supportsParameter는 어노테이션(@LoginUser) 유무와 파라미터 타입(UsersVO 할당 가능)만 본다. 세션 값 존재 여부는 resolveArgument 단계에서 확인한다." />
