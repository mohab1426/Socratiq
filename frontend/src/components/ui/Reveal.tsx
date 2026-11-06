import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useInView } from "@/lib/useInView"

/** Fades content up when it enters the viewport. `delay` (ms) staggers siblings. Motion is disabled under prefers-reduced-motion. */
export function Reveal({ children, delay = 0, className, as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" | "section" | "article" }) {
  const [ref, seen] = useInView<HTMLElement>()
  return (
    <Tag ref={ref as never} data-visible={seen} className={cn("reveal", className)} style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  )
}
