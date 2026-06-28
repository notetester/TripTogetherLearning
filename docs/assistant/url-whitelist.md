---
title: "URL 화이트리스트 보안"
owner: D
domain: "AI 어시스턴트·챗봇"
tags: ["보안", "URL"]
---

# URL 화이트리스트 보안

> LLM이 만든 링크를 그대로 믿지 않는다. 사이트 네비 챗봇이 응답에 넣은 모든 내부 링크를 정규식 화이트리스트로 검증하고, 위험 스킴·경로 순회·프로토콜 상대 URL을 서버에서 잘라낸다.

## 1. 한 줄 정의

사이트 네비게이션 챗봇(`common` 모듈, Google Gemini 2.5 Flash)이 구조화 JSON 응답의 `links[]`에 담아 내려준 모든 내부 URL을, 서버가 **허용 경로 정규식 목록(allow-list)** 과 대조해 통과한 것만 사용자에게 노출하는 출력 검증 계층이다.

## 2. 왜 이렇게 설계했나

LLM 응답은 신뢰 경계 밖의 입력이다. 챗봇은 자연어 질문을 받아 "이 페이지로 가보세요"라며 링크를 생성하는데, 모델이 환각으로 존재하지 않는 경로를 만들거나, 프롬프트 인젝션으로 `javascript:` 같은 위험 링크를 유도당할 수 있다. 클라이언트가 이 링크를 그대로 렌더링하면 잘못된 이동, 피싱, 또는 XSS로 이어진다.

핵심 설계 원칙은 세 가지다.

- **출력 검증을 클라이언트가 아니라 서버에서 한다.** 프론트는 신뢰 경계 안이 아니므로 차단 로직을 우회당할 수 있다. 따라서 Gemini 응답을 파싱하는 서버 단계에서 거른다.
- **블랙리스트가 아니라 화이트리스트다.** "위험한 것을 막는" 방식은 새 공격 패턴을 계속 따라가야 하지만, "허용된 것만 통과"는 사이트가 실제로 가진 경로만 열거하므로 미지의 입력을 기본 거부한다.
- **위험 스킴 차단은 화이트리스트와 별개로 둔다.** 화이트리스트가 모든 케이스를 잡더라도, `javascript:`·경로 순회 같은 고전적 우회는 명시적 사전 검사로 한 번 더 거른다(방어 심층화).

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 요소 | 위치 | 역할 |
| --- | --- | --- |
| `ChatbotService` | `common/service` | Gemini 호출·JSON 파싱·링크 검증의 본체 |
| `ALLOWED_URL_PATTERNS` | `ChatbotService` 상수 | 허용 내부 경로 `Pattern` 목록 |
| `DANGEROUS_SCHEME_PATTERN` | `ChatbotService` 상수 | 위험 스킴 사전 차단 정규식 |
| `isAllowedInternalUrl(String)` | `ChatbotService` private | 단일 URL 검증 메서드 |
| `ChatbotResponseVO.SiteLink` | `common/vo` | 검증 통과 링크의 label·url·icon 보관 |
| `ChatbotFastPathService` | `common/service` | LLM을 생략하는 단순 네비, 하드코딩 신뢰 링크 |
| `ChatbotController` | `common/controller` | `/chatbot/ask` 응답, `/chatbot/link-click` 클릭 로깅 |

화이트리스트는 모델 텍스트가 아닌 코드 안의 정규식 배열이다(발췌, 따옴표·이스케이프 생략).

```java
ALLOWED_URL_PATTERNS = List.of(
    compile(^/$),
    compile(^/explore(\?.*)?$),
    compile(^/detail/\d+(\?.*)?$),        // 여행지 상세
    compile(^/community/\d+(\?.*)?$),     // 커뮤니티 상세
    compile(^/mypage(/.*)?(\?.*)?$),
    compile(^/auth/(login|register|find-password)(\?.*)?$)
    // ... explore/courses/packages/wallet/shop/inquiry 등
);
DANGEROUS_SCHEME_PATTERN =
    compile(^\s*(?:javascript|data|file|vbscript):, CASE_INSENSITIVE);
```

정규식은 경로 형태를 좁게 묶는다. 예를 들어 `/detail/\d+` 는 숫자 spotIdx만 받고, 임의 문자열이나 하위 경로 주입을 거부한다. 쿼리스트링은 `(\?.*)?$` 로만 열어둔다.

## 4. 동작 원리 (흐름·표·작은 코드)

`isAllowedInternalUrl` 은 순서가 곧 보안 정책이다. 위험 검사를 먼저, 화이트리스트를 마지막에 둔다.

```java
private boolean isAllowedInternalUrl(String url) {
    if (url == null) return false;
    String trimmed = url.trim();
    if (trimmed.isEmpty()) return false;
    if (DANGEROUS_SCHEME_PATTERN.matcher(trimmed).find()) return false; // 위험 스킴
    if (!trimmed.startsWith(/))   return false;   // 내부 절대경로만
    if (trimmed.startsWith(//))   return false;   // 프로토콜 상대 차단
    if (trimmed.contains(..))     return false;   // 경로 순회 차단
    for (Pattern p : ALLOWED_URL_PATTERNS)
        if (p.matcher(trimmed).matches()) return true;
    return false;                                  // 기본 거부
}
```

검사 단계별 의도는 다음과 같다.

| 단계 | 차단 대상 | 예시 입력 → 결과 |
| --- | --- | --- |
| 위험 스킴 | javascript·data·file·vbscript | javascript:alert(1) → 거부 |
| 절대경로 강제 | 외부 도메인·상대경로 | https://evil.example → 거부 |
| 프로토콜 상대 | 슬래시 두 개로 시작 | //evil.example → 거부 |
| 경로 순회 | 점 두 개 포함 | /mypage/../admin → 거부 |
| 화이트리스트 | 목록에 없는 경로 | /admin/secret → 거부 |
| 통과 | 목록 일치 | /community/42 → 허용 |

응답 조립 루프에서 검증에 더해 **세션 기반 가드**가 한 번 더 작동한다. 비로그인 사용자에게는 마이페이지 링크를 제거한다.

```java
String url = l.get(url).getAsString();
if (!isAllowedInternalUrl(url)) { log.warn(허용되지 않은 URL drop); continue; }
if (!loggedIn && url.startsWith(/mypage)) continue;  // 비로그인 /mypage 제외
links.add(SiteLink.builder().label(...).url(url).icon(...).build());
```

전체 흐름은 두 경로로 갈린다.

| 경로 | 링크 출처 | URL 검증 |
| --- | --- | --- |
| Fast-path (`ChatbotFastPathService`) | 코드 내 하드코딩 신뢰 링크 | 검증 불필요 (LLM 미개입) |
| LLM-path (`ChatbotService` + Gemini) | 모델 생성 `links[]` | `isAllowedInternalUrl` 필수 |

즉 단순 네비 질문은 LLM을 거치지 않고 신뢰된 링크를 즉시 반환해 비용·지연을 줄이고, LLM이 자유 생성한 링크만 화이트리스트를 통과해야 한다.

## 5. 구현 상태 (됨 vs Mock/계획)

:::tip 구현됨
- 정규식 화이트리스트(`ALLOWED_URL_PATTERNS`)와 단일 URL 검증(`isAllowedInternalUrl`)
- 위험 스킴(javascript·data·file·vbscript), 프로토콜 상대(//), 경로 순회(..) 차단
- 절대 내부경로만 허용, 기본 거부 정책
- 비로그인 사용자 마이페이지 링크 제외
- 차단 시 경고 로그 기록, 클릭은 `/chatbot/link-click` 으로 별도 로깅
:::

:::warning 한계·계획
- 화이트리스트는 코드 상수라 새 라우트가 생기면 배열에 수동 추가해야 한다(주석으로 명시). 누락 시 정상 링크가 조용히 drop된다.
- 검증 대상은 챗봇 응답 링크에 한정한다. 다른 모듈(커뮤니티 본문 등)의 사용자 URL은 jsoup XSS 정화 같은 별도 방어를 쓴다.
- URL 디코딩 우회(인코딩된 경로 순회 등)는 현재 단순 문자열 검사 범위 밖이다. 입력이 내부 절대경로로 한정되고 화이트리스트가 좁아 위험은 낮으나, 정량 평가 체계는 부재.
:::

## 6. 면접 답변 3단계

1. **무엇** — 챗봇이 만든 내부 링크를 서버에서 화이트리스트 정규식으로 검증해, 허용 경로만 사용자에게 노출합니다.
2. **왜** — LLM 출력은 신뢰 경계 밖이라 환각 경로나 프롬프트 인젝션으로 위험 링크가 섞일 수 있어, 블랙리스트가 아닌 기본 거부 화이트리스트로 막았습니다.
3. **어떻게** — `isAllowedInternalUrl` 이 위험 스킴·프로토콜 상대·경로 순회를 먼저 차단하고, 절대경로만 받은 뒤 `ALLOWED_URL_PATTERNS` 와 매칭되는 것만 통과시킵니다. 통과 못 하면 로그를 남기고 링크를 버립니다.

## 7. 꼬리질문 + 모범답안

:::details 화이트리스트와 블랙리스트 중 왜 화이트리스트인가
블랙리스트는 알려진 공격만 막아 새 패턴이 나오면 뚫린다. 화이트리스트는 사이트가 실제 가진 경로만 열거하므로 목록에 없는 모든 입력을 기본 거부한다. 네비 챗봇은 갈 수 있는 경로가 유한해 화이트리스트로 완전히 열거 가능하다.
:::

:::details 화이트리스트가 다 잡는데 위험 스킴 검사를 왜 또 두나
방어 심층화다. 화이트리스트 정규식에 실수가 있거나 향후 패턴이 느슨해져도, javascript·data·file·vbscript 사전 차단과 경로 순회·프로토콜 상대 차단이 독립적으로 한 번 더 막는다. 검증 순서를 위험 검사 먼저로 둔 이유이기도 하다.
:::

:::details 검증을 프론트에서 하면 안 되나
안 된다. 프론트는 신뢰 경계 밖이라 우회·변조가 가능하다. Gemini 응답을 파싱하는 서버 단계에서 걸러야 우회를 막는다. 프론트 차단은 UX 보조일 뿐 보안 경계가 아니다.
:::

:::details 비로그인 사용자의 마이페이지 링크는 어떻게 처리하나
URL 검증과 별개로 세션 가드를 둔다. 화이트리스트에는 /mypage가 있지만, 응답 조립 시 비로그인 상태면 /mypage로 시작하는 링크를 건너뛴다. 허용된 경로라도 인증 상태에 따라 노출을 다르게 한 것이다.
:::

:::details 새 페이지를 추가하면 무엇을 해야 하나
`ALLOWED_URL_PATTERNS` 배열에 해당 경로 정규식을 추가해야 한다. 빠뜨리면 챗봇이 정상 경로를 안내해도 검증에서 drop되어 링크가 사라진다. 상수 주석에 신규 라우트 추가 시 배열에 추가하라고 명시해 둔 이유다.
:::

## 8. 직접 말해보기

다음을 소리 내어 설명해 보자.

- 화이트리스트 검증과 위험 스킴 검사의 순서가 왜 중요한지, 순서를 바꾸면 무엇이 달라지는지.
- Fast-path와 LLM-path가 링크를 다루는 방식이 어떻게 다르고, 왜 한쪽만 검증이 필요한지.
- 정규식 `/detail/\d+` 가 막아주는 입력을 두 가지 들고, 같은 의도를 블랙리스트로 막으면 왜 더 약한지.

## 퀴즈

<QuizBox question="챗봇 응답 링크를 블랙리스트가 아니라 정규식 화이트리스트로 검증한 가장 큰 이유는?" :choices="['응답 속도가 빨라져서', '목록에 없는 모든 미지의 경로를 기본 거부할 수 있어서', '프론트엔드 코드가 줄어서', '다국어 번역이 쉬워서']" :answer="1" explanation="화이트리스트는 허용된 경로만 통과시키고 나머지를 전부 기본 거부하므로, 새로운 공격 패턴을 일일이 추적하지 않아도 된다." />

<QuizBox question="isAllowedInternalUrl이 명시적으로 차단하지 않는 것은?" :choices="['javascript 스킴', '슬래시 두 개로 시작하는 프로토콜 상대 URL', '점 두 개가 들어간 경로 순회', '커뮤니티 상세 같은 화이트리스트 일치 경로']" :answer="3" explanation="화이트리스트에 일치하는 정상 내부 경로는 통과 대상이다. 위험 스킴, 프로토콜 상대 URL, 경로 순회는 모두 차단된다." />

<QuizBox question="비로그인 사용자에게 마이페이지 링크가 노출되지 않는 이유는?" :choices="['화이트리스트에 mypage 경로가 아예 없어서', 'URL 검증과 별개로 비로그인이면 mypage로 시작하는 링크를 건너뛰는 세션 가드가 있어서', 'Gemini가 마이페이지를 모른다', '프론트엔드가 숨겨서']" :answer="1" explanation="화이트리스트에는 mypage가 있지만, 응답 조립 시 비로그인 상태이면 mypage로 시작하는 링크를 별도로 제외하는 세션 가드가 동작한다." />
