import { useEffect, useState } from "react"
import "katex/dist/katex.min.css"

/**
 * Renders LaTeX with KaTeX (loaded on demand, `trust: false`). If the source cannot be rendered the plain source is shown instead,
 * so a bad equation never breaks the board. `onStatus` lets an editor know whether the current source renders.
 */
export function MathView({ latex, className, onStatus }: { latex: string; className?: string; onStatus?: (ok: boolean) => void }) {
  const [out, setOut] = useState<{ latex: string; html: string | null } | null>(null)

  useEffect(() => {
    let live = true
    import("katex")
      .then(({ default: katex }) => {
        let html: string | null = null
        try {
          html = katex.renderToString(latex, { throwOnError: true, trust: false, displayMode: true, strict: "ignore", maxExpand: 200, output: "html" })
        } catch {
          html = null
        }
        if (live) {
          setOut({ latex, html })
          onStatus?.(html !== null)
        }
      })
      .catch(() => {
        if (live) {
          setOut({ latex, html: null })
          onStatus?.(false)
        }
      })
    return () => { live = false }
  }, [latex, onStatus])

  if (!out || out.latex !== latex || out.html === null) return <span className={className} style={{ fontFamily: "ui-monospace, monospace" }}>{latex}</span>
  return <span className={className} dangerouslySetInnerHTML={{ __html: out.html }} />
}
