import { describe, expect, it } from 'vitest';
import { conceptMatches, matchRank } from './conceptMatch';
import type { Concept, Reading } from '../types';

const c = (o: Partial<Concept>): Concept => ({ slug: '', speech: [], notations: [], links: [], alias: [], ...o });

/** Speech with one `default` reading in a language — the common case. */
const say = (lang: string, text: string): Concept['speech'][number] => ({
  lang,
  readings: [{ verbosity: 'default', text } as Reading],
});

describe('matchRank', () => {
  it('ranks by the matched cell: concept(0) < speech(1) < area(2) < alias(3); -1 = no match', () => {
    expect(matchRank(c({ slug: 'power' }), 'pow')).toBe(0);
    expect(matchRank(c({ speech: [say('en', 'power of two')] }), 'two')).toBe(1);
    expect(matchRank(c({ speech: [say('de', 'Potenz')] }), 'potenz')).toBe(1);
    expect(matchRank(c({ area: 'arithmetic' }), 'arith')).toBe(2);
    expect(matchRank(c({ alias: ['exponent'] }), 'expo')).toBe(3);
    expect(matchRank(c({ slug: 'power' }), 'zzz')).toBe(-1);
  });

  it('returns the highest-priority field when several match', () => {
    expect(matchRank(c({ slug: 'ratio', area: 'ratio theory' }), 'ratio')).toBe(0); // slug beats area
  });
});

describe('conceptMatches', () => {
  it('matches slug, speech (any language), area, and alias (case-insensitive)', () => {
    expect(conceptMatches(c({ slug: 'additive-inverse' }), 'INVERSE')).toBe(true);
    expect(conceptMatches(c({ speech: [say('en', 'additive inverse of $value')] }), 'inverse of')).toBe(true);
    expect(conceptMatches(c({ area: 'abstract algebra' }), 'algebra')).toBe(true);
    expect(conceptMatches(c({ alias: ['opposite'] }), 'oppos')).toBe(true);
    expect(conceptMatches(c({ speech: [say('de', 'additives Inverses')] }), 'inverses')).toBe(true);
  });

  it('returns false when nothing matches, true for an empty query', () => {
    expect(conceptMatches(c({ slug: 'power' }), 'zzz')).toBe(false);
    expect(conceptMatches(c({ slug: 'power' }), '   ')).toBe(true);
  });
});
