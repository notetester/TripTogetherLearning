<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  // 질문 텍스트
  question: { type: String, required: true },
  // 선택지 배열 (객관식). 비우면 '정답 보기'형 주관식으로 동작
  choices: { type: Array, default: () => [] },
  // 정답 인덱스 (0부터). 객관식일 때 사용
  answer: { type: Number, default: -1 },
  // 해설 / 주관식 모범답안
  explanation: { type: String, default: '' },
})

const picked = ref(-1)
const revealed = ref(false)

const isObjective = computed(() => props.choices && props.choices.length > 0)

function choose(i) {
  if (revealed.value) return
  picked.value = i
  revealed.value = true
}

function stateOf(i) {
  if (!revealed.value) return ''
  if (i === props.answer) return 'correct'
  if (i === picked.value) return 'wrong'
  return ''
}

function reset() {
  picked.value = -1
  revealed.value = false
}
</script>

<template>
  <div class="quizbox">
    <p class="quizbox__q"><span class="quizbox__tag">Q</span> {{ question }}</p>

    <!-- 객관식 -->
    <div v-if="isObjective" class="quizbox__choices">
      <button
        v-for="(c, i) in choices"
        :key="i"
        class="quizbox__choice"
        :class="stateOf(i)"
        :disabled="revealed"
        @click="choose(i)"
      >
        <span class="quizbox__num">{{ i + 1 }}</span>
        <span>{{ c }}</span>
      </button>
    </div>

    <!-- 객관식 결과 -->
    <div v-if="isObjective && revealed" class="quizbox__result">
      <p v-if="picked === answer" class="quizbox__ok">정답입니다 ✅</p>
      <p v-else class="quizbox__no">아쉬워요. 정답은 {{ answer + 1 }}번 입니다.</p>
      <p v-if="explanation" class="quizbox__exp">{{ explanation }}</p>
      <button class="quizbox__reset" @click="reset">다시 풀기</button>
    </div>

    <!-- 주관식 (정답 보기형) -->
    <div v-else-if="!isObjective" class="quizbox__subjective">
      <button v-if="!revealed" class="quizbox__reveal" @click="revealed = true">
        모범답안 보기
      </button>
      <div v-else class="quizbox__exp quizbox__exp--block">
        <p>{{ explanation }}</p>
        <button class="quizbox__reset" @click="revealed = false">접기</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quizbox {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 16px 18px;
  margin: 18px 0;
  background: var(--vp-c-bg-soft);
}
.quizbox__q {
  font-weight: 600;
  margin: 0 0 12px;
  line-height: 1.6;
}
.quizbox__tag {
  display: inline-block;
  background: var(--vp-c-brand-1);
  color: #fff;
  border-radius: 6px;
  padding: 0 8px;
  margin-right: 6px;
  font-size: 0.85em;
}
.quizbox__choices { display: flex; flex-direction: column; gap: 8px; }
.quizbox__choice {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: pointer;
  transition: border-color .15s, background .15s;
  font-size: 0.95em;
  color: var(--vp-c-text-1);
}
.quizbox__choice:hover:not(:disabled) { border-color: var(--vp-c-brand-1); }
.quizbox__choice:disabled { cursor: default; }
.quizbox__choice.correct { border-color: #16a34a; background: rgba(22,163,74,.12); }
.quizbox__choice.wrong { border-color: #dc2626; background: rgba(220,38,38,.12); }
.quizbox__num {
  flex: 0 0 auto;
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--vp-c-default-soft);
  font-size: 0.8em;
}
.quizbox__result { margin-top: 12px; }
.quizbox__ok { color: #16a34a; font-weight: 600; margin: 0 0 6px; }
.quizbox__no { color: #dc2626; font-weight: 600; margin: 0 0 6px; }
.quizbox__exp {
  font-size: 0.92em;
  color: var(--vp-c-text-2);
  line-height: 1.7;
  margin: 6px 0 0;
}
.quizbox__exp--block {
  background: var(--vp-c-bg);
  border: 1px dashed var(--vp-c-divider);
  border-radius: 8px;
  padding: 12px 14px;
}
.quizbox__reveal, .quizbox__reset {
  margin-top: 8px;
  padding: 6px 14px;
  border: 1px solid var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.88em;
}
.quizbox__reveal:hover, .quizbox__reset:hover {
  background: var(--vp-c-brand-1);
  color: #fff;
}
</style>
