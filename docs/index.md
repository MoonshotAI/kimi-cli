---
layout: home
hero:
  name: Kimi Code CLI
  text: ' '
  actions:
    - theme: brand
      text: 简体中文
      link: zh/
    - theme: alt
      text: English
      link: en/
---

<script setup>
import { onMounted } from 'vue'
import { useRouter, withBase } from 'vitepress'

const router = useRouter()

onMounted(() => {
  const lang = navigator.language || navigator.userLanguage
  if (lang.startsWith('en')) {
    router.go(withBase('/en/'))
  } else {
    router.go(withBase('/zh/'))
  }
})
</script>
