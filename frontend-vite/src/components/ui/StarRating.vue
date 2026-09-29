<script setup lang="ts">
import { computed } from 'vue'

const model = defineModel<number | null>({ default: null })

const props = withDefaults(defineProps<{
  readonly?: boolean
  size?: number
}>(), {
  readonly: false,
  size: 18,
})

const sizePx = computed(() => props.size)

function onPick(n: number) {
  if (props.readonly) return
  model.value = model.value === n ? null : n
}

function isOn(n: number): boolean {
  return model.value != null && n <= model.value
}
</script>

<template>
  <div
    class="star-rating"
    :class="{ 'star-rating--readonly': readonly }"
    role="group"
  >
    <button
      v-for="n in 5"
      :key="n"
      type="button"
      class="star-rating-btn"
      :class="{ on: isOn(n) }"
      :disabled="readonly"
      :title="String(n)"
      @click.stop.prevent="onPick(n)"
    >
      <svg :width="sizePx" :height="sizePx" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9L12 2.5z"
          :fill="isOn(n) ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.star-rating {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: #d4a017;
  line-height: 0;
  user-select: none;
}

.star-rating-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  margin: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.35;
  line-height: 0;
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.star-rating-btn.on {
  opacity: 1;
}

.star-rating-btn:hover:not(:disabled) {
  opacity: 1;
  transform: scale(1.08);
}

.star-rating-btn:disabled {
  cursor: default;
}

.star-rating-btn:disabled.on,
.star-rating--readonly .star-rating-btn.on {
  opacity: 1;
}

.star-rating--readonly .star-rating-btn:hover {
  transform: none;
}
</style>
