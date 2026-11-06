// Bundles the REAL SmartBoard.tsx (and real src/lib) with esbuild for browser testing.
// Only leaf dependencies are stubbed (see stubs.tsx): MathView, TextNode, SimulationNode, lucide-react, cn.
const esbuild = require(process.env.ESBUILD_PATH || "esbuild")
const path = require("path")
const fs = require("fs")
const os = require("os")
const FRONTEND = process.env.FRONTEND_DIR || path.resolve(__dirname, "../../frontend")
const SRC = path.join(FRONTEND, "src")
const OUT = process.env.HARNESS_OUT || path.join(os.tmpdir(), "socratiq-smartboard-harness")
// Directory whose node_modules contains react / react-dom (default: the frontend, after `npm install`).
const REACT_DIR = process.env.REACT_RESOLVE_DIR || FRONTEND
fs.mkdirSync(OUT, { recursive: true })
fs.copyFileSync(path.join(__dirname, "index.html"), path.join(OUT, "index.html"))
esbuild.build({
  entryPoints: [path.join(__dirname, "entry.tsx")], bundle: true, outfile: path.join(OUT, "bundle.js"), format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning",
  plugins: [{ name: "alias", setup(b) {
    const stubs = path.join(__dirname, "stubs.tsx")
    const stub = (re) => b.onResolve({ filter: re }, () => ({ path: stubs }))
    stub(/components\/socratiq\/(MathView|TextNode|SimulationNode)$/); stub(/^lucide-react$/); stub(/^@\/lib\/utils$/)
    b.onResolve({ filter: /^@\// }, (a) => b.resolve("./" + a.path.slice(2), { resolveDir: SRC, kind: a.kind }))
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (a) => a.pluginData === "skip" ? undefined : b.resolve(a.path, { resolveDir: REACT_DIR, kind: a.kind, pluginData: "skip" }))
  } }],
}).then(() => console.log("bundle ok ->", OUT)).catch((e) => { console.error(e.message); process.exit(1) })
