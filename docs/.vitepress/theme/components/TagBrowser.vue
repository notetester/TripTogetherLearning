<script setup>
import { ref, computed } from 'vue'
import { data as pages } from '../pages.data'

// 담당 묶음(익명) — 실제 팀 분담을 익명 라벨로. 자기 범위를 한 번에 묶어 보기 위한 것.
const OWNERS = [
  { key: 'A', label: '담당 A', desc: '인증 · 관리자 · 공통 인프라' },
  { key: 'B', label: '담당 B', desc: '커뮤니티 · 신고 · 문의 · 알림' },
  { key: 'C', label: '담당 C', desc: '여행지 탐색 · 커머스 · 다국어' },
  { key: 'D', label: '담당 D', desc: '여행 코스 · AI 일정 · AI 어시스턴트' },
]

const owner = ref('')
const domain = ref('')
const keyword = ref('')

const domains = computed(() => {
  const set = new Set()
  for (const p of pages) if (p.domain) set.add(p.domain)
  return [...set].sort()
})

const filtered = computed(() =>
  pages.filter((p) => {
    if (owner.value && p.owner !== owner.value) return false
    if (domain.value && p.domain !== domain.value) return false
    if (keyword.value) {
      const k = keyword.value.toLowerCase()
      const hay = (p.title + ' ' + p.tags.join(' ') + ' ' + p.domain).toLowerCase()
      if (!hay.includes(k)) return false
    }
    return true
  })
)

const grouped = computed(() => {
  const g = {}
  for (const p of filtered.value) (g[p.domain || '기타'] ||= []).push(p)
  return Object.keys(g).sort().map((d) => ({ domain: d, items: g[d] }))
})

function ownerCount(k) {
  return pages.filter((p) => p.owner === k).length
}
function reset() { owner.value = ''; domain.value = ''; keyword.value = '' }
</script>

<template>
  <div class="tagbrowser">
    <div class="tb-section">
      <div class="tb-label">담당 묶음</div>
      <div class="tb-chips">
        <button class="tb-chip" :class="{ on: owner === '' }" @click="owner = ''">전체 ({{ pages.length }})</button>
        <button
          v-for="o in OWNERS"
          :key="o.key"
          class="tb-chip"
          :class="{ on: owner === o.key }"
          :title="o.desc"
          @click="owner = (owner === o.key ? '' : o.key)"
        >
          {{ o.label }} · {{ o.desc }} ({{ ownerCount(o.key) }})
        </button>
      </div>
    </div>

    <div class="tb-section">
      <div class="tb-label">도메인</div>
      <div class="tb-chips">
        <button class="tb-chip sm" :class="{ on: domain === '' }" @click="domain = ''">전체</button>
        <button
          v-for="d in domains"
          :key="d"
          class="tb-chip sm"
          :class="{ on: domain === d }"
          @click="domain = (domain === d ? '' : d)"
        >{{ d }}</button>
      </div>
    </div>

    <div class="tb-section">
      <input v-model="keyword" class="tb-search" placeholder="제목·태그 검색…" />
      <button v-if="owner || domain || keyword" class="tb-reset" @click="reset">초기화</button>
    </div>

    <p class="tb-count">{{ filtered.length }}개 페이지</p>

    <div v-for="g in grouped" :key="g.domain" class="tb-group">
      <h3 class="tb-group-title">{{ g.domain }} <span>({{ g.items.length }})</span></h3>
      <ul class="tb-list">
        <li v-for="p in g.items" :key="p.url">
          <a :href="p.url">{{ p.title }}</a>
          <span v-for="t in p.tags" :key="t" class="tb-tag">{{ t }}</span>
        </li>
      </ul>
    </div>

    <p v-if="filtered.length === 0" class="tb-empty">조건에 맞는 페이지가 없습니다.</p>
  </div>
</template>

<style scoped>
.tagbrowser { margin: 16px 0; }
.tb-section { margin-bottom: 14px; }
.tb-label { font-size: 0.8em; font-weight: 700; color: var(--vp-c-text-2); margin-bottom: 6px; }
.tb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tb-chip {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 0.84em;
  cursor: pointer;
  transition: all .15s;
}
.tb-chip.sm { padding: 3px 10px; font-size: 0.8em; }
.tb-chip:hover { border-color: var(--vp-c-brand-1); }
.tb-chip.on { background: var(--vp-c-brand-1); color: #fff; border-color: var(--vp-c-brand-1); }
.tb-search {
  width: 100%; max-width: 320px; padding: 7px 12px;
  border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg);
  color: var(--vp-c-text-1); font-size: 0.9em;
}
.tb-reset { margin-left: 8px; font-size: 0.82em; color: var(--vp-c-brand-1); background: none; border: none; cursor: pointer; }
.tb-count { font-size: 0.82em; color: var(--vp-c-text-2); margin: 6px 0 14px; }
.tb-group { margin-bottom: 18px; }
.tb-group-title { font-size: 1.02em; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vp-c-divider); }
.tb-group-title span { color: var(--vp-c-text-3); font-weight: 400; font-size: 0.85em; }
.tb-list { list-style: none; padding: 0; margin: 0; }
.tb-list li { padding: 4px 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-tag { font-size: 0.7em; background: var(--vp-c-default-soft); color: var(--vp-c-text-2); border-radius: 4px; padding: 1px 6px; }
.tb-empty { color: var(--vp-c-text-3); font-size: 0.9em; }
</style>
