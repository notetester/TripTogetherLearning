# MyBatis

> TripTogether의 영속성 계층은 전부 MyBatis다. `@Mapper` 인터페이스가 SQL의 계약이고, 실제 SQL은 `resources/mapper/*.xml`에 동적으로 쓴다. JPA는 쓰지 않는다.

:::tip 허브
[도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/) · 인접 페이지: [Spring MVC](/backend/spring-mvc) · [MySQL 스키마](/backend/mysql-schema) · [JSP · JSTL · EL](/backend/jsp-jstl-el)
:::

## 1. 한 줄 정의

MyBatis는 **SQL을 직접 쓰는 SQL 매퍼 프레임워크**다. ORM처럼 객체를 SQL로 자동 변환하지 않고, 개발자가 작성한 SQL과 Java 메서드/VO를 매핑한다. TripTogether는 `mybatis-spring-boot-starter` 4.0.1을 쓰며, Java 인터페이스(`@Mapper`)와 XML(`<select>/<insert>/<update>/<delete>`)을 한 쌍으로 묶는다.

## 2. 왜 이렇게 설계했나

- **SQL 가시성·튜닝권한**: 커뮤니티 리스트는 태그 공출현(co-occurrence), 인기순 정렬, 서브쿼리 썸네일 등 복잡한 쿼리가 많다. SQL을 손에 쥐고 직접 인덱스·실행계획을 다뤄야 해서, SQL을 숨기는 ORM보다 매퍼 방식이 유리하다.
- **MySQL 함수 직접 사용**: `GREATEST()`, `COALESCE()`, `CONCAT()`, 상관 서브쿼리 등 DB 고유 기능을 그대로 쓴다.
- **명시적 매핑으로 의도 노출**: 컬럼-프로퍼티 매핑을 `<resultMap>`에 직접 적어 `like_count → likeCount` 같은 변환을 코드 리뷰에서 바로 확인할 수 있다.
- **팀 협업 경계**: 4인이 도메인을 수직 분담하므로, 도메인마다 매퍼 인터페이스 1개 + XML 1개로 묶이는 단순한 1:1 구조가 소유권 경계를 깔끔하게 만든다(현재 매퍼 인터페이스 45개 ≡ XML 45개).

## 3. 어떤 기술로 구현했나 (실제 클래스·테이블)

설정은 `application.properties` 두 줄과 인터페이스의 `@Mapper`로 끝난다. 별도 `@MapperScan`이나 Java 기반 MyBatis 설정 클래스는 없다.

```properties
# application.properties (값은 환경별, 호스트/계정은 자리표시자)
spring.datasource.url=jdbc:mysql://DB_HOST:3306/DB_NAME?...
mybatis.mapper-locations=classpath:mapper/*.xml
mybatis.type-aliases-package=org.triptogether.admin.vo,org.triptogether.community.vo, ...
```

| 구성요소 | 실제 위치 | 역할 |
| --- | --- | --- |
| 매퍼 인터페이스 | `org.triptogether.<도메인>.mapper.*Mapper` (예: `CommunityMapper`) | SQL의 Java 계약. `@Mapper` 부착 |
| 매퍼 XML | `resources/mapper/*.xml` (예: `CommunityMapper.xml`) | 실제 SQL + `<resultMap>` |
| namespace | `<mapper namespace="org.triptogether.community.mapper.CommunityMapper">` | 인터페이스 FQN과 1:1 일치 |
| VO/DTO | `org.triptogether.<도메인>.vo.*` (예: `CommunityPostDto`, `UsersVO`) | 결과/파라미터 객체 |

핵심 포인트:

- **`mapper-locations`**: `classpath:mapper/*.xml`로 모든 XML을 한 폴더에서 로딩한다.
- **`type-aliases-package`**: VO 패키지를 등록하면 XML에서 `resultType="CommunityPostDto"`처럼 FQN 없이 짧은 별칭을 쓸 수 있다.
- **namespace = 인터페이스 FQN**: XML의 `namespace`와 `<select id="...">`가 인터페이스의 패키지+메서드명에 정확히 대응해야 바인딩된다.

## 4. 동작 원리 (흐름·표·작은 코드)

### 인터페이스 → XML 바인딩

```text
service 코드
  communityMapper.selectPostList(search)
        │  메서드명 selectPostList, 파라미터 CommunitySearchDto
        ▼
CommunityMapper (namespace) 의 <select id="selectPostList"> 매칭
        │  #{...} 플레이스홀더에 파라미터 바인딩 (PreparedStatement)
        ▼
MySQL 실행 → ResultSet → <resultMap> 으로 CommunityPostDto 리스트 매핑
```

`#{}`는 `PreparedStatement` 바인딩(SQL 인젝션 방어)이고, `${}`는 문자열 치환이라 사용자 입력에 절대 쓰지 않는다.

### 컬럼-프로퍼티 매핑은 `<resultMap>`으로 명시

이 프로젝트는 언더스코어→카멜 자동 변환을 전역 설정으로 켜지 않는다. 대신 `<resultMap>`에 매핑을 직접 적어 의도를 드러낸다.

```xml
<resultMap id="postMap" type="CommunityPostDto">
  <result property="likeCount"    column="like_count"/>
  <result property="commentCount" column="comment_count"/>
  <result property="createdAt"    column="created_at"/>
</resultMap>
```

별칭(`AS`)으로 직접 카멜로 맞춰주는 쿼리도 일부 있다(`cp.like_count AS likeCount`). 즉 **컬럼명 ≠ 프로퍼티명** 변환은 resultMap 또는 SELECT 별칭으로 항상 명시한다.

### 동적 SQL — `<if> / <choose> / <foreach>`

검색·정렬·IN 절을 런타임에 조립한다.

```xml
<choose>
  <when test="sort == 'popular'">ORDER BY cp.like_count DESC, cp.created_at DESC</when>
  <when test="sort == 'views'">  ORDER BY cp.view_count DESC, cp.created_at DESC</when>
  <otherwise>                    ORDER BY cp.created_at DESC</otherwise>
</choose>

AND cp.post_id NOT IN
<foreach item="id" collection="excludeIds" open="(" separator="," close=")">#{id}</foreach>
```

### `useGeneratedKeys` — INSERT 후 PK 회수

```xml
<insert id="insertPost" useGeneratedKeys="true" keyProperty="postId">
  INSERT INTO COMMUNITY_POST (...) VALUES (...)
</insert>
```

INSERT 직후 `CommunityPostDto.postId`에 AUTO_INCREMENT 값이 자동 주입되어, 이어지는 이미지·태그 INSERT에 바로 쓸 수 있다.

### 캐시 컬럼 동기화 — `like_count`

좋아요·댓글·신고 수는 리스트/상세에서 매우 자주 읽히므로, 매번 `COUNT(*)`를 돌리지 않고 `COMMUNITY_POST.like_count` 캐시 컬럼에 누적한다([ADR-0006](/flow/data-model) 참고 — 같은 모듈의 [데이터 모델](/flow/data-model)에서 전체 그림). 갱신은 작은 UPDATE 두 개로 처리한다.

```xml
<!-- 좋아요 +1 -->
<update id="increaseLikeCount">
  UPDATE COMMUNITY_POST SET like_count = like_count + 1 WHERE post_id = #{postId}
</update>

<!-- 좋아요 -1 (음수 방지: GREATEST 로 0 클램프) -->
<update id="decreaseLikeCount">
  UPDATE COMMUNITY_POST SET like_count = GREATEST(like_count - 1, 0) WHERE post_id = #{postId}
</update>
```

| 시점 | 동작 |
| --- | --- |
| 좋아요 토글 | `COMMUNITY_POST_LIKE` row INSERT/DELETE + `like_count` ±1 (동일 `@Transactional`) |
| 음수 방어 | `GREATEST(like_count - 1, 0)`로 0 미만 방지 |
| 정합성 안전망 | `reconcilePostCounts`가 실제 row 수로 `like_count`/`comment_count`/`report_count` 재계산 |

```xml
<!-- reconcile: 실제 행 수로 캐시 일괄 재계산 (운영 안전망) -->
<update id="reconcilePostCounts">
  UPDATE COMMUNITY_POST cp
  SET cp.like_count = (SELECT COUNT(*) FROM COMMUNITY_POST_LIKE WHERE post_id = cp.post_id), ...
  WHERE cp.post_status IN ('ACTIVE', 'BLOCKED')
</update>
```

핵심 설계 의도: 평시엔 캐시 컬럼으로 조회 비용 0, 인기순 정렬(`ORDER BY like_count DESC`)은 인덱스로 처리, 갱신 누락이 생겨도 reconcile이 정합성을 회복한다. CAP 관점에서 **결과적 일관성(eventually consistent)** 설계다.

## 5. 구현 상태 (됨 vs Mock/계획)

| 항목 | 상태 |
| --- | --- |
| `@Mapper` + `resources/mapper/*.xml` 1:1 (45/45) | 구현됨 |
| `type-aliases-package` 별칭, `<resultMap>` 명시 매핑 | 구현됨 |
| 동적 SQL(`<if>/<choose>/<foreach>`), `useGeneratedKeys` | 구현됨 |
| `like_count` 캐시 ±1 + `GREATEST` 클램프 | 구현됨 |
| `reconcilePostCounts`/`reconcileCommentCounts` 정합성 SQL | 구현됨 (XML에 존재) |
| 항공권(`FlightMapper`) 연동 데이터 | 외부 항공 API는 **Mock 프로바이더** — 매퍼/SQL 구조는 실제, 데이터 출처가 Mock |
| MyBatis 2차 캐시(`<cache>`), Redis | 미사용 (현 규모 오버엔지니어링으로 판단) |
| `mapUnderscoreToCamelCase` 전역 설정 | 미사용 — resultMap/별칭으로 명시 매핑 |

## 6. 면접 답변 3단계

1. **한 줄**: "영속성은 전부 MyBatis로 처리합니다. `@Mapper` 인터페이스가 SQL의 계약이고 실제 SQL은 XML에 동적으로 작성합니다. JPA는 쓰지 않습니다."
2. **설계 이유**: "커뮤니티처럼 태그 공출현·인기순 정렬·상관 서브쿼리가 많은 도메인에서 SQL을 직접 튜닝해야 했고, 도메인별 매퍼 1쌍(인터페이스+XML) 구조가 4인 분담의 소유권 경계와도 잘 맞았습니다."
3. **깊이**: "조회가 잦은 카운트는 `like_count` 캐시 컬럼으로 비용을 0으로 만들고, ±1 UPDATE에 `GREATEST`로 음수를 막은 뒤, reconcile SQL로 실제 row 수와 주기적으로 정합성을 맞춥니다. 강한 일관성 대신 결과적 일관성을 택해 평시 성능을 극대화한 설계입니다."

## 7. 꼬리질문 + 모범답안

:::details Q1. 왜 JPA가 아니라 MyBatis인가?
복잡한 동적 SQL과 MySQL 고유 함수(`GREATEST`, 상관 서브쿼리, 인기순 정렬)를 직접 제어해야 했기 때문입니다. ORM은 단순 CRUD엔 편하지만, 실행계획을 손에 쥐어야 하는 쿼리에서는 생성 SQL이 불투명해집니다. 팀 규약상 영속성은 MyBatis로 통일되어 있습니다.
:::

:::details Q2. `#{}`와 `${}`의 차이는?
`#{}`는 `PreparedStatement` 바인딩으로 값이 파라미터로 안전하게 들어가 SQL 인젝션을 막습니다. `${}`는 SQL 문자열에 직접 치환되어 컬럼명·정렬 키워드 같은 구조에만 제한적으로 쓰고, 사용자 입력에는 절대 쓰지 않습니다.
:::

:::details Q3. `like_count` 캐시가 실제 좋아요 수와 어긋나면?
두 가지 방어선이 있습니다. 첫째, 좋아요 토글 시 LIKE row INSERT/DELETE와 카운트 ±1을 같은 트랜잭션에서 처리하고 `GREATEST(..., 0)`로 음수를 막습니다. 둘째, `reconcilePostCounts`가 실제 row 수로 캐시를 일괄 재계산해 동시성 누락이나 DB 직접 수정 후에도 정합성을 회복합니다.
:::

:::details Q4. 인터페이스 메서드와 XML이 어떻게 연결되나?
XML의 `namespace`가 매퍼 인터페이스의 FQN과 같고, `<select id="...">`의 id가 메서드명과 같아야 바인딩됩니다. `mybatis.mapper-locations`로 XML을 로딩하고, `@Mapper`가 붙은 인터페이스를 스프링이 프록시 빈으로 등록해 서비스에 주입합니다.
:::

:::details Q5. 컬럼명과 프로퍼티명이 다를 때(예: like_count vs likeCount) 어떻게 매핑하나?
전역 `mapUnderscoreToCamelCase`에 의존하지 않고, `<resultMap>`에 `<result property="likeCount" column="like_count"/>`로 명시하거나 SELECT에서 `like_count AS likeCount` 별칭을 줍니다. 매핑 규칙을 코드에 드러내 리뷰에서 바로 검증할 수 있게 한 선택입니다.
:::

## 8. 직접 말해보기

- 매퍼 인터페이스와 XML이 바인딩되는 3가지 조건(namespace, id, 파라미터/리턴 타입)을 말해보세요.
- `like_count` 캐시 컬럼이 왜 필요하고, 정합성을 어떻게 보장하는지 30초로 설명해보세요.
- `<choose>`와 `<foreach>`를 각각 어떤 쿼리에서 썼는지 실제 예로 들어보세요.
- 이 프로젝트가 `mapUnderscoreToCamelCase`를 켜지 않고 resultMap을 명시한 이유를 설명해보세요.

## 퀴즈

<QuizBox
  question="TripTogether에서 like_count 같은 카운트를 매 조회 시 COUNT(*) 하지 않고 캐시 컬럼에 누적하는 가장 큰 이유는?"
  :choices="['ORM이 COUNT를 지원하지 않아서', '리스트/상세에서 자주 읽히는 카운트의 조회 비용을 0으로 만들고 인기순 정렬을 인덱스로 처리하기 위해', 'MySQL이 서브쿼리를 금지해서', 'Redis를 필수로 쓰기 위해']"
  :answer="1"
  explanation="자주 읽히는 카운트는 캐시 컬럼에 누적해 조회 비용을 없애고 ORDER BY like_count DESC를 인덱스로 처리한다. 누락은 reconcile SQL로 회복하는 결과적 일관성 설계다."
/>

<QuizBox
  question="좋아요 -1 처리에서 like_count = GREATEST(like_count - 1, 0) 을 쓰는 이유는?"
  :choices="['속도가 빨라서', '카운트가 음수로 내려가는 것을 방지하려고', 'MyBatis가 뺄셈을 못해서', 'NULL을 0으로 바꾸려고']"
  :answer="1"
  explanation="GREATEST(x, 0)는 동시성/누락으로 인한 음수 카운트를 0으로 클램프해 비정상 표시를 막는다."
/>

<QuizBox
  question="매퍼 XML의 namespace는 무엇과 1:1로 일치해야 하는가?"
  :choices="['테이블 이름', '@Mapper 인터페이스의 FQN(패키지+클래스명)', 'VO 클래스명', 'application.properties의 키']"
  :answer="1"
  explanation="namespace는 매퍼 인터페이스의 완전한 이름과 같아야 하고, select id는 메서드명과 같아야 바인딩된다."
/>
