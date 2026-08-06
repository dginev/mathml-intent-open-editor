import type { Concept } from '../types';

/**
 * Stable per-row identity: the **(concept, intent)** pair. A concept *name* can appear at several
 * intent signatures (e.g. `sobolev-space($k)` vs `sobolev-space($k,$p)`, or an arity-0 symbol vs its
 * applied form) as distinct rows — so the signature, not the name or arity alone, is the key used for
 * reconcile maps, the edit cache, and edits. An omitted `intent` (arity 0) contributes an empty signature.
 */
export function conceptId(c: Pick<Concept, 'slug' | 'intent'>): string {
  return `${c.slug}#${c.intent ?? ''}`;
}
