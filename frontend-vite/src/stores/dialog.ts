import { ref } from 'vue'
import { defineStore } from 'pinia'

type DialogKind = 'alert' | 'confirm' | 'prompt'
type DialogResult = boolean | string | null | undefined

export interface DialogOptions {
  title?: string
  confirmText?: string
  cancelText?: string
  placeholder?: string
  danger?: boolean
  required?: boolean
}

interface ActiveDialog extends DialogOptions {
  id: number
  kind: DialogKind
  message: string
  inputValue: string
  resolve: (value: DialogResult) => void
}

export const useDialogStore = defineStore('dialog', () => {
  const active = ref<ActiveDialog | null>(null)
  const inputError = ref('')
  const queue: ActiveDialog[] = []
  let nextId = 1

  function pumpQueue() {
    if (active.value || !queue.length) return
    inputError.value = ''
    active.value = queue.shift() || null
  }

  function open(kind: DialogKind, message: unknown, options: DialogOptions = {}, defaultValue = '') {
    return new Promise<DialogResult>((resolve) => {
      queue.push({
        id: nextId++,
        kind,
        message: String(message ?? ''),
        inputValue: String(defaultValue ?? ''),
        resolve,
        ...options,
      })
      pumpQueue()
    })
  }

  async function alert(message: unknown, options: DialogOptions = {}) {
    await open('alert', message, options)
  }

  async function confirm(message: unknown, options: DialogOptions = {}) {
    return await open('confirm', message, options) === true
  }

  async function prompt(message: unknown, defaultValue = '', options: DialogOptions = {}) {
    const value = await open('prompt', message, options, defaultValue)
    return typeof value === 'string' ? value : null
  }

  function setInputValue(value: string) {
    if (!active.value) return
    active.value.inputValue = value
    inputError.value = ''
  }

  function finish(value: DialogResult) {
    const dialog = active.value
    if (!dialog) return
    active.value = null
    inputError.value = ''
    dialog.resolve(value)
    pumpQueue()
  }

  function submit() {
    const dialog = active.value
    if (!dialog) return
    if (dialog.kind === 'prompt') {
      if (dialog.required && !String(dialog.inputValue || '').trim()) {
        inputError.value = 'dialog.inputRequired'
        return
      }
      finish(dialog.inputValue)
      return
    }
    if (dialog.kind === 'confirm') {
      finish(true)
      return
    }
    finish(undefined)
  }

  function cancel() {
    const dialog = active.value
    if (!dialog) return
    if (dialog.kind === 'confirm') {
      finish(false)
      return
    }
    if (dialog.kind === 'prompt') {
      finish(null)
      return
    }
    finish(undefined)
  }

  return {
    active,
    inputError,
    alert,
    confirm,
    prompt,
    setInputValue,
    submit,
    cancel,
  }
})
