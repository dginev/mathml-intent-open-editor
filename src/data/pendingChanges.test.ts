import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  changeSummary,
  classifyChange,
  computeEdits,
  deletedIdsFromEdits,
  effectiveYaml,
  formatChangeSummary,
  markdownChangeSummary,
  prTitle,
} from './pendingChanges';
import { conceptId } from './conceptId';
import type { Concept } from '../types';

const c = (slug: string, mathml = '<math><mi>x</mi></math>'): Concept => ({
  slug,
  speech: [],
  notations: [{ mathml }],
  links: [],
  alias: [],
});
const mapOf = (...cs: Concept[]) => new Map(cs.map((x) => [conceptId(x), x]));

describe('classifyChange', () => {
  const base = c('power');
  const baseMap = mapOf(base);

  it('returns null for a row identical to the baseline', () => {
    expect(classifyChange(c('power'), baseMap, new Set())).toBeNull();
  });
  it('flags an edited row as changed', () => {
    expect(classifyChange(c('power', '<math><mi>y</mi></math>'), baseMap, new Set())).toBe('changed');
  });
  it('treats a renamed row (raw points to the baseline) as changed, not added', () => {
    const renamed = { ...c('reciprocal'), raw: { concept: 'power' } }; // power → reciprocal
    expect(classifyChange(renamed, baseMap, new Set())).toBe('changed');
  });
  it('flags a row absent from the baseline as added', () => {
    expect(classifyChange(c('brand-new'), baseMap, new Set())).toBe('added');
  });
  it('flags a row in the deleted set as deleted (regardless of content)', () => {
    expect(classifyChange(base, baseMap, new Set(['power#']))).toBe('deleted');
  });
});

describe('effectiveYaml', () => {
  it('omits pending deletions from the submitted content', () => {
    const yaml = effectiveYaml([c('alpha'), c('beta')], new Set(['beta#']));
    const slugs = (parse(yaml) as Array<{ concept: string }>).map((e) => e.concept);
    expect(slugs).toEqual(['alpha']); // beta dropped
  });
});

describe('computeEdits', () => {
  const base = c('power');
  const baseMap = mapOf(base, c('sum'));

  it('records adds, changes, and deletions; drops unchanged and add-then-delete', () => {
    const added = c('brand-new');
    const changed = c('power', '<math><mi>z</mi></math>');
    const edits = computeEdits(
      [added, changed, c('sum') /* unchanged */],
      new Set(['sum#', 'ghost#']), // sum deleted (baseline); ghost added-then-deleted (no baseline)
      baseMap,
    );
    expect(edits['brand-new#']).toEqual({ value: added, baseAtEdit: null });
    expect(edits['power#']).toEqual({ value: changed, baseAtEdit: base });
    expect(edits['sum#']).toEqual({ value: null, baseAtEdit: baseMap.get('sum#') });
    expect('ghost#' in edits).toBe(false); // added-then-deleted nets to nothing
  });

  it('produces an empty cache when the working set matches the baseline', () => {
    expect(computeEdits([c('power'), c('sum')], new Set(), baseMap)).toEqual({});
  });

  it('keys a rename by its baseline id so the original is replaced (no resurrection)', () => {
    const renamed = { ...c('exponent'), raw: { concept: 'power' } }; // power → exponent
    const edits = computeEdits([renamed, c('sum')], new Set(), baseMap);
    expect(edits['power#']).toEqual({ value: renamed, baseAtEdit: baseMap.get('power#') });
    expect('exponent#' in edits).toBe(false); // not recorded as a separate add
  });
});

describe('changeSummary / formatChangeSummary', () => {
  const baseMap = mapOf(c('power'), c('sum'), c('ratio'));

  it('groups added / modified / deleted concept names (sorted, de-duplicated)', () => {
    const all = [
      c('alpha'), // added
      c('beta'), // added
      c('power', '<math><mi>z</mi></math>'), // modified
      c('sum'), // unchanged
      c('ratio'), // held for display but pending-deleted (below)
    ];
    const summary = changeSummary(all, new Set(['ratio#']), baseMap);
    expect(summary).toEqual({ added: ['alpha', 'beta'], modified: ['power'], deleted: ['ratio'] });
  });

  it('formats only the non-empty categories', () => {
    expect(formatChangeSummary({ added: ['alpha', 'beta'], modified: ['power'], deleted: ['ratio'] })).toBe(
      'added - alpha, beta; modified - power; deleted - ratio;',
    );
    expect(formatChangeSummary({ added: [], modified: ['power'], deleted: [] })).toBe('modified - power;');
    expect(formatChangeSummary({ added: [], modified: [], deleted: [] })).toBe('');
  });

  it('prTitle is concise and ends in the author (empty categories omitted)', () => {
    expect(prTitle({ added: ['additive-inverse'], modified: ['abelian-group'], deleted: [] }, 'dginev')).toBe(
      'add: additive-inverse; edit: abelian-group; by @dginev',
    );
    expect(prTitle({ added: [], modified: [], deleted: ['foo'] }, 'dginev')).toBe('delete: foo; by @dginev');
  });

  it('prTitle caps the title at 72 chars, truncating at a name boundary, keeping the author', () => {
    // Untruncated would be 76 chars — the summary is cut back to the last complete name.
    const long = prTitle(
      {
        added: ['augmented-binomial-coefficient', 'barycentric-coordinates', 'cauchy-product'],
        modified: [],
        deleted: [],
      },
      'dginev',
    );
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long).toBe('add: augmented-binomial-coefficient…; by @dginev');

    // Exactly 72 chars → untouched.
    const exact = prTitle(
      { added: ['augmented-binomial-coefficient', 'barycentric-coordinates'], modified: [], deleted: [] },
      'dginev',
    );
    expect(exact.length).toBe(72);
    expect(exact).toBe('add: augmented-binomial-coefficient, barycentric-coordinates; by @dginev');

    // A single name longer than the whole budget still yields a capped title ending in the author.
    const huge = prTitle(
      { added: ['x'.repeat(100)], modified: [], deleted: [] },
      'dginev',
    );
    expect(huge.length).toBeLessThanOrEqual(72);
    expect(huge.endsWith('; by @dginev')).toBe(true);
    expect(huge).toContain('…');
  });

  it('markdownChangeSummary is a brief markdown body with inline-code names', () => {
    expect(
      markdownChangeSummary({ added: ['a', 'b'], modified: ['c'], deleted: [] }),
    ).toBe('### Open concept changes\n\n- **Added** (2): `a`, `b`\n- **Modified** (1): `c`');
    expect(markdownChangeSummary({ added: [], modified: [], deleted: [] })).toBe('');
  });
});

describe('deletedIdsFromEdits', () => {
  it('reconstructs the pending-delete set (tombstones of baseline rows)', () => {
    const baseMap = mapOf(c('power'));
    const edits = {
      'power#': { value: null, baseAtEdit: c('power') },
      'gone#': { value: null, baseAtEdit: c('gone') }, // not in baseMap → ignored
      'edited#': { value: c('edited'), baseAtEdit: null }, // not a deletion
    };
    expect([...deletedIdsFromEdits(edits, baseMap)]).toEqual(['power#']);
  });
});
