import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { serializeConcepts } from './serialize';
import { parseDictionary } from './parse';
import { conceptArity, type Concept } from '../types';

const concept = (over: Partial<Concept> & { slug: string }): Concept => ({
  area: undefined,
  speech: [],
  notations: [],
  links: [],
  alias: [],
  ...over,
});

describe('serializeConcepts', () => {
  it('writes a flat top-level list of records', () => {
    const out = serializeConcepts([
      concept({
        slug: 'power',
        intent: 'power($a,$b)',
        speech: [{ lang: 'en', readings: [{ verbosity: 'default', text: 'power' }] }],
        area: 'arithmetic',
        notations: [{ mathml: '<math/>' }],
        links: ['u'],
      }),
    ]);
    const doc = parse(out) as Array<Record<string, unknown>>;
    expect(Array.isArray(doc)).toBe(true);
    expect(doc).toHaveLength(1);
    const e = doc[0];
    expect(e.concept).toBe('power');
    expect(e.intent).toBe('power($a,$b)');
    expect(e.notations).toEqual([{ mathml: '<math/>' }]);
    expect(e.urls).toEqual(['u']); // links → urls
    expect('links' in e).toBe(false);
    expect('arity' in e).toBe(false); // arity is not a stored key
  });

  it('emits records in canonical ASCII order regardless of input order', () => {
    const out = serializeConcepts([concept({ slug: 'beta' }), concept({ slug: 'alpha' })]);
    const doc = parse(out) as Array<{ concept: string }>;
    expect(doc.map((e) => e.concept)).toEqual(['alpha', 'beta']);
  });

  it('preserves truly-unmodeled fields via raw, drops legacy keys, and writes tex inside its notation', () => {
    const out = serializeConcepts([
      concept({
        slug: 'x',
        property: 'symbol',
        notations: [{ tex: '\\arg{a}{x}', mathml: "<mi arg='a'>x</mi>" }],
        // `custom` is unmodeled → preserved; `notation`/`comments` are superseded legacy keys → dropped.
        raw: { concept: 'x', custom: 'kept', notation: 'legacy free-text sketch', comments: ['old'] },
      }),
    ]);
    const e = (parse(out) as Array<Record<string, unknown>>)[0];
    expect(e.custom).toBe('kept'); // unmodeled key — preserved from raw
    expect('notation' in e).toBe(false); // legacy free-text key — dropped
    expect('comments' in e).toBe(false); // legacy plural — dropped (superseded by `comment`)
    expect(e.property).toBe('symbol'); // modeled — from the concept
    expect(e.notations).toEqual([{ tex: '\\arg{a}{x}', mathml: "<mi arg='a'>x</mi>" }]);
    // tex precedes mathml inside each notation hash (the source above its rendering).
    expect(out.indexOf('tex:')).toBeGreaterThan(-1);
    expect(out.indexOf('tex:')).toBeLessThan(out.indexOf("mathml: <mi arg='a'>x</mi>"));
  });

  it('migrates old-shape raw keys: arity/en/mathml/tex are dropped in favor of the new keys', () => {
    const out = serializeConcepts([
      concept({
        slug: 'x',
        intent: 'x($n)',
        notations: [{ tex: '\\mathrm{x}', mathml: '<mi>x</mi>' }],
        // raw still carries the pre-migration keys (parsed from an old-shape file)
        raw: { concept: 'x', arity: 1, en: 'ex', mathml: ['<mi>x</mi>'], tex: '\\mathrm{x}' },
      }),
    ]);
    const e = (parse(out) as Array<Record<string, unknown>>)[0];
    expect('mathml' in e).toBe(false); // old keys don't survive a write
    expect('tex' in e).toBe(false);
    expect('arity' in e).toBe(false);
    expect('en' in e).toBe(false);
    expect(e.intent).toBe('x($n)');
    expect(e.notations).toEqual([{ tex: '\\mathrm{x}', mathml: '<mi>x</mi>' }]);
  });

  it('deletes a modeled field that was cleared (set to empty)', () => {
    const out = serializeConcepts([concept({ slug: 'x', area: undefined, raw: { concept: 'x', area: 'old' } })]);
    const e = (parse(out) as Array<Record<string, unknown>>)[0];
    expect('area' in e).toBe(false); // cleared in the model → removed on write
  });

  it('writes speech as a per-language map of readings and drops removed languages', () => {
    const out = serializeConcepts([
      concept({
        slug: 'x',
        speech: [
          { lang: 'en', readings: [{ verbosity: 'default', text: 'ex' }] },
          { lang: 'fr', readings: [{ verbosity: 'default', text: 'ixe' }] },
        ],
        // `de` was present in the file but removed in the editor → not in the model → dropped on write.
        raw: { concept: 'x', speech: { en: [{ default: 'ex' }], de: [{ default: 'Iks' }], fr: [{ default: 'old' }] } },
      }),
    ]);
    const e = (parse(out) as Array<Record<string, unknown>>)[0];
    expect(e.speech).toEqual({ en: [{ default: 'ex' }], fr: [{ default: 'ixe' }] });
    // and it round-trips back into speech
    const [back] = parseDictionary(out);
    expect(back.speech).toEqual([
      { lang: 'en', readings: [{ verbosity: 'default', text: 'ex' }] },
      { lang: 'fr', readings: [{ verbosity: 'default', text: 'ixe' }] },
    ]);
  });

  it('writes a conditioned reading with its condition beside the verbosity template', () => {
    const out = serializeConcepts([
      concept({
        slug: 'rising-factorial',
        intent: 'rising-factorial($base,$power)',
        speech: [
          {
            lang: 'en',
            readings: [
              { verbosity: 'terse', text: '$base rising $power', condition: '$base is a variable' },
              { verbosity: 'default', text: 'rising factorial' },
            ],
          },
        ],
      }),
    ]);
    const e = (parse(out) as Array<Record<string, unknown>>)[0];
    expect(e.speech).toEqual({
      en: [
        { terse: '$base rising $power', condition: '$base is a variable' },
        { default: 'rising factorial' },
      ],
    });
  });

  it('round-trips parse → serialize → parse without losing concepts', () => {
    const yaml = serializeConcepts([
      concept({ slug: 'a', property: 'symbol', notations: [{ mathml: '<math><mi>A</mi></math>' }] }),
      concept({ slug: 'b', intent: 'b($x)', notations: [{ mathml: '<math><mi>B</mi></math>' }] }),
    ]);
    const back = parseDictionary(yaml);
    expect(back.map((c) => c.slug)).toEqual(['a', 'b']);
    expect(conceptArity(back[0])).toBe(0);
    expect(back[0].property).toBe('symbol');
    expect(back[0].notations).toEqual([{ mathml: '<math><mi>A</mi></math>' }]);
    expect(back[1].intent).toBe('b($x)');
  });
});
