<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import CropCanvas from './CropCanvas.vue'

defineOptions({ name: 'CropPreview' })

const props = defineProps<{
  imageUrl: string
  bbox: number[]
}>()

const containerEl = ref<HTMLElement | null>(null)
const isVisible = ref(false)
let observer: IntersectionObserver | null = null

onMounted(() => {
  if (!containerEl.value) return

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          isVisible.value = true
          // Once visible, stop observing
          observer?.disconnect()
          observer = null
          break
        }
      }
    },
    {
      rootMargin: '100px',
      threshold: 0.01,
    }
  )

  observer.observe(containerEl.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div ref="containerEl" class="crop-preview">
    <CropCanvas
      v-if="isVisible"
      :image-url="imageUrl"
      :bbox="bbox"
    />
    <div v-else class="crop-preview-placeholder">
      <div class="crop-preview-skeleton" />
    </div>
  </div>
</template>

<style scoped>
.crop-preview {
  width: 100%;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.crop-preview-placeholder {
  width: 100%;
  min-height: 60px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.crop-preview-skeleton {
  width: 100%;
  height: 100%;
  min-height: 60px;
  background: linear-gradient(
    90deg,
    var(--bg-input) 25%,
    var(--bg-hover) 50%,
    var(--bg-input) 75%
  );
  background-size: 200% 100%;
  animation: crop-preview-shimmer 1.5s ease-in-out infinite;
}

@keyframes crop-preview-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
