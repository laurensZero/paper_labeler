// web/ 端到端冒烟：登录 → 题库（含 R2 图片） → 组卷建卷加题 → 清理
// 运行（先 npm run build && npm run preview）：node tests/e2e.mjs
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(__dir, 'shots')
mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.WEB_BASE || 'http://localhost:4173'
const EMAIL = process.env.WEB_TEST_EMAIL || 'admin@paperlabeler.test'
const PASS = process.env.WEB_TEST_PASS || 'Cloud-Test-2026!'

const results = []
function ok(name, detail = '') {
  results.push(`PASS ${name}${detail ? ' — ' + detail : ''}`)
  console.log(results[results.length - 1])
}
function fail(name, detail = '') {
  results.push(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  console.error(results[results.length - 1])
  throw new Error(`${name}: ${detail}`)
}

async function launch() {
  try {
    return await chromium.launch({ channel: 'chrome' })
  } catch {
    return await chromium.launch()
  }
}

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('dialog', (d) => void d.accept())

try {
  // 1. 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: join(SHOTS, '1-login.png') })
  await page.fill('#email', EMAIL)
  await page.fill('#password', PASS)
  await page.click('button[type=submit]')
  await page.waitForURL('**/bank', { timeout: 15000 })
  ok('登录并跳转题库')

  // 1b. 多语言：中文 → English → 中文
  let navText = (await page.locator('.nav-link').first().textContent()) || ''
  if (!navText.includes('题库')) fail('中文文案', `导航为 ${navText}`)
  await page.selectOption('.lang-select', 'en')
  await page.waitForTimeout(300)
  navText = (await page.locator('.nav-link').first().textContent()) || ''
  if (!navText.includes('Question Bank')) fail('English 文案', `导航为 ${navText}`)
  // 「显示答案」按管理端布局放在右侧信息卡（等题目加载选中后再查）
  await page.waitForSelector('.bank-info', { timeout: 15000 })
  const btnTexts = await page.locator('.bank-info button').allTextContents()
  if (!btnTexts.some((x) => x.trim() === 'Show answers')) fail('English 按钮', `按钮=[${btnTexts.join('|')}]`)
  await page.selectOption('.lang-select', 'zh-CN')
  await page.waitForTimeout(300)
  navText = (await page.locator('.nav-link').first().textContent()) || ''
  if (!navText.includes('题库')) fail('切回中文', `导航为 ${navText}`)
  ok('多语言切换', 'zh-CN ⇄ English 双向生效且持久化')

  // 2. 题库：filmstrip + 大题图 + R2 图片真实加载
  await page.waitForSelector('.bank', { timeout: 15000 })
  await page.waitForSelector('.fs-item', { timeout: 15000 })
  const stripCount = await page.locator('.fs-item').count()
  if (stripCount < 1) fail('filmstrip 条目', '0 个')
  await page.waitForSelector('.bank-question-imgs img', { timeout: 15000 })
  // 等所有大题图真正加载完成（比固定 sleep 稳）
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('.bank-question-imgs img')]
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.classList.contains('is-loaded'))
      },
      { timeout: 15000 },
    )
    .catch(() => {})
  const img = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.bank-question-imgs img')]
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      skeletonCleared: imgs.filter((i) => i.classList.contains('is-loaded')).length,
    }
  })
  if (img.total === 0 || img.loaded !== img.total) fail('大题图加载', JSON.stringify(img))
  if (img.skeletonCleared !== img.total) fail('图片骨架', `is-loaded ${img.skeletonCleared}/${img.total}`)
  const dotCount = await page.locator('.fs-item-dot, .bank-dot').count()
  if (dotCount !== 0) fail('分类色点已关闭', `${dotCount} 个色点`)
  ok('题库布局', `filmstrip ${stripCount} 条, 图片 ${img.loaded}/${img.total}, 骨架已清除, 无色点`)

  // 2a. 四个选择器必须排在同一行
  const ctlTops = await page.evaluate(() =>
    [...document.querySelectorAll('.bank-toolbar .bank-ctl')].map((e) => Math.round(e.getBoundingClientRect().top)),
  )
  if (ctlTops.length < 4) fail('工具栏控件数', `仅 ${ctlTops.length}`)
  if (new Set(ctlTops).size !== 1) fail('工具栏一行排版', `top=${JSON.stringify(ctlTops)}`)
  ok('工具栏一行排版', `4 个选择器 top=${ctlTops[0]}`)
  await page.screenshot({ path: join(SHOTS, '2-bank.png') })

  // 2b. 方向键：无需先点击条；底部条跟随滚动
  const firstActive = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const afterKey = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  if (afterKey === firstActive) fail('全局方向键', '未点击条时 ArrowRight 无效')
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(900)
  const stripScroll = await page.evaluate(() => document.querySelector('.bank-strip-scroll')?.scrollLeft ?? 0)
  if (stripScroll <= 0) fail('条滚动跟随', `scrollLeft=${stripScroll}`)
  const beforeClick = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  await page.locator('.fs-item').nth(2).click()
  await page.waitForTimeout(300)
  const afterClick = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  if (afterClick === beforeClick) fail('filmstrip 点击切换', 'active 未变化')
  ok('方向键与滚动跟随', `key ${firstActive}→${afterKey}, scrollLeft=${Math.round(stripScroll)}, click ${beforeClick}→${afterClick}`)

  // 2c. 焦点在 select 上时按方向键也应翻题（自动 blur）
  await page.locator('.bank-check input').focus()
  const beforeSel = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const afterSel = await page.locator('.fs-item--active').getAttribute('data-fs-id')
  if (afterSel === beforeSel) fail('select 焦点方向键', '焦点在 select 上时未翻题')
  ok('select 焦点不吞方向键', `${beforeSel} → ${afterSel}`)

  // 2d. 显示答案（只读视图，允许"未标注答案"）
  await page.click('button:has-text("显示答案")')
  await page.waitForTimeout(800)
  const ansVisible = (await page.locator('.bank-answer').count()) > 0
  if (!ansVisible) fail('显示答案面板', '未出现')
  ok('显示答案面板')
  await page.click('button:has-text("隐藏答案")')

  // 2d2. 题目反馈：提交 → 出现在我的反馈列表
  await page.fill('.bank-feedback textarea', 'E2E 反馈：这题印刷有点糊')
  await page.click('.bank-feedback button:has-text("提交反馈")')
  await page.waitForSelector('.bank-feedback-item', { timeout: 8000 })
  const fbText = (await page.locator('.bank-feedback-item').first().textContent()) || ''
  if (!fbText.includes('E2E 反馈')) fail('题目反馈内容', fbText)
  ok('题目反馈提交', '提交后立即出现在列表')

  // 3. 级联筛选：大分类 → 小分类
  await page.click('.bank-ctl--cascade .scs-trigger')
  await page.waitForSelector('.scs-dropdown', { timeout: 5000 })
  const groupCount = await page.locator('.scs-group-row').count()
  if (groupCount < 2) fail('级联分组', `仅 ${groupCount} 个分组（应含模块+分类组）`)
  // 选一个真实存在的小分类（跳过 全部模块/未分类）
  const itemLoc = page.locator('.scs-dropdown .scs-item')
  const n = await itemLoc.count()
  let picked = false
  for (let i = 0; i < n; i++) {
    const txt = (await itemLoc.nth(i).textContent()) || ''
    if (!txt.includes('全部') && !txt.includes('未分类')) {
      await itemLoc.nth(i).click()
      picked = true
      break
    }
  }
  if (!picked) {
    // 当前高亮组可能没有小分类，先点别的组
    await page.locator('.scs-group-row').nth(1).click()
    await page.locator('.scs-dropdown .scs-item').first().click()
  }
  await page.waitForTimeout(1000)
  const triggerText = await page.locator('.bank-ctl--cascade .scs-value').textContent()
  const err3 = await page.locator('.bank-hero .error-text').count()
  if (err3) fail('级联筛选', await page.locator('.bank-hero .error-text').first().textContent())
  if (!triggerText || triggerText.includes('全部模块')) fail('级联选中回显', `trigger=${triggerText}`)
  ok('级联筛选（大类-小类）', `${groupCount} 组, 选中「${triggerText}」`)
  await page.screenshot({ path: join(SHOTS, '3-bank-filtered.png') })
  // 复原
  await page.click('.bank-ctl--cascade .scs-trigger')
  await page.waitForSelector('.scs-dropdown', { timeout: 5000 })
  await page.locator('.scs-dropdown .scs-item').first().click()
  await page.waitForTimeout(600)

  // 3a. 导出可取消：进度出现后立刻取消，必须进入「已取消」状态
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  await page.click('.ex-modal button:has-text("开始导出")')
  await page.waitForSelector('.ex-progress', { timeout: 5000 })
  await page.click('.ex-modal button:has-text("取消导出")')
  await page.waitForSelector('.ex-cancelled', { timeout: 10000 })
  ok('导出可取消', '进度中取消 → 已取消导出')
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  // 3b. 题库快速导出：下载的文件必须是真 PDF，且页数 ≥ 1（防「导出空白」回归：
  //     R2 图片被 CORS 拦时 renderQuestion 不加页，产出 0 页空 PDF）
  const dl1Promise = page.waitForEvent('download', { timeout: 90000 })
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  await page.click('.ex-modal button:has-text("开始导出")')
  const dl1 = await dl1Promise
  const p1 = await dl1.path()
  const head1 = readFileSync(p1).subarray(0, 5).toString('latin1')
  if (head1 !== '%PDF-') fail('快速导出 PDF', `文件头=${head1}`)
  const { PDFDocument } = await import('pdf-lib')
  const doc1 = await PDFDocument.load(readFileSync(p1))
  const pages1 = doc1.getPageCount()
  if (pages1 < 1) fail('快速导出页数', `实际 ${pages1} 页（图片可能被 CORS 拦截）`)
  const done1 = await page.locator('.ex-done').textContent()
  const shown1 = Number(done1?.match(/(\d+)/)?.[1] ?? 0)
  if (shown1 !== pages1) fail('导出完成页数', `弹窗=${shown1} 实际=${pages1}`)
  ok('题库快速导出', `${dl1.suggestedFilename()} → %PDF- · ${pages1} 页`)
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  // 3c. 随机抽题（导出弹窗内页签）：抽 1 题 → 导出真 PDF
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  await page.click('.ex-tabs button:has-text("随机抽题")')
  await page.locator('.rnd-row input').first().fill('1')
  const dlR = page.waitForEvent('download', { timeout: 90000 })
  await page.click('.ex-modal button:has-text("开始导出")')
  const dl3 = await dlR
  const p3 = await dl3.path()
  const head3 = readFileSync(p3).subarray(0, 5).toString('latin1')
  if (head3 !== '%PDF-') fail('随机导出 PDF', `文件头=${head3}`)
  ok('随机抽题导出（弹窗内页签）', `${dl3.suggestedFilename()} → %PDF-`)
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  // 4. 组卷：空态 → 新建方案 → 加题 → 实时预览
  await page.goto(`${BASE}/compose`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.cv-empty', { timeout: 10000 })
  await page.click('.cv-empty button:has-text("新建方案")')
  const name = `E2E 测试卷 ${Date.now()}`
  await page.fill('.cv-new-row input', name)
  await page.click('.cv-new-row button:has-text("新建")')
  await page.waitForURL('**/compose/**', { timeout: 10000 })
  await page.waitForSelector('.cv-bank-item', { timeout: 15000 })

  // 左栏点击加题 → 中栏出现预览页
  await page.locator('.cv-bank-item').first().click()
  await page.waitForSelector('.cv-page', { timeout: 10000 })
  ok('建卷并加入题目（预览页出现）')

  // 点击预览页选中 → 右栏属性 → 插入空白页
  await page.locator('.cv-page').first().click()
  await page.waitForSelector('.cv-props-card:has-text("选中条目")', { timeout: 10000 })
  await page.click('button:has-text("在此之后插入空白页")')
  await page.waitForSelector('.cv-page--blank', { timeout: 10000 })
  ok('选中条目 + 插入空白页')

  // 实时预览：填试卷标题 → 封面页立即出现
  await page.fill('input[placeholder*="春季模拟卷"]', 'E2E 标题')
  await page.keyboard.press('Tab')
  await page.waitForSelector('.cv-page--cover', { timeout: 10000 })
  const coverTitle = await page.locator('.cv-cover-title').textContent()
  if (!coverTitle?.includes('E2E 标题')) fail('封面实时预览', `标题为 ${coverTitle}`)
  ok('封面实时预览', '标题即时反映到工作区')
  await page.screenshot({ path: join(SHOTS, '4-compose.png') })

  // 4b. 组卷导出：设置页直接导出，产出真 PDF
  const dl2Promise = page.waitForEvent('download', { timeout: 90000 })
  await page.click('.cv-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  await page.click('.ex-modal button:has-text("开始导出")')
  const dl2 = await dl2Promise
  const p2 = await dl2.path()
  const head2 = readFileSync(p2).subarray(0, 5).toString('latin1')
  if (head2 !== '%PDF-') fail('组卷导出 PDF', `文件头=${head2}`)
  ok('组卷导出', `${dl2.suggestedFilename()} → %PDF-`)
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  // 5. 打开方案弹窗 → 删除测试卷（清理）
  await page.click('button[title="打开方案"]')
  await page.waitForSelector('.cv-comp-item', { timeout: 10000 })
  const row = page.locator(`.cv-comp-item:has-text("${name}")`)
  await row.waitFor({ timeout: 10000 })
  await row.locator('button:has-text("删除")').click()
  await page.waitForSelector('.cv-empty', { timeout: 10000 })
  ok('删除测试卷（清理）')

  // 6. 多选导出（对齐管理端）：勾 2 题 → 弹窗显示「将导出 2 题」→ 真 PDF 且页数 ≥ 2
  await page.goto(`${BASE}/bank`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fs-item', { timeout: 15000 })
  await page.click('.bank-toolbar button:has-text("多选")')
  await page.locator('.fs-item').nth(0).click()
  await page.locator('.fs-item').nth(1).click()
  const selText = await page.locator('.bank-toolbar button:has-text("已选")').textContent()
  if (!selText?.includes('2')) fail('多选计数', `按钮文案=${selText}`)
  const checked = await page.locator('.fs-item--selected').count()
  if (checked !== 2) fail('多选勾选态', `.fs-item--selected=${checked}`)
  ok('多选勾选 2 题', selText.trim())
  await page.screenshot({ path: join(SHOTS, '5-multiselect.png') })

  const dl4Promise = page.waitForEvent('download', { timeout: 90000 })
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  const cntText = await page.locator('.ex-count').textContent()
  if (!cntText?.includes('2')) fail('导出题数提示', `.ex-count=${cntText}`)
  await page.click('.ex-modal button:has-text("开始导出")')
  const dl4 = await dl4Promise
  const p4 = await dl4.path()
  const head4 = readFileSync(p4).subarray(0, 5).toString('latin1')
  if (head4 !== '%PDF-') fail('多选导出 PDF', `文件头=${head4}`)
  const doc4 = await PDFDocument.load(readFileSync(p4))
  const pages4 = doc4.getPageCount()
  if (pages4 < 2) fail('多选导出页数', `选 2 题只出了 ${pages4} 页`)
  ok('多选导出（仅选中题）', `${cntText?.trim()} → ${dl4.suggestedFilename()} · ${pages4} 页`)
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  // 6b. 批量收藏：勾选题打星 → 缩略图收藏标记 +2；退出多选清空勾选
  await page.click('.bank-toolbar button:has-text("批量收藏")')
  await page.waitForFunction(
    () => document.querySelectorAll('.fs-item--fav.fs-item--selected').length === 2,
    { timeout: 10000 },
  )
  ok('批量收藏', '2 题缩略图出现收藏星标')
  await page.click('.bank-toolbar button:has-text("已选")')
  const cleared = await page.locator('.fs-item--selected').count()
  if (cleared !== 0) fail('退出多选', `仍残留 ${cleared} 个勾选`)
  ok('退出多选清空勾选')

  // 6c. 随机抽题「仅从收藏中抽」：勾选后每行库存总和必须收窄到收藏池
  await page.click('.bank-toolbar button:has-text("导出 PDF")')
  await page.waitForSelector('.ex-modal', { timeout: 5000 })
  await page.click('.ex-tabs button:has-text("随机抽题")')
  await page.waitForSelector('.rnd-stock', { timeout: 5000 })
  const sumStock = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.rnd-stock')].reduce(
        (s, el) => s + (parseInt(el.textContent.replace(/\D+/g, ''), 10) || 0),
        0,
      ),
    )
  const stockBefore = await sumStock()
  await page.locator('.rnd-toolbar input[type="checkbox"]').check()
  await page.waitForTimeout(400)
  const stockAfter = await sumStock()
  if (!(stockAfter > 0 && stockAfter < stockBefore)) {
    fail('仅从收藏中抽', `库存总和 ${stockBefore} → ${stockAfter}（应收窄且非 0）`)
  }
  ok('仅从收藏中抽（库存收窄）', `${stockBefore} → ${stockAfter}`)
  await page.click('.ex-modal button:has-text("关闭")')
  await page.waitForSelector('.ex-modal', { state: 'detached', timeout: 5000 })

  console.log('\nALL PASS')
  process.exitCode = 0
} catch (e) {
  console.error('\nE2E FAILED:', e.message)
  await page.screenshot({ path: join(SHOTS, '9-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
