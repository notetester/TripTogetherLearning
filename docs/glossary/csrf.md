# CSRF (Cross-Site Request Forgery)

> 로그인된 사용자의 브라우저를 속여, 사용자 의도 없이 서버에 "변경" 요청을 위조해 보내는 공격. TripTogether는 Spring Security의 CSRF 필터를 **부분 도입**해(ADR-0012) 일부 모듈의 POST/PUT/DELETE만 토큰으로 방어한다.

이 페이지는 특정 담당자의 작업이 아니라, TripTogether 전체 보안 설계의 한 축으로서 CSRF를 다룬다. 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/).

## 1. 한 줄 정의

CSRF는 인증 쿠키/세션이 **브라우저에 의해 자동 전송된다는 점**을 악용해, 공격자 페이지가 피해자 대신 서버에 상태 변경 요청을 보내는 공격이다. 방어의 핵심은 "쿠키와 별개로, 공격자가 알 수 없는 비밀값(CSRF 토큰)을 요청에 함께 요구"하는 것이다.

## 2. 왜 이렇게 설계했나

TripTogether는 Spring Security의 인증 메커니즘을 쓰지 않고 **자체 세션 + 인터셉터 + AOP**로 인증/인가를 처리한다([세션·쿠키](/glossary/session-cookie), [인터셉터](/glossary/interceptor), [AOP](/glossary/aop) 참고). 이 구조에서 세션은 쿠키로 식별되므로, 외부 페이지에서 `<form>`이나 `fetch`로 POST를 날려도 브라우저가 세션 쿠키를 자동 첨부해 정상 요청처럼 처리될 위험이 있었다.

문제는 "보호는 필요하지만, 풀 도입의 회귀 위험이 크다"는 점이었다. 4인 공동개발이라 CSRF를 모든 모듈에 켜면 다른 담당자의 모든 폼·AJAX가 토큰을 첨부하도록 일괄 수정해야 한다. ADR-0012는 이 트레이드오프를 **부분 도입**으로 해결했다.

- **시급성**: 변경 요청(POST/PUT/DELETE)이 무방어 상태였다.
- **회귀 위험 최소화**: 다른 담당자 모듈에 영향을 주지 않는다.
- **자체 인증 보존**: Spring Security 인증과 충돌을 피한다.
- **점진적 확장**: ADR에 단계별 마이그레이션 경로를 명시한다.

:::tip 왜 GET은 보호 대상이 아닌가
CSRF 토큰은 "상태를 바꾸는" 요청에만 요구한다. GET은 멱등/안전(side-effect 없음)해야 하므로([HTTP 메서드](/glossary/http-methods) 참고) CSRF 검증 대상에서 제외한다. 반대로 말하면, GET으로 상태를 바꾸는 API가 있으면 CSRF 방어 자체가 무력화된다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·설정)

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| `SecurityConfig` | `org.triptogether.config.SecurityConfig` | `SecurityFilterChain` 빈. CSRF 필터만 활성, 나머지 비활성 |
| 담당 모듈 매처 | `SecurityConfig` 내부 `RequestMatcher` (람다) | CSRF 검증 대상 URI·메서드 판별 |
| 토큰 노출 + 자동 첨부 | `WEB-INF/views/common/header.jsp` | `_csrf` 메타 태그 + `fetch`/jQuery monkey-patch |
| 정책 문서 | `docs/adr/0012-spring-security-csrf-partial-adoption.md` | 부분 도입 근거와 확장 계획 |

의존성은 `spring-security-crypto/config/web`. 단, 인증 기능(formLogin/httpBasic/logout)은 모두 비활성화해 **실질적으로 CSRF 필터 1개만 동작하는 모드**다. 비밀번호 해싱용 `BCryptPasswordEncoder`([BCrypt](/glossary/bcrypt))도 같은 Spring Security 의존성에서 가져온다.

```java
// SecurityConfig — 인증은 자체 인터셉터/AOP가 담당, Security는 CSRF만
http
    .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
    .csrf(csrf -> csrf.requireCsrfProtectionMatcher(moduleMatcher()))
    .formLogin(f -> f.disable())
    .httpBasic(b -> b.disable())
    .logout(l -> l.disable());
```

CSRF 검증 대상은 `RequestMatcher` 람다로 좁힌다. Spring Security 7+에서 `AntPathRequestMatcher`가 제거돼 람다로 직접 메서드·URI를 판별하며, contextPath(`/TripTogether`)가 URI에 포함되므로 `contains()`로 매칭한다.

```java
// 변경 메서드 + 담당 모듈 경로만 CSRF 검증 대상
private RequestMatcher moduleMatcher() {
    return req -> {
        String m = req.getMethod();
        if (!"POST".equalsIgnoreCase(m)
                && !"PUT".equalsIgnoreCase(m)
                && !"DELETE".equalsIgnoreCase(m)) return false;
        String uri = req.getRequestURI();
        return uri != null && (
            uri.contains("/community/")
         || uri.contains("/report/")
         || uri.contains("/inquiry/"));
    };
}
```

## 4. 동작 원리 (흐름·표·작은 코드)

**적용 범위 (Phase 1, 현재)**

```text
적용  : /community/**  /report/**  /inquiry/**  의 POST / PUT / DELETE
미적용: 그 외 모든 요청 (다른 모듈 + 모든 GET)
```

**토큰 자동 첨부 (개발자 경험)** — 기존 fetch/jQuery 코드를 한 줄도 고치지 않도록, `header.jsp`가 모든 페이지에서 토큰을 메타 태그로 노출하고 `window.fetch`를 monkey-patch 한다.

```html
<meta name="_csrf" content="${_csrf.token}">
<meta name="_csrf_header" content="${_csrf.headerName}">
```

```js
// 같은 origin 요청에만 자동으로 CSRF 헤더를 끼워 넣는다
const origFetch = window.fetch;
window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (url.startsWith('/') || url.startsWith(location.origin)) {
        init.headers = { ...init.headers, [header]: token };
    }
    return origFetch.call(this, input, init);
};
// jQuery가 로드되면 $.ajaxSetup(beforeSend)로 동일 처리
```

**요청 처리 흐름**

| 시나리오 | 토큰 | 결과 |
|---|---|---|
| 정상 페이지 fetch POST → `/community/...` | monkey-patch가 자동 첨부 | 200 |
| 정상 페이지 jQuery `$.ajax` | `ajaxSetup`이 자동 첨부 | 200 |
| 외부 페이지에서 위조 POST → `/community/...` | 토큰 없음 | **403** |
| GET 요청 (어느 모듈이든) | 검증 안 함 | 정상 |
| 다른 모듈 POST (예: `/auth/...`) | 매처 미해당 | 정상 (기존 동작 유지) |

핵심은 **공격자 페이지는 토큰 값을 알 수 없다**는 점이다. 토큰은 피해자 도메인의 응답(메타 태그)에만 담겨 있고, 동일 출처 정책(SOP) 때문에 공격자 스크립트는 그 응답을 읽을 수 없다. 그래서 위조 POST에는 토큰이 빠지고 403으로 거절된다.

:::warning 토큰 유출은 XSS에 의존
CSRF 토큰을 메타 태그로 모든 페이지에 노출하므로, XSS가 뚫리면 공격자 스크립트가 토큰을 읽어 CSRF 방어를 우회할 수 있다. 그래서 CSRF와 XSS 방어는 한 묶음이다 — TripTogether는 jsoup 서버 정화(ADR-0005)로 저장형 XSS를 차단해 이 위험을 보강한다. [입력 검증·정화](/backend/validation) 참고.
:::

## 5. 구현 상태 (됨 vs Mock/계획)

**구현됨**
- `SecurityConfig` + CSRF 필터 동작 (인증 기능은 비활성).
- `/community`, `/report`, `/inquiry`의 변경 요청 토큰 검증.
- `fetch`/jQuery 자동 첨부 monkey-patch (기존 코드 무수정).

**계획 (점진적 확장, ADR-0012)**

| 단계 | 적용 범위 | 시점 |
|---|---|---|
| Phase 1 (현재) | `/community`, `/report`, `/inquiry` POST/PUT/DELETE | 도입 완료 |
| Phase 2 | `/myPage`, `/admin` 등 추가/공동 영역 | 팀 합의 후 |
| Phase 3 | `/auth`, `/courses` 등 타 담당 영역 | 팀 합의 후 |
| Phase 4 | 전체 풀 적용 + 매처 제거 | 팀 통합 시점 |

**한계 (정직하게)**
- **부분 적용이라 일관성 결여** — CSRF 보호 영역과 무방어 영역이 공존한다.
- 다른 모듈의 변경 요청은 여전히 CSRF 무방어다.
- monkey-patch는 다른 라이브러리가 `fetch`를 재패치하면 충돌 여지가 있다.

## 6. 면접 답변 3단계

1. **한 줄**: "CSRF는 세션 쿠키가 자동 전송되는 점을 악용해 사용자 의도 없이 변경 요청을 위조하는 공격이고, 우리는 Spring Security CSRF 필터를 부분 도입해 일부 모듈의 POST/PUT/DELETE만 토큰으로 막았습니다."
2. **설계 의도**: "자체 세션+인터셉터+AOP 인증 구조와 충돌을 피하려고 Security의 인증 기능은 다 끄고 CSRF 필터만 살렸습니다. 4인 공동개발이라 풀 도입은 회귀 위험이 커서, `RequestMatcher`로 담당 모듈의 변경 요청만 검증 대상으로 좁히고 ADR에 단계별 확장 계획을 명시했습니다."
3. **개발자 경험**: "기존 fetch/jQuery 코드를 안 고치려고 `header.jsp`에서 토큰을 메타 태그로 노출하고 `window.fetch`와 `$.ajaxSetup`을 monkey-patch 해서 같은 origin 요청에 토큰을 자동 첨부했습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 GET에는 CSRF 토큰을 요구하지 않나요?
GET은 안전(safe)·멱등해야 하고 상태를 바꾸지 않으므로 위조돼도 피해가 없다는 전제입니다. 그래서 매처에서 POST/PUT/DELETE만 검증 대상으로 잡습니다. 단 이 전제가 성립하려면 GET으로 상태를 바꾸는 API가 없어야 하며, 그런 API가 있으면 CSRF 방어 자체가 무력화됩니다. [HTTP 메서드](/glossary/http-methods)
:::

:::details Q2. CSRF 토큰만으로 충분한가요? XSS와의 관계는?
토큰은 메타 태그로 페이지에 노출되므로, XSS가 뚫리면 공격자 스크립트가 토큰을 읽어 우회할 수 있습니다. 즉 CSRF 방어는 XSS 차단을 전제로 합니다. TripTogether는 jsoup 서버 정화(ADR-0005)로 저장형 XSS를 막아 이 의존 관계를 보강했습니다.
:::

:::details Q3. SameSite 쿠키가 있는데 CSRF 토큰이 또 필요한가요?
`SameSite=Lax/Strict`는 크로스 사이트 요청에 쿠키 전송을 제한해 1차 방어가 되지만, 브라우저 호환성·서브도메인·일부 내비게이션 케이스 때문에 단독 의존은 위험합니다. 토큰 기반 방어는 쿠키 정책과 독립적으로 "공격자가 토큰 값을 모른다"는 보증을 추가하는 심층 방어(defense in depth)입니다.
:::

:::details Q4. 부분 도입의 단점은 무엇이고 왜 감수했나요?
가장 큰 단점은 일관성 결여 — 같은 앱에 보호/무방어 영역이 공존합니다. 그럼에도 4인 협업에서 풀 도입의 회귀 위험과 조율 비용이 더 컸기에, 담당 영역을 즉시 보호하면서 ADR에 Phase 1~4 확장 경로를 명시해 마이그레이션 길을 열어두는 쪽을 택했습니다. "위험을 인지하고 관리한 결정"이라는 점이 핵심입니다.
:::

:::details Q5. Spring Security를 넣었는데 인증은 왜 자체 구현을 유지했나요?
이미 세션+인터셉터+AOP로 인증/인가가 동작 중이라, Security 인증으로 갈아끼우면 전 모듈 회귀가 발생합니다. 그래서 `authorizeHttpRequests(permitAll)`로 인가를 자체 인터셉터/AOP에 위임하고, formLogin/httpBasic/logout을 모두 disable 해 Security를 사실상 CSRF 필터 전용으로 운용했습니다. [로그인·세션](/auth/login-session)
:::

## 8. 직접 말해보기

- CSRF가 "쿠키 자동 전송"을 어떻게 악용하는지 30초로 설명해 보라.
- 우리 프로젝트가 풀 도입 대신 부분 도입을 택한 이유를, 협업 맥락까지 포함해 말해 보라.
- monkey-patch가 "기존 코드 무수정"을 어떻게 달성하는지, 같은 origin 판별까지 설명해 보라.
- CSRF 토큰과 XSS 차단(ADR-0005)이 왜 한 묶음인지 연결해 설명해 보라.

## 퀴즈

<QuizBox question="TripTogether에서 CSRF 토큰 검증 대상이 되는 요청은?" :choices="['모든 모듈의 모든 요청', '커뮤니티·신고·문의 모듈의 GET 요청', '커뮤니티·신고·문의 모듈의 POST/PUT/DELETE 요청', '인증(auth) 모듈의 모든 변경 요청']" :answer="2" explanation="ADR-0012의 부분 도입에 따라 /community, /report, /inquiry 경로의 POST/PUT/DELETE만 RequestMatcher로 검증 대상이 된다. GET과 다른 모듈은 제외된다." />

<QuizBox question="자체 세션 인증을 유지하면서 Spring Security를 CSRF 전용으로 운용하기 위해 SecurityConfig에서 한 조치로 가장 거리가 먼 것은?" :choices="['authorizeHttpRequests를 anyRequest().permitAll()로 인가를 자체 인터셉터/AOP에 위임', 'formLogin/httpBasic/logout 비활성화', 'requireCsrfProtectionMatcher로 검증 범위를 좁힘', 'Spring Security 로그인 폼으로 세션 인증을 교체']" :answer="3" explanation="인증은 자체 세션+인터셉터+AOP를 유지했고, Security 로그인 폼으로 교체하지 않았다. 오히려 formLogin을 disable 해 충돌과 회귀를 피했다." />

<QuizBox question="CSRF 토큰을 메타 태그로 노출하는 방식의 보안상 전제 조건은?" :choices="['HTTPS만 쓰면 무조건 안전하다', 'XSS가 차단되어야 토큰 유출을 막을 수 있다', '토큰을 쿠키에도 함께 저장해야 한다', 'GET 요청도 토큰을 검증해야 한다']" :answer="1" explanation="토큰이 페이지에 노출되므로 XSS가 뚫리면 공격자 스크립트가 토큰을 읽어 CSRF를 우회할 수 있다. 그래서 jsoup 정화(ADR-0005)로 XSS를 막아 보강한다." />
