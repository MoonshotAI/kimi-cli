<script setup lang="ts">
import { useData } from 'vitepress'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

// Renamed when the project was archived so that previously dismissed banners show again.
const STORAGE_KEY = 'kimi-cli-archived-banner-dismissed'
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
    ? 'Kimi CLI 已归档，旧版将无法继续使用，请迁移至 Kimi Code CLI ➡️'
    : 'Kimi CLI is archived and will stop working. Please migrate to Kimi Code CLI ➡️',
)
const targetUrl = computed(() =>
  isZh.value
    ? 'https://moonshotai.github.io/kimi-code/zh/guides/migration'
    : 'https://moonshotai.github.io/kimi-code/en/guides/migration',
)
const closeLabel = computed(() => (isZh.value ? '关闭' : 'Dismiss'))
</script>

<template>
  <div v-if="hydrated && !dismissed" class="evolution-banner">
    <a
      class="evolution-banner__link"
      :href="targetUrl"
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
