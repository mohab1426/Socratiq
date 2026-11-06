import { Fragment, type ReactNode } from "react"
import { looksLikeCode } from "@/lib/richText"

/**
 * Minimal, safe renderer for chat text: ```fenced``` blocks and `inline code`. Everything else stays plain text with
 * line breaks preserved. It builds React elements only (never HTML), so model output cannot inject markup.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="my-2 max-w-full overflow-x-auto rounded-[var(--radius-md)] bg-black/[0.06] p-3 font-mono text-[13px] leading-relaxed" tabIndex={0}>
      <code>{code}</code>
    </pre>
  )
}


export function RichText({ text, detectCode = false }: { text: string; detectCode?: boolean }) {
  if (detectCode && looksLikeCode(text)) return <CodeBlock code={text} />
  const segments = text.split(/```[^\n`]*\n?([\s\S]*?)```/g)
  // split with one capture group alternates: prose, code, prose, code, ...
  return (
    <>
      {segments.map((seg, i) =>
        i % 2 === 1 ? (
          <CodeBlock key={i} code={seg.replace(/\n$/, "")} />
        ) : seg ? (
          <p key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{inline(seg)}</p>
        ) : null
      )}
    </>
  )
}
