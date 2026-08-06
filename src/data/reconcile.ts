import type { Concept } from '../types';

/** Concepts keyed by slug — the shape of a parsed `open.yml`. */
export type ConceptMap = Record<string, Concept>;

export type MergeResult = {
  /** The reconciled working set (ours wins on conflicts, but the slug is also listed in `conflicts`). */
  merged: ConceptMap;
  /** Slugs that both the user (ours) and upstream (theirs) changed differently. */
  conflicts: string[];
};

/**
 * Stable identity of a concept's *file* content (order-sensitive on arrays); `undefined` = absent.
 * Keys on the `notations` list — both each rendering's stored `mathml` and its authored `tex` (so
 * re-authoring the TeX counts as a change even when the rendered MathML is unchanged). Exported so
 * the pending-change classifier shares one "content changed".
 */
export function contentKey(c?: Concept): string {
  if (!c) return '∅';
  return JSON.stringify([
    c.slug, // the `concept:` key — so a rename counts as a content change
    c.intent ?? null,
    c.area ?? null,
    c.property ?? null,
    c.comment ?? null,
    c.notations.map((n) => [n.tex ?? null, n.mathml]),
    c.links,
    c.alias,
    c.speech.length ? c.speech : null,
  ]);
}

const same = (a?: Concept, b?: Concept) => contentKey(a) === contentKey(b);

/**
 * Three-way merge of the concept dictionary by slug.
 * - `ancestor`: the base `open.yml` the user's branch forked from.
 * - `ours`: the user's working set (their branch + local edits).
 * - `theirs`: the current base (`main`), which may have advanced via others' merged PRs.
 *
 * Per slug: unchanged-on-our-side → take theirs (adopt upstream); unchanged-upstream → keep ours;
 * both changed identically → that value; both changed differently → conflict (merged keeps ours and the
 * slug is reported). Absence on a winning side is a deletion.
 */
export function threeWayMerge(ancestor: ConceptMap, ours: ConceptMap, theirs: ConceptMap): MergeResult {
  const slugs = new Set([...Object.keys(ancestor), ...Object.keys(ours), ...Object.keys(theirs)]);
  const merged: ConceptMap = {};
  const conflicts: string[] = [];

  for (const slug of slugs) {
    const a = ancestor[slug];
    const o = ours[slug];
    const t = theirs[slug];

    let pick: Concept | undefined;
    if (same(o, t)) pick = o; // both sides agree (incl. both-added-same / both-deleted)
    else if (same(o, a)) pick = t; // only upstream changed → adopt it
    else if (same(t, a)) pick = o; // only the user changed → keep it
    else {
      pick = o; // both diverged → keep the user's, surface as conflict
      conflicts.push(slug);
    }

    if (pick !== undefined) merged[slug] = pick;
  }

  return { merged, conflicts };
}
