// Real-browser checks for SmartBoard.tsx. Run build.cjs first. See README.md.
const path = require("path")
const os = require("os")
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright")
const OUT = process.env.HARNESS_OUT || path.join(os.tmpdir(), "socratiq-smartboard-harness")
let pass = 0, fail = 0
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`) }
const near = (a, b, tol) => Math.abs(a - b) <= tol

async function open(browser, size, init, dsf = 1) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: dsf })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message))
  await page.addInitScript((i) => { window.__init = i }, init || {})
  await page.goto("file://" + path.join(OUT, "index.html"))
  await page.waitForFunction(() => window.__t && document.querySelector("canvas"))
  return { ctx, page }
}
const get = (page) => page.evaluate(() => window.__t.get())
const set = (page, p) => page.evaluate((x) => window.__t.set(x), p).then(() => page.waitForTimeout(60))
const px = (page, x, y) => page.evaluate(([x, y]) => { const c = document.querySelector("canvas"); return Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data) }, [x, y])
const drag = async (page, pts, { release = true, button = "left" } = {}) => {
  await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down({ button })
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 6 })
  if (release) await page.mouse.up({ button })
}

;(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ["--no-sandbox"] })

  // ---------- Desktop ----------
  let { ctx, page } = await open(browser, { width: 1280, height: 800 })
  const cw = await page.evaluate(() => { const c = document.querySelector("canvas"); return [c.width, c.height] })
  ok("canvas buffer is 2000x1200", cw[0] === 2000 && cw[1] === 1200, cw.join("x"))

  // T1 pen coordinate accuracy at several zoom/pan combos
  for (const [view, A, B] of [[{ x: 0, y: 0, scale: 0.5 }, [200, 200], [420, 330]], [{ x: 300, y: 150, scale: 1 }, [200, 200], [420, 330]], [{ x: 600, y: 400, scale: 2 }, [200, 200], [420, 330]], [{ x: 50, y: 20, scale: 0.25 }, [100, 100], [300, 200]]]) {
    await set(page, { view, tool: "pen" })
    const before = (await get(page)).board.strokes.length
    await drag(page, [A, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], B])
    const st = (await get(page)).board.strokes
    const s = st[st.length - 1]
    const ex = (p) => [view.x + p[0] / view.scale, view.y + p[1] / view.scale]
    const first = s.pts[0], last = s.pts[s.pts.length - 1]
    const e0 = ex(A), e1 = ex(B)
    ok(`pen @scale ${view.scale} pan(${view.x},${view.y}) endpoints match pointer`, st.length === before + 1 && near(first[0], e0[0], 1.5) && near(first[1], e0[1], 1.5) && near(last[0], e1[0], 1.5) && near(last[1], e1[1], 1.5), `first=${first} want≈${e0.map(Math.round)} last=${last} want≈${e1.map(Math.round)}`)
  }
  await ctx.close()

  // T2-T4 highlighter preview/commit/cancel/erase
  const penStroke = { t: "p", w: 6, color: "#000000", pts: [[300, 600], [900, 600]] }
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: { elements: [], strokes: [penStroke], steps: [] }, view: { x: 0, y: 0, scale: 1 }, tool: "highlighter", color: "#facc15" }))
  // screen == board coords at scale 1, pan 0
  const blackBefore = await px(page, 600, 600)
  ok("committed pen ink present before highlighter", blackBefore[3] === 255 && blackBefore[0] < 10, blackBefore.join(","))
  // highlighter path: right along y=300, then back left along y=300 (self-overlap), then down across the pen line
  await page.mouse.move(300, 300); await page.mouse.down()
  for (const p of [[500, 300], [700, 300], [500, 300], [400, 300], [400, 500], [400, 700]]) await page.mouse.move(p[0], p[1], { steps: 8 })
  const prev = {
    plain: await px(page, 650, 300),       // highlighter only (single pass)
    overlap: await px(page, 450, 300),     // path passes here twice (out and back)
    onInk: await px(page, 600, 600),       // far from highlighter: committed ink must be untouched
    crossInk: await px(page, 400, 600),    // highlighter crossing the black stroke
  }
  console.log("   preview samples", JSON.stringify(prev))
  ok("preview: committed ink untouched by snapshot blit", prev.onInk[3] === 255 && prev.onInk[0] < 10)
  ok("preview: highlighter is translucent (~35% alpha), yellow-ish", near(prev.plain[3], 89, 6) && prev.plain[0] > 200 && prev.plain[2] < 80, prev.plain.join(","))
  ok("preview: self-overlap does not darken (single-path alpha)", near(prev.overlap[3], prev.plain[3], 3), `overlap α=${prev.overlap[3]} plain α=${prev.plain[3]}`)
  await page.mouse.up()
  await page.waitForTimeout(80)
  const fin = { plain: await px(page, 650, 300), overlap: await px(page, 450, 300), onInk: await px(page, 600, 600), crossInk: await px(page, 400, 600) }
  console.log("   final samples  ", JSON.stringify(fin))
  for (const k of ["plain", "overlap", "onInk", "crossInk"]) ok(`preview == final (${k})`, prev[k].every((v, i) => near(v, fin[k][i], 4)), `${prev[k]} vs ${fin[k]}`)
  const sts = (await get(page)).board.strokes
  ok("highlighter stroke saved with chosen colour and highlighter type", sts.length === 2 && sts[1].t === "h" && sts[1].color === "#facc15", JSON.stringify({ t: sts[1]?.t, c: sts[1]?.color, w: sts[1]?.w }))

  // erase part of the highlighter
  await set(page, { tool: "eraser" })
  await drag(page, [[600, 300], [760, 300]])
  const erased = await px(page, 650, 300)
  ok("eraser removes highlighter ink (alpha 0)", erased[3] === 0, erased.join(","))
  const inkAfterErase = await px(page, 600, 600)
  ok("eraser leaves distant ink intact", inkAfterErase[3] === 255)

  // cancel mid-stroke
  await set(page, { tool: "highlighter" })
  const nBefore = (await get(page)).board.strokes.length
  await page.mouse.move(900, 100); await page.mouse.down(); await page.mouse.move(1000, 140, { steps: 5 }); await page.mouse.move(1100, 160, { steps: 5 })
  const during = await px(page, 1000, 140)
  await page.evaluate(() => { const el = document.elementFromPoint(1100, 160); el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" })) })
  await page.waitForTimeout(80)
  const afterCancel = await px(page, 1000, 140)
  ok("cancel: preview existed then removed", during[3] > 0 && afterCancel[3] === 0, `during α=${during[3]} after α=${afterCancel[3]}`)
  ok("cancel: nothing committed", (await get(page)).board.strokes.length === nBefore)
  await page.mouse.up()
  await drag(page, [[900, 100], [1000, 140]])
  ok("tool not stuck after cancel: next stroke commits", (await get(page)).board.strokes.length === nBefore + 1)
  await ctx.close()

  // ---------- Part 2: navigation ----------
  const shape = { id: "e1", kind: "shape", author: "student", seq: 1, x: 400, y: 300, w: 200, h: 120, color: "#2563eb" }
  const text = { id: "e2", kind: "text", author: "student", seq: 2, x: 900, y: 700, w: 240, h: 60, text: "hello" }
  const stroke = { t: "p", w: 4, color: "#000000", pts: [[1500, 900], [1700, 1000]] }
  const base = { elements: [shape, text], strokes: [stroke], steps: [] }
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: base, view: { x: 0, y: 0, scale: 0.6 }, tool: "select" }))
  const boardOf = async () => JSON.stringify((await get(page)).board)
  const immut = async () => { const b = (await get(page)).board; return JSON.stringify([b.elements, b.strokes[0]]) }
  const snapshotBoard = await immut()

  // wheel zoom toward pointer (ctrl+wheel)
  const focal = [640, 400]
  let v0 = (await get(page)).view
  const bp0 = [v0.x + focal[0] / v0.scale, v0.y + focal[1] / v0.scale]
  await page.mouse.move(...focal)
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -120); await page.keyboard.up("Control")
  await page.waitForTimeout(80)
  let v1 = (await get(page)).view
  const bp1 = [v1.x + focal[0] / v1.scale, v1.y + focal[1] / v1.scale]
  ok("zoom-to-pointer keeps board point under cursor", v1.scale > v0.scale && near(bp0[0], bp1[0], 0.5) && near(bp0[1], bp1[1], 0.5), `scale ${v0.scale}->${v1.scale.toFixed(3)} point ${bp0.map(Math.round)}->${bp1.map(Math.round)}`)

  // small (pinch-like) deltas are gentle
  v0 = (await get(page)).view
  await page.keyboard.down("Control")
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -2)
  await page.keyboard.up("Control"); await page.waitForTimeout(80)
  v1 = (await get(page)).view
  const ratio = v1.scale / v0.scale
  ok("20 tiny wheel events zoom ≈ +10% (proportional, not 2.6x)", ratio > 1.05 && ratio < 1.2, `ratio ${ratio.toFixed(3)}`)

  // zoom limits
  await page.keyboard.down("Control")
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400)
  await page.keyboard.up("Control"); await page.waitForTimeout(80)
  ok("zoom clamps at max 5x", near((await get(page)).view.scale, 5, 1e-6), String((await get(page)).view.scale))
  await page.keyboard.down("Control")
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 400)
  await page.keyboard.up("Control"); await page.waitForTimeout(80)
  ok("zoom clamps at min 0.1x", near((await get(page)).view.scale, 0.1, 1e-6), String((await get(page)).view.scale))

  // middle-mouse pan (select tool)
  await set(page, { view: { x: 200, y: 100, scale: 0.5 }, tool: "select" })
  await drag(page, [[600, 400], [500, 350]], { button: "middle" })
  let v = (await get(page)).view
  ok("middle-mouse drag pans by delta/scale", near(v.x, 400, 1) && near(v.y, 200, 1) && v.scale === 0.5, JSON.stringify(v))
  ok("middle-mouse pan did not alter board", (await immut()) === snapshotBoard)

  // space + drag with PEN tool pans and draws nothing; releasing space restores drawing
  await set(page, { view: { x: 200, y: 100, scale: 0.5 }, tool: "pen" })
  await page.mouse.move(100, 100)
  await page.keyboard.down("Space")
  await drag(page, [[600, 400], [700, 450]])
  await page.keyboard.up("Space")
  v = (await get(page)).view
  ok("space+drag pans with pen tool", near(v.x, 0, 1) && near(v.y, 0, 1), JSON.stringify(v))
  ok("space+drag drew no stroke", (await get(page)).board.strokes.length === 1)
  await drag(page, [[300, 300], [400, 360]])
  ok("pen works again after releasing Space", (await get(page)).board.strokes.length === 2)

  // clamping: wheel-pan far away never loses the board
  await set(page, { view: { x: 0, y: 0, scale: 1 }, tool: "select" })
  await page.mouse.move(640, 400)
  for (const [dx, dy] of [[100000, 0], [-100000, 0], [0, 100000], [0, -100000]]) {
    await page.mouse.wheel(dx, dy); await page.waitForTimeout(60)
    const vv = (await get(page)).view
    const right = (2000 - vv.x) * vv.scale, bottom = (1200 - vv.y) * vv.scale, left = -vv.x * vv.scale, top = -vv.y * vv.scale
    ok(`clamp after wheel-pan (${dx},${dy}): ≥120px of board stays on screen`, right >= 119.9 && bottom >= 119.9 && left <= 1280 - 119.9 && top <= 800 - 119.9, `view ${vv.x.toFixed(0)},${vv.y.toFixed(0)}`)
  }
  ok("zoom/pan never mutated stored element or stroke coordinates", (await immut()) === snapshotBoard)

  // window resize keeps content
  await page.setViewportSize({ width: 800, height: 600 }); await page.waitForTimeout(120)
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(120)
  ok("resizing the viewport did not mutate stored element or stroke coordinates", (await immut()) === snapshotBoard)
  await ctx.close()

  // ---------- element drag at different zoom ----------
  for (const scale of [0.5, 1, 2]) {
    ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: { elements: [shape], strokes: [], steps: [] }, view: { x: 0, y: 0, scale }, tool: "select" }))
    const c = [(shape.x + shape.w / 2) * scale, (shape.y + shape.h / 2) * scale]
    await page.mouse.click(c[0], c[1]); await page.waitForTimeout(60)
    await drag(page, [c, [c[0] + 60, c[1] + 40]])
    const e = (await get(page)).board.elements[0]
    ok(`select+drag moves element by pointer delta/scale @${scale}`, near(e.x, shape.x + 60 / scale, 2) && near(e.y, shape.y + 40 / scale, 2) && e.w === shape.w && e.h === shape.h, `x=${e.x} y=${e.y} want≈${shape.x + 60 / scale},${shape.y + 40 / scale}`)
    await ctx.close()
  }

  // ---------- text tool ----------
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: { elements: [], strokes: [], steps: [] }, view: { x: 100, y: 50, scale: 1.5 }, tool: "text" }))
  await page.mouse.click(500, 300); await page.waitForTimeout(150)
  const ta = await page.$("textarea")
  ok("text tool: click opens a textarea", !!ta)
  if (ta) {
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName)
    ok("text tool: textarea is focused", focused === "TEXTAREA", focused)
    const box = await ta.boundingBox()
    ok("text tool: textarea placed at the click (zoom 1.5, pan 100,50)", box && near(box.x, 500, 40) && near(box.y, 300, 40) && box.x >= 0 && box.y >= 0, JSON.stringify(box))
    await page.keyboard.type("hi there")
    await page.keyboard.press("Enter"); await page.waitForTimeout(150)
    const els = (await get(page)).board.elements
    ok("text tool: Enter commits one text element", els.length === 1 && els[0].kind === "text" && /hi there/.test(els[0].text || ""), JSON.stringify(els.map((e) => [e.kind, e.text, Math.round(e.x), Math.round(e.y)])))
    const expX = 100 + 500 / 1.5, expY = 50 + 300 / 1.5
    ok("text tool: element positioned at board coordinates of the click", els[0] && near(els[0].x, expX, 25) && near(els[0].y, expY, 25), `x=${els[0]?.x} y=${els[0]?.y} want≈${Math.round(expX)},${Math.round(expY)}`)
  }
  await ctx.close()

  // ---------- mobile width ----------
  ;({ ctx, page } = await open(browser, { width: 390, height: 844 }, { view: { x: 0, y: 0, scale: 0.2 }, tool: "pen" }))
  await drag(page, [[60, 100], [200, 160], [300, 200]])
  const ms = (await get(page)).board.strokes
  const mlast = ms[0]?.pts[ms[0].pts.length - 1]
  ok("mobile 390px: pen endpoint matches pointer at scale 0.2", ms.length === 1 && near(mlast[0], 300 / 0.2, 2) && near(mlast[1], 200 / 0.2, 2), JSON.stringify(mlast))
  await ctx.close()

  // ---------- Part 3: snapshot invalidation + cost ----------
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: { elements: [], strokes: [], steps: [] }, view: { x: 0, y: 0, scale: 1 }, tool: "highlighter", color: "#facc15" }))
  await page.mouse.move(300, 300); await page.mouse.down()
  await page.mouse.move(500, 300, { steps: 6 })
  // a stroke arrives from elsewhere (undo/AI/another handler) while the highlighter stroke is in progress
  await set(page, { board: { elements: [], strokes: [{ t: "p", w: 6, color: "#000000", pts: [[300, 600], [900, 600]] }], steps: [] } })
  await page.mouse.move(700, 300, { steps: 6 })
  const midInk = await px(page, 600, 600), midHl = await px(page, 450, 300), midHl2 = await px(page, 650, 300)
  ok("board change mid-stroke: new committed ink still visible (stale snapshot not blitted)", midInk[3] === 255 && midInk[0] < 10, midInk.join(","))
  ok("board change mid-stroke: whole highlighter path still previewed", midHl[3] > 80 && midHl2[3] > 80, `${midHl[3]},${midHl2[3]}`)
  await page.mouse.up(); await page.waitForTimeout(80)
  const sfin = (await get(page)).board.strokes
  ok("board change mid-stroke: both strokes present after commit", sfin.length === 2 && sfin[1].t === "h", String(sfin.length))
  await ctx.close()

  const bigStrokes = []
  for (let i = 0; i < 600; i++) { const pts = []; for (let k = 0; k < 49; k++) pts.push([40 + k * 38, 40 + (i % 60) * 18 + Math.sin(k) * 6]); bigStrokes.push({ t: "p", w: 4, color: "#000000", pts }) }
  const timeStroke = async (strokes) => {
    const o = await open(browser, { width: 1280, height: 800 }, { board: { elements: [], strokes, steps: [] }, view: { x: 0, y: 0, scale: 1 }, tool: "highlighter", color: "#facc15" })
    await o.page.waitForTimeout(300)
    return o.page.evaluate(async () => {
      Element.prototype.setPointerCapture = () => {}
      Element.prototype.releasePointerCapture = () => {}
      const target = document.elementFromPoint(300, 300)
      const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 })
      target.dispatchEvent(mk("pointerdown", 300, 300))
      const t0 = performance.now()
      for (let i = 1; i <= 300; i++) { const x = 300 + i * 2, y = 300 + Math.sin(i / 8) * 40; (document.elementFromPoint(x, y) || target).dispatchEvent(mk("pointermove", x, y)) }
      const ms = (performance.now() - t0) / 300
      const d = document.querySelector("canvas").getContext("2d").getImageData(0, 0, 2000, 1200).data
      let hl = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 80 && d[i] < 100) hl++
      return { ms, painted: hl }
    }).finally(() => o.ctx.close())
  }
  const rE = await timeStroke([]), rB = await timeStroke(bigStrokes)
  ok("timing run really painted a highlighter stroke on both boards (dense ink hides most of it on the big board)", rE.painted > 5000 && rB.painted > 500, `${rE.painted} / ${rB.painted}`)
  console.log(`   real handler, per pointermove: empty board ${rE.ms.toFixed(3)} ms, 600-stroke/29k-pt board ${rB.ms.toFixed(3)} ms`)
  ok("highlighter move cost is independent of board size (600-stroke board < 3x empty)", rB.ms < Math.max(rE.ms * 3, 0.5), `${rE.ms.toFixed(3)} vs ${rB.ms.toFixed(3)} ms`)

  // microbenchmark of the two alternatives in this Chromium: replay all strokes vs blit one snapshot
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }))
  const mb = await page.evaluate((strokes) => {
    const c = document.createElement("canvas"); c.width = 2000; c.height = 1200
    const g = c.getContext("2d")
    const replay = () => { g.clearRect(0, 0, 2000, 1200); for (const s of strokes) { g.save(); g.lineWidth = s.w; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = s.color; g.beginPath(); g.moveTo(s.pts[0][0], s.pts[0][1]); for (let i = 1; i < s.pts.length; i++) g.lineTo(s.pts[i][0], s.pts[i][1]); g.stroke(); g.restore() } }
    replay()
    const snap = document.createElement("canvas"); snap.width = 2000; snap.height = 1200
    snap.getContext("2d").drawImage(c, 0, 0)
    const time = (f, n) => { f(); g.getImageData(0, 0, 1, 1); const t = performance.now(); for (let i = 0; i < n; i++) f(); g.getImageData(0, 0, 1, 1); return (performance.now() - t) / n }
    return { replay: time(replay, 20), blit: time(() => { g.save(); g.globalCompositeOperation = "copy"; g.drawImage(snap, 0, 0); g.restore() }, 200) }
  }, bigStrokes)
  console.log(`   microbenchmark (this Chromium, software rendering): replay 600 strokes ${mb.replay.toFixed(2)} ms vs snapshot blit ${mb.blit.toFixed(2)} ms per move`)
  ok("snapshot blit is cheaper than replaying all strokes", mb.blit < mb.replay, `${mb.blit.toFixed(2)} < ${mb.replay.toFixed(2)}`)
  await ctx.close()

  // ---------- Device pixel ratio 2 ----------
  const penHL = { t: "p", w: 6, color: "#000000", pts: [[300, 600], [900, 600]] }
  ;({ ctx, page } = await open(browser, { width: 1280, height: 800 }, { board: { elements: [], strokes: [penHL], steps: [] }, view: { x: 0, y: 0, scale: 1 }, tool: "highlighter", color: "#facc15" }, 2))
  const dpr = await page.evaluate(() => [window.devicePixelRatio, document.querySelector("canvas").width, document.querySelector("canvas").height])
  ok("DPR 2: canvas buffer still 2000x1200 (not DPR-scaled)", dpr[0] === 2 && dpr[1] === 2000 && dpr[2] === 1200, dpr.join(","))
  await page.mouse.move(300, 300); await page.mouse.down()
  for (const p of [[500, 300], [700, 300], [500, 300], [400, 500]]) await page.mouse.move(p[0], p[1], { steps: 8 })
  const dprPrev = { plain: await px(page, 650, 300), ink: await px(page, 600, 600) }
  await page.mouse.up(); await page.waitForTimeout(80)
  const dprFin = { plain: await px(page, 650, 300), ink: await px(page, 600, 600) }
  ok("DPR 2: highlighter preview == final and ink preserved", dprPrev.plain.every((v, i) => near(v, dprFin.plain[i], 4)) && dprPrev.ink[3] === 255 && dprFin.ink[3] === 255 && near(dprPrev.plain[3], 89, 6), `${dprPrev.plain} vs ${dprFin.plain}`)
  await set(page, { tool: "pen", view: { x: 200, y: 100, scale: 1.5 } })
  await drag(page, [[200, 200], [400, 300]])
  const dst = (await get(page)).board.strokes, dl = dst[dst.length - 1]
  ok("DPR 2: pen coordinates still follow the pointer (zoom 1.5)", near(dl.pts[0][0], 200 + 200 / 1.5, 1.5) && near(dl.pts[dl.pts.length - 1][1], 100 + 300 / 1.5, 1.5), JSON.stringify([dl.pts[0], dl.pts[dl.pts.length - 1]]))
  await ctx.close()

  await browser.close()
  console.log(`\nbrowser checks: ${pass} passed, ${fail} failed`)
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1) })
