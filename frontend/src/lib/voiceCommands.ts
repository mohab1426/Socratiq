/**
 * Voice -> board-aware Coach. A spoken phrase such as "explain this" or "is this correct?" is the same request as pressing the matching
 * "Ask SocratiQ" board button, so it is sent with that `boardIntent`. The transcript is still sent as the message (the Coach sees the
 * student's real words, in Arabic or English); the intent only tells it which board action was meant.
 *
 * Deliberately NOT matched: clear / erase / organize. Those change the board, a misheard word must never trigger them through a shortcut.
 * They still work as ordinary messages: the server only performs them when the message itself is an explicit request.
 */
import type { BoardIntent } from "@/lib/boardAsk"

type Voiced = Exclude<BoardIntent, "organize">

/** Lowercase, strip punctuation/diacritics, fold Arabic letter variants (same folding the server uses for board commands). */
export function normalizeSpeech(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[?؟!.,،;:"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Order matters: the first group that matches wins, and "correct" outranks "explain" ("explain where my mistake is" is a check).
const RULES: { intent: Voiced; patterns: RegExp[] }[] = [
  { intent: "correct", patterns: [
    /\b(is|are) (this|that|it|my \w+) (right|correct|wrong|ok|okay)\b/, /\bam i (right|correct|wrong)\b/, /\bcheck (my|this|that|the) (work|answer|step|steps|solution|board)\b/,
    /\bwhere('?s| is) (my|the) (mistake|error)\b/, /\bwhat('?s| is) wrong\b/, /\b(highlight|mark|show) (me )?(the |my )?(mistake|error)\b/, /\bany mistakes?\b/,
    /(?:^| )(?:ده|دا|دي|هذا|هذه) (?:صح|صحيح|غلط)(?: |$)/, /صح ولا غلط/, /(?:هل )?(?:ده|دا|دي|هذا|هذه) صحيح/, /راجع (?:شغلي|حلي|الحل|اجابتي)/,
    /فين الغلط/, /فين الخطا/, /(?:حدد|علم علي|ظلل|وريني) (?:ال)?(?:غلط|خطا)/, /فيه غلط/,
  ] },
  { intent: "continue", patterns: [
    /\b(show me |what('?s| is) )?(the )?next step\b/, /\bwhat('?s| is) next\b/, /\b(continue|keep going|go on)\b/,
    /(?:ال)?خطوه (?:الجايه|التاليه|اللي بعدها|بعدها)/, /(?:^| )(?:كمل|اكمل|كملي)(?: |$)/, /وبعدين/,
  ] },
  { intent: "explain", patterns: [
    /\bexplain (this|that|it|the board|what('?s| is) (on|here))\b/, /\bwhat (does|do) (this|that|it) mean\b/, /\bwhat('?s| is) (this|that)\b/,
    /اشرح[\u0600-\u06FF]*(?: لي| لنا)? (?:ده|دا|دي|هذا|هذه|هذي|ذلك|اللي)/, /يعني ايه (?:ده|دا|دي)/, /ايه ده/,
  ] },
  { intent: "highlight_key", patterns: [/\bhighlight (the )?(key|main|important)/, /(?:ظلل|علم علي|حدد) (?:ال)?(?:مهم|اهم|الاساسي)/] },
  { intent: "summarize", patterns: [/\bsummari[sz]e\b/, /(?:^| )لخص[\u0600-\u06FF]*(?: |$)/] },
  { intent: "steps", patterns: [/\b(turn|put|break|make)\b.{0,20}\bsteps\b/, /(?:(?:حول|اعمل|قسم)[\u0600-\u06FF]*).{0,20}خطوات/] },
]

/** Words in a spoken command; a long paragraph that merely contains "explain this" is a question for the Coach, not a board shortcut. */
const MAX_WORDS = 12

/** The board intent a spoken phrase asks for, or null (then it is an ordinary message to the Coach). */
export function matchBoardCommand(transcript: string): BoardIntent | null {
  const t = normalizeSpeech(transcript)
  if (!t || t.split(" ").length > MAX_WORDS) return null
  for (const r of RULES) if (r.patterns.some((p) => p.test(t))) return r.intent
  return null
}
