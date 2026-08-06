import { describe, expect, it } from 'vitest';
import { aliasWarnings, buildConceptIndex, relatedConcepts } from './conceptIndex';
import type { Concept } from '../types';

// `arity` here is a convenience that generates an `intent` signature of that many args (arity is
// derived from `intent` in the model). All other fields pass through unchanged.
const c = (slug: string, extra: Partial<Concept> & { arity?: number } = {}): Concept => {
  const { arity, ...rest } = extra;
  const intent = arity && arity > 0 ? `${slug}(${Array.from({ length: arity }, (_, i) => `$a${i}`).join(',')})` : undefined;
  return { slug, intent, speech: [], notations: [], links: [], alias: [], ...rest };
};

const dict: Concept[] = [
  c('disjoint-union', { arity: 1, area: 'set theory' }),
  c('disjoint-union', { arity: 2, area: 'set theory' }), // overloaded by arity
  c('union', { arity: 2, area: 'set theory', alias: ['cup'] }),
  c('power', { arity: 2, area: 'arithmetic', alias: ['exponentiation'] }),
  c('abelian-group', { arity: 0, area: 'algebra' }),
];

describe('buildConceptIndex', () => {
  it('collapses overloaded names into one entry with all arities', () => {
    const idx = buildConceptIndex(dict);
    expect(idx.bySlug.get('disjoint-union')).toMatchObject({ arities: [1, 2], area: 'set theory' });
  });

  it('maps aliases to their owning concept and tokens/areas to slugs', () => {
    const idx = buildConceptIndex(dict);
    expect(idx.aliasOwner.get('cup')).toBe('union');
    expect(idx.byArea.get('set theory')).toEqual(['disjoint-union', 'union']);
    expect(idx.byToken.get('union')).toEqual(['disjoint-union', 'union']);
  });
});

describe('relatedConcepts', () => {
  const idx = buildConceptIndex(dict);

  it('flags an exact name collision first', () => {
    const { items } = relatedConcepts(idx, { slug: 'union', aliases: [], area: '' }, '');
    expect(items[0]).toMatchObject({ slug: 'union', kind: 'collision' });
  });

  it('flags a typed alias that already names a concept as a collision', () => {
    const { items } = relatedConcepts(idx, { slug: 'add', aliases: ['cup'], area: '' }, '');
    expect(items.some((r) => r.slug === 'union' && r.kind === 'collision')).toBe(true);
  });

  it('surfaces same-area and shared-token neighbours, excluding the edited concept', () => {
    const { items } = relatedConcepts(
      idx,
      { slug: 'union', aliases: [], area: 'set theory' },
      'union', // editing `union` → it must not list itself
    );
    const slugs = items.map((r) => r.slug);
    expect(slugs).toContain('disjoint-union'); // shares area + the `union` token
    expect(slugs).not.toContain('union');
  });

  it('caps the result and reports the true total', () => {
    const big = Array.from({ length: 20 }, (_, i) => c(`area-item-${i}`, { area: 'big', arity: 0 }));
    const idx2 = buildConceptIndex(big);
    const { items, total } = relatedConcepts(idx2, { slug: 'x', aliases: [], area: 'big' }, '', 8);
    expect(items).toHaveLength(8);
    expect(total).toBe(20);
  });
});

describe('aliasWarnings', () => {
  const idx = buildConceptIndex(dict);

  it('warns when an alias already names another concept', () => {
    expect(aliasWarnings(idx, 'newthing', ['cup'])).toEqual([
      'alias “cup” already names concept “union”',
    ]);
  });

  it('warns when an alias is itself a concept name', () => {
    expect(aliasWarnings(idx, 'newthing', ['power'])[0]).toContain('is itself a concept name');
  });

  it('does not warn about a concept’s own existing alias', () => {
    expect(aliasWarnings(idx, 'union', ['cup'])).toEqual([]);
  });

  it('warns about a duplicate alias within the same concept', () => {
    expect(aliasWarnings(idx, 'newthing', ['foo', 'foo'])).toEqual(['duplicate alias “foo”']);
  });
});
