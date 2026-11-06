import { Badge } from "@/components/ui/Badge"
import type { Mastery } from "@/types"

const tone: Record<Mastery, "success" | "slate" | "danger"> = {
  Strong: "success",
  Moderate: "slate",
  Weak: "danger",
}

/** `null` means there is no verification evidence yet; the UI says so instead of guessing a level. */
export function MasteryBadge({ level }: { level: Mastery | null }) {
  if (!level) return <Badge tone="neutral" title="Mastery appears after the student completes a learning verification">Not enough evidence</Badge>
  return <Badge tone={tone[level]}>{level}</Badge>
}
