# 4계층 (controller · service · mapper · vo)

> 요청 하나가 `controller → service → mapper → vo` 네 칸을 순서대로 지나도록 강제해, "어디에 무슨 코드를 쓸지"를 위치만 보면 알 수 있게 만든 분리 규칙.

## 1. 한 줄 정의

TripTogether의 모든 백엔드 도메인은 **계층(layer)** 으로 나뉜다. HTTP를 받는 **controller**, 비즈니스 규칙을 담는 **service**(인터페이스 + `ServiceImpl`), SQL에 연결하는 **mapper**(`@Mapper` + XML), 데이터를 담아 나르는 **vo**. 각 계층은 자기 바로 아래 계층만 호출하고, 위로는 올라가지 않는다.

이 프로젝트는 약 14~15개 도메인 모듈(`auth`, `community`, `courses`, `explore`, `inquiry`, `admin` 등)이 전부 이 동일한 4칸 구조를 따른다. 4명이 도메인을 나눠 개발해도 폴더만 열면 어디에 무엇이 있는지 즉시 파악되는 이유다.

## 2. 왜 이렇게 설계했나

한 클래스에 HTTP 파싱·검증·트랜잭션·SQL·뷰 선택을 다 넣으면 짧은 동안은 빠르지만, 곧 수정 한 곳이 엉뚱한 곳을 깨뜨린다. 계층 분리는 그 **관심사(concern)** 를 칸으로 가른다.

- **변경 격리**: DB 컬럼명을 바꿔도 mapper와 vo만 손대면 된다. controller는 모른다.
- **테스트 용이**: service가 인터페이스라, 테스트에서 mapper를 가짜(mock)로 갈아끼우고 규칙만 검증할 수 있다.
- **공동 작업**: 도메인 owner가 자기 `service`/`mapper`를 고쳐도 controller 시그니처만 지키면 다른 화면이 안 깨진다.
- **일관성**: 모든 모듈이 같은 모양이라, 처음 보는 도메인도 "controller부터 읽으면 된다"가 통한다.

:::tip 핵심 원칙: 의존 방향은 한쪽으로만
controller는 service를, service는 mapper를 안다. 거꾸로 mapper가 controller를 알면 절대 안 된다. 의존이 단방향이라 위쪽을 바꿔도 아래쪽은 영향이 없다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

`courses`(여행 코스) 모듈의 실제 한 줄기를 예로 든다. 같은 패턴이 전 도메인에 반복된다.

| 계층 | 실제 파일 | 역할 | 핵심 애너테이션 |
| --- | --- | --- | --- |
| controller | `TravelPlanController` | URL 매핑·세션 검사·뷰 이름 반환 | `@Controller`, `@RequestMapping("/courses")` |
| service (인터페이스) | `TravelPlanService` | 도메인이 할 수 있는 일의 계약 | — |
| service (구현) | `TravelPlanServiceImpl` | 검증·여러 mapper 호출 조합·트랜잭션 | `@Service` |
| mapper (인터페이스) | `TravelPlanMapper` | 메서드 ↔ SQL id 연결 | `@Mapper` |
| mapper (XML) | `resources/mapper/TravelPlanMapper.xml` | 실제 SQL과 `namespace` 바인딩 | — |
| vo | `TravelPlanVO`, `PlanSpotVO`, `SpotTravelVO` | 한 행/한 묶음의 데이터 운반 | Lombok `@Getter/@Setter` |

연결 테이블은 `TRAVEL_PLAN`(소프트삭제 `is_deleted`)와 `plan_spot`(방문 순서 `visit_order`). XML의 `namespace`가 mapper 인터페이스의 FQN(`org.triptogether.courses.mapper.TravelPlanMapper`)과 정확히 같고, 메서드명이 SQL의 `id`와 같아야 MyBatis가 둘을 잇는다.

:::warning DTO와 VO 구분
이 프로젝트는 DB 행을 그대로 옮길 땐 `vo`(예: `TravelPlanVO`)를, AI 응답 같은 API 전용 구조엔 `dto`(예: `AiPlanResponseDTO`)를 쓴다. CareerTuner 등 다른 팀 코드의 명명과 혼동하지 말 것 — TripTogether의 영속 객체는 **VO**다.
:::

## 4. 동작 원리 (흐름·표·작은 코드)

"내 여행 코스 목록" 요청 `GET /courses/my`가 흐르는 경로다.

```text
브라우저 GET /courses/my
   │
controller  TravelPlanController.myList()
   │  세션에서 loginUser 꺼내 user_idx 확인 → 파라미터 VO 채움
   ▼
service     TravelPlanService.getTravelList(vo)   // 인터페이스
   │  TravelPlanServiceImpl 가 규칙 적용 후 mapper 호출
   ▼
mapper      TravelPlanMapper.getTravelList(vo)    // @Mapper 인터페이스
   │  XML의 <select id="getTravelList"> SQL 실행 (is_deleted = 0)
   ▼
DB          TRAVEL_PLAN 행들
   │  결과를 List<TravelPlanVO> 로 자동 매핑
   ▼
controller  model 에 담고 "courses/my" JSP 반환
```

**controller — 받고, 위임하고, 뷰만 고른다.** SQL이나 비즈니스 분기를 넣지 않는다.

```java
@GetMapping("/my")
public String myList(HttpSession session, Model model, RedirectAttributes ra) {
    Long userIdx = getLoginUserIdx(session);          // 세션 인증
    if (userIdx == null) return "redirect:/auth/login";

    TravelPlanVO vo = new TravelPlanVO();
    vo.setUser_idx(userIdx);
    List<TravelPlanVO> list = travelPlanService.getTravelList(vo);  // 위임
    model.addAttribute("travelPlanList", list);
    return "courses/my";                              // 뷰 이름만 반환
}
```

**serviceImpl — 규칙과 조합.** 단순 조회는 그대로 mapper에 넘기지만, 쓰기 작업은 여러 mapper 호출을 한 덩어리로 묶는다. 예를 들어 코스 저장은 `insertTravelPlan` 뒤에 스팟마다 `visit_order`를 1부터 매겨 `insertPlanSpot`을 반복한다 — 이 "한 코스 + 여러 스팟" 규칙이 service의 책임이다.

**mapper(인터페이스 + XML) — 메서드를 SQL로.** 자바 메서드 시그니처와 XML SQL이 짝을 이룬다.

```java
@Mapper
public interface TravelPlanMapper {
    List<TravelPlanVO> getTravelList(TravelPlanVO vo);   // 이름이 곧 SQL id
}
```

```xml
<mapper namespace="org.triptogether.courses.mapper.TravelPlanMapper">
  <select id="getTravelList" resultType="...TravelPlanVO">
    SELECT * FROM TRAVEL_PLAN
    WHERE user_idx = #{user_idx} AND is_deleted = 0
    ORDER BY created_at DESC
  </select>
</mapper>
```

**vo — 데이터 운반체.** `TravelPlanVO`는 Lombok으로 getter/setter만 가진 단순 객체다. controller가 폼 값을 담아 내려보내고, mapper가 SELECT 결과를 채워 올려보낼 때 양방향으로 쓰인다.

| 흔히 헷갈리는 질문 | 어느 계층 책임? |
| --- | --- |
| 로그인 안 했으면 로그인 페이지로 | controller (요청 컨텍스트) |
| "코스 1개당 스팟 N개" 묶어 저장 | service (도메인 규칙) |
| `is_deleted = 0`만 조회 | mapper/XML (SQL) |
| 화면에 뿌릴 닉네임 필드 | vo (데이터 모양) |

## 5. 구현 상태 (됨 vs Mock/계획)

- **됨**: 4계층 구조 자체는 전 도메인에 일관 적용되어 안정적으로 동작한다. `courses`, `community`, `auth`, `inquiry`, `explore`, `admin` 모두 동일 패턴.
- **됨**: 쓰기 묶음의 원자성이 필요한 곳은 service에 `@Transactional`을 건다. 예: `AiPlanServiceImpl`은 AI 일정(코스 1 + 일자 + 스팟들) 전체를 한 트랜잭션으로 저장해, 중간 실패 시 롤백한다.
- **부분/관례**: 모든 메서드에 트랜잭션이 걸린 것은 아니다. 단건 조회·단건 쓰기는 트랜잭션 애너테이션 없이 동작한다. 묶음 쓰기에서만 명시적으로 사용한다.
- **관례 차이**: JSP를 쓰는 화면 컨트롤러는 **뷰 이름(String)** 을 반환하지만, REST 성격의 컨트롤러(예: 챗봇·AI 일정 API)는 공통 응답 래퍼로 JSON을 돌려준다. 같은 controller 계층이라도 표현 방식이 둘로 갈린다.
- **계획/한계**: 일부 `ServiceImpl`에는 디버깅용 `System.out.println`과 `e.printStackTrace()`가 남아 있다. 구조적 결함은 아니지만, 정식 로깅으로 통일하는 것이 향후 정리 과제다.

## 6. 면접 답변 3단계

1. **한 문장**: "모든 백엔드 도메인을 controller·service·mapper·vo 4계층으로 나눠, HTTP 처리·비즈니스 규칙·SQL·데이터 운반의 관심사를 분리했습니다."
2. **왜 + 어떻게**: "service를 인터페이스와 `ServiceImpl`로 나눠 구현을 갈아끼울 수 있게 했고, MyBatis `@Mapper` 인터페이스와 XML의 `namespace`를 묶어 SQL을 격리했습니다. controller는 SQL을 전혀 모르고 뷰 이름만 반환합니다."
3. **효과**: "4명이 도메인을 나눠 개발해도 폴더 구조가 동일해 처음 보는 모듈도 controller부터 따라 읽으면 됐고, 컬럼 변경이 mapper/vo에 격리돼 화면이 안 깨졌습니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 service를 인터페이스와 구현으로 나눴나요? 그냥 클래스 하나면 안 되나요?
계약(인터페이스)과 구현을 분리하면 controller가 구현 세부에 의존하지 않습니다. 테스트에서 구현을 mock으로 대체할 수 있고, 나중에 구현을 통째로 교체해도 controller 코드는 그대로입니다. TripTogether에선 `TravelPlanService`(계약)와 `TravelPlanServiceImpl`(`@Service`)로 나눠 이 유연성을 확보했습니다. 단순 위임만 하는 메서드라도 일관성을 위해 같은 규칙을 따릅니다.
:::

:::details Q2. 비즈니스 로직은 controller에 둬도 동작하는데, 왜 굳이 service로 내리나요?
controller에 두면 (1) 같은 규칙을 다른 진입점에서 재사용 못 하고, (2) HTTP 없이 단위 테스트하기 어렵고, (3) 트랜잭션 경계를 잡기 모호해집니다. 예로 "코스 저장 시 스팟마다 `visit_order`를 매겨 함께 저장"하는 규칙은 `TravelPlanServiceImpl`에 있어, 일반 작성과 AI 일정 저장이 같은 규칙을 공유합니다.
:::

:::details Q3. mapper 인터페이스와 XML은 어떻게 연결되나요?
XML의 `namespace`를 mapper 인터페이스의 전체 경로(FQN)와 똑같이 두고, XML SQL의 `id`를 인터페이스 메서드명과 일치시키면 MyBatis가 런타임에 둘을 묶어 프록시 구현을 만들어 줍니다. 예: `namespace="org.triptogether.courses.mapper.TravelPlanMapper"` + `<select id="getTravelList">` ↔ `getTravelList()` 메서드. 이름이 어긋나면 바로 바인딩 예외가 납니다.
:::

:::details Q4. 트랜잭션은 어느 계층에 거나요?
service 계층입니다. 여러 mapper 호출(코스 1건 + 스팟 N건)을 하나의 원자 단위로 묶어야 하므로, 그 호출들을 조합하는 service 메서드에 `@Transactional`을 붙입니다. `AiPlanServiceImpl`이 그 예로, AI 일정 저장 전체를 한 트랜잭션으로 처리해 중간 실패 시 롤백합니다. controller나 mapper에는 걸지 않습니다.
:::

:::details Q5. vo와 dto는 어떻게 구분해 쓰나요?
DB 테이블 한 행에 대응하는 영속 데이터는 `vo`(예: `TravelPlanVO`)에 둡니다. 반면 외부 표현 전용 구조 — 예를 들어 AI 모델이 돌려준 구조화 응답을 담는 `AiPlanResponseDTO` — 는 `dto`에 둡니다. DB 모양과 API 모양이 달라질 때 서로를 오염시키지 않으려는 분리입니다.
:::

## 8. 직접 말해보기

다음을 막힘 없이 설명할 수 있으면 이 주제는 합격이다.

1. 4계층 각각의 이름과 한 줄 책임을, 의존 방향까지 말한다.
2. `GET /courses/my` 한 요청이 controller→service→mapper→DB→vo→뷰로 흐르는 경로를 실제 클래스명으로 설명한다.
3. "이 로직은 어느 계층에 둬야 하나?"라는 질문 세 개(인증, 묶음 저장, `is_deleted` 필터)에 즉답한다.
4. mapper 인터페이스와 XML이 `namespace`/`id`로 연결되는 규칙을 설명한다.
5. 트랜잭션을 service에 거는 이유를 `AiPlanServiceImpl` 예로 든다.

---

더 보기: [백엔드 개요](/backend/) · [MyBatis](/backend/mybatis) · [ORM과 MyBatis](/glossary/mybatis-orm) · [트랜잭션](/glossary/transaction) · [DTO / VO](/glossary/dto-vo) · [전체 아키텍처](/flow/architecture) · 허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 퀴즈

<QuizBox
  question="TravelPlanController.myList() 안에 직접 SELECT SQL을 작성한다면 어떤 설계 원칙을 어기는가?"
  :choices="['관심사 분리 — SQL은 mapper/XML 계층의 책임이다', '의존성 역전 — controller가 vo를 모르게 해야 한다', '단일 책임 — controller는 트랜잭션만 담당한다', '문제없다, controller에 SQL을 두는 것이 표준이다']"
  :answer="0"
  explanation="controller는 요청 처리와 뷰 반환만 맡고, SQL은 mapper 인터페이스와 XML이 담당한다. controller에 SQL을 직접 넣으면 관심사 분리가 깨지고 DB 변경이 화면 코드를 오염시킨다."
/>

<QuizBox
  question="MyBatis에서 mapper 인터페이스 메서드와 XML SQL을 연결하는 두 가지 일치 조건은?"
  :choices="['XML namespace = 인터페이스 FQN, SQL id = 메서드명', '파일 이름과 패키지 이름', 'vo 클래스명과 테이블명', '@Service 이름과 @Controller 이름']"
  :answer="0"
  explanation="XML의 namespace를 mapper 인터페이스의 전체 경로(FQN)와 같게 두고, SQL의 id를 메서드명과 같게 두면 MyBatis가 둘을 바인딩한다. 예: namespace=...TravelPlanMapper + id=getTravelList ↔ getTravelList()."
/>

<QuizBox
  question="AI 일정 저장처럼 '코스 1건 + 스팟 여러 건'을 한 번에 저장할 때 @Transactional을 어느 계층에 거는 것이 적절한가?"
  :choices="['controller', 'service(ServiceImpl)', 'mapper 인터페이스', 'vo']"
  :answer="1"
  explanation="여러 mapper 호출을 하나의 원자 단위로 묶는 책임은 service에 있다. TripTogether는 AiPlanServiceImpl의 저장 메서드에 @Transactional을 걸어 중간 실패 시 전체를 롤백한다."
/>
