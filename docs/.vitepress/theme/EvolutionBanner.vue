<script setup lang="ts">
import { useData } from 'vitepress'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const STORAGE_KEY = 'kimi-cli-evolution-banner-dismissed'
const TARGET_URL = 'https://github.com/MoonshotAI/kimi-code'
const HTML_CLASS = 'has-evolution-banner'

const { lang } = useData()

const dismissed = ref(true)
const hydrated = ref(false)

function applyHtmlClass(active: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(HTML_CLASS, active)
}

onMounted(() => {
  dismissed.value = localStorage.getItem(STORAGE_KEY) === '1'
  hydrated.value = true
})

watch([dismissed, hydrated], () => {
  applyHtmlClass(hydrated.value && !dismissed.value)
}, { immediate: true })

onUnmounted(() => {
  applyHtmlClass(false)
})

function dismiss() {
  dismissed.value = true
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // ignore (private mode etc.)
  }
}

const isZh = computed(() => lang.value.startsWith('zh'))
const message = computed(() =>
  isZh.value
    ? 'Kimi Code CLI 重构升级版已发布，迭代更快   了解更多➡️'
    : 'Kimi Code CLI rebuilt & upgraded version released — faster iterations. Learn more ➡️',
)
const closeLabel = computed(() => (isZh.value ? '关闭' : 'Dismiss'))
</script>

<template>
  <div v-if="hydrated && !dismissed" class="evolution-banner">
    <a
      class="evolution-banner__link"
      :href="TARGET_URL"
      target="_blank"
      rel="noopener"
    >
      {{ message }}
    </a>
    <button
      class="evolution-banner__close"
      type="button"
      :aria-label="closeLabel"
      @click="dismiss"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.evolution-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 44px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  line-height: 1.4;
  text-align: center;
}

.evolution-banner__link {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
  transition: color 0.2s;
}

.evolution-banner__link:hover {
  color: var(--vp-c-brand-2);
  text-decoration: underline;
}

.evolution-banner__close {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: 0;
  color: var(--vp-c-text-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s, background-color 0.2s;
}

.evolution-banner__close:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-default-soft);
}

@media (max-width: 640px) {
  .evolution-banner {
    font-size: 12px;
    padding: 0 40px;
  }
}
</style>
