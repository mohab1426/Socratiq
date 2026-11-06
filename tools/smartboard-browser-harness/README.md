# SmartBoard browser harness (optional dev tool)

Runs the **real** `frontend/src/components/socratiq/SmartBoard.tsx` and `src/lib/*` in Chromium and drives it with real
mouse/wheel/keyboard input. Only leaf dependencies are stubbed (`stubs.tsx`): `MathView`, `TextNode`, `SimulationNode`,
`lucide-react` icons and `cn`. Layout CSS in `index.html` is a hand-written stand-in for the Tailwind utilities the board
uses for positioning, so this verifies behaviour and geometry, **not pixel-accurate styling**.

It does **not** mount `BoardWorkspace` (auth, API, speech, Supabase). The "Show new content" button and AI tool flow are not covered.

## Run
```bash
cd frontend && npm install                      # react, react-dom, esbuild (via vite)
npm i --no-save playwright && npx playwright install chromium   # if not already available
cd ..
node tools/smartboard-browser-harness/build.cjs
node tools/smartboard-browser-harness/run.cjs
```
Optional environment variables: `ESBUILD_PATH`, `REACT_RESOLVE_DIR`, `PLAYWRIGHT_PATH`, `CHROME_PATH`, `HARNESS_OUT`, `FRONTEND_DIR`.

Checks (52): canvas buffer size; pen coordinates at four zoom/pan combinations; highlighter preview == saved pixels,
translucency and no self-overlap darkening; committed ink preserved; eraser; pointer-cancel; ink invalidation when the board
changes mid-stroke; zoom-to-pointer, proportional wheel zoom, zoom limits; middle-mouse and Space pan; pan clamping;
no mutation of stored coordinates on zoom/pan/resize; select-and-drag at three zoom levels; text tool; a 390 px viewport;
highlighter per-move cost and a replay-vs-snapshot microbenchmark; device pixel ratio 2.
