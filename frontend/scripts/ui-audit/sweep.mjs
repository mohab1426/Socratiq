// Multi-viewport layout sweep. Usage:
//   BASE_URL=http://127.0.0.1:5173 OUT=../docs/ui-ux-evidence/before node scripts/ui-audit/sweep.mjs public
//   ... sweep.mjs mocked      (authenticated routes with intercepted network; layout checks only)
// Browser: uses Playwright's bundled Chromium, or CHROMIUM_PATH (+ CHROMIUM_ARGS as a JSON array) when set.
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"
import { mockRoutes, mockSetup } from "./mocks.mjs"

export const VIEWPORTS = [
  { name: "320x720", width: 320, height: 720 },
  { name: "375x812", width: 375, height: 812 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1920x1080", width: 1920, height: 1080 },
]

const PUBLIC_ROUTES = ["/", "/signup", "/signup/student", "/signup/teacher", "/login", "/login/forgot", "/complete-profile", "/smartboard-demo", "/does-not-exist"]

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173"
const OUT = process.env.OUT ?? "ui-audit-out"
const mode = process.argv[2] ?? "public"
const only = process.env.ONLY ? process.env.ONLY.split(",") : null
const noShots = process.env.NO_SHOTS === "1"

const launchOpts = { headless: true }
if (process.env.CHROMIUM_PATH) {
  launchOpts.executablePath = process.env.CHROMIUM_PATH
  if (process.env.CHROMIUM_ARGS) launchOpts.args = JSON.parse(process.env.CHROMIUM_ARGS)
}

/** Runs inside the page. Returns layout/a11y metrics. */
function measure() {
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  const isVisible = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"
  }
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if ((o === "auto" || o === "scroll" || o === "hidden" || o === "clip") && p.scrollWidth >= p.clientWidth) return true
    }
    return false
  }
  const label = (el) => {
    const t = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 40)
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${t ? ` "${t}"` : ""}`
  }
  const accName = (el) => {
    if (el.getAttribute("aria-label")?.trim()) return true
    if (el.getAttribute("aria-labelledby")) return true
    if (el.getAttribute("title")?.trim()) return true
    if ((el.innerText || el.textContent || "").trim()) return true
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true
      if (el.closest("label")) return true
      if (el.getAttribute("placeholder")) return "placeholder-only"
      return false
    }
    if (el.querySelector("img[alt]:not([alt=''])")) return true
    return false
  }

  const docOverflow = document.documentElement.scrollWidth - vw
  const bodyOverflow = document.body.scrollWidth - vw

  const clipped = []
  const small = []
  const smallCritical = []
  const unnamed = []
  const tinyText = new Set()
  const all = Array.from(document.body.querySelectorAll("*"))
  for (const el of all) {
    if (!isVisible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right > vw + 1 && !insideScroller(el) && el.tagName !== "HTML") {
      if (clipped.length < 8) clipped.push(`${label(el)} right=${Math.round(r.right)} (vw ${vw})`)
    }
    if (r.width <= 1 && r.height <= 1) continue // visually-hidden (skip links, sr-only)
    const isCtl = el.matches("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox]")
    if (isCtl) {
      if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) {
        // native control inside a label: the label is the target
      } else if (r.width < 24 || r.height < 24) {
        smallCritical.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      } else if (r.height < 44 && r.width < 44) {
        small.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
      const n = accName(el)
      if (n === false) unnamed.push(label(el))
      else if (n === "placeholder-only") unnamed.push(label(el) + " [placeholder-only]")
    }
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const fs = parseFloat(getComputedStyle(el).fontSize)
      if (fs < 11.5) tinyText.add(`${fs}px: ${(el.innerText || "").trim().slice(0, 30)}`)
    }
  }
  const h1 = document.querySelectorAll("h1").length
  const main = document.querySelectorAll("main, [role=main]").length
  const nav = document.querySelectorAll("nav, [role=navigation]").length
  const title = document.title
  const lang = document.documentElement.lang
  const imgNoAlt = Array.from(document.images).filter((i) => i.getAttribute("alt") === null).length
  return {
    docOverflow, bodyOverflow,
    scrollHeight: document.documentElement.scrollHeight, vh,
    clipped, small: small.slice(0, 6), smallCount: small.length,
    smallCritical: smallCritical.slice(0, 8), smallCriticalCount: smallCritical.length,
    unnamed: unnamed.slice(0, 8), unnamedCount: unnamed.length,
    tinyText: Array.from(tinyText).slice(0, 5), tinyTextCount: tinyText.size,
    h1, main, nav, title, lang, imgNoAlt,
  }
}

const slug = (r) => (r === "/" ? "home" : r.replace(/^\//, "").replace(/[/:]+/g, "_"))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch(launchOpts)
  const routes = mode === "mocked" ? mockRoutes : PUBLIC_ROUTES.map((p) => ({ path: p, role: null }))
  const results = []
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 1024, deviceScaleFactor: 1 })
    for (const route of routes) {
      if (only && !only.some((o) => route.path.includes(o))) continue
      const page = await ctx.newPage()
      const errors = []
      page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 160)))
      page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_NAME_NOT_RESOLVED")) errors.push("console: " + m.text().slice(0, 160)) }) // font CDN is unreachable in the sandbox
      if (mode === "mocked") await mockSetup(page, route.role, route.scenario)
      try {
        await page.goto(BASE + route.path, { waitUntil: "load", timeout: 20000 })
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {})
        await page.waitForTimeout(route.wait ?? 700)
        // reveal-on-scroll content: scroll through once so measurements and screenshots include everything
        await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) } window.scrollTo(0, 0) })
        await page.waitForTimeout(500)
        const m = await page.evaluate(measure)
        const finalPath = new URL(page.url()).pathname
        const rec = { viewport: vp.name, route: route.path, finalPath, role: route.role, scenario: route.scenario ?? null, ...m, errors: errors.slice(0, 4) }
        results.push(rec)
        if (!noShots) await page.screenshot({ path: path.join(OUT, `${mode}__${slug(route.path + (route.scenario ? "." + route.scenario : ""))}__${vp.name}.png`), fullPage: false })
      } catch (e) {
        results.push({ viewport: vp.name, route: route.path, role: route.role, fatal: String(e.message).slice(0, 200) })
      }
      await page.close()
    }
    await ctx.close()
  }
  await browser.close()
  fs.writeFileSync(path.join(OUT, `${mode}-results.json`), JSON.stringify(results, null, 2))
  // console summary
  let bad = 0
  for (const r of results) {
    const flags = []
    if (r.fatal) flags.push("FATAL " + r.fatal)
    else {
      if (r.docOverflow > 1) flags.push(`H-OVERFLOW ${r.docOverflow}px`)
      if (r.clipped.length) flags.push(`clipped:${r.clipped.length}`)
      if (r.smallCriticalCount) flags.push(`target<24:${r.smallCriticalCount}`)
      if (r.unnamedCount) flags.push(`unnamed:${r.unnamedCount}`)
      if (r.errors.length) flags.push(`errors:${r.errors.length}`)
    }
    if (flags.length) { bad++; console.log(`${r.viewport.padEnd(10)} ${r.route.padEnd(52)} ${flags.join(" | ")}`) }
  }
  console.log(`\n${results.length} page/viewport combinations, ${bad} with findings. Results: ${path.join(OUT, `${mode}-results.json`)}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
