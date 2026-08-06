import type { Concept } from '../types';

/**
 * Rank a concept against the query by *which field* matched, in column-priority order (lower = shown
 * first): `0` concept (slug), `1` speech (any language's reading), `2` area, `3` alias. The
 * highest-priority hit wins, so filtered results group by the cell the hit was found in. `-1` means no
 * match; an empty query ranks everything at the top. (Notation/links aren't text-searched.)
 */
export function matchRank(c: Concept, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  if (c.slug.toLowerCase().includes(q)) return 0;
  if (c.speech.some((s) => s.readings.some((r) => r.text.toLowerCase().includes(q)))) return 1;
  if (c.area?.toLowerCase().includes(q) ?? false) return 2;
  if (c.alias.some((a) => a.toLowerCase().includes(q))) return 3;
  return -1;
}

/** Whether the concept matches the query in any searched field. */
export function conceptMatches(c: Concept, query: string): boolean {
  return matchRank(c, query) >= 0;
}
