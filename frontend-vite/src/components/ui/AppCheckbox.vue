<template>
  <label class="app-checkbox" :class="{ 'app-checkbox--checked': modelValue, 'app-checkbox--disabled': disabled }">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="app-checkbox__box">
      <svg v-if="modelValue" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
    <span v-if="$slots.default" class="app-checkbox__label">
      <slot />
    </span>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<style scoped>
.app-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.app-checkbox--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.app-checkbox input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.app-checkbox__box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease-out);
  background: transparent;
}

.app-checkbox--checked .app-checkbox__box {
  border-color: var(--text-primary);
  background: transparent;
  color: var(--text-primary);
}

.app-checkbox__label {
  font-size: 13px;
  color: var(--text-primary);
}
</style>