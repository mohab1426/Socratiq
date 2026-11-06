import { describe, expect, it } from "vitest"
import { matchBoardCommand, normalizeSpeech } from "./voiceCommands"
import { describeVoiceError } from "./voice"

const CASES: [string, string | null][] = [
  // English: the examples from the product brief
  ["Explain this", "explain"], ["explain this please", "explain"], ["What does this mean?", "explain"],
  ["Show me the next step", "continue"], ["what's next", "continue"], ["Continue", "continue"],
  ["Is this correct?", "correct"], ["is my answer right", "correct"], ["Check my work", "correct"], ["Highlight the mistake", "correct"], ["where is my mistake", "correct"],
  ["highlight the key point", "highlight_key"], ["summarize the board", "summarize"], ["turn this into steps", "steps"],
  // Arabic (MSA + Egyptian), with and without diacritics / hamza variants
  ["اشرح ده", "explain"], ["اشرحلي دي", "explain"], ["اشرح لي هذه", "explain"], ["يعني ايه ده", "explain"],
  ["الخطوة الجاية", "continue"], ["كمل", "continue"], ["أكمل", "continue"],
  ["ده صح ولا غلط؟", "correct"], ["فين الغلط", "correct"], ["راجع شغلي", "correct"], ["حدد الغلط", "correct"], ["هل هذا صحيح", "correct"],
  ["لخص اللي علي البورد", "summarize"], ["حولها إلى خطوات", "steps"],
  // never shortcut: destructive board commands and ordinary questions
  ["clear the board", null], ["امسح البورد", null], ["organize the board", null], ["رتب البورد", null],
  ["what is the derivative of x squared", null], ["hello", null], ["", null],
  // a long question that merely contains a command phrase is a question for the Coach
  ["can you explain this because i have been stuck on the second step for twenty minutes and i do not understand why we subtract", null],
]

describe("matchBoardCommand", () => {
  it.each(CASES)("%j -> %s", (said, intent) => { expect(matchBoardCommand(said)).toBe(intent) })
  it("normalizes Arabic letter variants and punctuation", () => { expect(normalizeSpeech("  أكمل؟! ")).toBe("اكمل") })
})

describe("describeVoiceError keeps the real cause visible", () => {
  const ok = { brave: false, online: true, secure: true }
  it("network in Brave names Brave, not the connection", () => { expect(describeVoiceError("network", { ...ok, brave: true })).toMatch(/Brave/) })
  it("network while offline says offline", () => { expect(describeVoiceError("network", { ...ok, online: false })).toMatch(/offline/) })
  it("network online explains the cloud speech service and keeps the code", () => {
    const m = describeVoiceError("network", ok)
    expect(m).toMatch(/online speech service/); expect(m).toMatch(/internet connection/); expect(m).toMatch(/\(network\)/)
  })
  it("blocked mic on an insecure page points at https", () => { expect(describeVoiceError("not-allowed", { ...ok, secure: false })).toMatch(/https/) })
  it("unknown codes are shown, not swallowed", () => { expect(describeVoiceError("weird", ok)).toMatch(/\(weird\)/) })
})
