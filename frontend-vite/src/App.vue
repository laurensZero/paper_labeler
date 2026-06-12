<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue'
import { NConfigProvider, darkTheme, lightTheme } from 'naive-ui'
import AppShell from '@/components/layout/AppShell.vue'
import CieImport from '@/components/CieImport.vue'
import AppDialogHost from '@/components/AppDialogHost.vue'
import ExportWizard from '@/views/ExportWizard.vue'

const isDark = ref(false)
const theme = computed(() => isDark.value ? darkTheme : lightTheme)

watchEffect(() => {
  document.body.classList.toggle('dark', isDark.value)
})

onBeforeUnmount(() => {
  document.body.classList.remove('dark')
})
</script>

<template>
  <n-config-provider :theme="theme">
    <AppShell :is-dark="isDark" @toggle-theme="isDark = !isDark" />
    <CieImport />
    <ExportWizard />
    <AppDialogHost :is-dark="isDark" />
  </n-config-provider>
</template>
