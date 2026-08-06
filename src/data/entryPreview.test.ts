import { describe, expect, it } from 'vitest';
import { changedFields, hasHiddenInfo } from './entryPreview';
import type { Concept, SpeechLang } from '../types';

/** Speech with one `default` reading in a language. */
const say = (lang: string, text: string): SpeechLang => ({ lang, readings: [{ verbosity: 'default', text }] });

const c = (over: Partial<Concept> = {}): Concept => ({
  slug: 'power',
  intent: 'power($a,$b)',
  speech: [say('en', 'power of $a to $b')],
  area: 'arithmetic',
  property: 'indexed',
  notations: [{ mathml: '<math><msup/></math>' }],
  links: ['https://w3.org/'],
  alias: [],
  ...over,
});

describe('changedFields — which fields an edit touched (for the View dialog highlight)', () => {
  it('empty when nothing changed', () => {
    expect([...changedFields(c(), c())]).toEqual([]);
  });

  it('keys each differing field, matching the editor field names', () => {
    expect([...changedFields(c(), c({ area: 'algebra' }))]).toEqual(['area']);
    expect([...changedFields(c(), c({ property: 'function' }))]).toEqual(['property']);
    expect([...changedFields(c(), c({ links: ['https://x/'] }))]).toEqual(['links']);
    expect([...changedFields(c(), c({ alias: ['exp'] }))]).toEqual(['alias']);
    expect([...changedFields(c(), c({ notations: [{ mathml: '<m/>' }] }))]).toEqual(['notations']);
    expect([...changedFields(c(), c({ intent: 'power($x,$y)' }))]).toEqual(['intent']);
    expect([...changedFields(c(), c({ comment: 'a note' }))]).toEqual(['comment']);
  });

  it('keys English as speech:en and other languages as speech:<lang>', () => {
    expect([...changedFields(c(), c({ speech: [say('en', 'new speech')] }))]).toEqual(['speech:en']);
    // both have the same en, differ only in de → only speech:de
    const withDe = (de: string) => c({ speech: [say('en', 'power of $a to $b'), say('de', de)] });
    expect([...changedFields(withDe('alt'), withDe('neu'))]).toEqual(['speech:de']);
  });
});

describe('hasHiddenInfo — the general "more to see here" signal', () => {
  it('true for extra notations / other-language speech / aliases / comment / raw extras', () => {
    expect(hasHiddenInfo(c(), 'en')).toBe(false); // a plain entry the row fully shows
    expect(hasHiddenInfo(c({ notations: [{ mathml: '<a/>' }, { mathml: '<b/>' }] }), 'en')).toBe(true);
    expect(hasHiddenInfo(c({ speech: [say('en', 'p'), say('fr', 'opposé')] }), 'en')).toBe(true);
    expect(hasHiddenInfo(c({ alias: ['exponentiation'] }), 'en')).toBe(true);
    expect(hasHiddenInfo(c({ comment: 'a note' }), 'en')).toBe(true);
    expect(hasHiddenInfo(c({ raw: { concept: 'power', comments: 'a legacy note' } }), 'en')).toBe(true);
  });

  it('ignores property/intent — near-universal, so not a "more to see" signal', () => {
    expect(hasHiddenInfo(c({ property: 'symbol', intent: 'power($a,$b,$c)' }), 'en')).toBe(false);
  });

  it('only languages OTHER than the displayed one count as hidden', () => {
    const bilingual = c({ speech: [say('en', 'power'), say('fr', 'opposé')] });
    expect(hasHiddenInfo(bilingual, 'en')).toBe(true); // fr hidden while showing en
    expect(hasHiddenInfo(bilingual, 'fr')).toBe(true); // en hidden while showing fr
    const onlyFr = c({ speech: [say('fr', 'opposé')] });
    expect(hasHiddenInfo(onlyFr, 'fr')).toBe(false); // fr is the only language and it's displayed
  });
});
