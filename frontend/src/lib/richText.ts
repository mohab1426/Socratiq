/** Looks like pasted code: several lines with indentation and no prose-style fences. */
export function looksLikeCode(text: string): boolean {
  return !text.includes("```") && text.includes("\n") && /^(?: {2,}|\t)\S/m.test(text)
}
