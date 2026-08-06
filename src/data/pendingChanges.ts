import { conceptId } from './conceptId';
import { contentKey } from './reconcile';
import { serializeConcepts } from './serialize';
import type { EditCache } from './editCache';
import type { Concept } from '../types';

/**
 * Local change tracking for the batch-edit session. The editor compares its working set against the
 * GitHub baseline (the `intent/<handle>` branch if a PR is open, else `main`): each row is unchanged,
 * `added`, `changed`, or pending `deleted`. Pending deletions stay visible (rendered red) until a Save
 * enacts the whole batch. "Dirty" is purely content-based — an edit-then-revert or an add-then-delete
 * nets back to clean — so Save only activates when a submit would actually change the file.
 */
export type ChangeKind = 'added' | 'changed' | 'deleted';

export type BaseMap = ReadonlyMap<string, Concept>;

/**
 * The conceptId a row had in the baseline. Recovered from its preserved `raw` (which keeps the original
 * `concept`/`arity` through a rename), so a renamed/re-aritied row still maps to its original entry
 * rather than reading as a brand-new add. Falls back to the current id (brand-new rows have no `raw`).
 */
function baselineId(c: Concept): string {
  const raw = c.raw;
  if (raw && typeof raw.concept === 'string') {
    const intent = typeof raw.intent === 'string' ? raw.intent : undefined;
    return conceptId({ slug: raw.concept, intent });
  }
  return conceptId(c);
}

/** Look up a row's baseline entry by its original id, falling back to its current id (post-save). */
const baseEntry = (c: Concept, baseMap: BaseMap): Concept | undefined =>
  baseMap.get(baselineId(c)) ?? baseMap.get(conceptId(c));

/** How a concept differs from the baseline (`null` = identical to what's already on GitHub). */
export function classifyChange(
  concept: Concept,
  baseMap: BaseMap,
  deletedIds: ReadonlySet<string>,
): ChangeKind | null {
  if (deletedIds.has(conceptId(concept))) return 'deleted';
  const base = baseEntry(concept, baseMap);
  if (!base) return 'added';
  return contentKey(concept) !== contentKey(base) ? 'changed' : null;
}

/** The content that would be submitted: every concept except the pending deletions, canonical YAML. */
export function effectiveYaml(all: readonly Concept[], deletedIds: ReadonlySet<string>): string {
  return serializeConcepts(all.filter((c) => !deletedIds.has(conceptId(c))));
}

/**
 * Rebuild the persisted edit cache from the current working set. Idempotent and net-zero-aware: rows
 * identical to the baseline (incl. edit-then-revert) produce no entry, and an added-then-deleted row
 * (no baseline) drops out entirely. `baseAtEdit` is the baseline value — the fork point for the reload
 * three-way reconcile.
 */
export function computeEdits(
  all: readonly Concept[],
  deletedIds: ReadonlySet<string>,
  baseMap: BaseMap,
): EditCache {
  const edits: EditCache = {};
  for (const c of all) {
    const id = conceptId(c);
    if (deletedIds.has(id)) continue; // a held-for-display deleted row: recorded as a tombstone below
    const baseId = baselineId(c);
    const base = baseMap.get(baseId) ?? baseMap.get(id);
    if (!base) edits[id] = { value: c, baseAtEdit: null }; // added
    // Key a change by its BASELINE id so a rename replaces the original entry on reload (instead of
    // leaving the old name behind). `value` carries the new slug/arity.
    else if (contentKey(c) !== contentKey(base)) {
      edits[baseMap.has(baseId) ? baseId : id] = { value: c, baseAtEdit: base };
    }
  }
  for (const id of deletedIds) {
    const base = baseMap.get(id);
    if (base) edits[id] = { value: null, baseAtEdit: base }; // delete of a baseline row
    // a purely-local addition that was deleted has no baseline → net nothing
  }
  return edits;
}

/** Reconstruct the pending-delete set from a loaded edit cache (tombstones of baseline rows). */
export function deletedIdsFromEdits(edits: EditCache, baseMap: BaseMap): Set<string> {
  return new Set(Object.keys(edits).filter((id) => edits[id].value === null && baseMap.has(id)));
}

export type ChangeSummary = { added: string[]; modified: string[]; deleted: string[] };

/** Concept names changed vs the baseline, grouped by kind (sorted, de-duplicated by slug). */
export function changeSummary(
  all: readonly Concept[],
  deletedIds: ReadonlySet<string>,
  baseMap: BaseMap,
): ChangeSummary {
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const c of all) {
    const kind = classifyChange(c, baseMap, deletedIds);
    if (kind === 'added') added.add(c.slug);
    else if (kind === 'changed') modified.add(c.slug);
  }
  const deleted = new Set<string>();
  for (const id of deletedIds) {
    const base = baseMap.get(id);
    if (base) deleted.add(base.slug);
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { added: sorted(added), modified: sorted(modified), deleted: sorted(deleted) };
}

/** One-line human summary, omitting empty categories: `added - a, b; modified - c; deleted - d;`. */
export function formatChangeSummary(s: ChangeSummary): string {
  const parts: string[] = [];
  if (s.added.length) parts.push(`added - ${s.added.join(', ')}`);
  if (s.modified.length) parts.push(`modified - ${s.modified.join(', ')}`);
  if (s.deleted.length) parts.push(`deleted - ${s.deleted.join(', ')}`);
  return parts.length ? `${parts.join('; ')};` : '';
}

/** Long name lists get capped so a PR title stays short. */
const capNames = (names: string[], max = 8): string =>
  names.length > max ? `${names.slice(0, max).join(', ')}, +${names.length - max} more` : names.join(', ');

/** Hard ceiling for the generated PR title (~GitHub's list-view truncation point). */
const TITLE_MAX = 72;

/**
 * A concise PR title from the changes, ending in the author: `add: a; edit: b; delete: c; by @handle`.
 * Hard-capped at TITLE_MAX chars: the change-summary portion is truncated with `…` — at a name
 * boundary when one fits — while the trailing `by @handle` always survives intact.
 */
export function prTitle(s: ChangeSummary, handle: string): string {
  const parts: string[] = [];
  if (s.added.length) parts.push(`add: ${capNames(s.added)}`);
  if (s.modified.length) parts.push(`edit: ${capNames(s.modified)}`);
  if (s.deleted.length) parts.push(`delete: ${capNames(s.deleted)}`);
  const by = `by @${handle}`;
  let head = parts.length ? parts.join('; ') : 'dictionary update';
  const budget = Math.max(TITLE_MAX - by.length - 2, 1); // 2 = the '; ' joining head to author
  if (head.length > budget) {
    const cut = head.slice(0, budget - 1); // leave room for the ellipsis
    const boundary = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '));
    head = `${boundary > 0 ? cut.slice(0, boundary) : cut}…`;
  }
  return `${head}; ${by}`;
}

/** A brief Markdown PR description (the body), omitting empty categories — names as inline code. */
export function markdownChangeSummary(s: ChangeSummary): string {
  const line = (label: string, names: string[]): string | null =>
    names.length ? `- **${label}** (${names.length}): ${names.map((n) => `\`${n}\``).join(', ')}` : null;
  const rows = [line('Added', s.added), line('Modified', s.modified), line('Deleted', s.deleted)].filter(
    (x): x is string => x !== null,
  );
  return rows.length ? `### Open concept changes\n\n${rows.join('\n')}` : '';
}
