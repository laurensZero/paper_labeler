// 双端像素对比截图：web (4173) + 管理端 (5175)
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('tests/shots/cmp', { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())

async function shotWeb() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:4173/login', { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'tests/shots/cmp/web-login.png' })
  await page.fill('#email', 'admin@paperlabeler.test')
  await page.fill('#password', 'Cloud-Test-2026!')
  await page.click('button[type=submit]')
  await page.waitForURL('**/bank', { timeout: 15000 })
  // 等题图全部加载完（骨架 is-loaded）
  await page
    .waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.bank-question-imgs img')]
      return imgs.length > 0 && imgs.every((i) => i.classList.contains('is-loaded'))
    }, { timeout: 30000 })
    .catch(() => {})
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'tests/shots/cmp/web-bank.png' })
  // 打开答案
  await page.click('.bank-toolbar button:has-text("显示答案")').catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'tests/shots/cmp/web-bank-answer.png' })
  await page.goto('http://localhost:4173/compose', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'tests/shots/cmp/web-compose-empty.png' })
  // 建个卷看三栏（复用已有方案或新建）
  const newBtn = page.locator('button:has-text("新建方案")')
  if (await newBtn.count()) {
    await newBtn.click()
    await page.fill('.cv-new-row input', `截图 ${Date.now()}`)
    await page.click('.cv-new-row button:has-text("新建")')
    await page.waitForURL('**/compose/**', { timeout: 10000 })
    await page.waitForSelector('.cv-bank-item', { timeout: 15000 })
    await page.locator('.cv-bank-item').first().click()
    await page.waitForSelector('.cv-page', { timeout: 10000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'tests/shots/cmp/web-compose.png' })
  }
  await page.close()
}

async function shotAdmin() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:5175/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'tests/shots/cmp/admin-landing.png' })
  // 找筛选/题库导航
  for (const label of ['筛选', '题库', 'Filter', 'Question']) {
    const link = page.locator(`.nav-item:has-text("${label}"), .titlebar-nav-item:has-text("${label}")`)
    if (await link.count()) {
      await link.first().click()
      await page.waitForTimeout(2500)
      break
    }
  }
  await page.screenshot({ path: 'tests/shots/cmp/admin-filter.png' })
  // 组卷（左侧栏 nav-item）
  const composeLink = page.locator('.sidebar .nav-item:has-text("组卷")').first()
  if (await composeLink.count()) {
    await composeLink.click()
    await page.waitForTimeout(3000)
  }
  await page.screenshot({ path: 'tests/shots/cmp/admin-compose.png' })
  await page.close()
}

try {
  await shotWeb()
  console.log('web shots done')
  await shotAdmin()
  console.log('admin shots done')
} catch (e) {
  console.error('SHOT FAIL', e)
  process.exitCode = 1
} finally {
  await browser.close()
}
