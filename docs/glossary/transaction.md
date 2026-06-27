# 트랜잭션

> 여러 DB 쓰기를 "전부 성공하거나 전부 취소되는" 하나의 단위로 묶는 장치. TripTogether에서는 AI가 만든 여행 일정을 부모(TRAVEL_PLAN) 한 줄과 자식(PLAN_SPOT) 여러 줄로 나눠 저장하는데, 이걸 `@Transactional` 하나로 묶어 중간에 실패하면 부모까지 통째로 롤백한다.

이 페이지는 특정 도메인이 아니라 TripTogether 전체에 깔린 데이터 안전성 규약을 다룬다. 데이터 계층의 형제 개념은 [ORM과 MyBatis](/glossary/mybatis-orm)와 [소프트 삭제](/glossary/soft-delete)다. 도메인 허브는 [도메인 전체 개요](/domains), 담당 태그로 보려면 [담당별 보기](/by-area/), 요청이 계층을 어떻게 통과하는지는 [전체 흐름](/flow/)을 참고한다.

## 1. 한 줄 정의

트랜잭션(transaction)은 **"여러 개의 DB 작업을 논리적으로 하나로 묶어, 모두 반영(commit)되거나 모두 취소(rollback)되도록 보장하는 작업 단위"** 다. 절반만 저장된 어중간한 상태를 원천적으로 막는 것이 목적이다. 그 보장의 성질을 네 글자로 줄인 것이 **ACID**다.

| 글자 | 이름 | 한 줄 의미 |
| --- | --- | --- |
| A | Atomicity(원자성) | 전부 성공 아니면 전부 실패. 중간 상태가 없다 |
| C | Consistency(일관성) | 제약(FK·UNIQUE·NOT NULL)을 깨는 상태로는 커밋되지 않는다 |
| I | Isolation(격리성) | 동시에 도는 다른 트랜잭션의 미완료 변경이 섞이지 않는다 |
| D | Durability(지속성) | 커밋된 결과는 장애가 나도 살아남는다 |

## 2. 왜 이렇게 설계했나

TripTogether의 여러 기능은 **한 번의 사용자 동작이 둘 이상의 테이블 쓰기**로 번진다. 대표가 AI 일정 생성이다. 한 번 "생성"을 누르면:

1. `TRAVEL_PLAN`에 일정 헤더 1행 (제목·여행지·기간)
2. `PLAN_SPOT`에 날짜별 장소 N행 (방문 순서 포함)

이 두 단계가 따로 놀면 위험하다.

- **부분 저장 방지:** 헤더만 저장되고 장소 저장이 중간에 깨지면, 사용자에게는 "제목만 있고 일정이 텅 빈" 망가진 코스가 남는다. 원자성으로 이걸 막는다.
- **제약 위반의 안전한 취소:** `PLAN_SPOT`에는 `uq_plan_spot_order (plan_id, visit_date, visit_order)` UNIQUE 제약이 있다. AI가 같은 날 같은 순서를 두 번 만들어내면 두 번째 INSERT가 터지는데, 이때 **이미 들어간 헤더와 앞선 장소들까지 함께 되돌아가야** 일관성이 유지된다.
- **외부 호출과 DB의 경계:** AI 호출(OpenAI)은 트랜잭션 바깥의 네트워크 작업이다. DB 쓰기만 묶고, 느리고 불확실한 외부 호출은 그 앞에 두는 경계 설계가 중요하다(아래 4.3).

:::tip MyBatis인데 트랜잭션이 되나
된다. 트랜잭션은 ORM 기능이 아니라 **Spring의 `@Transactional`(AOP 프록시) + DataSource**가 담당한다. JPA를 안 쓰고 [MyBatis](/glossary/mybatis-orm)만 써도, 같은 메서드 안의 여러 매퍼 호출이 하나의 커넥션·하나의 트랜잭션으로 묶인다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

스택은 Spring Boot 4.0.6 / Java 21 / MyBatis 4.0.1 / MySQL(InnoDB). 핵심 트랜잭션은 `org.springframework.transaction.annotation.Transactional` 애너테이션으로 선언한다.

| 요소 | 실제 위치 | 역할 |
| --- | --- | --- |
| 트랜잭션 경계 | `AiPlanServiceImpl.generateAndSavePlan()` (`@Transactional`) | AI 호출 + 두 테이블 저장을 한 단위로 |
| 외부 AI 호출 | `AiPlanGPTServiceImpl.generatePlan()` | OpenAI GPT-4o-mini, Structured Outputs → `AiPlanResponseDTO` |
| 부모 저장 | `TravelPlanServiceImpl.insertTravelPlan()` → `TRAVEL_PLAN` | 헤더 1행, `plan_id` 채번 |
| 자식 저장 | `savePlanSpots()` → 반복 `insertPlanSpot()` → `PLAN_SPOT` | 날짜·순서별 장소 N행 |
| 엔진 | MySQL InnoDB | 트랜잭션·FK·UNIQUE 제약을 실제로 강제 |

- `@Transactional`은 Spring이 만든 **프록시**가 메서드 진입 시 트랜잭션을 열고, 정상 종료 시 commit, 예외가 메서드 밖으로 튀어나가면 rollback 한다.
- `PLAN_SPOT`은 `TRAVEL_PLAN`을 FK(`fk_plan_spot_plan ... ON DELETE CASCADE`)로 참조한다. 즉 두 테이블은 부모-자식으로 강하게 묶여 있어, 트랜잭션으로 한꺼번에 다루는 것이 자연스럽다.
- 테이블 엔진이 **InnoDB**여야 한다는 점이 전제다. MyISAM이면 트랜잭션 자체가 무시되므로, "트랜잭션이 된다"는 말에는 엔진 선택이 깔려 있다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 성공 경로 — 한 번에 commit

```java
@Service
@RequiredArgsConstructor
public class AiPlanServiceImpl implements AiPlanService {

    @Override
    @Transactional                                   // ① 프록시가 트랜잭션 시작
    public Long generateAndSavePlan(AiPlanRequestDTO req, Long userIdx) {
        validateRequest(req);                         // 입력 검증

        AiPlanResponseDTO ai = aiPlanGPTService.generatePlan(req);  // ② 외부 AI 호출

        TravelPlanVO plan = /* req+ai로 헤더 구성 */ ...;
        travelPlanService.insertTravelPlan(plan);     // ③ TRAVEL_PLAN INSERT
        Long planId = plan.getPlan_id();              //    채번된 plan_id

        savePlanSpots(planId, ai);                    // ④ PLAN_SPOT 반복 INSERT
        return planId;                                // ⑤ 정상 반환 → commit
    }
}
```

`return`까지 예외 없이 도달하면, 그제서야 ③·④의 모든 INSERT가 한꺼번에 확정된다. 그전까지는 DB에 "임시로" 반영돼 있을 뿐 다른 트랜잭션에는 보이지 않는다.

### 4.2 실패 경로 — 한 장소 저장이 깨지면 일정 전체가 사라진다 (핵심 예)

`savePlanSpots`는 날짜별로 장소를 INSERT 하는 이중 루프다.

```java
private void savePlanSpots(Long planId, AiPlanResponseDTO res) {
    for (AiDayDTO day : res.getDays()) {
        for (AiSpotDTO spot : day.getSpots()) {
            PlanSpotVO ps = new PlanSpotVO();
            ps.setPlan_id(planId);
            ps.setVisit_date(...);
            ps.setVisit_order(spot.getVisitOrder());  // ← 같은 날 같은 순서가 또 나오면?
            travelPlanService.insertPlanSpot(ps);      // UNIQUE 위반 → 예외 발생
        }
    }
}
```

상황을 단계로 따라가 보자. AI가 1일차 3개, 2일차 3개를 만들었는데 2일차 두 번째와 세 번째가 같은 `visit_order`라고 하자.

| 단계 | 일어나는 일 | DB 임시 상태 |
| --- | --- | --- |
| 헤더 INSERT | `TRAVEL_PLAN` 1행 | 미확정 1행 |
| 1일차 장소 3건 | `PLAN_SPOT` 3행 | 미확정 4행 |
| 2일차 장소 1·2건 | `PLAN_SPOT` 2행 | 미확정 6행 |
| 2일차 3건째 INSERT | `uq_plan_spot_order` UNIQUE 위반 → 예외 | — |
| 예외가 메서드 밖으로 | 프록시가 **rollback** | **전부 취소(0행)** |

결과적으로 헤더 1행과 앞서 들어간 장소 5행까지 **모두 사라진다**. "제목만 있고 일정이 빈" 좀비 데이터가 남지 않는다 — 이것이 원자성의 실전 가치다.

### 4.3 외부 AI 호출과 롤백의 관계

`generatePlan`은 OpenAI를 부르고, 실패하면 `AiPlanGPTServiceImpl` 안에서 `RuntimeException`("OpenAI 일정 생성 실패")으로 바꿔 던진다. 이 예외는 **DB INSERT가 시작되기 전(②단계)** 에 터지므로 되돌릴 DB 변경이 아직 없다. 즉:

- **AI 호출이 실패하면** → DB 손도 안 댄 채 트랜잭션이 깔끔히 취소된다.
- **AI는 성공했는데 저장이 실패하면** → 4.2처럼 이미 들어간 행까지 전부 롤백.

핵심 원칙: **느리고 불확실한 외부 호출은 트랜잭션 안에서 최대한 짧게**. 여기서는 AI 응답을 다 받은 뒤 DB 쓰기를 몰아서 하므로, DB 커넥션을 OpenAI 응답 시간만큼 붙잡고 있는 약점은 있다(아래 5의 한계).

### 4.4 Spring 롤백 규칙 — 무엇이 롤백을 트리거하나

```text
@Transactional 기본 규칙:
  - RuntimeException / Error (unchecked)  → 롤백 O
  - checked Exception                     → 롤백 X (커밋!)  ← 함정
```

TripTogether의 이 경로는 운 좋게도 던지는 예외가 전부 unchecked다.

- 입력 검증 실패 → `IllegalArgumentException`(RuntimeException 계열) → 롤백
- AI 실패 → `RuntimeException` → 롤백
- UNIQUE 위반 → MyBatis가 `DataAccessException`(unchecked)로 감싸 던짐 → 롤백

만약 checked 예외를 던졌다면 기본값에서는 **커밋돼버려** 부분 저장이 남는다. 그럴 땐 `@Transactional(rollbackFor = Exception.class)`를 명시해야 한다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| AI 일정 생성 `@Transactional`(헤더+장소 원자 저장) | 구현됨 |
| InnoDB FK(`ON DELETE CASCADE`)·UNIQUE 제약으로 일관성 강제 | 구현됨 |
| unchecked 예외 → 자동 롤백 (검증/AI/UNIQUE 위반) | 구현됨 |
| OpenAI 호출(GPT-4o-mini, Structured Outputs) | 구현됨 — 자세히는 [AI 일정 생성](/courses/ai-plan-gpt) |
| 외부 AI 호출을 트랜잭션 **밖으로** 분리(커넥션 점유 최소화) | 미적용 — 현재는 같은 메서드 안 |
| 명시적 격리 수준·전파(propagation) 튜닝 | 미적용 — 기본값 사용 |
| 분산 트랜잭션 / 보상 트랜잭션(Saga) | 없음 — 단일 DB 단일 트랜잭션 범위 |

:::warning 정직하게 짚을 점
"트랜잭션 잘 걸었습니다"로 끝내면 약하다. 이 구조는 **AI 호출이 트랜잭션 경계 안**에 있어, OpenAI 응답이 느리면 그만큼 DB 커넥션을 붙잡는다. 면접에서 한계를 먼저 말하고 "AI 호출은 트랜잭션 밖에서 끝내고, 검증된 결과만 짧은 트랜잭션으로 저장하는 쪽으로 분리하는 게 다음 개선"이라고 덧붙이면 설계 감각이 드러난다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** "트랜잭션은 여러 DB 쓰기를 전부 성공 아니면 전부 취소되는 한 단위로 묶는 것이고, 저희는 AI 일정 저장을 `@Transactional`로 묶어 부분 저장을 막았습니다."
2. **근거 한 스푼:** "AI 일정은 `TRAVEL_PLAN` 헤더 1행과 `PLAN_SPOT` 장소 N행으로 나뉘는데, 중간에 UNIQUE 제약 위반 같은 예외가 나면 이미 넣은 헤더와 앞 장소들까지 자동 롤백됩니다. Spring 기본 규칙상 unchecked 예외면 롤백되도록 돼 있고요."
3. **한계 인정:** "다만 외부 AI 호출이 트랜잭션 경계 안에 있어 커넥션 점유가 길어질 수 있어서, AI 호출을 밖으로 빼는 분리가 다음 개선 과제입니다."

## 7. 꼬리질문 + 모범답안

:::details ACID에서 가장 중요하게 본 속성은 무엇이고, 코드 어디서 보장되나?
원자성(Atomicity)이다. AI 일정 저장은 헤더와 장소가 한 묶음이라, 둘 중 하나라도 실패하면 전부 무효가 돼야 한다. `AiPlanServiceImpl.generateAndSavePlan`의 `@Transactional`이 이 경계를 만들고, 예외 시 Spring 프록시가 commit 대신 rollback 한다. 일관성(Consistency)은 InnoDB의 FK·`uq_plan_spot_order` UNIQUE 제약이 받쳐 준다.
:::

:::details checked 예외를 던졌는데 데이터가 커밋돼버렸다. 왜인가?
Spring `@Transactional`의 기본 롤백 규칙은 **unchecked(RuntimeException/Error)만 롤백**이고, checked 예외는 정상 흐름으로 보고 커밋한다. 이게 흔한 함정이다. checked 예외에서도 롤백하려면 `@Transactional(rollbackFor = Exception.class)`를 명시해야 한다. TripTogether의 이 경로는 검증 실패가 `IllegalArgumentException`, AI 실패가 `RuntimeException`, DB 제약 위반이 `DataAccessException`으로 전부 unchecked라 기본값으로도 안전하게 롤백된다.
:::

:::details 같은 클래스 안의 다른 메서드를 호출하면 트랜잭션이 안 걸린다던데?
맞다. `@Transactional`은 프록시 기반이라, 같은 빈 내부에서 `this.다른메서드()`로 직접 호출하면 프록시를 거치지 않아 트랜잭션 애너테이션이 무시된다(self-invocation 문제). 그래서 트랜잭션 경계는 외부에서 진입하는 메서드(`generateAndSavePlan`)에 두고, 그 안에서 협력 빈(`travelPlanService`)을 호출하는 구조가 안전하다.
:::

:::details AI 호출이 트랜잭션 안에 있으면 뭐가 문제인가?
OpenAI 응답이 수 초 걸릴 수 있는데, 그동안 DB 커넥션과 트랜잭션이 열린 채 유지된다. 동시 사용자가 많으면 커넥션 풀이 고갈되고 락 유지 시간도 길어진다. 개선책은 AI 호출(읽기 전용·외부 I/O)을 트랜잭션 밖에서 먼저 끝내고, 검증을 통과한 결과 객체만 받아 짧은 쓰기 트랜잭션으로 저장하는 것이다.
:::

:::details 소프트 삭제와 트랜잭션은 어떤 관계인가?
직교하지만 자주 함께 쓴다. [소프트 삭제](/glossary/soft-delete)는 행을 지우는 대신 상태 컬럼(`is_deleted` 등)을 바꾸는 UPDATE인데, 그 UPDATE가 다른 연관 테이블 변경과 함께 일어나면 역시 한 트랜잭션으로 묶어 일관성을 지킨다. 즉 "삭제 방식"과 "원자성 보장"은 별개의 결정이다.
:::

## 8. 직접 말해보기

- AI 일정 저장에서 "헤더만 저장되고 장소가 빈" 좀비 데이터가 왜 생기지 않는지, `@Transactional`과 UNIQUE 제약을 엮어 30초 안에 설명해 보자.
- Spring의 기본 롤백 규칙(unchecked만 롤백)을 말하고, checked 예외에서 부분 저장이 남는 함정을 어떻게 피하는지 풀어 보자.
- 외부 AI 호출이 트랜잭션 경계 안에 있을 때의 약점과, 그걸 밖으로 빼는 개선안을 한 문장씩으로 정리해 보자.

## 퀴즈

<QuizBox
  question="AI 일정 저장 중 PLAN_SPOT의 uq_plan_spot_order UNIQUE 제약을 위반하는 장소가 한 건 발생했다. @Transactional 하에서 최종 DB 상태는?"
  :choices="['그 장소 한 건만 빠지고 나머지는 저장된다', '헤더와 앞서 저장된 장소까지 전부 롤백돼 아무것도 남지 않는다', '헤더는 저장되고 장소만 전부 빠진다', '에러를 무시하고 모두 저장된다']"
  :answer="1"
  explanation="원자성에 따라 메서드 밖으로 예외가 튀면 트랜잭션 전체가 롤백된다. 이미 INSERT된 TRAVEL_PLAN 헤더와 앞 장소들까지 함께 취소돼 0행이 된다."
/>

<QuizBox
  question="Spring @Transactional의 '기본' 롤백 규칙으로 옳은 것은?"
  :choices="['모든 예외에서 롤백한다', 'checked 예외에서만 롤백한다', 'unchecked(RuntimeException/Error)에서만 롤백하고 checked 예외는 커밋된다', '예외 종류와 무관하게 항상 커밋한다']"
  :answer="2"
  explanation="기본값은 unchecked 예외만 롤백, checked 예외는 정상 흐름으로 보고 커밋한다. checked에서도 롤백하려면 rollbackFor = Exception.class를 명시해야 한다."
/>

<QuizBox
  question="이 구조에서 OpenAI 호출(generatePlan)을 트랜잭션 경계 안에 두는 것의 단점을 한 문장으로 설명해 보라."
  explanation="AI 응답이 느리면 그 시간만큼 DB 커넥션과 트랜잭션이 열린 채 유지돼 커넥션 풀 고갈·락 유지 시간 증가로 이어진다. 그래서 외부 I/O는 트랜잭션 밖에서 끝내고 짧은 쓰기 트랜잭션으로 저장하는 것이 바람직하다."
/>
