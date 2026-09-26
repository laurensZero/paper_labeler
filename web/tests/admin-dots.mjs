import { chromium } from "@playwright/test";
const b = await (async () => { try { return await chromium.launch({ channel: "chrome" }) } catch { return await chromium.launch() } })();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.addInitScript(() => localStorage.setItem("setting:filmStripSectionDots", "0"));
await p.goto("http://127.0.0.1:8766/ui/filter", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
const dots1 = await p.locator(".ws-filmstrip .fs-item-dot").count();
console.log("filter dots with setting=0:", dots1);
await p.goto("http://127.0.0.1:8766/ui/settings", { waitUntil: "networkidle" });
await p.waitForTimeout(800);
const checked = await p.locator('input[type="checkbox"]').nth(2).isChecked().catch(() => "n/a");
// 找到题库条色点开关
const labels = await p.locator(".card").allTextContents();
const hasToggle = labels.some((t) => t.includes("题库条显示分类颜色"));
console.log("settings has dots toggle:", hasToggle);
// 开关状态
const toggleState = await p.evaluate(() => localStorage.getItem("setting:filmStripSectionDots"));
console.log("localStorage after load:", toggleState);
// 打开组卷页看 bank dots
await p.goto("http://127.0.0.1:8766/ui/compose", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
const composeDots = await p.locator(".bank-item-dot").count();
console.log("compose bank dots with setting=0:", composeDots);
await b.close();
