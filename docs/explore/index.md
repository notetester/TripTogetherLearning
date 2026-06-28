---
title: "여행지 탐색·커머스·리워드 개요"
owner: C
domain: "여행지 탐색·커머스"
tags: ["탐색", "커머스"]
---

# 여행지 탐색·커머스·리워드 개요

> 여행지를 찾아보고(탐색), 결제로 사고(커머스), 활동으로 등급을 올리는(리워드) 세 묶음을 하나의 흐름으로 엮은 도메인.

이 도메인은 TripTogether의 "탐색 → 계획 → 예약 → 공유" 사용자 여정에서 **탐색과 예약(결제)** 구간을 책임진다. 여행지 데이터(SPOT_TRAVEL)를 중심으로 개인화 추천을 붙이고, 그 위에 항공권·패키지 같은 커머스 기능과 포인트·레벨 게이미피케이션을 얹는다. 네 명이 도메인을 나눠 만든 팀 프로젝트이며, 이 페이지는 특정 담당자 관점이 아니라 도메인 전체를 동등하게 정리한다.

## 1. 이 도메인이 다루는 것

| 묶음 | 핵심 질문 | 대표 기능 |
| --- | --- | --- |
| 탐색(Explore) | 어디로 갈까 | 7탭 필터 검색, 지도, 찜·좋아요, AI 개인화 추천 |
| 상세·추천(Detail) | 이곳이 나에게 맞나 | 스팟 상세, 체류시간 기반 추천 3건, 리뷰 |
| 커머스(Commerce) | 어떻게 예약·결제하나 | 항공권 견적, Toss 결제·충전, 3원 지갑, 패키지 마켓플레이스 |
| 리워드(Reward) | 무엇을 돌려받나 | 포인트·경험치·레벨, 포인트 상점, 등급 할인 |

탐색이 "유입", 커머스가 "전환", 리워드가 "재방문 동기"를 담당해 한 도메인 안에서 퍼널이 닫히도록 설계됐다.

## 2. 담당과 협업 경계

- 네 명이 도메인을 수직 분담해 공동 개발했으며, 탐색·커머스·리워드 묶음은 이 도메인 담당자가 맡았다. 실명은 표기하지 않는다.
- **지갑(USER_WALLET_HISTORY)·Toss 결제·환불 로직은 myPage 모듈과 공유**한다. 커머스(항공권·패키지)는 결제 시 myPage의 `WalletMapper`·`TossPaymentsClient`를 호출하므로, 이 경계를 침범하지 않고 인터페이스로만 연동한다.
- **추천 결과의 다국어 번역은 i18n 도메인의 캐시(SPOT_TEXT_TRANSLATION_CACHE)** 를 재사용한다.
- 레벨업·포인트 적립이 일어나면 알림(MYPAGE_FEED_NOTIFICATION)이 발생하므로 **알림 도메인과도 연결**된다.

:::tip 면접 한 줄
"세 기능을 따로 만든 게 아니라, 여행지 한 건을 축으로 탐색-결제-보상이 같은 데이터 흐름을 공유하도록 묶었습니다."
:::

## 3. 핵심 기술 한눈에

### 3-1. AI 개인화 추천 (Gemini 2.5 Flash)
- `RecommendService`가 사용자의 최근 체류 로그(SPOT_VIEW_LOG, 최근 30건)에서 **체류시간 + 방문빈도 가중치**로 관심 태그를 추출한다.
- 후보를 태그 매칭 점수로 1차 정렬한 뒤 Gemini에 넘겨 최종 3건을 고른다.
- **3단 폴백**: 5분 캐시(SPOT_RECOMMEND) 적중 → 없으면 Gemini 호출 → 실패하면 트렌딩 폴백. 외부 AI가 죽어도 화면이 비지 않는다.

### 3-2. 커머스 결제 (Toss Payments + Mock 항공권)
- 충전·결제는 **실제 Toss Payments API**(`TossPaymentsClient`, confirm/cancel 엔드포인트)로 연동한다.
- 항공권 견적은 외부 항공 API 대신 **Mock 프로바이더**(`MockFlightOfferProvider`)다. 단, `FlightOfferProvider` 인터페이스로 추상화해 나중에 실 API로 교체할 수 있게 설계했다.
- 결제는 **캐시 + 마일리지 혼합**을 지원하고, 마일리지는 결제액의 30%까지로 서버에서 검증한다.

### 3-3. 3원 지갑 + 게이미피케이션
- 지갑은 **캐시 / 마일리지 / 포인트** 세 자산으로 나뉘고, 모든 증감은 USER_WALLET_HISTORY·USER_POINT_HISTORY에 이력으로 남는다.
- 활동 시 `RewardService.awardAction`이 포인트·경험치를 지급하고, 경험치가 임계를 넘으면 EXP_LEVEL_POLICY에 따라 **자동 레벨업**과 레벨업 보상(LEVEL_UP_REWARD_POLICY)을 같은 트랜잭션에서 처리한다.
- 포인트는 POINT_SHOP_ITEM 상점에서 아이템 구매로 소비된다.

## 4. 데이터 모델 지도

```text
SPOT_TRAVEL ──< SPOT_REVIEW / SPOT_FAVORITE / SPOT_LIKE      (탐색·상세)
   │   └─ SPOT_TAG / SPOT_TAG_LIST                            (태그)
   ├─ SPOT_VIEW_LOG ─→ SPOT_RECOMMEND                         (체류로그 → AI 추천)
   └─ FLIGHT_PURCHASE_SIMULATION                              (Mock 항공권 예매)

USERS ─ USER_WALLET_HISTORY / USER_PAYMENT_HISTORY / WALLET_REFUND_LOG   (3원 지갑·결제·환불)
   ├─ USER_EXP_HISTORY / USER_POINT_HISTORY / USER_LEVEL_UP_REWARD_HISTORY (리워드 이력)
   └─ USER_POINT_ITEM_INVENTORY ←─ POINT_SHOP_ITEM            (포인트 상점)

TRAVEL_PACKAGE ──< TRAVEL_PACKAGE_BOOKING / TRAVEL_PACKAGE_REVISION       (패키지 마켓플레이스)
```

정책 테이블(EXP_LEVEL_POLICY, POINT_REWARD_POLICY, MEMBER_GRADE_POLICY, WALLET_LIMIT_POLICY 등)이 따로 분리돼, 보상·할인·한도 규칙을 코드 수정 없이 DB에서 조정하도록 만든 점이 이 도메인의 설계 특징이다.

## 5. 구현 상태 (됨 vs Mock·계획)

| 기능 | 상태 |
| --- | --- |
| Gemini 개인화 추천 + 3단 폴백 | 구현됨 |
| 체류시간 로그·관심 태그 추출 | 구현됨 |
| Toss 결제·충전·환불 | 구현됨(실 API 연동) |
| 3원 지갑·혼합결제·마일리지 한도 | 구현됨 |
| 포인트·경험치·자동 레벨업·포인트 상점 | 구현됨 |
| 패키지 마켓플레이스(판매자 등록 → 관리자 승인) | 구현됨 |
| 항공권 견적·예매 | **Mock 프로바이더**(실제 항공 API 미연동) |
| AI 추천 품질 정량평가 | 미구현(향후 과제) |
| 모바일 반응형 | 데스크톱 JSP 레이아웃 위주(향후) |

:::warning 정직하게 구분
항공권은 인터페이스만 실서비스 수준으로 추상화돼 있고 데이터는 시뮬레이션이다. 면접에서 "실제 항공권 API를 붙였나요"라고 물으면 "Mock이지만 교체 가능한 구조"라고 답하는 것이 정확하다.
:::

## 6. 권장 학습 순서

1. [탐색 필터](/explore/explore-filters) — 검색·필터로 들어오는 입구를 먼저 본다.
2. [AI 추천(Gemini)](/explore/ai-recommendation-gemini) — 개인화의 핵심.
3. [추천 캐시·폴백](/explore/recommendation-cache-fallback) — 외부 AI 의존을 어떻게 안전하게 만들었나.
4. [찜·좋아요·지도](/explore/spot-favorite-maps) — 사용자 신호 수집.
5. [항공권(Mock 프로바이더)](/explore/flight-mock) — 커머스 진입, 추상화 패턴.
6. [Toss 결제](/explore/toss-payments) → [3원 지갑](/explore/three-wallet) — 결제와 자산 관리.
7. [게이미피케이션](/explore/gamification) — 포인트·레벨 보상.
8. [패키지 마켓플레이스](/explore/package-marketplace) — 판매자 승인 워크플로우.
9. [면접 플레이북](/explore/interview-playbook) — 전체를 말로 정리.

허브: [도메인 전체 개요](/domains) · [담당별 보기](/by-area/) · [전체 흐름](/flow/)

## 7. 단골 면접 질문 5선

1. **외부 AI(Gemini)가 응답을 못 하면 추천 화면은 어떻게 되나요?**
   캐시 → Gemini → 트렌딩의 3단 폴백으로, 어떤 단계가 실패해도 항상 3건을 채워 반환합니다. 빈 화면이 나오지 않는 것이 설계 목표였습니다.

2. **개인화 추천에서 무엇을 신호로 쓰나요?**
   SPOT_VIEW_LOG의 최근 30건에서 체류시간과 방문빈도에 가중치를 줘 관심 태그를 뽑고, 현재 보는 여행지 태그와의 겹침을 가장 우선해 후보를 정렬합니다.

3. **항공권은 실제로 결제되나요?**
   항공권 견적 자체는 Mock 프로바이더입니다. 다만 FlightOfferProvider 인터페이스로 추상화해 실 API 교체 시 서비스·화면 변경을 최소화하도록 했습니다. 결제 수단(Toss·지갑)은 실제 동작합니다.

4. **지갑이 왜 세 자산으로 나뉘어 있나요?**
   현금성 캐시, 적립성 마일리지, 활동 보상 포인트는 충전·소비·환불 규칙이 달라서 분리했습니다. 모든 증감은 이력 테이블로 남겨 정합성을 추적합니다.

5. **레벨업과 보상은 어떻게 일관되게 처리하나요?**
   경험치 적립·레벨 재계산·레벨업 보상 지급·알림 발송을 하나의 @Transactional 안에서 처리하고, 중복 지급은 이력 테이블 조회로 막습니다.

## 퀴즈

<QuizBox question="여행지 개인화 추천에서 외부 AI 호출이 실패했을 때 최종적으로 무엇을 반환하나요?" :choices="['빈 목록을 반환한다','트렌딩(요즘 뜨는 여행지) 폴백을 반환한다','에러 페이지를 띄운다','이전 사용자의 추천을 그대로 보여준다']" :answer="1" explanation="추천은 캐시 → Gemini → 트렌딩의 3단 폴백 구조라서, 외부 AI가 실패해도 트렌딩 결과로 항상 추천 건수를 채워 반환합니다." />

<QuizBox question="항공권 기능의 실제 구현 상태로 옳은 것은?" :choices="['실제 항공사 API에 연동되어 있다','Mock 프로바이더이지만 인터페이스로 추상화되어 교체 가능하다','아직 코드가 전혀 없다','Toss 결제로만 동작하고 견적은 없다']" :answer="1" explanation="항공권 견적은 MockFlightOfferProvider로 시뮬레이션되지만, FlightOfferProvider 인터페이스로 추상화해 실제 API로 교체하기 쉽게 설계했습니다." />

<QuizBox question="이 도메인의 지갑은 어떤 세 가지 자산으로 구성되나요?" :choices="['캐시, 마일리지, 포인트','현금, 카드, 쿠폰','포인트, 코인, 캐시','마일리지, 포인트, 기프티콘']" :answer="0" explanation="지갑은 현금성 캐시, 적립성 마일리지, 활동 보상 포인트의 세 자산으로 나뉘며 각 증감은 이력 테이블에 기록됩니다." />
