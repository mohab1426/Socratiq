// Copies Excalidraw's font files into public/ so the board works offline and never calls a third-party CDN.
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const from = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts")
const to = resolve(root, "public/excalidraw-assets/fonts")
if (!existsSync(from)) { console.warn("[excalidraw-assets] package not installed yet; skipping"); process.exit(0) }
mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log("[excalidraw-assets] fonts copied to public/excalidraw-assets/fonts")
