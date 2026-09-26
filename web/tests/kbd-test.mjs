import { chromium } from "@playwright/test";
const b = await (async () => { try { return await chromium.launch({ channel: "chrome" }) } catch { return await chromium.launch() } })();
const p = await b.newPage();
await p.goto("http://localhost:4173/login", { waitUntil: "networkidle" });
await p.fill("#email", "admin@paperlabeler.test");
await p.fill("#password", "Cloud-Test-2026!");
await p.click("button[type=submit]");
await p.waitForURL("**/bank");
await p.waitForSelector(".fs-item");
await p.waitForTimeout(500);

const active = () => p.locator(".fs-item--active").getAttribute("data-fs-id");
console.log("initial active:", await active());

// A. 完全不点击，直接按方向键
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(200);
console.log("after ArrowRight (no click):", await active());

// B. 点击大题图区后再按
await p.locator(".bank-question-imgs img").first().click();
await p.waitForTimeout(100);
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(200);
console.log("after click hero + ArrowRight:", await active());

// C. 点击筛选 select 后按（焦点陷阱？）
await p.locator(".bank-toolbar .select").first().click();
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(200);
console.log("focus on select + ArrowRight:", await active());

// D. 条是否随选中滚动（scrollLeft 变化）
const info = await p.evaluate(() => {
  const s = document.querySelector(".bank-strip-scroll");
  return { scrollLeft: s?.scrollLeft, scrollWidth: s?.scrollWidth, clientWidth: s?.clientWidth };
});
console.log("strip scroll:", JSON.stringify(info));
// 连按右键 10 次看 scrollLeft 是否动
await p.locator(".bank-toolbar .select").first().blur();
for (let i = 0; i < 10; i++) await p.keyboard.press("ArrowRight");
await p.waitForTimeout(400);
const info2 = await p.evaluate(() => document.querySelector(".bank-strip-scroll")?.scrollLeft);
console.log("after 10 rights scrollLeft:", info2, "active:", await active());
await b.close();
