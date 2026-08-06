import { describe, expect, it } from 'vitest';
import { threeWayMerge, type ConceptMap } from './reconcile';
import type { Concept } from '../types';

const c = (slug: string, mathml: string): Concept => ({
  slug,
  area: undefined,
  speech: [],
  notations: [{ mathml }],
  links: [],
  alias: [],
});

const map = (...cs: Concept[]): ConceptMap => Object.fromEntries(cs.map((x) => [x.slug, x]));

describe('threeWayMerge', () => {
  it('takes upstream (theirs) when only base changed a concept the user did not touch', () => {
    const ancestor = map(c('a', '1'));
    const ours = map(c('a', '1')); // unchanged by user
    const theirs = map(c('a', '2')); // base advanced
    const { merged, conflicts } = threeWayMerge(ancestor, ours, theirs);
    expect(merged['a'].notations).toEqual([{ mathml: '2' }]);
    expect(conflicts).toEqual([]);
  });

  it('keeps the user edit when only the user changed a concept', () => {
    const r = threeWayMerge(map(c('a', '1')), map(c('a', 'mine')), map(c('a', '1')));
    expect(r.merged['a'].notations).toEqual([{ mathml: 'mine' }]);
    expect(r.conflicts).toEqual([]);
  });

  it('flags a conflict when base and the user both changed the same concept differently', () => {
    const r = threeWayMerge(map(c('a', '1')), map(c('a', 'mine')), map(c('a', 'theirs')));
    expect(r.conflicts).toEqual(['a']);
    expect(r.merged['a'].notations).toEqual([{ mathml: 'mine' }]); // ours wins in the merged view; surfaced as conflict
  });

  it('does not conflict when both sides made the identical change', () => {
    const r = threeWayMerge(map(c('a', '1')), map(c('a', '2')), map(c('a', '2')));
    expect(r.conflicts).toEqual([]);
    expect(r.merged['a'].notations).toEqual([{ mathml: '2' }]);
  });

  it('includes concepts newly added on either side', () => {
    const r = threeWayMerge(map(), map(c('mine', 'x')), map(c('theirs', 'y')));
    expect(Object.keys(r.merged).sort()).toEqual(['mine', 'theirs']);
    expect(r.conflicts).toEqual([]);
  });

  it('applies an upstream deletion the user did not touch', () => {
    const r = threeWayMerge(map(c('a', '1')), map(c('a', '1')), map());
    expect(r.merged['a']).toBeUndefined();
    expect(r.conflicts).toEqual([]);
  });

  it('keeps an untouched concept present everywhere', () => {
    const r = threeWayMerge(map(c('a', '1')), map(c('a', '1')), map(c('a', '1')));
    expect(r.merged['a'].notations).toEqual([{ mathml: '1' }]);
  });
});
