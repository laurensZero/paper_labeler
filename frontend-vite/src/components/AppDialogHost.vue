<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useDialogStore } from '@/stores/dialog'

defineOptions({ name: 'AppDialogHost' })

defineProps<{
  isDark: boolean
}>()

const dialogStore = useDialogStore()
const { t } = useI18n()
const { active, inputError } = storeToRefs(dialogStore)
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
  dialogStore.setInputValue((evt.target as HTMLInputElement).value)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape') {
    evt.preventDefault()
    dialogStore.cancel()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="app-dialog-fade">
      <div
        v-if="active"
        class="app-dialog-mask"
        :class="{ dark: isDark }"
        @keydown="onKeydown"
      >
        <form
          class="app-dialog"
          style="backdrop-filter: blur(30px) saturate(180%); -webkit-backdrop-filter: blur(30px) saturate(180%)"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          @submit.prevent="dialogStore.submit()"
        >
          <div class="app-dialog-header">
            <div class="app-dialog-title">{{ title }}</div>
          </div>

          <div class="app-dialog-body">
            <div class="app-dialog-message">{{ active.message }}</div>
            <div v-if="active.kind === 'prompt'" class="app-dialog-input-wrap">
              <input
                ref="inputRef"
                class="app-dialog-input"
                :value="active.inputValue"
                :placeholder="active.placeholder || ''"
                @input="onInput"
              />
              <div v-if="inputError" class="app-dialog-error">{{ t(inputError) }}</div>
            </div>
          </div>

          <div class="app-dialog-actions">
            <button
              v-if="showCancel"
              type="button"
              class="btn btn-ghost"
              @click="dialogStore.cancel()"
            >
              {{ cancelText }}
            </button>
            <button
              ref="primaryButtonRef"
              type="submit"
              class="btn"
              :class="active.danger ? 'app-dialog-danger' : 'btn-primary'"
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
.app-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.38);
}

.app-dialog {
  width: min(420px, 100%);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  background: color-mix(in srgb, var(--bg-elevated) 76%, transparent);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  contain: layout paint;
}

.app-dialog-header {
  padding: 18px 20px 8px;
}

.app-dialog-title {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}

.app-dialog-body {
  padding: 8px 20px 16px;
  overflow-y: auto;
}

.app-dialog-message {
  white-space: pre-line;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.55;
}

.app-dialog-input-wrap {
  margin-top: 14px;
}

.app-dialog-input {
  width: 100%;
  padding: 9px 10px;
  font: inherit;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
}

.app-dialog-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.app-dialog-error {
  margin-top: 6px;
  color: var(--danger);
  font-size: 12px;
}

.app-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
  border-top: 1px solid var(--border);
}

.app-dialog-danger {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}

.app-dialog-danger:hover {
  background: var(--danger);
  border-color: var(--danger);
  filter: brightness(0.95);
}

.app-dialog-fade-enter-active,
.app-dialog-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out);
}

.app-dialog-fade-enter-active .app-dialog,
.app-dialog-fade-leave-active .app-dialog {
  transition: transform var(--duration-fast) var(--ease-out);
}

.app-dialog-fade-enter-from,
.app-dialog-fade-leave-to {
  opacity: 0;
}

.app-dialog-fade-enter-from .app-dialog,
.app-dialog-fade-leave-to .app-dialog {
  transform: translateY(6px) scale(0.98);
}
</style>
