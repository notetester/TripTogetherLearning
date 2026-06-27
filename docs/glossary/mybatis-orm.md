# ORM과 MyBatis

> 객체(자바 VO)와 관계형 테이블(MySQL 행)의 간극을 메우는 두 갈래 길 — 프레임워크가 SQL을 자동 생성하는 ORM과, 개발자가 SQL을 직접 쓰되 매핑만 위임하는 SQL 매퍼. TripTogether는 후자, **MyBatis**(`@Mapper` 인터페이스 + XML)를 영속성 전 계층에서 일관되게 쓴다.

이 페이지는 특정 도메인이 아니라 TripTogether 전체의 데이터 접근 계층을 다룬다. 자원이 계층을 어떻게 통과하는지는 [4계층 구조](/glossary/layered-architecture), 더 깊은 백엔드 설정은 [백엔드 MyBatis](/backend/mybatis), 스키마는 [MySQL 스키마](/backend/mysql-schema)를 참고한다. 허브: [도메인 전체 개요](/domains), [담당별 보기](/by-area/), [전체 흐름](/flow/).

## 1. 한 줄 정의

ORM(Object-Relational Mapping)은 **객체와 관계형 테이블의 불일치(impedance mismatch)를 자동으로 변환**해 주는 기술 범주다. MyBatis는 그 중에서도 **"SQL은 사람이 쓰고, 결과 행과 객체 사이의 매핑만 프레임워크가 한다"**는 SQL 매퍼(half-ORM, persistence framework) 방식이다. JPA/Hibernate처럼 SQL을 자동 생성하지는 않는다.

## 2. 왜 이렇게 설계했나

자바는 객체(`TravelPlanVO`)로 생각하고, MySQL은 행과 컬럼으로 저장한다. 이 둘을 손으로 잇는 JDBC는 `ResultSet.getString()`을 일일이 호출하고 `try-finally`로 커넥션을 닫는 보일러플레이트 지옥이다. ORM/SQL 매퍼는 그 반복을 걷어낸다.

TripTogether가 JPA가 아니라 **MyBatis를 택한 이유**는 분명하다.

- **SQL 가시성·통제권:** 추천·랭킹·집계처럼 튜닝이 필요한 쿼리(예: 태그 공출현 `co_count`, 좋아요 캐시 정합성)는 SQL을 직접 보고 손봐야 한다. JPA의 JPQL/자동 생성 SQL은 이런 복잡 쿼리에서 의도와 멀어지기 쉽다.
- **학습 곡선·팀 합의:** 14~15개 모듈을 4인이 나눠 만드는 구조에서, "쿼리 = XML 한 곳"이라는 단순한 멘탈 모델이 협업 비용을 낮춘다. 엔티티 그래프·영속성 컨텍스트·지연 로딩 같은 JPA 개념을 모두가 균일하게 다룰 필요가 없다.
- **레거시 친화 스키마:** 컬럼명이 `user_idx`, `is_deleted`처럼 스네이크 케이스이고 소프트 삭제·카운터 캐시 같은 관례가 박혀 있어, SQL을 그대로 쓰는 편이 자연스럽다.

:::tip ORM vs SQL 매퍼, 면접용 한 줄 구분
"JPA/Hibernate는 **full ORM**으로 SQL을 자동 생성하고 객체 상태를 추적(dirty checking)합니다. MyBatis는 **SQL 매퍼**라서 SQL은 제가 쓰고 결과 매핑만 위임합니다. 저희는 쿼리 통제권과 단순함을 위해 MyBatis를 선택했습니다." — 이 구분을 못 하면 "MyBatis가 ORM이냐"는 꼬리질문에서 무너진다.
:::

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

스택은 `mybatis-spring-boot-starter` 4.0.1 + MySQL. 설정은 `application.properties` 두 줄이 핵심이다.

```properties
# XML 매퍼 위치
mybatis.mapper-locations=classpath:mapper/*.xml
# resultType/parameterType에 FQCN 대신 짧은 별칭 허용
mybatis.type-aliases-package=org.triptogether.admin.vo, ... ,org.triptogether.courses.vo
```

매퍼는 **인터페이스(자바) + 매핑(XML)** 두 짝으로 구성된다. 실제 `courses` 도메인 예시.

```java
@Mapper                                    // 스프링이 프록시 구현체를 자동 생성
public interface TravelPlanMapper {
    List<TravelPlanVO> getTravelList(TravelPlanVO vo);     // SELECT 다건
    TravelPlanVO       getTravelPlanDetail(TravelPlanVO vo);
    void               insertTravelPlan(TravelPlanVO vo);  // PK는 useGeneratedKeys로 회수
    void               editTravelPlan(TravelPlanVO vo);
    // 동적 다중 키워드 검색 — 컬렉션 파라미터엔 @Param으로 이름 부여
    List<Map<String,Object>> searchPlansByKeywords(@Param("keywords") List<String> kw,
                                                   @Param("limit") int limit);
}
```

| 요소 | 역할 | TripTogether 실제 예 |
| --- | --- | --- |
| `@Mapper` 인터페이스 | 메서드 시그니처 = 호출 계약. 구현체는 스프링이 런타임 생성 | `TravelPlanMapper`, `CommunityMapper`, `ReportMapper` 등 30+ |
| `resources/mapper/*.xml` | 메서드 id에 SQL을 바인딩. `namespace`=인터페이스 FQCN | `TravelPlanMapper.xml`, `CommunityMapper.xml` … |
| `parameterType` / `resultType` | 입력 VO ↔ 출력 VO/Map 매핑 | `TravelPlanVO`, `PlanSpotVO`, `SpotTravelVO` |
| `<resultMap>` | 컬럼↔필드 수동 매핑(복잡 조인·중첩) | `CommunityMapper`, `InquiryMapper`, `ReportMapper` 등에서 사용 |

XML 한 조각(실제 `TravelPlanMapper.xml`).

```xml
<mapper namespace="org.triptogether.courses.mapper.TravelPlanMapper">
  <select id="getTravelList" parameterType="TravelPlanVO" resultType="TravelPlanVO">
    SELECT * FROM TRAVEL_PLAN
    WHERE user_idx = #{user_idx} AND is_deleted = 0
    ORDER BY created_at DESC
  </select>

  <insert id="insertTravelPlan" parameterType="TravelPlanVO"
          useGeneratedKeys="true" keyProperty="plan_id">
    INSERT INTO TRAVEL_PLAN (user_idx, title, destination, start_date, ...)
    VALUES (#{user_idx}, #{title}, #{destination}, #{start_date}, ...)
  </insert>
</mapper>
```

관련 테이블: `TRAVEL_PLAN` / `PLAN_SPOT`(코스), `COMMUNITY_POST` / `COMMENT`(커뮤니티), `REPORT`, `INQUIRY_POST` 등 — [MySQL 스키마](/backend/mysql-schema)에서 전체를 본다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 4.1 한 번의 호출이 거치는 길

```text
Service 코드            MyBatis                         MySQL
mapper.getTravelList(vo) ──► namespace+id로 XML SQL 찾기
                          ──► #{user_idx} → JDBC PreparedStatement ? 바인딩
                          ──────────────────────────────► SELECT 실행
                          ◄── ResultSet 컬럼 → TravelPlanVO 필드 매핑 (List 반환)
List<TravelPlanVO> 반환 ◄──
```

서비스는 `mapper.메서드()`만 호출한다. SQL 탐색·파라미터 바인딩·결과 매핑은 전부 MyBatis가 처리하고, 커넥션·트랜잭션은 스프링이 관리한다([트랜잭션](/glossary/transaction) 참고).

### 4.2 `#{}` vs `${}` — 보안의 분기점

| 표기 | 처리 방식 | 안전성 | 용도 |
| --- | --- | --- | --- |
| `#{value}` | `PreparedStatement` 바인딩 변수(`?`) | **SQL 인젝션 안전** | 거의 모든 값 |
| `${value}` | 문자열 그대로 치환 | 인젝션 위험 | 컬럼명·정렬 방향 등 구조적 부분만, 화이트리스트 검증 후 |

원칙은 **"값은 무조건 `#{}`"**. TripTogether 매퍼는 사용자 입력값에 `${}`를 쓰지 않는다.

### 4.3 동적 SQL — MyBatis의 진짜 무기

검색·필터·부분수정처럼 **조건에 따라 SQL이 달라지는** 경우, 자바에서 문자열을 이어 붙이지 않고 XML 태그로 표현한다. 실제 코드베이스에서 쓰이는 빈도(매퍼 전체 집계, 근사치).

| 태그 | 의미 | 사용 빈도(대략) |
| --- | --- | --- |
| `<if>` | 조건 충족 시 절 삽입 | 300+ |
| `<choose>/<when>/<otherwise>` | 다분기(switch처럼) | 70+ choose, 270+ when |
| `<where>` | 앞쪽 `AND`/`OR` 자동 제거 + WHERE 자동 부착 | 38+ |
| `<set>` | UPDATE에서 마지막 콤마 자동 제거 | 사용 |
| `<foreach>` | IN 절·다중 키워드 LIKE 등 컬렉션 펼치기 | 29+ |

부분 수정 실제 예(`editTravelPlan`) — `plan_source`는 값이 있을 때만 갱신한다.

```xml
<update id="editTravelPlan" parameterType="TravelPlanVO">
  UPDATE TRAVEL_PLAN
  <set>
    title = #{title}, destination = #{destination},
    start_date = #{start_date}, end_date = #{end_date}, is_public = #{is_public},
    <if test="plan_source != null and plan_source != ''">
      plan_source = #{plan_source},
    </if>
    updated_at = NOW()
  </set>
  WHERE plan_id = #{plan_id} AND user_idx = #{user_idx}
</update>
```

`<foreach>`로 컬렉션을 펼치는 예(다중 키워드 OR LIKE, 챗봇 컨텍스트 검색).

```xml
<select id="searchPlansByKeywords" resultType="map">
  SELECT * FROM TRAVEL_PLAN
  WHERE is_public = 1 AND is_deleted = 0
  AND (
    <foreach collection="keywords" item="kw" separator=" OR ">
      title LIKE CONCAT('%', #{kw}, '%') OR destination LIKE CONCAT('%', #{kw}, '%')
    </foreach>
  )
  ORDER BY created_at DESC LIMIT #{limit}
</select>
```

이 동적 SQL이 JPA 대신 MyBatis를 쓰는 핵심 이점이다 — SQL을 보면서, 조건 조합을 선언적으로 표현한다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `@Mapper` + XML 4계층 매핑, 전 도메인 일관 적용 | 구현됨 |
| `#{}` 파라미터 바인딩(인젝션 방지)·`useGeneratedKeys` PK 회수 | 구현됨 |
| 동적 SQL(`if`/`choose`/`where`/`set`/`foreach`) 광범위 사용 | 구현됨 |
| `<resultMap>` 기반 복잡 조인·중첩 매핑(커뮤니티·신고·문의 등) | 구현됨 |
| `type-aliases-package`로 VO 별칭, 소프트 삭제(`is_deleted`) 관례 | 구현됨 |
| JPA/Hibernate(엔티티·영속성 컨텍스트·dirty checking) | **미사용 — 설계상 배제** |
| 1·2차 캐시, 인터셉터 플러그인(페이징 자동화 등) | 미도입(좋아요 등 캐시는 SQL/컬럼 레벨에서 직접 처리) |

:::warning 정직하게 짚을 점
MyBatis는 SQL 자동 생성·변경 감지·연관 객체 그래프 탐색을 해 주지 않는다. 그만큼 **반복 SQL을 사람이 다 쓴다**(보일러플레이트는 줄지만 0은 아니다). 또 `${}`를 잘못 쓰면 인젝션이 열리므로 "값은 `#{}`, 구조는 화이트리스트 검증" 규칙을 지켜야 한다. 면접에서 "MyBatis = ORM"이라고 단정하지 말고 "SQL 매퍼"라고 정확히 말하는 편이 낫다.
:::

## 6. 면접 답변 3단계

1. **한 줄:** "ORM은 객체와 테이블의 불일치를 자동 변환하는 기술이고, 저희는 그 중 SQL 매퍼인 MyBatis를 써서 SQL은 직접 작성하고 결과 매핑만 위임했습니다."
2. **근거 한 스푼:** "`@Mapper` 인터페이스와 `resources/mapper/*.xml`을 namespace로 짝지어 두고, `#{}`로 PreparedStatement 바인딩을 합니다. 검색·부분수정은 `<if>`·`<where>`·`<set>`·`<foreach>` 동적 SQL로 표현해서, 예를 들어 일정 수정 시 값이 있는 필드만 갱신합니다."
3. **선택 근거 + 한계:** "복잡한 추천·집계 쿼리의 통제권과 팀 협업 단순성을 위해 JPA 대신 MyBatis를 택했습니다. 대신 SQL을 직접 써야 하고, 변경 감지나 1차 캐시 같은 JPA 편의는 포기했습니다."

## 7. 꼬리질문 + 모범답안

:::details MyBatis도 ORM인가요?
넓게 보면 객체-관계 매핑을 하므로 ORM 범주에 넣기도 하지만, 엄밀히는 **SQL 매퍼(half-ORM)**입니다. JPA/Hibernate가 SQL을 자동 생성하고 엔티티 상태를 추적하는 full ORM이라면, MyBatis는 SQL을 개발자가 쓰고 결과 행과 객체의 매핑만 담당합니다.
:::

:::details `#{}`와 `${}`의 차이, 왜 중요한가요?
`#{}`는 `PreparedStatement`의 바인딩 변수(`?`)로 들어가 SQL 인젝션에 안전합니다. `${}`는 문자열을 그대로 치환하므로 사용자 입력에 쓰면 인젝션이 열립니다. 그래서 값은 항상 `#{}`를 쓰고, 컬럼명·정렬 방향처럼 구조가 바뀌어야 할 때만 화이트리스트로 검증한 뒤 `${}`를 제한적으로 씁니다.
:::

:::details 왜 JPA가 아니라 MyBatis를 선택했나요?
세 가지입니다. (1) 추천·랭킹·집계 같은 복잡 쿼리의 가시성과 튜닝 통제권, (2) 4인 공동개발에서 "쿼리는 XML 한 곳"이라는 단순한 멘탈 모델, (3) 스네이크 케이스·소프트 삭제·카운터 캐시 같은 관례가 박힌 스키마와의 친화성. 트레이드오프로 반복 SQL을 직접 써야 하는 점은 인정합니다.
:::

:::details 동적 SQL을 자바 문자열로 안 이어 붙이고 XML 태그로 쓰는 이유는?
문자열 연결은 콤마·`AND` 누락 같은 실수가 잦고 인젝션 위험도 큽니다. `<where>`는 앞쪽 `AND`/`OR`를, `<set>`은 마지막 콤마를 자동으로 정리해 주고, `<if>`·`<foreach>`로 조건과 컬렉션을 선언적으로 표현하면 SQL을 읽으면서 안전하게 조립할 수 있습니다.
:::

:::details INSERT 후 생성된 PK는 어떻게 받나요?
`<insert>`에 `useGeneratedKeys="true" keyProperty="plan_id"`를 주면 AUTO_INCREMENT로 생성된 키가 파라미터 VO의 `plan_id` 필드에 자동으로 채워집니다. 일정(`TravelPlan`)을 만든 뒤 그 PK로 하위 장소(`PlanSpot`)를 같은 트랜잭션에서 넣을 때 이 값을 씁니다.
:::

## 8. 직접 말해보기

- "MyBatis는 ORM인가?"라는 질문에, ORM과 SQL 매퍼의 차이를 들어 30초 안에 정확히 답해 보자.
- `editTravelPlan`의 `<set>` + `<if>` 동적 SQL이, 자바에서 문자열을 이어 붙이는 방식보다 나은 이유를 두 가지 들어 설명해 보자.
- `#{}`와 `${}`를 각각 어디에 쓰고 왜 그렇게 나누는지, 인젝션 관점에서 말해 보자.

## 퀴즈

<QuizBox
  question="MyBatis를 가장 정확히 분류한 것은?"
  :choices="['SQL을 개발자가 작성하고 결과 매핑만 위임하는 SQL 매퍼', 'SQL을 자동 생성하고 엔티티 상태를 추적하는 full ORM', '커넥션 풀 라이브러리', '캐시 전용 프레임워크']"
  :answer="0"
  explanation="MyBatis는 SQL 매퍼(half-ORM)다. SQL은 사람이 XML/애너테이션으로 쓰고, 결과 행과 VO의 매핑만 프레임워크가 한다. SQL 자동 생성·dirty checking은 JPA/Hibernate의 특징이다."
/>

<QuizBox
  question="TripTogether 매퍼에서 사용자 입력 값을 바인딩할 때 #{} 를 쓰는 직접적 이유는?"
  :choices="['PreparedStatement 바인딩 변수로 들어가 SQL 인젝션에 안전하기 때문', '컬럼명을 동적으로 바꿀 수 있어서', '문자열을 그대로 치환하기 때문', '캐시가 자동 적용돼서']"
  :answer="0"
  explanation="#{}는 PreparedStatement의 ? 바인딩으로 처리돼 인젝션에 안전하다. ${}는 문자열을 그대로 치환하므로 사용자 입력에 쓰면 위험하고, 컬럼명·정렬 등 구조적 부분에 화이트리스트 검증 후 제한적으로만 쓴다."
/>

<QuizBox
  question="editTravelPlan의 UPDATE에서 마지막 콤마를 자동으로 정리해 주는 동적 SQL 태그의 이름을 한 단어로 답해 보라."
  explanation="<set> 태그다. UPDATE 절에서 조건부로 컬럼을 넣을 때 마지막 콤마를 자동 제거해 문법 오류를 막는다. SELECT의 WHERE에서 앞쪽 AND/OR를 정리하는 짝은 <where> 태그다."
/>
