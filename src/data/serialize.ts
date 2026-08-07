import { stringify } from 'yaml';
import type { Concept } from '../types';
import { conceptArity } from '../types';

/** Canonical on-disk key order for a record. Unknown `raw` keys (if any) trail after these. */
const FIELD_ORDER = ['concept', 'intent', 'speech', 'property', 'subject_area', 'urls', 'alias', 'comment', 'notations'];

/** Legacy / superseded keys we never re-emit — dropped from `raw` on write. */
const DROP_KEYS = [
  'arity', 'en', 'area', 'mathml', 'tex', 'comments',
  'notation', 'notationa', 'notationb', 'notationc', 'notationd',
];

/**
 * Modeled fields are authoritative: set when present, deleted when empty/absent (so a cleared field is
 * removed). Fields we don't model are left untouched via the `raw` spread.
 */
function setOrDelete(e: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    delete e[key];
  } else {
    e[key] = value;
  }
}

/**
 * Deterministic canonical order, fully determined by `(concept, arity)`: ASCII (code-unit) by slug,
 * then ascending arity (derived from `intent`). Reproducible across machines and closest to the W3C
 * file's order — minimizing PR churn.
 */
export function byConcept(a: Concept, b: Concept): number {
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  const byArity = conceptArity(a) - conceptArity(b);
  if (byArity !== 0) return byArity;
  const ia = a.intent ?? '';
  const ib = b.intent ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Serialize concepts back to the **W3C `open.yml` shape** — a flat top-level list of records. We start
 * from each concept's preserved `raw` so unmodeled keys round-trip, drop superseded keys, overlay the
 * modeled fields, then reorder to the canonical field order.
 *
 * Adding/removing a modeled field touches four sites that must stay in sync: this writer, `parse.ts`
 * (the reader), `reconcile.ts::contentKey` (diff identity), and `Concept` in `types.ts` (the shape).
 */
export function serializeConcepts(concepts: Concept[]): string {
  const records = [...concepts].sort(byConcept).map((c) => {
    const e: Record<string, unknown> = { ...(c.raw ?? {}) };
    for (const k of DROP_KEYS) delete e[k];

    e.concept = c.slug;
    setOrDelete(e, 'intent', c.intent);

    // speech: { <lang>: [ { <verbosity>: text, condition? } ] } — `en` first, then the rest in order.
    const speech: Record<string, Array<Record<string, string>>> = {};
    for (const s of c.speech) {
      const readings = s.readings
        .filter((r) => r.text.trim() !== '')
        .map((r) => (r.condition !== undefined && r.condition !== ''
          ? { [r.verbosity]: r.text, condition: r.condition }
          : { [r.verbosity]: r.text }));
      if (readings.length) speech[s.lang] = readings;
    }
    setOrDelete(e, 'speech', Object.keys(speech).length ? speech : undefined);

    setOrDelete(e, 'property', c.property);
    setOrDelete(e, 'subject_area', c.area);
    setOrDelete(e, 'urls', c.links);
    setOrDelete(e, 'alias', c.alias);
    setOrDelete(e, 'comment', c.comment);
    setOrDelete(
      e,
      'notations',
      c.notations.map((n) => (n.tex !== undefined ? { tex: n.tex, mathml: n.mathml } : { mathml: n.mathml })),
    );

    // Reorder to the canonical field order; any leftover raw keys trail after.
    const ordered: Record<string, unknown> = {};
    for (const k of FIELD_ORDER) if (k in e) ordered[k] = e[k];
    for (const k of Object.keys(e)) if (!(k in ordered)) ordered[k] = e[k];
    return ordered;
  });
  // lineWidth: 0 disables line wrapping — long URLs/MathML stay on one line, so editing one entry
  // never rewraps a neighbour. Deterministic output is what makes the canonical lint + minimal diffs work.
  return stringify(records, { lineWidth: 0 });
}
