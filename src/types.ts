/**
 * The editor's data model — a normalized view of one record in the W3C MathML Intent `open.yml`
 * (w3c/mathml-docs `_data/open.yml`; the backing repo mirrors it). The on-disk schema is a **flat
 * top-level list** of records with keys `concept`/`intent`/`speech`/`notations`/`urls`/`alias`/
 * `area`/`property`/`comment`. Unknown fields round-trip via `raw`.
 */

/** One example rendering of a concept (an item of the `notations:` list). `mathml` is the stored,
 * canonical form — a full `<math>…</math>` carrying `intent=`/`arg=` annotations. `tex` is present
 * only when the rendering was authored in TeX (the editor re-renders the rich display from it and
 * reopens it on re-edit); a raw-MathML-authored rendering has no `tex`. The author writes one *or*
 * the other — we always store the MathML. */
export type Notation = { mathml: string; tex?: string };

/** How verbose a spoken reading is. `default` is the fallback, used when no conditioned reading matches. */
export type Verbosity = 'verbose' | 'terse' | 'default';

/** One spoken reading of a concept in some language: exactly one verbosity template, plus an optional
 * `condition` restricting when it applies (e.g. `$base is a variable`). Templates use `$argname`
 * placeholders that must match the concept's `intent` arguments / notation `arg=` markers. */
export type Reading = { verbosity: Verbosity; text: string; condition?: string };

/** All spoken readings of a concept in one language, keyed by ISO 639-1 code (`en` is the anchor). */
export type SpeechLang = { lang: string; readings: Reading[] };

export type Concept = {
  /** kebab-case identifier (the `concept:` key). Together with arity it is unique per dictionary. */
  slug: string;
  /** The intent signature `concept($a,$b,…)` (the `intent:` key). Names the arguments and, by their
   * count, the arity. Omitted for a bare arity-0 concept. */
  intent?: string;
  /** Per-language spoken readings (the `speech:` map). `en` is the anchor. */
  speech: SpeechLang[];
  /** Example renderings (the `notations:` list; `notations[0]` is the primary one shown in the table). */
  notations: Notation[];
  /** Reference URLs (the `urls:` key). */
  links: string[];
  /** Alternate names/slugs (the `alias:` key). */
  alias: string[];
  /** Subject area, e.g. "number theory". */
  area?: string;
  /** Notation-form soft hint, e.g. "symbol", "indexed", "prefix", "function". */
  property?: string;
  /** Free-text explanation / editorial note (the `comment:` key). */
  comment?: string;
  /** The original YAML record, preserved so serialization round-trips fields we don't model. */
  raw?: Record<string, unknown>;
};

/** Distinct `$arg` references inside an `intent` signature (e.g. `f($a,$b)` → `['a','b']`). */
export function intentArgs(intent: string | undefined): string[] {
  if (!intent) return [];
  const seen = new Set<string>();
  for (const m of intent.matchAll(/\$([A-Za-z_][A-Za-z0-9_.-]*)/g)) seen.add(m[1]);
  return [...seen];
}

/** A concept's arity, derived from its `intent` signature (0 when there is no `intent`). */
export function conceptArity(c: { intent?: string }): number {
  return intentArgs(c.intent).length;
}

/** The primary reading of a concept in a language — the `default` reading, else the first one. */
export function readingFor(c: { speech: SpeechLang[] }, lang: string): Reading | undefined {
  const s = c.speech.find((x) => x.lang === lang);
  if (!s) return undefined;
  return s.readings.find((r) => r.verbosity === 'default') ?? s.readings[0];
}

/** The primary reading's text for a language (empty string when absent) — the table/summary display. */
export function speechText(c: { speech: SpeechLang[] }, lang: string): string {
  return readingFor(c, lang)?.text ?? '';
}
