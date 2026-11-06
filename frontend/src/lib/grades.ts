import type { Grade } from "./queries"

const fmt = (n: number) => String(Number.isInteger(n) ? n : Number(n.toFixed(2)))
export { fmt as formatNumber }
export const gradeLabel = (g: Grade) => `${fmt(g.score)} / ${fmt(g.maxScore)} (${fmt(g.percentage)}%)`
