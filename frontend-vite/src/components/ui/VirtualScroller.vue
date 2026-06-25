<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

defineOptions({ name: 'VirtualScroller' })

const props = withDefaults(defineProps<{
  items: unknown[]
  itemHeight: number
  overscan?: number
}>(), {
  overscan: 5,
})

const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const containerHeight = ref(0)

let resizeObserver: ResizeObserver | null = null
let rafId: number | null = null

const totalHeight = computed(() => props.items.length * props.itemHeight)

const visibleRange = computed(() => {
  const start = Math.floor(scrollTop.value / props.itemHeight)
  const visible = Math.ceil(containerHeight.value / props.itemHeight)
  const overscanStart = Math.max(0, start - props.overscan)
  const overscanEnd = Math.min(props.items.length, start + visible + props.overscan)
  return { start: overscanStart, end: overscanEnd }
})

const visibleItems = computed(() => {
  const { start, end } = visibleRange.value
  return props.items.slice(start, end).map((item, i) => ({
    item,
    index: start + i,
    style: {
      position: 'absolute' as const,
      top: `${(start + i) * props.itemHeight}px`,
      left: 0,
      right: 0,
      height: `${props.itemHeight}px`,
    },
  }))
})

function onScroll() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    scrollTop.value = scrollEl.value?.scrollTop ?? 0
    rafId = null
  })
}

function updateContainerHeight() {
  containerHeight.value = scrollEl.value?.clientHeight ?? 0
}

function scrollToIndex(index: number) {
  if (!scrollEl.value) return
  const top = index * props.itemHeight
  scrollEl.value.scrollTo({ top, behavior: 'smooth' })
}

function scrollToTop() {
  scrollEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  updateContainerHeight()
  if (scrollEl.value) {
    resizeObserver = new ResizeObserver(() => {
      updateContainerHeight()
    })
    resizeObserver.observe(scrollEl.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
})

// Reset scroll when items change significantly
watch(() => props.items.length, () => {
  // Keep current scroll, just update container
  scrollTop.value = scrollEl.value?.scrollTop ?? 0
})

defineExpose({ scrollToIndex, scrollToTop })
</script>

<template>
  <div
    ref="scrollEl"
    class="vs"
    @scroll="onScroll"
  >
    <div class="vs-spacer" :style="{ height: `${totalHeight}px`, position: 'relative' }">
      <div
        v-for="entry in visibleItems"
        :key="entry.index"
        :style="entry.style"
        class="vs-item"
      >
        <slot :item="entry.item" :index="entry.index" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.vs {
  overflow-y: auto;
  width: 100%;
  height: 100%;
  position: relative;
}

.vs-spacer {
  width: 100%;
}

.vs-item {
  box-sizing: border-box;
}
</style>
