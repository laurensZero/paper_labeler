// 样式审计：程序化断言 web 关键计算样式 == 管理端规格值
import { chromium } from '@playwright/test'

const BASE = process.env.WEB_BASE || 'http://localhost:4173'
const results = []
function chk(name, actual, expected) {
  const pass = String(actual) === String(expected)
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}: ${actual}${pass ? '' : ` (期望 ${expected})`}`)
  if (!pass) process.exitCode = 1
}

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('#email', 'admin@paperlabeler.test')
  await page.fill('#password', 'Cloud-Test-2026!')
  await page.click('button[type=submit]')
  await page.waitForURL('**/bank', { timeout: 15000 })
  await page.waitForSelector('.fs-item', { timeout: 15000 })
  await page.waitForTimeout(1500)

  const a = await page.evaluate(() => {
    const g = (sel, props, el = document) => {
      const n = typeof sel === 'string' ? el.querySelector(sel) : sel
      if (!n) return null
      const cs = getComputedStyle(n)
      return Object.fromEntries(props.map((p) => [p, cs[p]]))
    }
    const topbar = g('.topbar', ['height', 'backgroundColor', 'borderBottomColor', 'borderBottomWidth'])
    const toolbar = g('.bank-toolbar', ['backgroundColor', 'borderBottomWidth', 'borderBottomColor', 'borderRadius', 'borderTopWidth', 'boxShadow'])
    const heroHead = document.querySelectorAll('.bank-question-head').length
    const imgs = g('.bank-question-imgs', ['borderRadius', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'gap'])
    const img0 = g('.bank-question-imgs img', ['borderTopWidth', 'borderRadius'])
    const info = g('.bank-info', ['width', 'borderLeftWidth', 'borderLeftColor', 'backgroundColor', 'borderRadius', 'marginTop'])
    const infoK = g('.bank-info-k', ['fontSize', 'fontWeight', 'textTransform', 'color'])
    const qno = g('.bank-info-qno', ['fontSize', 'fontWeight'])
    const qnoText = document.querySelector('.bank-info-qno')?.textContent
    const stripCount = document.querySelector('.bank-strip-count')?.textContent
    const fs0 = g('.fs-item:not(.fs-item--active):not(.fs-item--fav)', ['backgroundColor', 'borderRadius', 'borderColor', 'paddingTop'])
    const fsNo = g('.fs-item:not(.fs-item--active) .fs-item-no', ['fontSize', 'fontWeight', 'color'])
    const fsActive = g('.fs-item--active', ['backgroundColor', 'borderColor'])
    const navActive = g('.nav-link.active', ['backgroundColor', 'fontSize', 'fontWeight'])
    const cascade = document.querySelector('.bank-ctl--cascade')?.getBoundingClientRect().width
    const answerRow = [...document.querySelectorAll('.bank-info-row')].find((r) => r.querySelector('button')?.textContent.includes('显示答案'))
    const bodyBg = getComputedStyle(document.body).backgroundColor
    const heroPad = g('.bank-hero', ['paddingTop', 'paddingLeft', 'backgroundColor', 'borderTopWidth'])
    const titlePad = g('.bank-info > .card-title', ['paddingLeft', 'paddingTop'])
    const feedbackPad = g('.bank-info > .bank-feedback', ['paddingLeft', 'paddingTop'])
    const hintPad = g('.bank-info > .muted', ['paddingLeft', 'paddingBottom'])
    const rowPad = g('.bank-info-row', ['paddingLeft', 'paddingTop'])
    return { topbar, toolbar, heroHead, imgs, img0, info, infoK, qno, qnoText, stripCount, fs0, fsNo, fsActive, navActive, cascade, answerRow: !!answerRow, bodyBg, heroPad, titlePad, feedbackPad, hintPad, rowPad }
  })

  chk('顶栏高度', a.topbar?.height, '36px')
  chk('顶栏背景', a.topbar?.backgroundColor, 'rgb(250, 250, 250)')
  chk('工具栏底边线色', a.toolbar?.borderBottomColor, 'rgb(228, 228, 231)')
  chk('工具栏底边线宽', a.toolbar?.borderBottomWidth, '1px')
  chk('工具栏圆角', a.toolbar?.borderRadius, '16px')
  chk('工具栏无顶边线', a.toolbar?.borderTopWidth, '0px')
  chk('主区题号头已删', a.heroHead, 0)
  chk('题图容器圆角', a.imgs?.borderRadius, '20px')
  chk('题图容器背景', a.imgs?.backgroundColor, 'rgb(255, 255, 255)')
  chk('题图容器无间隙', a.imgs?.gap, '0px')
  chk('题图无边框', a.img0?.borderTopWidth, '0px')
  chk('信息卡宽', a.info?.width, '280px')
  chk('信息卡左边线', a.info?.borderLeftWidth, '1px')
  chk('信息卡圆角卡', `${a.info?.borderRadius}/${a.info?.marginTop}`, '16px/8px')
  chk('信息标签 11px 大写', `${a.infoK?.fontSize}/${a.infoK?.fontWeight}/${a.infoK?.textTransform}`, '11px/600/uppercase')
  chk('信息卡题号 28px', a.qno?.fontSize, '28px')
  chk('信息卡题号无#', a.qnoText?.startsWith('#'), false)
  chk('信息卡含答案行', a.answerRow, true)
  chk('filmstrip 计数 N 题', /^\d+ 题$/.test(a.stripCount?.trim() ?? ''), true)
  chk('fs 胶囊白底', a.fs0?.backgroundColor, 'rgb(255, 255, 255)')
  chk('fs 圆角 8px', a.fs0?.borderRadius, '8px')
  chk('fs 题号 13px/500', `${a.fsNo?.fontSize}/${a.fsNo?.fontWeight}`, '13px/500')
  chk('fs active indigo 边', a.fsActive?.borderColor, 'rgb(79, 70, 229)')
  chk('fs active 底色', a.fsActive?.backgroundColor, 'rgba(79, 70, 229, 0.08)')
  chk('导航 active 灰底', a.navActive?.backgroundColor, 'rgb(235, 235, 235)')
  chk('导航 active 字号', a.navActive?.fontSize, '12px')
  chk('级联选择器宽 180', Math.round(a.cascade ?? 0), 180)
  chk('页面底色 #fafafa', a.bodyBg, 'rgb(250, 250, 250)')
  chk('主区内边距 16/20', `${a.heroPad?.paddingTop}/${a.heroPad?.paddingLeft}`, '16px/20px')
  chk('信息卡标题内边距', `${a.titlePad?.paddingTop}/${a.titlePad?.paddingLeft}`, '16px/16px')
  chk('信息卡反馈内边距', `${a.feedbackPad?.paddingTop}/${a.feedbackPad?.paddingLeft}`, '12px/16px')
  chk('信息卡提示内边距', `${a.hintPad?.paddingLeft}/${a.hintPad?.paddingBottom}`, '16px/16px')
  chk('信息行内边距', `${a.rowPad?.paddingTop}/${a.rowPad?.paddingLeft}`, '12px/16px')

  // 组卷页（先建一个方案进到工作区）
  await page.goto(`${BASE}/compose`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const newBtn = page.locator('button:has-text("新建方案")')
  if (await newBtn.count()) {
    await newBtn.click()
    await page.fill('.cv-new-row input', `审计 ${Date.now()}`)
    await page.click('.cv-new-row button:has-text("新建")')
    await page.waitForURL('**/compose/**', { timeout: 10000 })
    await page.waitForSelector('.cv-toolbar', { timeout: 10000 })
  }
  await page.waitForTimeout(600)
  const c = await page.evaluate(() => {
    const g = (sel, props) => {
      const n = document.querySelector(sel)
      if (!n) return null
      const cs = getComputedStyle(n)
      return Object.fromEntries(props.map((p) => [p, cs[p]]))
    }
    return {
      toolbar: g('.cv-toolbar', ['borderBottomWidth', 'borderBottomColor', 'backgroundColor', 'borderTopWidth', 'borderRadius']),
      bankPanel: g('.cv-panel--bank', ['width', 'backgroundColor']),
      propsPanel: g('.cv-panel--props', ['width', 'backgroundColor']),
      header: g('.cv-panel-header', ['textTransform', 'fontSize', 'fontWeight', 'color']),
      modeToggle: g('.cv-mode-toggle', ['backgroundColor', 'borderRadius', 'borderTopWidth']),
    }
  })
  chk('组卷工具栏底线', `${c.toolbar?.borderBottomWidth} ${c.toolbar?.borderBottomColor}`, '1px rgb(228, 228, 231)')
  chk('组卷工具栏无外框', `${c.toolbar?.borderTopWidth}/${c.toolbar?.borderRadius}`, '0px/16px')
  chk('左栏 280px 灰底', `${c.bankPanel?.width}/${c.bankPanel?.backgroundColor}`, '280px/rgb(250, 250, 250)')
  chk('右栏 260px 灰底', `${c.propsPanel?.width}/${c.propsPanel?.backgroundColor}`, '260px/rgb(250, 250, 250)')
  chk('面板头大写 12px', `${c.header?.textTransform}/${c.header?.fontSize}/${c.header?.fontWeight}`, 'uppercase/12px/600')
  chk('模式切换灰槽', `${c.modeToggle?.backgroundColor}/${c.modeToggle?.borderRadius}/${c.modeToggle?.borderTopWidth}`, 'rgb(244, 244, 245)/6px/0px')

  // 导出弹窗（有卷才有按钮？题库页开）
  await page.goto(`${BASE}/bank`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fs-item', { timeout: 15000 })
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  const m = await page.evaluate(() => {
    const g = (sel, props) => {
      const n = document.querySelector(sel)
      if (!n) return null
      const cs = getComputedStyle(n)
      return Object.fromEntries(props.map((p) => [p, cs[p]]))
    }
    return {
      overlay: g('.cv-modal-overlay', ['backgroundColor']),
      modal: g('.cv-modal', ['borderRadius', 'borderTopWidth', 'borderTopColor', 'backgroundColor', 'boxShadow']),
      header: g('.cv-modal-header', ['paddingTop', 'borderBottomWidth']),
      title: g('.cv-modal-header h3', ['fontSize', 'fontWeight']),
      body: g('.cv-modal-body', ['paddingTop', 'paddingLeft']),
      footer: g('.cv-modal-footer', ['borderTopWidth', 'borderTopColor', 'paddingTop']),
      tabs: g('.ex-tabs', ['backgroundColor', 'borderRadius', 'padding']),
      tabActive: g('.ex-tabs button.active', ['backgroundColor', 'fontSize', 'boxShadow']),
      tabIdle: g('.ex-tabs button:not(.active)', ['backgroundColor', 'color']),
    }
  })
  chk('遮罩 rgba(0,0,0,.38)', m.overlay?.backgroundColor, 'rgba(0, 0, 0, 0.38)')
  chk('弹窗 16px 圆角带边', `${m.modal?.borderRadius}/${m.modal?.borderTopWidth}/${m.modal?.borderTopColor}`, '16px/1px/rgb(228, 228, 231)')
  chk('弹窗标题 15px', `${m.title?.fontSize}/${m.title?.fontWeight}`, '15px/650')
  chk('弹窗头无下边线', m.header?.borderBottomWidth, '0px')
  chk('弹窗体 padding', `${m.body?.paddingTop}/${m.body?.paddingLeft}`, '8px/20px')
  chk('弹窗脚上边线', `${m.footer?.borderTopWidth}/${m.footer?.borderTopColor}`, '1px/rgb(228, 228, 231)')
  chk('页签灰槽', `${m.tabs?.backgroundColor}/${m.tabs?.borderRadius}`, 'rgb(244, 244, 245)/6px')
  chk('页签激活态', `${m.tabActive?.backgroundColor}/${m.tabActive?.fontSize}`, 'rgb(255, 255, 255)/12px')
  chk('页签非激活透明', m.tabIdle?.backgroundColor, 'rgba(0, 0, 0, 0)')
} catch (e) {
  console.error('AUDIT ERROR', e)
  process.exitCode = 1
} finally {
  await browser.close()
}
console.log(results.join('\n'))
console.log(process.exitCode ? '\nAUDIT FAILED' : '\nAUDIT ALL PASS')
