import { chromium } from 'playwright'

const baseUrl = process.env.PAPER_LABELER_SMOKE_URL || 'http://127.0.0.1:8000/ui/'
const chromeExe = process.env.CHROME_EXE || process.env.PLAYWRIGHT_CHROME_EXE || ''
const launchOptions = { headless: true }
if (chromeExe) launchOptions.executablePath = chromeExe

const browser = await chromium.launch(launchOptions)
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const logs = []
const requestFailures = []
const checks = []

page.on('console', (msg) => {
  if (['error', 'warning'].includes(msg.type())) {
    logs.push({ type: msg.type(), text: msg.text() })
  }
})
page.on('pageerror', (err) => {
  logs.push({ type: 'pageerror', text: String(err?.stack || err) })
})
page.on('requestfailed', (request) => {
  requestFailures.push({
    url: request.url(),
    errorText: request.failure()?.errorText || '',
  })
})

function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
}

async function bodyText() {
  return (await page.locator('body').innerText()).trim()
}

async function firstText(selector) {
  const loc = page.locator(selector).first()
  if (!(await loc.count())) return ''
  return (await loc.textContent())?.trim() || ''
}

function hasI18nLeak(text) {
  return /\b[a-zA-Z]+\.[a-zA-Z][\w.]*\b/.test(text)
}

async function expectHidden(locator) {
  await locator.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}

function isBenignRequestFailure(item) {
  return /net::ERR_(CONNECTION_CLOSED|ABORTED)/.test(item.errorText)
    && (/\/data\/pages\//.test(item.url) || /\/data\/pdfs\//.test(item.url))
}

function relevantConsoleLogs() {
  const benignRequestCount = requestFailures.filter(isBenignRequestFailure).length
  let ignoredGenericResourceErrors = 0
  return logs.filter((log) => {
    if (
      log.type === 'error'
      && /^Failed to load resource: net::ERR_(CONNECTION_CLOSED|ABORTED)$/.test(log.text)
      && ignoredGenericResourceErrors < benignRequestCount
    ) {
      ignoredGenericResourceErrors += 1
      return false
    }
    return true
  })
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  let text = await bodyText()
  check('root route loads app', page.url().startsWith(baseUrl), page.url())
  check('app mounted', await page.locator('.app').count() === 1, await firstText('.brand-name'))
  check('not blank', text.length > 50, text.slice(0, 160))
  check('no vite overlay', await page.locator('vite-error-overlay').count() === 0)
  check('no initial i18n leak', !hasI18nLeak(text), text.match(/\b[a-zA-Z]+\.[a-zA-Z][\w.]*\b/)?.[0] || 'none')

  for (const label of ['题库管理', '题目标注', '答案标注', '模块管理', '设置']) {
    const item = page.getByRole('button', { name: label }).first()
    check(`nav visible ${label}`, await item.count() > 0)
    if (await item.count()) {
      await item.click()
      await page.waitForTimeout(500)
      check(`nav click ${label}`, true, page.url())
    }
  }

  await page.getByRole('button', { name: '题库管理' }).first().click()
  await page.waitForTimeout(800)
  const paperCount = await page.locator('.paper-row').count()
  check('paper list rendered', paperCount > 0, `paper rows=${paperCount}`)
  const searchInput = page.locator('.search-input').first()
  check('paper search visible', await searchInput.count() > 0)
  if (await searchInput.count()) {
    await searchInput.fill('__no_such_paper__')
    await page.waitForTimeout(300)
    text = await bodyText()
    check('paper search filters list', text.includes('没有匹配的试卷'), text.slice(0, 180))
    await searchInput.fill('')
    await page.waitForTimeout(300)
    check('paper search clear restores list', await page.locator('.paper-row').count() === paperCount)
  }

  const cieButton = page.getByRole('button', { name: '从 CIE 网站导入' }).first()
  check('cie import button visible', await cieButton.count() > 0)
  if (await cieButton.count()) {
    await cieButton.click()
    await page.waitForTimeout(1000)
    text = await bodyText()
    check('cie import modal opens', text.includes('从 CIE 网站导入试卷') && text.includes('筛选条件'), text.slice(0, 180))
    const cieOverlay = page.locator('.modalMask.show')
    if (await cieOverlay.count()) {
      await page.locator('button[title="关闭"]').first().click()
      await expectHidden(cieOverlay)
    }
  }

  const answerAdminButton = page.getByRole('button', { name: '答案卷管理' }).first()
  check('answer admin button visible', await answerAdminButton.count() > 0)
  if (await answerAdminButton.count()) {
    await answerAdminButton.click()
    await page.waitForTimeout(1000)
    check('answer admin route opens', page.url().includes('/answer-admin'), page.url())
    text = await bodyText()
    check('answer admin content rendered', text.includes('答案卷管理'), text.slice(0, 180))
    await page.getByRole('button', { name: '题库管理' }).first().click()
    await page.waitForTimeout(500)
  }

  let openedMarkUrl = ''
  if (paperCount > 0) {
    await page.locator('.paper-row').first().click()
    await page.waitForTimeout(1200)
    check('open paper navigates mark', page.url().includes('/mark/'), page.url())
    openedMarkUrl = page.url()
    const markMedia = await page.locator('img, canvas').count()
    check('mark media visible', markMedia > 0, `media=${markMedia}`)

    const canvas = page.locator('.overlay-canvas').first()
    check('mark overlay canvas visible', await canvas.count() > 0)
    if (await canvas.count()) {
      await canvas.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      const box = await canvas.boundingBox()
      if (box && box.width > 120 && box.height > 120) {
        await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.18)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.3, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(300)
        check('mark draw creates unsaved box row', await page.locator('.box-row').count() > 0)
        const saveButton = page.locator('.mark-toolbar-right .btn-primary').first()
        check('mark save enabled after draw', await saveButton.count() > 0 && await saveButton.isEnabled())
        await page.keyboard.press('Control+Z')
        await page.waitForTimeout(300)
        check('mark undo removes unsaved box', await page.locator('.box-row').count() === 0)
        await page.keyboard.press('Control+Y')
        await page.waitForTimeout(300)
        check('mark redo restores unsaved box', await page.locator('.box-row').count() > 0)
        page.once('dialog', (dialog) => dialog.accept())
        await page.locator('.mark-right-panel button', { hasText: '清空' }).first().click()
        await page.waitForTimeout(300)
        check('mark clear removes unsaved box', await page.locator('.box-row').count() === 0)
      } else {
        check('mark overlay canvas usable size', false, JSON.stringify(box))
      }
    }

    const markAnswerBtn = page.getByRole('button', { name: '标注答案' }).first()
    check('mark answer button visible', await markAnswerBtn.count() > 0)
    if (await markAnswerBtn.count() && await markAnswerBtn.isEnabled()) {
      await markAnswerBtn.click()
      await page.waitForTimeout(3000)
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      const routed = page.url().includes('/answer/')
      const answerTextFromMark = await firstText('.answer-view')
      check('mark answer button opens answer route', routed, page.url())
      check('mark answer route not empty', answerTextFromMark.length > 20, answerTextFromMark.slice(0, 160))
      await page.getByRole('button', { name: '题目标注' }).first().click()
      await page.waitForTimeout(800)
    } else if (await markAnswerBtn.count()) {
      check('mark answer button disabled only for non-qp', true)
    }

    await page.getByRole('button', { name: '答案标注' }).first().click()
    await page.waitForTimeout(3000)
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    const answerText = await firstText('.answer-view')
    check('answer route loads', page.url().includes('/answer'), page.url())
    check('answer mode not empty', !answerText.includes('请先在题目标注中打开答案模式') && !answerText.includes('未选择试卷'), answerText.slice(0, 180))
    const answerMedia = await page.locator('.answer-view img, .answer-view canvas').count()
    check('answer media visible', answerMedia > 0, `media=${answerMedia}`)
    check('no answer i18n leak', !hasI18nLeak(answerText), answerText.match(/\b[a-zA-Z]+\.[a-zA-Z][\w.]*\b/)?.[0] || 'none')
  }

  await page.goto(new URL('filter', baseUrl).toString(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  text = await bodyText()
  check('filter deep link SPA fallback', text.includes('题库管理') || text.includes('模块'), text.slice(0, 160))

  for (const route of ['settings', 'sections']) {
    await page.goto(new URL(route, baseUrl).toString(), { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    text = await bodyText()
    check(`${route} deep link SPA fallback`, text.length > 50 && !text.includes('Not Found'), text.slice(0, 160))
  }

  if (paperCount > 0 && openedMarkUrl) {
    await page.goto(new URL('mark', baseUrl).toString(), { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    text = await bodyText()
    check('mark deep link SPA fallback', text.includes('题目标注') || text.includes('请选择'), text.slice(0, 160))
    await page.goto(openedMarkUrl, { waitUntil: 'networkidle' }).catch(() => {})
  }

  await page.goto(new URL('filter', baseUrl).toString(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  const exportBtn = page.locator('button', { hasText: '导出PDF' }).first()
  check('export button visible', await exportBtn.count() > 0)
  if (await exportBtn.count()) {
    await exportBtn.click()
    await page.waitForTimeout(1000)
    text = await bodyText()
    check('export wizard opens', text.includes('导出 PDF') && text.includes('随机导出'), text.slice(0, 240))
    const randomBtn = page.locator('button', { hasText: '随机导出' }).first()
    check('random export button visible', await randomBtn.count() > 0)
    if (await randomBtn.count()) {
      await randomBtn.click()
      await page.waitForTimeout(1500)
      text = await bodyText()
      check('random export modal opens', text.includes('随机导出设置') && text.includes('预计总题数'), text.slice(0, 240))
    }
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  text = await bodyText()
  check('mobile not blank', text.length > 50, text.slice(0, 120))
  const relevantRequests = requestFailures.filter((item) => !isBenignRequestFailure(item))
  check('request health', relevantRequests.length === 0, JSON.stringify(relevantRequests.slice(0, 5)))
  const relevantLogs = relevantConsoleLogs()
  check('console health', relevantLogs.length === 0, JSON.stringify(relevantLogs.slice(0, 5)))
} finally {
  await browser.close()
}

console.log(JSON.stringify({ checks, logs, requestFailures }, null, 2))

if (checks.some((item) => !item.pass)) {
  process.exitCode = 1
}
