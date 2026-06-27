# 인터셉터 체인

> 한 요청이 컨트롤러에 닿기 전·후를 8개 인터셉터가 순서대로 관통한다 — locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification.

이 페이지는 특정 도메인 소유가 아니라 4명이 공유하는 공통 인프라다. 모든 도메인의 요청이 이 체인을 지난다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 용어는 [인터셉터](/glossary/interceptor).

## 1. 한 줄 정의

`HandlerInterceptor`를 구현한 8개 컴포넌트를 `WebConfig.addInterceptors()`에서 경로 패턴과 함께 **등록 순서대로** 묶어, 요청 → 컨트롤러 → 뷰의 전 구간에 횡단 관심사(로케일, 차단, 로깅, 인증, 권한, 화면 데이터 주입)를 끼워 넣는 Spring MVC 체인이다.

## 2. 왜 이렇게 설계했나

- **컨트롤러는 도메인 로직만.** "로그인 했나", "차단된 IP인가", "이 요청을 로그로 남겨야 하나" 같은 질문을 컨트롤러마다 반복하면 4명이 같은 코드를 14~15개 모듈에 흩뿌리게 된다. 체인으로 한 곳에 모은다.
- **순서가 곧 정책.** 인터셉터는 등록 순서대로 `preHandle`이 실행되고, `postHandle`/`afterCompletion`은 역순으로 실행된다. 그래서 "차단을 인증보다 먼저", "활동 로그는 차단 통과 후" 같은 우선순위를 등록 순서로 표현한다.
- **세션 인증 모델과 결.** TripTogether는 세션 속성 `loginUser`(`UsersVO`)에 로그인 상태를 둔다. 대부분의 인터셉터가 이 세션 속성을 읽어 동작하므로, 인증 게이트(login/admin/superAdmin)와 화면 데이터 주입(adminMode/notification)을 같은 모델 위에서 일관되게 처리한다.
- **앞단(WAF/CDN)과 역할 분리.** 대량 트래픽 방어는 앞단 계층에 맡기고, `IpBlockInterceptor`는 "이 계정이 BLOCKED인가", "이 회원+IP 조합이 차단됐나"처럼 **애플리케이션 문맥**이 필요한 정밀 차단만 담당한다.

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

전부 `org.triptogether.config` 패키지, 등록은 `WebConfig implements WebMvcConfigurer`.

| 순서 | 인터셉터 클래스 | 훅 | 핵심 역할 |
| --- | --- | --- | --- |
| 1 | `LocaleChangeInterceptor`(Spring 기본) | preHandle | `?lang=` 파라미터로 세션 로케일 전환 |
| 2 | `IpBlockInterceptor` | preHandle | IP/국가/ASN/CIDR·회원 차단, 403 forward |
| 3 | `ActivityLogInterceptor` | pre/afterCompletion | 요청 ID·시작시각 기록 → 응답 후 활동 로그 적재 |
| 4 | `LoginInterceptor` | preHandle | 비로그인 시 로그인 화면 redirect |
| 5 | `AdminInterceptor` | preHandle | 관리자 권한 + URL별 세부 권한 게이트 |
| 6 | `SuperAdminInterceptor` | preHandle | `/superAdmin/**` 관리자 계열 게이트 |
| 7 | `AdminModeInterceptor` | postHandle | 모델에 `isAdmin`/`isAdminMode`/권한 플래그 주입 |
| 8 | `NotificationInterceptor` | postHandle | 헤더 알림 벨 데이터(안읽음 수·최근 5건) 주입 |

연관 인프라: 로케일은 `SessionLocaleResolver`(기본 `Locale.KOREAN`) + `MessageSource`(도메인별 다수 basename). 차단/활동 로그는 `BlockAccessLogMapper`·`ActivityLogMapper`로 각각 `BlockAccessLogVO`·`UserActivityLogVO`를 적재한다. 차단 규칙은 `BlockRuleCacheService` 스냅샷(IP 규칙 `IpBlockRuleVO`, 회원 규칙 `UserBlockRuleVO`)에서 읽는다. 알림 데이터는 `MyPageService.getUnreadCount()`·`getRecentNotifications()`로 가져온다.

:::tip 인터셉터 vs AOP vs ArgumentResolver
같은 횡단 관심사라도 층이 다르다. **인터셉터**는 HTTP 요청 경계(URL 패턴 기반)에서 동작하고, **AOP**(`@RequireLogin`/`@RequireAdmin` = `AuthorizationAspect`, ADR-0011)는 메서드 호출 경계에서, **`LoginUserArgumentResolver`**는 파라미터 바인딩 단계에서 `@LoginUser UsersVO`를 주입한다. 셋 다 `WebConfig`/`ai` 공통 영역과 맞물리는 공통 인프라다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

### 4-1. 등록 — 순서와 경로 패턴

```java
// WebConfig.addInterceptors(InterceptorRegistry registry)
registry.addInterceptor(localeChangeInterceptor())   // 1
        .addPathPatterns("/**")
        .excludePathPatterns("/resources/**", "/upload/**", "/favicon.ico",
                             "/error", "/css/**", "/js/**", "/images/**");

registry.addInterceptor(ipBlockInterceptor)          // 2 — 차단을 인증보다 먼저
        .addPathPatterns("/**")
        .excludePathPatterns(/* 정적 + */ "/blocked-access", "/security/appeal/**", ...);

registry.addInterceptor(activityLogInterceptor)      // 3
        .addPathPatterns("/**").excludePathPatterns(/* 정적 + 차단/이의신청 */ ...);

registry.addInterceptor(loginInterceptor)            // 4 — 좁은 경로만
        .addPathPatterns("/mypage/**", "/wallet/**", "/auth/link/**", "/inquiry/**")
        .excludePathPatterns("/mypage/temp", "/mypage/temp/**");

registry.addInterceptor(adminInterceptor).addPathPatterns("/admin/**");          // 5
registry.addInterceptor(superAdminInterceptor).addPathPatterns("/superAdmin/**");// 6

registry.addInterceptor(adminModeInterceptor)        // 7
        .addPathPatterns("/**")
        .excludePathPatterns("/resources/**", "/upload/**", "/api/**", "/blocked-access");

registry.addInterceptor(notificationInterceptor)     // 8
        .addPathPatterns("/**")
        .excludePathPatterns(/* 정적 + */ "/api/**", "/sse/**", "/blocked-access", ...);
```

경로 패턴의 핵심 차이:

- **전역(`/**`)**: locale, ipBlock, activityLog, adminMode, notification. 단 화면 데이터를 주입하는 7·8번은 `/api/**`를 제외한다(JSON 응답엔 모델이 없으므로 무의미). 8번은 `/sse/**`도 제외한다(스트리밍 응답).
- **좁은 경로**: login은 `/mypage/**`·`/wallet/**`·`/auth/link/**`·`/inquiry/**`만, admin은 `/admin/**`, superAdmin은 `/superAdmin/**`만 본다.
- **차단 우회 경로**: ipBlock/activityLog/notification은 `/blocked-access`(차단 안내 페이지)와 `/security/appeal/**`(계정 차단 해제 이의신청)을 제외한다. 차단된 사용자도 안내·이의신청 화면에는 닿아야 하기 때문이다.

### 4-2. 실행 타이밍 — preHandle은 정방향, post/after는 역방향

```text
요청 ──▶ [1 locale] [2 ipBlock] [3 activityLog.pre] [4 login] [5 admin] ... preHandle (정방향)
                                       │
                                  Controller
                                       │
[7 adminMode.post] [8 notification.post] ◀── View 렌더 직전 postHandle (역방향)
[3 activityLog.afterCompletion] ◀────────── 응답 완료 후 (역방향, 예외 무관)
```

- 2~6번은 **preHandle**에서 게이트 역할(`return false`면 컨트롤러 미진입).
- 3번은 preHandle에서 `requestId`(UUID)·시작시각만 심고, **afterCompletion**에서 응답 상태·소요시간까지 묶어 로그를 적재한다. `afterCompletion`이라 예외가 나도 기록된다.
- 7·8번은 **postHandle**에서 `ModelAndView`에 값을 추가한다 — `modelAndView == null`(뷰 없는 응답)이면 즉시 return.

### 4-3. 각 인터셉터가 실제로 하는 일

```text
② IpBlock     세션 loginUser·클라이언트 IP(X-Forwarded-For 우선)·국가(CF-IPCountry)·ASN 추출
              → IP 규칙(SINGLE_IP/CIDR/RANGE/COUNTRY/ASN) 먼저, 회원 규칙(계정 BLOCKED·USER_ONLY·USER_IP) 다음
              → 차단이면 BlockAccessLogVO 적재 + 상태 403 + /blocked-access 로 forward
④ Login       세션 loginUser 없으면 원래 URL을 redirect 파라미터로 인코딩해 /auth/login 으로 보냄
⑤ Admin       비로그인→로그인 화면 / hasAdminRole() 아니면 / 로 / SUPER_ADMIN 권한이면 통과
              → 아니면 URL별 필요 권한(예: /admin/members→MEMBER_ADMIN, /admin/finance/refund→FINANCE_OPERATOR) 확인
⑦ AdminMode   isAdmin·isAdminMode(viewMode!="user")와 도메인별 권한 플래그(hasCommunityAdmin 등)를 모델에 주입
⑧ Notification 로그인 사용자에 한해 headerUnreadCount·headerRecentNotifications(최근 5건) 주입
```

`AdminInterceptor`의 권한 해석은 URL 접두사 → 권한 코드 매핑(`URL_PERMISSION_MAP`, `AUDIT_URLS`)과 분기 메서드(`resolveAiHelperPermission`, `resolveFinancePermission`)로 처리한다. 예를 들어 `/admin/ai-helper/chatbot`은 `AI_CHATBOT_ADMIN`(Gemini 챗봇 운영), 그 외 `/admin/ai-helper`는 `ASSISTANT_ADMIN`(Claude 도우미 운영)으로 갈린다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::details 됨 / 부분 / 한계
- **됨**: 8개 인터셉터 전부 실제 등록·동작. IP/회원 정밀 차단(CIDR·국가·ASN 매칭, 403 forward, DB 로그), URL별 세부 권한 게이트, 활동 로그 비동기 적재, 헤더 알림·관리자 모드 모델 주입, 4개국어 로케일 전환까지 구현되어 있다.
- **부분/주의**: 국가(`CF-IPCountry` 등)·ASN(`CF-ASN`)은 **앞단 프록시가 주입하는 헤더**에 의존한다. 프록시가 없으면 이 값은 비고, 해당 규칙 타입은 매칭되지 않는다(IP/CIDR/RANGE는 그대로 동작). `getClientIp`도 `X-Forwarded-For`를 신뢰하므로 신뢰 가능한 프록시 뒤 배치가 전제다.
- **계획/한계**: 차단 안내 다국어는 지원 언어(ko/en/ja/zh)에 한정. 인터셉터 단위의 정량 성능 모니터링/대시보드는 없다. AOP 권한(`@RequireLogin`)과 인터셉터 게이트가 경로에 따라 **이중**으로 걸릴 수 있어, 신규 보호 경로 추가 시 둘 중 어느 층으로 막을지 합의가 필요하다(공통 영역이라 팀 합의 대상).
:::

## 6. 면접 답변 3단계

1. **한 문장**: "요청이 컨트롤러에 닿기 전·후로 8개 `HandlerInterceptor`를 등록 순서대로 통과시켜 로케일·차단·로깅·인증·권한·화면 데이터 주입을 한 곳에서 처리합니다."
2. **순서의 의미**: "등록 순서가 정책입니다. 차단(ipBlock)을 인증보다 앞에 둬 BLOCKED 사용자는 컨트롤러에 진입조차 못 하게 하고, 활동 로그는 `afterCompletion`이라 예외가 나도 응답 상태까지 묶어 남깁니다. 화면 데이터 주입(adminMode·notification)은 `postHandle`이라 `/api/**`에선 건너뜁니다."
3. **트레이드오프**: "전역 `/**`로 거는 인터셉터는 정적 리소스·`/blocked-access`·`/security/appeal/**`를 명시적으로 제외해 차단된 사용자도 안내·이의신청에는 닿게 했습니다. 인증 게이트는 인터셉터(경로 기반)와 AOP(`@RequireLogin`, 메서드 기반)가 공존해, 신규 경로는 어느 층으로 막을지 합의로 정합니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. preHandle / postHandle / afterCompletion은 언제, 어떤 순서로 실행되나?
preHandle은 컨트롤러 호출 전, 등록 **정방향**으로 실행되고 `false`를 반환하면 체인이 끊겨 컨트롤러로 가지 않는다. postHandle은 컨트롤러 성공 후 뷰 렌더 직전, afterCompletion은 응답 완료 후 실행되며 둘 다 등록 **역방향**이다. 그래서 `ActivityLogInterceptor`는 preHandle에서 `requestId`·시작시각만 심고 `afterCompletion`에서 응답 상태·소요시간을 묶는다 — afterCompletion은 예외가 나도 호출되므로 실패 요청도 누락 없이 기록된다.
:::

:::details Q2. 차단(ipBlock)을 인증(login)보다 먼저 등록한 이유는?
차단은 "이 요청을 아예 받지 않겠다"는 상위 정책이라 인증보다 앞서야 한다. 차단된 IP/회원이면 컨트롤러는 물론 로그인 게이트도 거치지 않고 즉시 403으로 `/blocked-access`에 forward된다. 만약 login을 먼저 두면 차단 대상이 로그인 리다이렉트로 튕겨 차단 안내를 못 보는 모순이 생긴다. 그래서 ipBlock의 제외 경로에 `/blocked-access`·`/security/appeal/**`를 넣어 차단된 사용자도 안내·이의신청에는 접근하게 했다.
:::

:::details Q3. adminMode·notification 인터셉터가 `/api/**`를 제외하는 이유는?
둘 다 `postHandle`에서 `ModelAndView`에 값을 추가하는 인터셉터다. `/api/**`는 JSON을 직접 쓰는 응답이라 `ModelAndView`가 `null`이고(코드에서 `if (modelAndView == null) return;`), 모델에 값을 넣어도 화면이 없어 무의미하다. 그래서 패턴 단계에서 아예 제외해 불필요한 DB 조회(알림 개수·최근 알림)를 막는다. notification은 추가로 `/sse/**`도 제외한다 — 서버 푸시 스트리밍이라 일반 뷰 모델 개념이 없기 때문이다.
:::

:::details Q4. AdminInterceptor와 SuperAdminInterceptor는 무엇이 다른가?
경로와 검사 깊이가 다르다. AdminInterceptor는 `/admin/**`에서 로그인 + `hasAdminRole()`을 본 뒤, `SUPER_ADMIN` 권한이면 통과시키고 아니면 URL별 세부 권한(`MEMBER_ADMIN`, `FINANCE_OPERATOR` 등)을 확인한다. SuperAdminInterceptor는 `/superAdmin/**`에서 로그인 + 관리자 계열 여부까지만 게이트하고, 그 안의 세부 권한은 superAdmin 화면/권한 정책 테이블에서 다룬다. 즉 admin은 "권한별 정밀 게이트", superAdmin은 "관리자 계열 진입 게이트 + 화면 내부 분기" 구조다.
:::

:::details Q5. 클라이언트 IP를 어떻게 구하고, 그 위험은?
`getClientIp`는 `X-Forwarded-For`·`Proxy-Client-IP` 등 프록시 헤더를 우선 확인하고 첫 값을 취한 뒤 없으면 `getRemoteAddr()`로 떨어진다. `normalizeIp`로 IPv6 루프백(`::1`)을 `127.0.0.1`로, IPv4-mapped(`::ffff:`)를 정규화한다. 위험은 `X-Forwarded-For`가 클라이언트가 위조 가능한 헤더라는 점이다 — 신뢰할 수 있는 프록시 뒤에 둬서 프록시가 이 헤더를 덮어쓰도록 운영하는 것이 전제다. 국가/ASN도 `CF-IPCountry`·`CF-ASN` 같은 프록시 주입 헤더에 의존하므로 같은 신뢰 경계가 적용된다.
:::

## 8. 직접 말해보기

- 8개 인터셉터를 등록 순서대로 나열하고, 각 순서가 왜 그 위치인지 한 문장씩 설명해 보라.
- "BLOCKED 계정 사용자가 `/mypage`에 GET 요청을 보냈다." preHandle 정방향으로 어디서 멈추고 사용자는 어떤 화면을 보는지 따라가 보라.
- 전역 `/**` 인터셉터들이 공통으로 제외하는 경로 두 종류(정적 리소스, 차단 우회 경로)를 들고, 각각 왜 제외해야 하는지 말해 보라.
- adminMode/notification이 `postHandle`을 쓰는 이유를, "JSON 응답에는 왜 안 거나"와 엮어 설명해 보라.

## 퀴즈

<QuizBox question="WebConfig.addInterceptors()의 실제 등록 순서로 옳은 것은?" :choices="['login → admin → ipBlock → activityLog → locale → notification', 'locale → ipBlock → activityLog → login → admin → superAdmin → adminMode → notification', 'ipBlock → login → activityLog → locale → admin → notification', 'activityLog → ipBlock → locale → login → notification → admin']" :answer="1" explanation="등록 순서가 곧 preHandle 실행 순서다. locale(언어) → ipBlock(차단) → activityLog(로깅 시작) → login → admin → superAdmin 게이트 → adminMode/notification(postHandle 모델 주입) 순서로, 차단을 인증보다 앞에 둬 BLOCKED 사용자가 컨트롤러에 진입하지 못하게 한다." />

<QuizBox question="ActivityLogInterceptor가 응답 상태·소요시간을 afterCompletion에서 기록하는 이유로 가장 적절한 것은?" :choices="['preHandle에서는 세션을 읽을 수 없어서', 'afterCompletion은 컨트롤러에서 예외가 나도 호출되므로 실패 요청까지 누락 없이 기록할 수 있어서', 'postHandle은 정적 리소스에서만 실행되어서', 'afterCompletion이 가장 먼저 실행되어서']" :answer="1" explanation="preHandle에서 requestId·시작시각만 심고, afterCompletion에서 응답 상태·소요시간을 묶는다. afterCompletion은 정상/예외 응답 모두에서 호출되므로 4xx·5xx로 끝난 요청도 빠짐없이 로그로 남길 수 있다." />

<QuizBox question="adminMode·notification 인터셉터가 경로 패턴에서 /api/**를 제외하는 핵심 이유는?" :choices="['/api/** 는 로그인할 수 없어서', '두 인터셉터는 postHandle에서 ModelAndView에 값을 주입하는데, JSON 응답은 ModelAndView가 null이라 주입이 무의미하고 불필요한 DB 조회만 발생해서', 'API는 차단 대상이 아니어서', '/api/** 는 인터셉터를 지원하지 않아서']" :answer="1" explanation="adminMode·notification은 postHandle에서 모델에 isAdmin/알림 데이터를 넣는다. /api/** 는 JSON을 직접 쓰므로 ModelAndView가 null이고(코드에서 null이면 즉시 return), 모델 주입이 의미가 없으며 알림 개수 같은 DB 조회만 낭비된다. notification은 SSE 스트리밍인 /sse/** 도 함께 제외한다." />
