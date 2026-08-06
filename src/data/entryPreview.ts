import type { Concept } from '../types';

/**
 * Helpers for the full-entry preview affordance (the row ⤢).
 *
 * The table row shows only a slice of each entry: the concept name, ONE speech language (the selected
 * column), the area, the PRIMARY notation (`notations[0]`), and all links. The rest — extra notations
 * (and their TeX/raw-MathML source), other-language speech, aliases, property/arity, unmodeled raw keys —
 * only appears in the preview.
 *
 * - While **browsing**, the ⤢ is shown selectively, as a "there's more to see here" hint:
 *   {@link hasHiddenInfo} (extra notations/languages, aliases, raw extras; property/arity excluded as
 *   near-universal, so the marker stays meaningful).
 * - While **reviewing a PR**, the ⤢ is shown on *every* row — the notation source is never in the table
 *   and is always worth checking — so the gate there is simply `true` (no predicate needed).
 *   {@link changedFields} then highlights, inside the view, exactly which fields an edit touched.
 */

/** The `raw` keys we model through dedicated fields; the rest are "extra" (legacy notation*, comments). */
export const MODELED_RAW_KEYS = new Set([
  'concept',
  'intent',
  'speech',
  'area',
  'property',
  'comment',
  'notations',
  'urls',
  'alias',
]);

/** Unmodeled raw keys that carry real content — visible only in the full-entry preview. */
export function extraRawKeys(c: Concept): string[] {
  const raw = c.raw ?? {};
  return Object.keys(raw).filter((k) => !MODELED_RAW_KEYS.has(k) && raw[k] != null && raw[k] !== '');
}

/** Languages with a non-empty reading other than the one the table is currently showing. */
function hiddenLangs(c: Concept, displayLang: string): string[] {
  return c.speech
    .filter((s) => s.readings.some((r) => r.text.trim() !== ''))
    .map((s) => s.lang)
    .filter((l) => l !== displayLang);
}

/**
 * The set of an entry's fields that differ between its `main` version and the PR's version — used to
 * highlight exactly what an edit touched in the read-only "View concept" dialog. Keys match the editor's
 * fields: `area`, `property`, `notations`, `links`, `alias`, and `speech:<lang>` per language (English is
 * `speech:en`). Slug/arity are omitted (they're the row identity — invariant for an edit).
 */
export function changedFields(base: Concept, c: Concept): Set<string> {
  const s = new Set<string>();
  const cmp = (k: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) s.add(k);
  };
  cmp('intent', base.intent, c.intent);
  cmp('area', base.area, c.area);
  cmp('property', base.property, c.property);
  cmp('comment', base.comment, c.comment);
  cmp('notations', base.notations, c.notations);
  cmp('links', base.links, c.links);
  cmp('alias', base.alias, c.alias);
  const langs = new Set([...base.speech, ...c.speech].map((x) => x.lang));
  for (const lang of langs) {
    cmp(
      `speech:${lang}`,
      base.speech.find((x) => x.lang === lang)?.readings,
      c.speech.find((x) => x.lang === lang)?.readings,
    );
  }
  return s;
}

/**
 * Whether an entry holds content the table row can't show — extra notations or languages (the row shows
 * one of each), aliases, or unmodeled raw keys. This is the general "there's more to see here" signal,
 * independent of any diff. Property/arity are excluded on purpose (near-universal — see the module note).
 */
export function hasHiddenInfo(c: Concept, displayLang: string): boolean {
  return (
    c.notations.length > 1 ||
    hiddenLangs(c, displayLang).length > 0 ||
    c.alias.length > 0 ||
    !!c.comment?.trim() ||
    extraRawKeys(c).length > 0
  );
}
