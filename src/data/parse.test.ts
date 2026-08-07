import { describe, expect, it } from 'vitest';
import { parseDictionary } from './parse';
import { conceptArity, speechText } from '../types';
import { w3cYaml } from '../test/dictFixture';

describe('parseDictionary (open.yml schema)', () => {
  it('reads a flat list of records into Concept[] with mapped fields', () => {
    const yaml = w3cYaml([
      {
        concept: 'abelian-category',
        property: 'symbol',
        subject_area: 'category theory',
        speech: { en: [{ default: 'abelian category' }] },
        notations: [{ mathml: "<math><mi intent='abelian-category'>Ab</mi></math>" }],
        urls: ['https://example.org/a'],
      },
      {
        concept: 'power',
        intent: 'power($b,$e)',
        speech: { en: [{ default: '$b to the $e' }] },
        alias: ['exponentiation'],
        notations: [{ mathml: "<msup intent='power($b,$e)'><mi arg='b'>x</mi><mi arg='e'>n</mi></msup>" }],
      },
    ]);
    const concepts = parseDictionary(yaml);

    expect(concepts.map((c) => c.slug)).toEqual(['abelian-category', 'power']);
    const ab = concepts[0];
    expect(ab.intent).toBeUndefined(); // arity-0 → no intent
    expect(conceptArity(ab)).toBe(0); // arity is derived
    expect(ab.property).toBe('symbol');
    expect(ab.area).toBe('category theory');
    expect(speechText(ab, 'en')).toBe('abelian category');
    expect(ab.notations).toEqual([{ mathml: "<math><mi intent='abelian-category'>Ab</mi></math>" }]);
    expect(ab.links).toEqual(['https://example.org/a']); // urls → links
    expect(concepts[1].alias).toEqual(['exponentiation']);
    expect(conceptArity(concepts[1])).toBe(2); // from intent power($b,$e)
  });

  it('reads the notations: shape — a list of {tex?, mathml} hashes', () => {
    const yaml = w3cYaml([
      {
        concept: 'power',
        intent: 'power($b,$e)',
        notations: [
          { tex: '\\arg{b}{x}^{\\arg{e}{n}}', mathml: "<msup intent='power($b,$e)'><mi>x</mi><mi>n</mi></msup>" },
          { mathml: '<mrow><mi>pow</mi></mrow>' }, // raw-MathML-authored extra: no tex
        ],
      },
    ]);
    const [c] = parseDictionary(yaml);
    expect(c.notations).toEqual([
      { tex: '\\arg{b}{x}^{\\arg{e}{n}}', mathml: "<msup intent='power($b,$e)'><mi>x</mi><mi>n</mi></msup>" },
      { mathml: '<mrow><mi>pow</mi></mrow>' },
    ]);
  });

  it('reads the speech: map into per-language readings, leaving unmodeled keys in raw', () => {
    const yaml = w3cYaml([
      {
        concept: 'x',
        speech: { en: [{ default: 'ex' }], de: [{ default: 'Iks' }], fr: [{ default: 'ixe' }] },
        notationa: 'mo ′',
      },
    ]);
    const [c] = parseDictionary(yaml);
    expect(speechText(c, 'en')).toBe('ex');
    expect(c.speech).toEqual([
      { lang: 'en', readings: [{ verbosity: 'default', text: 'ex' }] },
      { lang: 'de', readings: [{ verbosity: 'default', text: 'Iks' }] },
      { lang: 'fr', readings: [{ verbosity: 'default', text: 'ixe' }] },
    ]);
    expect(c.raw?.notationa).toBe('mo ′'); // a non-modeled key is preserved in raw
  });

  it('reads a conditioned + multi-verbosity speech reading list', () => {
    const yaml = w3cYaml([
      {
        concept: 'rising-factorial',
        intent: 'rising-factorial($base,$power)',
        speech: {
          en: [
            { verbose: '$base to the rising $power' },
            { terse: '$base rising $power', condition: '$base is a variable' },
            { default: 'rising factorial' },
          ],
        },
      },
    ]);
    const [c] = parseDictionary(yaml);
    expect(c.speech).toEqual([
      {
        lang: 'en',
        readings: [
          { verbosity: 'verbose', text: '$base to the rising $power' },
          { verbosity: 'terse', text: '$base rising $power', condition: '$base is a variable' },
          { verbosity: 'default', text: 'rising factorial' },
        ],
      },
    ]);
    expect(speechText(c, 'en')).toBe('rising factorial'); // the default reading is the display text
  });

  it('de-duplicates urls and aliases into sets, preserving first-seen order', () => {
    const yaml = w3cYaml([
      {
        concept: 'x',
        urls: ['https://a', 'https://b', 'https://a'],
        alias: ['ex', 'eks', 'ex'],
      },
    ]);
    const [c] = parseDictionary(yaml);
    expect(c.links).toEqual(['https://a', 'https://b']);
    expect(c.alias).toEqual(['ex', 'eks']);
  });

  it('keeps the original record in raw for lossless round-trip', () => {
    const yaml = w3cYaml([{ concept: 'x', notationa: 'mo ′', comment: 'a note' }]);
    const [c] = parseDictionary(yaml);
    expect(c.comment).toBe('a note');
    expect(c.raw?.notationa).toBe('mo ′');
  });

  it('tolerates an empty / non-list document', () => {
    expect(parseDictionary('')).toEqual([]);
    expect(parseDictionary('concepts: []')).toEqual([]); // a mapping, not a list → nothing
  });
});
