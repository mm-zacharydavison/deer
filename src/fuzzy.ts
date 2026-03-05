/**
 * Returns true if every character in `query` appears in `text` in order
 * (case-insensitive). An empty query always matches.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (query.length === 0) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return false;
    ti = idx + 1;
  }
  return true;
}
