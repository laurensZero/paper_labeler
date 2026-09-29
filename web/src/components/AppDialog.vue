<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialog } from '@/composables/dialog'

defineOptions({ name: 'AppDialog' })

const { t } = useI18n()
const { active, inputError, setInputValue, submit, cancel } = useDialog()
const inputRef = ref<HTMLInputElement | null>(null)
const primaryButtonRef = ref<HTMLButtonElement | null>(null)

const title = computed(() => {
  if (!active.value) return ''
  if (active.value.title) return active.value.title
  if (active.value.kind === 'confirm') return t('dialog.confirmTitle')
  if (active.value.kind === 'prompt') return t('dialog.promptTitle')
  return t('dialog.alertTitle')
})

const confirmText = computed(() => {
  if (!active.value) return t('dialog.ok')
  if (active.value.confirmText) return active.value.confirmText
  if (active.value.kind === 'confirm') return t('dialog.confirm')
  return t('dialog.ok')
})

const cancelText = computed(() => active.value?.cancelText || t('dialog.cancel'))
const showCancel = computed(() => active.value?.kind === 'confirm' || active.value?.kind === 'prompt')

watch(
  () => active.value?.id,
  async () => {
    await nextTick()
    if (active.value?.kind === 'prompt') {
      inputRef.value?.focus()
      inputRef.value?.select()
    } else {
      primaryButtonRef.value?.focus()
    }
  },
)

function onInput(evt: Event) {
  setInputValue((evt.target as HTMLInputElement).value)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape') {
    evt.preventDefault()
    cancel()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="app-dialog-fade">
      <div v-if="active" class="cv-modal-overlay app-dialog-overlay" @keydown="onKeydown" @click.self="cancel">
        <form class="cv-modal app-dialog" role="dialog" aria-modal="true" :aria-label="title" @submit.prevent="submit">
          <div class="cv-modal-header">
            <h3>{{ title }}</h3>
            <button type="button" class="cv-modal-x" :aria-label="t('dialog.cancel')" @click="cancel">×</button>
          </div>
          <div class="cv-modal-body app-dialog-body">
            <div class="app-dialog-message">{{ active.message }}</div>
            <div v-if="active.kind === 'prompt'" class="app-dialog-input-wrap">
              <input
                ref="inputRef"
                class="input app-dialog-input"
                :value="active.inputValue"
                :placeholder="active.placeholder || ''"
                @input="onInput"
              />
              <div v-if="inputError" class="error-text">{{ t(inputError) }}</div>
            </div>
          </div>
          <div class="cv-modal-footer">
            <button v-if="showCancel" type="button" class="btn btn-soft" @click="cancel">
              {{ cancelText }}
            </button>
            <button
              ref="primaryButtonRef"
              type="submit"
              class="btn"
              :class="active.danger ? 'btn-danger' : 'btn-primary'"
            >
              {{ confirmText }}
            </button>
          </div>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-dialog-overlay {
  z-index: 200;
}

.app-dialog {
  position: relative;
  width: 400px;
}

.app-dialog-body {
  padding-top: 0;
}

.app-dialog-message {
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.app-dialog-input-wrap {
  margin-top: 14px;
}

.app-dialog-input {
  width: 100%;
}

.app-dialog-fade-enter-active,
.app-dialog-fade-leave-active {
  transition: opacity var(--duration-med) var(--ease-out);
}

.app-dialog-fade-enter-active .app-dialog,
.app-dialog-fade-leave-active .app-dialog {
  transition: transform var(--duration-med) var(--ease-spring), opacity var(--duration-med) var(--ease-out);
}

.app-dialog-fade-enter-from,
.app-dialog-fade-leave-to {
  opacity: 0;
}

.app-dialog-fade-enter-from .app-dialog,
.app-dialog-fade-leave-to .app-dialog {
  opacity: 0;
  transform: scale(0.94) translateY(8px);
}
</style>
