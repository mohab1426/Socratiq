/** Lower-case, strip accents/diacritics, collapse whitespace — so "Résumé" matches "resume" and Arabic input isn't mangled. */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/** True when every word typed appears somewhere in the given fields. An empty query matches everything. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = normalize(query).split(" ").filter(Boolean)
  if (words.length === 0) return true
  const haystack = normalize(fields.filter(Boolean).join(" "))
  return words.every((w) => haystack.includes(w))
}
