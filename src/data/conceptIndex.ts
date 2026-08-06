import type { Concept } from '../types';
import { conceptArity } from '../types';

/**
 * Lightweight, dictionary-wide indexes that power the editor's *authoring helpers* — the
 * "related concepts already in the list" overview and the alias-collision warnings. Built once from the
 * working set (memoized in `App`) and handed to `NotationEditor`, so neither helper re-scans 10k rows on
 * every keystroke.
 */

/** A concept name and the arities it occurs at (a name can be overloaded across arities). */
export type SlugInfo = { slug: string; arities: number[]; area?: string };

export type ConceptIndex = {
  /** slug → its arities + area (one entry per name, even when overloaded). */
  bySlug: Map<string, SlugInfo>;
  /** alias → the slug of the concept that first declares it. */
  aliasOwner: Map<string, string>;
  /** area → the slugs in it. */
  byArea: Map<string, string[]>;
  /** hyphen-separated slug token (e.g. `disjoint`, `union`) → the slugs containing it. */
  byToken: Map<string, string[]>;
};

/** Why a concept is shown as related — strongest (a likely duplicate) first. */
export type RelatedKind = 'collision' | 'area' | 'token';
export type Related = SlugInfo & { kind: RelatedKind };

const norm = (s: string) => s.trim().toLowerCase();

const pushUniq = (m: Map<string, string[]>, key: string, value: string) => {
  const arr = m.get(key);
  if (!arr) m.set(key, [value]);
  else if (!arr.includes(value)) arr.push(value);
};

export function buildConceptIndex(concepts: readonly Concept[]): ConceptIndex {
  const bySlug = new Map<string, SlugInfo>();
  const aliasOwner = new Map<string, string>();
  const byArea = new Map<string, string[]>();
  const byToken = new Map<string, string[]>();

  for (const c of concepts) {
    const slug = c.slug;
    if (!slug) continue;
    let info = bySlug.get(slug);
    if (!info) {
      info = { slug, arities: [], area: c.area };
      bySlug.set(slug, info);
    }
    const arity = conceptArity(c);
    if (!info.arities.includes(arity)) info.arities.push(arity);
    if (!info.area && c.area) info.area = c.area;

    for (const a of c.alias) {
      const k = norm(a);
      if (k && !aliasOwner.has(k)) aliasOwner.set(k, slug);
    }
    if (c.area) pushUniq(byArea, norm(c.area), slug);
    for (const tok of slug.split('-')) if (tok) pushUniq(byToken, tok, slug);
  }
  return { bySlug, aliasOwner, byArea, byToken };
}

/**
 * Concepts related to what's being authored, ranked by why: an exact name/alias **collision** (a likely
 * duplicate) first, then **same area**, then a **shared slug token**. De-duplicated by slug (first/
 * strongest reason wins) and with the concept being edited (`selfSlug`) excluded. Returns the top
 * `limit` plus the full `total` so the UI can show "+N more".
 */
export function relatedConcepts(
  index: ConceptIndex,
  query: { slug: string; aliases: readonly string[]; area?: string },
  selfSlug: string,
  limit = 8,
): { items: Related[]; total: number } {
  const out = new Map<string, Related>();
  const slug = norm(query.slug);
  const aliases = query.aliases.map(norm).filter(Boolean);
  const area = query.area ? norm(query.area) : '';

  const add = (s: string, kind: RelatedKind) => {
    if (!s || s === selfSlug || out.has(s)) return;
    const info = index.bySlug.get(s);
    if (info) out.set(s, { ...info, kind });
  };

  // 1) collisions — the dedup signal
  if (slug) {
    add(slug, 'collision'); // the typed name already exists
    const owner = index.aliasOwner.get(slug);
    if (owner) add(owner, 'collision'); // the typed name is an existing concept's alias
  }
  for (const a of aliases) {
    add(a, 'collision'); // a typed alias is itself a concept name
    const owner = index.aliasOwner.get(a);
    if (owner) add(owner, 'collision'); // a typed alias already names an existing concept
  }
  // 2) same area, then 3) shared slug token
  if (area) for (const s of index.byArea.get(area) ?? []) add(s, 'area');
  if (slug) for (const tok of slug.split('-')) for (const s of index.byToken.get(tok) ?? []) add(s, 'token');

  const items = [...out.values()];
  return { items: items.slice(0, limit), total: items.length };
}

/**
 * Non-blocking warnings about the concept's aliases: an alias that already names (or is an alias of)
 * *another* concept — the deduplication signal Moritz asked for — or a duplicate within this concept's
 * own list (which the serializer would silently collapse). `selfSlug` is excluded so a concept's own
 * existing aliases never warn.
 */
export function aliasWarnings(
  index: ConceptIndex,
  selfSlug: string,
  aliases: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const a = norm(raw);
    if (!a) continue;
    if (seen.has(a)) {
      out.push(`duplicate alias “${raw}”`);
      continue;
    }
    seen.add(a);
    const owner = index.aliasOwner.get(a);
    if (owner && owner !== selfSlug) {
      out.push(`alias “${raw}” already names concept “${owner}”`);
    } else if (index.bySlug.has(a) && a !== selfSlug) {
      out.push(`alias “${raw}” is itself a concept name`);
    }
  }
  return out;
}
