// Keyboard / focus / title checks in a real browser. Uses the layout-only fixtures from mocks.mjs.
//   BASE_URL=... CHROMIUM_PATH=... CHROMIUM_ARGS='[...]' node scripts/ui-audit/interactions.mjs
import { chromium } from "playwright"
import fs from "node:fs"
import { mockSetup } from "./mocks.mjs"

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173"
const launchOpts = { headless: true }
if (process.env.CHROMIUM_PATH) {
  launchOpts.executablePath = process.env.CHROMIUM_PATH
  if (process.env.CHROMIUM_ARGS) launchOpts.args = JSON.parse(process.env.CHROMIUM_ARGS)
}
const results = []
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`) }

const browser = await chromium.launch(launchOpts)
const open = async (role, path, vp, scenario) => {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 1024 })
  const page = await ctx.newPage()
  await mockSetup(page, role, scenario)
  await page.goto(BASE + path, { waitUntil: "load" })
  await page.waitForTimeout(1200)
  return { ctx, page }
}
const inDrawer = (page) => page.evaluate(() => !!document.activeElement?.closest("aside"))

// 1. Mobile drawer
{
  const { ctx, page } = await open("teacher", "/teacher", { width: 375, height: 812 })
  const visible = await page.evaluate(() => getComputedStyle(document.querySelector("aside")).visibility)
  check("drawer closed: aside is visibility:hidden on phone", visible === "hidden", visible)
  let leaked = false
  for (let i = 0; i < 14; i++) { await page.keyboard.press("Tab"); if (await inDrawer(page)) leaked = true }
  check("drawer closed: Tab never lands inside the off-screen drawer (14 presses)", !leaked)
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur())
  await page.getByRole("button", { name: "Open menu" }).focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(400)
  const label = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
  check("drawer open: focus moves to the Close button", label === "Close menu", String(label))
  const dlg = await page.evaluate(() => { const a = document.querySelector("aside"); return a.getAttribute("role") + "/" + a.getAttribute("aria-modal") })
  check("drawer open: exposed as modal dialog", dlg === "dialog/true", dlg)
  let escaped = false
  for (let i = 0; i < 16; i++) { await page.keyboard.press("Tab"); if (!(await inDrawer(page))) escaped = true }
  check("drawer open: Tab stays trapped inside (16 presses)", !escaped)
  await page.keyboard.press("Shift+Tab")
  check("drawer open: Shift+Tab stays inside", await inDrawer(page))
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector("aside")).visibility)
  check("Escape closes the drawer and returns focus to the menu button", back === "Open menu" && hidden === "hidden", `${back}, ${hidden}`)
  await ctx.close()
}
// 2. Desktop: drawer semantics must not leak onto the permanent sidebar
{
  const { ctx, page } = await open("teacher", "/teacher", { width: 1366, height: 768 })
  const s = await page.evaluate(() => { const a = document.querySelector("aside"); return { vis: getComputedStyle(a).visibility, role: a.getAttribute("role") } })
  check("desktop: sidebar is visible and not a dialog", s.vis === "visible" && s.role === null, JSON.stringify(s))
  await ctx.close()
}
// 3. Coach tabs
{
  const { ctx, page } = await open("student", "/student/courses/c1/assignments/a1/coach", { width: 375, height: 812 })
  const chat = page.locator("#coach-tab-chat"), board = page.locator("#coach-tab-board")
  check("coach tabs: Chat selected initially, Whiteboard tab not in tab order", (await chat.getAttribute("aria-selected")) === "true" && (await board.getAttribute("tabindex")) === "-1")
  await chat.focus()
  await page.keyboard.press("ArrowRight")
  await page.waitForTimeout(500)
  check("coach tabs: ArrowRight selects Whiteboard and moves focus", (await board.getAttribute("aria-selected")) === "true" && (await page.evaluate(() => document.activeElement?.id)) === "coach-tab-board")
  await page.keyboard.press("ArrowLeft")
  await page.waitForTimeout(300)
  check("coach tabs: ArrowLeft returns to Chat", (await chat.getAttribute("aria-selected")) === "true" && (await page.evaluate(() => document.activeElement?.id)) === "coach-tab-chat")
  const panel = await page.evaluate(() => { const p = document.getElementById("coach-panel-chat"); return { role: p.getAttribute("role"), labelled: p.getAttribute("aria-labelledby"), tab: p.tabIndex, live: p.getAttribute("aria-live") } })
  check("coach chat panel: tabpanel, labelled by its tab, keyboard-scrollable, polite live region", panel.role === "tabpanel" && panel.labelled === "coach-tab-chat" && panel.tab === 0 && panel.live === "polite", JSON.stringify(panel))
  const code = await page.evaluate(() => ({ inline: document.querySelectorAll("#coach-panel-chat p code").length, pre: document.querySelectorAll("#coach-panel-chat pre code").length, backticks: document.getElementById("coach-panel-chat").innerText.includes("`") }))
  check("coach messages: inline code and pasted code render, no literal backticks", code.inline > 0 && code.pre > 0 && !code.backticks, JSON.stringify(code))
  const send = await page.getByRole("button", { name: "Send message" }).boundingBox()
  check("coach composer: Send button fully inside a 375px viewport", !!send && send.x >= 0 && send.x + send.width <= 375, JSON.stringify(send))
  await ctx.close()
}
// 4. Titles
{
  const { ctx, page } = await open("teacher", "/teacher/courses", { width: 1366, height: 768 })
  const t1 = await page.title()
  await page.goto(BASE + "/teacher/settings"); await page.waitForTimeout(600)
  const t2 = await page.title()
  check("titles change with the route", t1 !== t2 && t1.endsWith("SocratiQ") && t2.endsWith("SocratiQ"), `${t1} | ${t2}`)
  await ctx.close()
}
await browser.close()
fs.mkdirSync("../docs/ui-ux-evidence", { recursive: true })
fs.writeFileSync("../docs/ui-ux-evidence/interactions-results.json", JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
