# 인터셉터(Interceptor)

> 컨트롤러에 도달하기 전/후로 모든 요청을 가로채, 인증·차단·로깅·다국어·뷰 데이터 주입 같은 횡단 관심사를 한곳에서 처리하는 Spring MVC 장치.

TripTogether는 8개의 `HandlerInterceptor`를 경로별로 등록해, 컨트롤러가 "비즈니스 로직"에만 집중하도록 공통 처리를 앞단으로 끌어올렸다. 이 페이지는 인터셉터의 개념과 TripTogether 실제 체인을 함께 설명한다.

상위 맥락은 [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/)에서 볼 수 있고, 백엔드 관점의 심화는 [인터셉터 체인](/backend/interceptors)·[AOP 권한 체크](/backend/aop-authorization) 페이지에서 다룬다.

## 1. 한 줄 정의

인터셉터는 `DispatcherServlet`이 핸들러(컨트롤러 메서드)를 호출하기 직전(`preHandle`), 호출 직후·뷰 렌더링 전(`postHandle`), 응답 완료 후(`afterCompletion`)에 끼어들어 요청 흐름을 관찰·변경·중단할 수 있는 컴포넌트다.

## 2. 왜 이렇게 설계했나

"로그인했는가", "이 IP는 차단 대상인가", "활동 로그를 남겨야 하는가", "헤더 알림 벨에 안읽음 개수를 뿌려야 하는가" 같은 요구는 **거의 모든 컨트롤러에 공통**이다. 이를 각 컨트롤러에 복붙하면 중복과 누락이 생긴다.

- **횡단 관심사 분리:** 인증·차단·로깅·i18n·뷰 데이터 주입을 컨트롤러 밖으로 빼낸다.
- **경로 단위 정책:** `/admin/**`는 관리자만, `/mypage/**`는 로그인 사용자만 — URL 패턴으로 선언적으로 묶는다.
- **순서 보장:** 등록 순서대로 `preHandle`이 실행되므로 "차단 → 로깅 → 로그인 검사" 같은 우선순위를 강제할 수 있다.

:::tip 인터셉터 vs 서블릿 필터 vs AOP
필터(`Filter`)는 서블릿 컨테이너 레벨이라 `DispatcherServlet` 바깥, 핸들러 정보(`HandlerMethod`)를 모른다. 인터셉터는 MVC 레벨이라 어떤 컨트롤러 메서드가 매칭됐는지 알 수 있다. 메서드 호출 자체를 감싸는 세밀한 권한 체크(`@RequireLogin` 등)는 [AOP](/glossary/aop)가 맡는다. TripTogether는 셋 다 쓰며 역할이 겹치지 않는다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

모든 인터셉터는 `org.triptogether.config` 패키지의 `@Component`이고, `WebConfig.addInterceptors()`에서 `InterceptorRegistry`에 등록된다.

| 인터셉터 클래스 | 사용 훅 | 적용 경로 | 역할 |
| --- | --- | --- | --- |
| `LocaleChangeInterceptor`(Spring 기본) | `preHandle` | `/**` | `?lang=` 파라미터로 세션 locale 변경(ko/en/ja/zh) |
| `IpBlockInterceptor` | `preHandle` | `/**` | IP/국가/ASN/회원 차단, 403 + `/blocked-access` forward |
| `ActivityLogInterceptor` | `preHandle`+`afterCompletion` | `/**` | `USER_ACTIVITY_LOG` 적재(누가/어디를/결과) |
| `LoginInterceptor` | `preHandle` | `/mypage/**` `/wallet/**` `/auth/link/**` `/inquiry/**` | 비로그인 차단 → 로그인 화면 redirect |
| `AdminInterceptor` | `preHandle` | `/admin/**` | 관리자 권한 + URL별 세부 권한(`ADMIN_PERMISSION`) 검사 |
| `SuperAdminInterceptor` | `preHandle` | `/superAdmin/**` | 최고관리자 영역 진입 가드 |
| `AdminModeInterceptor` | `postHandle` | `/**`(API 제외) | `isAdmin`/`isAdminMode`/권한 플래그를 Model에 주입 |
| `NotificationInterceptor` | `postHandle` | `/**`(API·SSE 제외) | 헤더 알림 벨 데이터(`headerUnreadCount` 등) 주입 |

별도로 `admin.interceptor.AdminAssistantGuardInterceptor`가 AI 관리 화면에 추가로 적용된다. 세션 인증의 단일 진실은 세션 속성 `loginUser`(타입 `UsersVO`)이며, 거의 모든 인터셉터가 이 값을 읽는다.

```java
// WebConfig.addInterceptors() — 등록 순서 = preHandle 실행 순서
registry.addInterceptor(localeChangeInterceptor()).addPathPatterns("/**");
registry.addInterceptor(ipBlockInterceptor).addPathPatterns("/**")
        .excludePathPatterns("/blocked-access", "/security/appeal/**", "/css/**", ...);
registry.addInterceptor(activityLogInterceptor).addPathPatterns("/**");
registry.addInterceptor(loginInterceptor)
        .addPathPatterns("/mypage/**", "/wallet/**", "/auth/link/**", "/inquiry/**");
registry.addInterceptor(adminInterceptor).addPathPatterns("/admin/**");
registry.addInterceptor(superAdminInterceptor).addPathPatterns("/superAdmin/**");
registry.addInterceptor(adminModeInterceptor).addPathPatterns("/**").excludePathPatterns("/api/**", ...);
registry.addInterceptor(notificationInterceptor).addPathPatterns("/**").excludePathPatterns("/api/**", "/sse/**", ...);
```

## 4. 동작 원리 (흐름·표·작은 코드)

### `preHandle`의 boolean 계약

`preHandle`이 `true`를 반환하면 체인의 다음 단계(또는 컨트롤러)로 진행하고, `false`를 반환하면 **요청을 거기서 끝낸다.** 이때 응답(redirect/forward/status)은 인터셉터가 직접 써야 한다.

```java
// LoginInterceptor — 비로그인이면 false로 끊고 로그인 화면으로 보낸다
public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
    UsersVO loginUser = sessionLoginUser(req);
    if (loginUser != null) return true;            // 통과
    String redirect = encode(req.getRequestURI()); // 원래 가려던 경로 보존
    res.sendRedirect(ctx + "/auth/login?redirect=" + redirect);
    return false;                                  // 체인 중단
}
```

### 한 요청의 전체 타임라인

```text
요청 ──▶ [preHandle 순서대로]
        localeChange → ipBlock → activityLog(시작시각 기록)
                     → login → admin → superAdmin
        (하나라도 false면 즉시 종료)
              │ 모두 true
              ▼
        ┌── 컨트롤러 메서드 실행 ──┐
              │
        [postHandle 역순]  ← 뷰 렌더링 직전, ModelAndView 접근 가능
        adminMode(isAdmin 주입) → notification(알림 벨 주입)
              ▼
        뷰(JSP) 렌더링
              ▼
        [afterCompletion 역순]  ← 응답 완료 후
        activityLog.afterCompletion: 상태코드·소요시간 계산해 DB 적재
```

### 훅별 책임 분담

| 훅 | 시점 | TripTogether 활용 |
| --- | --- | --- |
| `preHandle` | 컨트롤러 호출 전 | 차단(IpBlock)·로그인/권한 가드(Login/Admin/SuperAdmin), 시작시각 기록 |
| `postHandle` | 컨트롤러 후, 뷰 전 | `ModelAndView`에 뷰 전용 데이터 주입(AdminMode·Notification) |
| `afterCompletion` | 응답 완료 후 | 최종 상태코드·예외·응답시간까지 확정해 활동 로그 저장 |

:::details IpBlockInterceptor가 차단을 처리하는 방식
`preHandle`에서 `BlockRuleCacheService` 스냅샷으로 IP/CIDR/RANGE/국가/ASN 규칙과 회원 차단(`accountStatus == BLOCKED`)을 평가한다. 차단이면 `BlockAccessLogVO`를 적재하고 응답 상태를 `403`으로 세팅한 뒤 `/blocked-access`로 **forward**(redirect 아님)해 안내 페이지를 보여주고 `false`를 반환한다. 차단 안내 페이지 언어는 회원 선호 언어/국가코드로 결정하고, 쿼리스트링의 `password`·`token`·`code`·`state`는 로그 저장 전에 마스킹한다.
:::

`postHandle`은 `modelAndView == null`이면(REST/AJAX 응답 등) 조용히 빠진다. 그래서 `NotificationInterceptor`·`AdminModeInterceptor`는 JSP 뷰가 있는 페이지에서만 동작하고, JSON API 응답에는 영향을 주지 않는다.

## 5. 구현 상태 (됨 vs Mock/계획)

- **구현됨:** 위 8개 인터셉터 체인 전체. 로그인/관리자/최고관리자 가드, IP·국가·ASN·회원 차단과 `/blocked-access` 포워딩, 활동 로그 DB 적재, 다국어 전환, 관리자 모드 플래그·헤더 알림 주입까지 실제 동작한다.
- **외부 신호 의존:** 국가코드/ASN은 `CF-IPCountry`·`CloudFront-Viewer-Country`·`CF-ASN` 등 **CDN/WAF가 붙여주는 헤더**를 읽는다. 해당 헤더가 없는 환경(로컬 직접 호출 등)에서는 국가/ASN 규칙이 매칭되지 않고 단일 IP/CIDR 규칙만 작동한다.
- **설계상 한계:** `AdminModeInterceptor`는 `UsersVO`가 타 도메인(auth) 소유라 리플렉션으로 `getUserRole()`을 호출한다. 의도된 결합 완화이며, 실패 시 비관리자로 안전하게 폴백한다.
- **계획/미연동:** 인터셉터 단위의 성능 메트릭·분산 트레이싱(예: requestId 외부 APM 연동)은 미도입. 모바일 전용 레이아웃 분기 인터셉터는 없고 현재는 데스크톱 JSP 위주.

## 6. 면접 답변 3단계

1. **한 줄:** "TripTogether는 인증·차단·로깅·다국어·뷰 데이터 주입 같은 공통 처리를 8개의 `HandlerInterceptor` 체인으로 컨트롤러 앞단에 모았습니다."
2. **메커니즘:** "`preHandle`의 boolean 반환으로 차단/통과를 결정합니다. 비로그인은 `LoginInterceptor`가 `false`로 끊어 로그인 화면으로 redirect하고, IP/회원 차단은 `IpBlockInterceptor`가 403으로 `/blocked-access`에 forward합니다. 뷰가 필요한 데이터(관리자 모드 플래그, 알림 벨)는 `postHandle`에서 `ModelAndView`에 주입하고, 응답 완료 후 `afterCompletion`에서 상태코드·소요시간까지 확정해 활동 로그를 DB에 남깁니다."
3. **트레이드오프:** "메서드 단위 세밀한 권한은 인터셉터 대신 AOP(`@RequireLogin`/`@RequireAdmin`)로 분리했습니다. 인터셉터는 URL 패턴 기반 거친 가드, AOP는 핸들러 단위 정밀 가드라는 역할 분담입니다."

## 7. 꼬리질문 + 모범답안

**Q1. 필터와 인터셉터, 언제 무엇을 쓰나요?**
필터는 서블릿 컨테이너 레벨이라 `DispatcherServlet` 바깥에서 모든 요청에 작동하지만 어떤 컨트롤러가 매칭됐는지 모릅니다. 인터셉터는 MVC 레벨이라 `HandlerMethod`를 알 수 있어 핸들러 이름 기반 로깅·도메인 분류가 가능합니다. TripTogether는 인코딩·전역 보안 같은 저수준은 필터/WAF에, 인증·로깅·뷰 데이터 주입은 인터셉터에 둡니다.

**Q2. `preHandle`이 `false`를 반환하면 무슨 일이 벌어지나요?**
체인이 즉시 중단되고 컨트롤러는 호출되지 않습니다. 단, 응답은 자동으로 채워지지 않으므로 인터셉터가 직접 `sendRedirect`·`forward`·상태코드를 써야 합니다. 또 `false`로 끊은 인터셉터의 `postHandle`/`afterCompletion`은 실행되지 않으므로, 자원 정리는 `afterCompletion`에 의존하기보다 끊는 지점에서 마무리해야 합니다.

**Q3. 인터셉터 실행 순서는 어떻게 정해지나요?**
`InterceptorRegistry`에 등록한 순서대로 `preHandle`이 실행되고, `postHandle`·`afterCompletion`은 **역순**으로 실행됩니다. TripTogether는 차단(IpBlock)을 로그인/권한 검사보다 앞에 둬, 차단 대상이면 인증 처리에 자원을 쓰기 전에 끊습니다.

**Q4. 왜 활동 로그를 `preHandle`이 아니라 `afterCompletion`에서 저장하나요?**
응답이 끝나야 최종 HTTP 상태코드·발생 예외·총 응답시간이 확정되기 때문입니다. `preHandle`에서는 시작 시각과 requestId만 `request` 속성에 심어두고, `afterCompletion`에서 그 값을 읽어 성공 여부(상태코드 400 미만 且 예외 없음)와 소요시간을 계산해 적재합니다.

**Q5. `postHandle`이 REST API 응답에 영향을 주지 않는 이유는요?**
`@ResponseBody`/REST 응답은 `ModelAndView`가 `null`이라, `AdminModeInterceptor`·`NotificationInterceptor`는 `modelAndView == null` 가드에서 바로 빠집니다. 추가로 이 두 인터셉터는 `/api/**`·`/sse/**`를 `excludePathPatterns`로 제외해 이중으로 안전장치를 둡니다.

## 8. 직접 말해보기

- TripTogether 인터셉터 체인을 등록 순서대로 나열하고, 각각이 `preHandle`/`postHandle`/`afterCompletion` 중 무엇을 쓰는지 60초로 설명해 보세요.
- "비로그인 사용자가 `/mypage/orders`에 접근"하는 요청을 인터셉터 체인 관점에서 처음부터 끝까지 추적해 말해 보세요.
- 인터셉터로 처리하면 안 되고 AOP로 빼야 하는 권한 체크의 예를 하나 들고 이유를 설명해 보세요.

## 퀴즈

<QuizBox question="HandlerInterceptor의 preHandle이 false를 반환하면 어떻게 되나요?" :choices="['컨트롤러가 호출된 뒤 응답만 버려진다', '체인이 중단되고 컨트롤러는 호출되지 않으며, 응답은 인터셉터가 직접 써야 한다', '다음 인터셉터는 건너뛰지만 컨트롤러는 그대로 실행된다', '예외가 던져져 GlobalExceptionHandler로 넘어간다']" :answer="1" explanation="preHandle이 false면 그 지점에서 요청이 종료되어 컨트롤러는 실행되지 않습니다. redirect·forward·상태코드 등 응답은 인터셉터가 직접 작성해야 하며, LoginInterceptor가 로그인 화면으로 redirect하는 것이 그 예입니다." />

<QuizBox question="TripTogether에서 헤더 알림 벨 데이터(headerUnreadCount 등)와 isAdminMode 플래그를 Model에 주입하기에 가장 적절한 인터셉터 훅은?" :choices="['preHandle', 'postHandle', 'afterCompletion', 'destroy']" :answer="1" explanation="ModelAndView에 뷰 전용 데이터를 넣으려면 컨트롤러 실행 후·뷰 렌더링 전인 postHandle을 써야 합니다. NotificationInterceptor와 AdminModeInterceptor 모두 postHandle을 사용하고, modelAndView가 null인 REST/AJAX 응답에서는 조용히 빠집니다." />

<QuizBox question="ActivityLogInterceptor가 응답 상태코드와 총 응답시간을 afterCompletion에서 기록하는 이유로 가장 정확한 것은?" :choices="['preHandle에서는 세션에 접근할 수 없기 때문', '응답이 완료되어야 최종 상태코드·예외·소요시간이 확정되기 때문', 'afterCompletion이 가장 먼저 실행되기 때문', 'postHandle은 REST 응답에서 호출되지 않기 때문']" :answer="1" explanation="최종 HTTP 상태코드, 발생 예외, 총 응답시간은 응답이 끝나야 확정됩니다. 그래서 preHandle에서 시작시각·requestId만 request 속성에 심어두고, afterCompletion에서 그 값으로 성공 여부와 소요시간을 계산해 USER_ACTIVITY_LOG에 적재합니다." />
