import { chromium } from "@playwright/test";
const b = await (async () => { try { return await chromium.launch({ channel: "chrome" }) } catch { return await chromium.launch() } })();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.addInitScript(() => localStorage.setItem("setting:filmStripSectionDots", "1"));
await p.goto("http://127.0.0.1:8766/ui/filter", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log("filter dots ON:", await p.locator(".ws-filmstrip .fs-item-dot").count());

await p.goto("http://127.0.0.1:8766/ui/settings", { waitUntil: "networkidle" });
await p.waitForTimeout(800);
// 找到含“题库条显示分类颜色”的行，点它的 toggle
const row = p.locator("div").filter({ hasText: "题库条显示分类颜色" }).last();
const cb = p.locator('label.toggle input').filter({ has: p.locator("") });
// 直接通过文本定位行内的 toggle checkbox
const toggles = p.locator("label.toggle");
const n = await toggles.count();
let clicked = false;
for (let i = 0; i < n; i++) {
  const txt = await toggles.nth(i).evaluate((el) => el.parentElement?.textContent || "");
  if (txt.includes("题库条显示分类颜色")) { await toggles.nth(i).locator("input").click({ force: true }); clicked = true; break; }
}
console.log("toggle clicked:", clicked, "ls =", await p.evaluate(() => localStorage.getItem("setting:filmStripSectionDots")));
await p.waitForTimeout(300);

await p.goto("http://127.0.0.1:8766/ui/filter", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
console.log("filter dots after toggle OFF:", await p.locator(".ws-filmstrip .fs-item-dot").count());

await p.goto("http://127.0.0.1:8766/ui/compose", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log("compose bank items:", await p.locator(".bank-item").count(), "dots:", await p.locator(".bank-item-dot").count());
await b.close();
