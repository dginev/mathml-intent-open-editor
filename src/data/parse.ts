import { parse } from 'yaml';
import type { Concept, Notation, Reading, SpeechLang, Verbosity } from '../types';
import { uniq } from '../uniq';

/** A raw record. Loose because the file is hand-authored; unknown keys are kept in `raw`. */
type RawEntry = Record<string, unknown> & {
  concept?: string;
  intent?: string;
  speech?: Record<string, unknown>;
  subject_area?: string | null;
  property?: string;
  comment?: string;
  notations?: Array<Record<string, unknown>>;
  urls?: string | string[];
  alias?: string | string[];
};

const VERBOSITIES: Verbosity[] = ['verbose', 'terse', 'default'];

const asArray = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? (v as string[]) : [String(v)];

/** Read an entry's renderings — the `notations:` list of `{tex?, mathml}` hashes. */
function readNotations(e: RawEntry): Notation[] {
  if (!Array.isArray(e.notations)) return [];
  const out: Notation[] = [];
  for (const n of e.notations) {
    if (n == null || typeof n !== 'object' || typeof n.mathml !== 'string') continue;
    out.push(typeof n.tex === 'string' ? { tex: n.tex, mathml: n.mathml } : { mathml: n.mathml });
  }
  return out;
}

/**
 * Read the `speech:` map — `{ <lang>: [ { verbose|terse|default: <template>, condition?: … } ] }` —
 * into `SpeechLang[]`. `en` is the anchor; other ISO 639-1 codes are translations. Each reading item
 * carries exactly one verbosity key (its value is the template) plus an optional `condition`.
 */
function readSpeech(e: RawEntry): SpeechLang[] {
  const sp = e.speech;
  if (sp == null || typeof sp !== 'object') return [];
  const out: SpeechLang[] = [];
  for (const [lang, rawReadings] of Object.entries(sp as Record<string, unknown>)) {
    if (!Array.isArray(rawReadings)) continue;
    const readings: Reading[] = [];
    for (const r of rawReadings) {
      if (r == null || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const verbosity = VERBOSITIES.find((v) => typeof rec[v] === 'string');
      if (!verbosity) continue;
      const reading: Reading = { verbosity, text: String(rec[verbosity]) };
      if (typeof rec.condition === 'string') reading.condition = rec.condition;
      readings.push(reading);
    }
    if (readings.length) out.push({ lang, readings });
  }
  return out;
}

function normalize(e: RawEntry): Concept {
  return {
    slug: String(e.concept),
    intent: typeof e.intent === 'string' ? e.intent : undefined,
    speech: readSpeech(e),
    notations: readNotations(e),
    // `urls`/`alias` are sets — de-duplicate on read so the model (and the next Save's diff) is clean.
    links: uniq(asArray(e.urls)),
    alias: uniq(asArray(e.alias)),
    // On-disk key is `subject_area`; we keep the internal field named `area` (cf. urls→links).
    area: typeof e.subject_area === 'string' ? e.subject_area.trim() || undefined : undefined,
    property: typeof e.property === 'string' ? e.property : undefined,
    comment: typeof e.comment === 'string' ? e.comment : undefined,
    raw: e,
  };
}

/** Parse the W3C `open.yml` — a flat top-level list of records — into a flat `Concept[]`. */
export function parseDictionary(text: string): Concept[] {
  const doc = parse(text) as unknown;
  const list = Array.isArray(doc) ? (doc as RawEntry[]) : [];
  const out: Concept[] = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && typeof entry.concept === 'string') out.push(normalize(entry));
  }
  return out;
}
