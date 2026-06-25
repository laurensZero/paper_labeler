import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from './app'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import type { QuestionsIntegrityReport, QuestionsRepairReport } from '@/types/question'
import type { AlignBounds, PaperAlignRef } from '@/utils/alignment'
import { clampInt } from '@/utils/geometry'

// localStorage keys match the old frontend/modules/settings.js exactly
export const useSettingsStore = defineStore('settings', () => {
  // --- alignment ---
  const alignLeftEnabled = ref(true)
  const alignPaperFirstEnabled = ref(false)
  const answerAlignEnabled = ref(true)
  const paperAlignRef = ref<PaperAlignRef>({})

  // --- filter virtual list ---
  const filterVirtualThreshold = ref(24)
  const filterVirtualOverscanPx = ref(900)

  // --- maintenance ---
  const maintenanceBusy = ref(false)
  const maintenanceDryRun = ref(true)
  const maintenanceRemoveOrphanBoxes = ref(false)
  const maintenanceFillMissingQuestionNo = ref(false)
  const maintenanceRenumberQuestionNo = ref(false)
  const maintenanceIntegrityReport = ref<QuestionsIntegrityReport | null>(null)
  const maintenanceRepairReport = ref<QuestionsRepairReport | null>(null)


  // --- appearance ---
  const darkImageInvert = ref(false)
  const filmStripSectionDots = ref(false)

  // --- OCR ---
  const ocrAutoEnabled = ref(false)
  const ocrMinHeightPx = ref(70)
  const ocrYPaddingPx = ref(12)

  // --- actions ---
  function loadFromStorage() {
    try {
      const v = localStorage.getItem('setting:alignLeftEnabled')
      if (v != null) alignLeftEnabled.value = v === '1' || v === 'true'
    } catch {}
    try {
      const v = localStorage.getItem('setting:alignPaperFirstEnabled')
      if (v != null) alignPaperFirstEnabled.value = v === '1' || v === 'true'
    } catch {}
    try {
      const v = localStorage.getItem('setting:answerAlignEnabled')
      if (v != null) answerAlignEnabled.value = v === '1' || v === 'true'
    } catch {}
    try {
      const raw = localStorage.getItem('setting:paperAlignRef')
      const parsed = raw ? JSON.parse(raw) : null
      paperAlignRef.value = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      paperAlignRef.value = {}
    }
    try {
      const v = localStorage.getItem('setting:darkImageInvert')
      if (v != null) darkImageInvert.value = v === '1' || v === 'true'
    } catch {}
    try {
      const v = localStorage.getItem('setting:filmStripSectionDots')
      if (v != null) filmStripSectionDots.value = v === '1' || v === 'true'
    } catch {}
    try {
      const v = localStorage.getItem('setting:ocrAutoEnabled')
      if (v != null) ocrAutoEnabled.value = v === '1' || v === 'true'
    } catch {}
    try {
      const mh = localStorage.getItem('setting:ocrMinHeightPx')
      if (mh != null) ocrMinHeightPx.value = clampInt(mh, 0, 2000)
    } catch {}
    try {
      const pad = localStorage.getItem('setting:ocrYPaddingPx')
      if (pad != null) ocrYPaddingPx.value = clampInt(pad, 0, 500)
    } catch {}
    try {
      const t = localStorage.getItem('setting:filterVirtualThreshold')
      if (t != null) filterVirtualThreshold.value = clampInt(t, 1, 200)
    } catch {}
    try {
      const o = localStorage.getItem('setting:filterVirtualOverscanPx')
      if (o != null) filterVirtualOverscanPx.value = clampInt(o, 0, 5000)
    } catch {}
    syncInvertClass()
  }

  function saveAlignLeft(v: boolean) {
    alignLeftEnabled.value = !!v
    if (alignLeftEnabled.value) {
      alignPaperFirstEnabled.value = false
      try { localStorage.setItem('setting:alignPaperFirstEnabled', '0') } catch {}
    }
    try { localStorage.setItem('setting:alignLeftEnabled', alignLeftEnabled.value ? '1' : '0') } catch {}
    return alignLeftEnabled.value
  }

  function saveAlignPaperFirst(v: boolean) {
    alignPaperFirstEnabled.value = !!v
    if (alignPaperFirstEnabled.value) {
      alignLeftEnabled.value = false
      try { localStorage.setItem('setting:alignLeftEnabled', '0') } catch {}
    }
    try { localStorage.setItem('setting:alignPaperFirstEnabled', alignPaperFirstEnabled.value ? '1' : '0') } catch {}
    return alignPaperFirstEnabled.value
  }

  function saveAnswerAlign(v: boolean) {
    answerAlignEnabled.value = !!v
    try { localStorage.setItem('setting:answerAlignEnabled', answerAlignEnabled.value ? '1' : '0') } catch {}
    return answerAlignEnabled.value
  }

  function savePaperAlignRef(paperId: number | null | undefined, bounds: AlignBounds | null) {
    if (paperId == null) return
    const key = String(paperId)
    const next: PaperAlignRef =
      paperAlignRef.value && typeof paperAlignRef.value === 'object'
        ? { ...paperAlignRef.value }
        : {}
    if (!bounds) {
      delete next[key]
    } else {
      next[key] = bounds
    }
    paperAlignRef.value = next
    try { localStorage.setItem('setting:paperAlignRef', JSON.stringify(next)) } catch {}
  }

  function saveDarkImageInvert(v: boolean) {
    darkImageInvert.value = !!v
    try { localStorage.setItem('setting:darkImageInvert', darkImageInvert.value ? '1' : '0') } catch {}
    syncInvertClass()
    return darkImageInvert.value
  }

  function syncInvertClass() {
    document.documentElement.classList.toggle('img-invert', darkImageInvert.value)
  }

  function saveOcrAuto(v: boolean) {
    ocrAutoEnabled.value = !!v
    try { localStorage.setItem('setting:ocrAutoEnabled', ocrAutoEnabled.value ? '1' : '0') } catch {}
    return ocrAutoEnabled.value
  }

  function saveOcrMinHeight(v: number) {
    ocrMinHeightPx.value = clampInt(v, 0, 2000)
    try { localStorage.setItem('setting:ocrMinHeightPx', String(ocrMinHeightPx.value)) } catch {}
    return ocrMinHeightPx.value
  }

  function saveOcrYPadding(v: number) {
    ocrYPaddingPx.value = clampInt(v, 0, 500)
    try { localStorage.setItem('setting:ocrYPaddingPx', String(ocrYPaddingPx.value)) } catch {}
    return ocrYPaddingPx.value
  }

  function saveFilterVirtualThreshold(v: number) {
    filterVirtualThreshold.value = clampInt(v, 1, 200)
    try { localStorage.setItem('setting:filterVirtualThreshold', String(filterVirtualThreshold.value)) } catch {}
    return filterVirtualThreshold.value
  }

  function saveFilterVirtualOverscanPx(v: number) {
    filterVirtualOverscanPx.value = clampInt(v, 0, 5000)
    try { localStorage.setItem('setting:filterVirtualOverscanPx', String(filterVirtualOverscanPx.value)) } catch {}
    return filterVirtualOverscanPx.value
  }

  function saveToStorage() {
    saveAlignLeft(alignLeftEnabled.value)
    saveAlignPaperFirst(alignPaperFirstEnabled.value)
    saveAnswerAlign(answerAlignEnabled.value)
    try { localStorage.setItem('setting:paperAlignRef', JSON.stringify(paperAlignRef.value || {})) } catch {}
    saveOcrAuto(ocrAutoEnabled.value)
    saveOcrMinHeight(ocrMinHeightPx.value)
    saveOcrYPadding(ocrYPaddingPx.value)
    saveFilterVirtualThreshold(filterVirtualThreshold.value)
    saveFilterVirtualOverscanPx(filterVirtualOverscanPx.value)
    saveFilmStripSectionDots(filmStripSectionDots.value)
  }

  function saveFilmStripSectionDots(v: boolean) {
    filmStripSectionDots.value = !!v
    try { localStorage.setItem('setting:filmStripSectionDots', filmStripSectionDots.value ? '1' : '0') } catch {}
    return filmStripSectionDots.value
  }

  async function runIntegrityCheck() {
    if (maintenanceBusy.value) return
    maintenanceBusy.value = true
    const appStore = useAppStore()
    try {
      const data = await api('/maintenance/questions_integrity')
      maintenanceIntegrityReport.value = data || null
      appStore.setStatus('完整性检查完成', 'ok')
    } catch (e) {
      appStore.setStatus(`完整性检查失败：${String(e)}`, 'err')
    } finally {
      maintenanceBusy.value = false
    }
  }

  async function runRepair(applyNow = false) {
    if (maintenanceBusy.value) return
    const payload = {
      dry_run: !applyNow,
      remove_orphan_boxes: !!maintenanceRemoveOrphanBoxes.value,
      fill_missing_question_no: !!maintenanceFillMissingQuestionNo.value,
      renumber_question_no_sequence: !!maintenanceRenumberQuestionNo.value,
    }
    if (applyNow) {
      const t = i18n.global.t
      const ok = await useDialogStore().confirm(t('settings.maintenance.repairConfirm'), {
        title: t('settings.maintenance.repairConfirmTitle'),
        confirmText: t('settings.maintenance.repairConfirmButton'),
        danger: true,
      })
      if (!ok) return
    }
    maintenanceBusy.value = true
    const appStore = useAppStore()
    try {
      const data = await api('/maintenance/questions_repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      maintenanceRepairReport.value = data?.report || null
      appStore.setStatus(applyNow ? '数据修复已执行' : '干跑完成（未落库）', 'ok')
      await runIntegrityCheck()
    } catch (e) {
      appStore.setStatus(`${applyNow ? '数据修复' : '干跑'}失败：${String(e)}`, 'err')
    } finally {
      maintenanceBusy.value = false
    }
  }

  return {
    // alignment
    alignLeftEnabled,
    alignPaperFirstEnabled,
    answerAlignEnabled,
    paperAlignRef,
    // filter virtual
    filterVirtualThreshold,
    filterVirtualOverscanPx,
    // maintenance
    maintenanceBusy,
    maintenanceDryRun,
    maintenanceRemoveOrphanBoxes,
    maintenanceFillMissingQuestionNo,
    maintenanceRenumberQuestionNo,
    maintenanceIntegrityReport,
    maintenanceRepairReport,
    // appearance
    darkImageInvert,
    filmStripSectionDots,
    // OCR
    ocrAutoEnabled,
    ocrMinHeightPx,
    ocrYPaddingPx,
    // actions
    loadFromStorage,
    saveToStorage,
    saveAlignLeft,
    saveAlignPaperFirst,
    saveAnswerAlign,
    savePaperAlignRef,
    saveDarkImageInvert,
    saveFilmStripSectionDots,
    saveOcrAuto,
    saveOcrMinHeight,
    saveOcrYPadding,
    saveFilterVirtualThreshold,
    saveFilterVirtualOverscanPx,
    runIntegrityCheck,
    runRepair,
  }
})
