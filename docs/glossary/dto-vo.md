# DTO / VO

> 계층 사이로 흐르는 데이터를 무엇으로 담느냐 — TripTogether는 `vo` 패키지의 값 객체로 DB·요청·응답을 함께 매핑하고, 외부 AI처럼 모양이 다른 경계에서는 `dto`로 분리합니다.

## 1. 한 줄 정의

**VO(Value Object)** 는 "값을 담는 객체"입니다. TripTogether에서는 DB 테이블 한 행, 폼 요청, 화면 출력에 두루 쓰이는 데이터 그릇이고, 도메인마다 `org.triptogether.<도메인>.vo` 패키지에 모여 있습니다(예: `UsersVO`, `TravelPlanVO`).

**DTO(Data Transfer Object)** 는 "계층·시스템 경계를 넘길 때 모양을 맞춘 전송 객체"입니다. TripTogether에서는 주로 **외부 AI API의 입출력 JSON 구조**를 그대로 받는 그릇으로 씁니다(예: `ai.dto`의 `AiPlanRequestDTO`, `AiPlanResponseDTO`).

:::tip 한 문장 구분
"DB 행이자 화면 데이터면 `VO`, 외부/경계로 넘기려고 모양을 따로 맞춘 그릇이면 `DTO`." TripTogether는 **VO를 기본**으로 쓰고, **모양이 DB와 다른 곳(특히 AI)** 에서만 DTO를 둡니다.
:::

## 2. 왜 이렇게 설계했나

DTO/VO를 구분하는 근본 이유는 **계층마다 데이터의 책임이 다르기** 때문입니다. 컨트롤러는 HTTP 요청/응답 모양을, 매퍼는 DB 컬럼 모양을 원합니다. 이 둘을 하나의 클래스로 강제로 합치면 어느 한쪽이 오염됩니다.

- **MyBatis와의 궁합.** TripTogether는 JPA가 아니라 MyBatis를 씁니다(→ [ORM과 MyBatis](/glossary/mybatis-orm)). MyBatis는 SQL 결과 컬럼을 자바 객체 필드에 매핑(`resultType`)하므로, **테이블을 직접 닮은 평범한 자바 빈(VO)** 이 가장 잘 맞습니다. 그래서 실무 규모 대비 VO가 다수입니다.
- **"DTO를 위한 DTO"의 비용 회피.** 4계층이 짧고(컨트롤러 → 서비스 → 매퍼 → vo), JSP 서버 렌더링이라 응답을 별도 JSON DTO로 변환할 일이 적습니다. 그래서 화면·폼·DB를 한 VO로 공유해 보일러플레이트를 줄였습니다.
- **경계가 다른 곳에서만 DTO.** 외부 AI 응답 JSON은 DB 스키마와 구조가 완전히 다릅니다. 여기서까지 VO를 재사용하면 DB 컬럼과 AI 필드가 한 클래스에 뒤섞입니다. 그래서 AI 입출력은 `ai.dto`로 **명확히 분리**했습니다.

:::warning 트레이드오프 정직하게
VO를 폼·DB·화면에 공유하면 코드는 줄지만, **한 클래스가 여러 책임을 겸합니다.** 예컨대 `UsersVO`에는 `userPassword`(BCrypt 해시) 같은 민감 필드가 있어, JSP/JSON으로 그대로 노출하지 않도록 주의가 필요합니다. "DTO를 안 나눈 비용"을 면접에서 숨기지 말고 "규모와 렌더링 방식에 맞춘 선택"으로 설명하는 편이 낫습니다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

| 구분 | 실제 클래스 | 패키지 | 대응 대상 |
| --- | --- | --- | --- |
| VO (DB 매핑) | `UsersVO` | `auth.vo` | `USERS` 테이블 한 행(일반+소셜 로그인 공용) |
| VO (DB+화면) | `TravelPlanVO` | `courses.vo` | `TRAVEL_PLAN` 행 + `spotList`(연관 `PlanSpotVO`) |
| VO (DB 매핑) | `PlanSpotVO` | `courses.vo` | `PLAN_SPOT` 행(방문 순서 `visit_order`) |
| DTO (AI 요청) | `AiPlanRequestDTO` | `ai.dto` | 사용자가 입력한 AI 일정 생성 조건 |
| DTO (AI 응답) | `AiPlanResponseDTO` | `ai.dto` | GPT-4o-mini Structured Outputs JSON |
| DTO (AI 중첩) | `AiDayDTO`, `AiSpotDTO` | `ai.dto` | 응답 JSON의 `days[]` → `spots[]` |

공통 도구:

- **Lombok.** `@Data`(또는 `@Getter/@Setter`) + `@NoArgsConstructor` + `@AllArgsConstructor`로 게터/세터/생성자를 자동 생성. `UsersVO`는 `@Builder`까지 붙여 빌더 패턴으로도 만듭니다.
- **`@NoArgsConstructor`가 필수인 이유.** MyBatis와 JSON 역직렬화 모두 "기본 생성자로 빈 객체를 만든 뒤 세터/필드로 채우는" 방식이라, 인자 없는 생성자가 없으면 매핑이 깨집니다.
- **네이밍 차이까지 코드에 박혀 있음.** `UsersVO`는 카멜케이스(`userIdx`), `TravelPlanVO`는 스네이크케이스(`plan_id`, `start_date`)를 그대로 필드명으로 씁니다. 이는 MyBatis 매핑 설정/관례 차이로, 한 프로젝트 안에서도 VO마다 규칙이 다를 수 있음을 보여주는 실제 사례입니다.

## 4. 동작 원리 (흐름·표·작은 코드)

### VO: 한 그릇이 DB·서비스·화면을 관통

```text
JSP 폼 / 컨트롤러 파라미터
   → TravelPlanVO (바인딩)
   → service → mapper (INSERT/SELECT, resultType=TravelPlanVO)
   → JSP (EL로 ${plan.title} 출력)
```

`TravelPlanVO`는 한 발 더 나아가 **연관 데이터까지 품습니다.** DB의 일정(plan) 한 행에 더해, 그 일정에 속한 장소 목록을 `List<PlanSpotVO> spotList` 필드로 담아 한 객체로 화면에 넘깁니다.

```java
public class TravelPlanVO {
    private Long plan_id;
    private String title;
    private String plan_source;        // MANUAL(직접작성) / AI(생성)
    private Integer is_public;         // 공개 피드 노출 여부
    private List<PlanSpotVO> spotList; // 1:N 연관 — 장소 목록을 함께 보유
    private String nickname;           // 조인으로 끌어온 작성자 표시용
    // ... Lombok @Getter/@Setter ...
}
```

### DTO: 외부 AI의 모양을 그대로 받기

AI 일정 생성은 GPT-4o-mini의 **Structured Outputs(JSON Schema strict)** 로 정해진 JSON을 받습니다. 그 JSON 구조가 곧 DTO 클래스 트리입니다.

```text
AiPlanResponseDTO { title, summary, days[] }
        └ AiDayDTO { dayNo, date, theme, spots[] }
                 └ AiSpotDTO { name, description, visitOrder }
```

```java
public class AiPlanResponseDTO {
    private String title;
    private String summary;
    private List<AiDayDTO> days;   // JSON 배열 → 중첩 DTO 리스트
}
```

핵심은 **경계에서의 변환**입니다. AI가 돌려준 `AiPlanResponseDTO`(전송용 모양)는 그대로 DB에 들어가지 않습니다. 서비스가 이를 읽어 `TravelPlanVO`/`PlanSpotVO`(DB 모양)로 옮겨 `@Transactional` 안에서 저장합니다(부분 실패 시 전체 롤백 → [트랜잭션](/glossary/transaction)).

| 항목 | VO (`TravelPlanVO`) | DTO (`AiPlanResponseDTO`) |
| --- | --- | --- |
| 주 용도 | DB 행 + 화면/폼 데이터 | 외부 AI JSON 입출력 |
| 필드 모양의 기준 | 테이블 컬럼 | AI API의 JSON Schema |
| 영속성과의 관계 | MyBatis가 직접 매핑 | 직접 매핑 안 함, VO로 변환 후 저장 |
| 들어 있는 도메인 | `courses.vo` | `ai.dto` |

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨** — 거의 모든 도메인이 `vo` 패키지로 DB·요청·응답을 매핑합니다. `UsersVO`(인증), `TravelPlanVO`/`PlanSpotVO`(일정), `AiPlanResponseDTO` 트리(AI 일정) 등 본문에 든 클래스는 모두 실제 코드에 존재합니다.
- **됨** — Lombok 기반 보일러플레이트 자동화, `@Builder`(UsersVO), 1:N 연관을 VO 안 리스트로 담기(`spotList`)도 동작합니다.
- **혼재(의도된 설계)** — DTO를 전 계층에 일관 적용하지 않았습니다. **API 경계가 DB와 다른 곳(주로 AI)** 에서만 DTO를 두고, 나머지는 VO를 화면까지 공유합니다. 이는 누락이 아니라 규모·렌더링 방식에 맞춘 선택입니다.
- **계획/주의** — 응답 전용 DTO 분리, 민감 필드(`userPassword` 등) 노출 방지를 위한 화면 전용 View 모델, 입력 검증 애너테이션(`@NotBlank` 등) 표준화는 아직 광범위하게 적용되어 있지 않습니다. 현재 `AiPlanRequestDTO`도 검증 애너테이션 없이 평범한 필드로만 구성됩니다.

## 6. 면접 답변 3단계

1. **정의** — "VO는 값을 담는 객체로, 저희는 DB 행·폼·화면에 두루 쓰는 데이터 그릇으로 `vo` 패키지에 뒀습니다. DTO는 계층/시스템 경계를 넘길 때 모양을 맞춘 전송 객체로, 저희는 외부 AI JSON 입출력에 한정해 `ai.dto`에 분리했습니다."
2. **근거** — "MyBatis가 SQL 결과를 자바 빈에 매핑하고 JSP로 서버 렌더링하는 구조라, 테이블을 닮은 VO를 화면까지 공유하면 변환 비용이 줄어듭니다. 다만 AI 응답은 JSON 구조가 DB와 완전히 달라, 거기서까지 VO를 쓰면 책임이 섞여서 DTO로 끊었습니다."
3. **결과/한계** — "AI 일정은 `AiPlanResponseDTO` 트리로 받아 `TravelPlanVO`/`PlanSpotVO`로 변환해 트랜잭션으로 저장합니다. 한계는 응답 전용 DTO를 전면 적용하지 않은 점인데, 규모와 렌더링 방식에 맞춘 트레이드오프로 설명할 수 있습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. DTO와 VO의 차이가 뭔가요? 같은 말 아닌가요?
역할이 다릅니다. **VO는 값 자체를 담는 도메인 데이터 그릇**이고, **DTO는 계층/시스템 경계를 넘기기 위한 전송 모양**입니다. TripTogether에서는 VO(`UsersVO`, `TravelPlanVO`)가 DB·화면까지 관통하고, DTO(`AiPlanResponseDTO`)는 외부 AI JSON 경계에서만 등장합니다. 즉 "쓰임의 경계"가 다릅니다. (학문적으로 VO를 '불변·동등성 기반 객체'로 더 엄격히 정의하기도 하지만, 이 프로젝트의 VO는 MyBatis 매핑용 가변 빈이라는 점을 솔직히 덧붙입니다.)
:::

:::details Q2. 왜 DTO를 모든 계층에 일관되게 안 썼나요?
규모와 렌더링 방식 때문입니다. 4계층이 짧고 JSP로 서버 렌더링하므로 응답을 별도 JSON DTO로 변환할 일이 적습니다. VO를 화면까지 공유하면 보일러플레이트가 크게 줄어 그렇게 했고, **DB와 모양이 다른 경계(AI)에서만** DTO로 분리했습니다. 다만 이로 인해 `UsersVO`처럼 민감 필드를 가진 VO를 그대로 노출하지 않도록 주의해야 하는 점은 한계로 인정합니다.
:::

:::details Q3. VO에 비밀번호 같은 민감 정보가 있는데 화면 노출은 어떻게 막나요?
`UsersVO`의 `userPassword`(BCrypt 해시)는 화면/JSON으로 내보내면 안 됩니다. 현재는 JSP에서 해당 필드를 출력하지 않는 관례로 막고 있고, 더 안전한 방향은 **출력 전용 모델(또는 응답 DTO)을 만들어 민감 필드를 애초에 제외**하는 것입니다. 이 부분은 향후 개선 과제로 보고 있습니다.
:::

:::details Q4. AI 응답 DTO를 받아 어떻게 DB에 저장하나요?
변환 단계를 거칩니다. AI가 `AiPlanResponseDTO`(title/summary/days[] → `AiDayDTO` → `AiSpotDTO`) 모양의 JSON을 돌려주면, 서비스가 이를 읽어 `TravelPlanVO`와 `PlanSpotVO`(방문 순서 `visit_order` 포함)로 옮깁니다. 이 저장은 `@Transactional`로 묶여, 일부 장소 저장이 실패하면 일정 전체가 롤백됩니다.
:::

:::details Q5. VO 필드가 어떤 건 카멜케이스, 어떤 건 스네이크케이스인데 왜 그런가요?
실제로 `UsersVO`는 `userIdx`처럼 카멜케이스, `TravelPlanVO`는 `plan_id`·`start_date`처럼 스네이크케이스를 씁니다. 이는 VO와 DB 컬럼을 매핑하는 방식의 차이(카멜↔스네이크 자동 변환에 기대느냐, 컬럼명을 필드명으로 직접 맞추느냐)에서 나옵니다. 한 프로젝트 안에서도 모듈별로 관례가 갈린 부분이라, 일관성 측면에서 개선 여지가 있다고 봅니다.
:::

## 8. 직접 말해보기

아래 질문에 소리 내어 답해보세요. 막히면 위 절로 돌아갑니다.

1. VO와 DTO를 각각 한 문장으로 정의하고, TripTogether에서 대표 클래스를 하나씩 대보세요.
2. "왜 DTO를 전 계층에 안 썼나"를 트레이드오프로 30초 안에 설명해보세요.
3. AI 일정 생성에서 `AiPlanResponseDTO`가 DB까지 가는 경로(변환·트랜잭션)를 그려 말해보세요.
4. `UsersVO`를 그대로 화면에 노출하면 어떤 위험이 있는지, 어떻게 막을지 말해보세요.

:::tip 다음 행선지
- 이 그릇들이 흐르는 골격 → [4계층 구조](/glossary/layered-architecture)
- VO를 DB에 매핑하는 도구 → [ORM과 MyBatis](/glossary/mybatis-orm)
- DTO가 다루는 데이터 포맷 → [JSON](/glossary/json)
- 전체 데이터 모델·테이블 지도 → [전체 흐름의 데이터 모델](/flow/data-model)
- 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)
:::

## 퀴즈

<QuizBox
  question="TripTogether에서 VO와 DTO의 쓰임을 가장 정확히 구분한 것은?"
  :choices="['VO와 DTO는 같은 것이라 아무거나 쓴다', 'VO는 DB 행·폼·화면에 두루 쓰는 값 그릇이고, DTO는 외부 AI JSON 같은 경계 전송용으로 ai.dto에 분리했다', 'VO는 AI 응답 전용, DTO는 DB 전용이다', 'DTO는 JSP 렌더링 전용 객체다']"
  :answer="1"
  explanation="TripTogether는 VO(UsersVO, TravelPlanVO)를 DB·화면까지 공유하는 기본 그릇으로 쓰고, DB와 모양이 다른 경계(특히 외부 AI 입출력)에서만 DTO(AiPlanResponseDTO)를 ai.dto 패키지에 분리합니다."
/>

<QuizBox
  question="AI 일정 생성에서 AiPlanResponseDTO와 TravelPlanVO의 관계로 옳은 것은?"
  :choices="['AiPlanResponseDTO가 MyBatis로 DB에 직접 INSERT된다', 'TravelPlanVO를 AI에 그대로 보내 응답으로 받는다', 'AI가 돌려준 AiPlanResponseDTO를 서비스가 TravelPlanVO/PlanSpotVO로 변환해 @Transactional로 저장한다', '두 클래스는 같은 패키지에 있고 동일하다']"
  :answer="2"
  explanation="AI는 AiPlanResponseDTO(전송 모양) JSON을 돌려주고, 서비스가 이를 읽어 DB 모양인 TravelPlanVO·PlanSpotVO로 옮겨 트랜잭션 안에서 저장합니다. 부분 실패 시 전체 롤백됩니다."
/>

<QuizBox
  question="TripTogether VO 설계의 한계로 면접에서 정직하게 밝힐 만한 항목은?"
  :choices="['VO에 게터가 없어 데이터를 못 읽는다', 'UsersVO가 userPassword 같은 민감 필드를 가져, 응답 전용 모델 없이 그대로 노출하지 않도록 주의가 필요하다', 'MyBatis가 VO를 매핑하지 못한다', 'DTO가 존재하지 않는다']"
  :answer="1"
  explanation="VO를 화면까지 공유하는 설계는 보일러플레이트를 줄이지만, UsersVO처럼 BCrypt 해시 비밀번호 등 민감 필드를 가진 VO를 그대로 노출하지 않도록 주의해야 합니다. 출력 전용 모델 분리가 향후 개선 과제입니다."
/>
