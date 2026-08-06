import { describe, expect, it } from 'vitest';
import { buildSubmission } from './submission';
import { conceptId } from '../data/conceptId';
import type { Concept } from '../types';

const c = (slug: string, mathml = '<math><mi>x</mi></math>'): Concept => ({
  slug,
  speech: [],
  notations: [{ mathml }],
  links: [],
  alias: [],
});
const baseMap = new Map([c('power'), c('sum')].map((x) => [conceptId(x), x]));
const now = new Date(2026, 4, 31);

describe('buildSubmission', () => {
  it('mints a fresh unique branch when there is no open PR', () => {
    const sub = buildSubmission({
      concepts: [c('power', '<math><mi>z</mi></math>'), c('sum')], // power edited
      deletedIds: new Set(),
      baseMap,
      handle: 'dginev',
      activeBranch: null,
      description: '',
      now,
    });
    expect(sub.branch).toBe('dginev-20260531-power');
    expect(sub.title).toBe('edit: power; by @dginev');
    expect(sub.message).toBe('modified - power;');
    expect(sub.description).toContain('### Open concept changes'); // generated when blank
  });

  it("reuses the open PR's branch and keeps the user's description", () => {
    const sub = buildSubmission({
      concepts: [c('power'), c('sum'), c('brand-new')], // an add
      deletedIds: new Set(),
      baseMap,
      handle: 'dginev',
      activeBranch: 'dginev-20260101-power',
      description: 'My notes',
      now,
    });
    expect(sub.branch).toBe('dginev-20260101-power'); // reused, not re-minted
    expect(sub.description).toBe('My notes'); // user text preserved
    expect(sub.title).toBe('add: brand-new; by @dginev');
  });

  it('excludes pending deletions from the submitted content', () => {
    const sub = buildSubmission({
      concepts: [c('power'), c('sum')],
      deletedIds: new Set([conceptId(c('sum'))]),
      baseMap,
      handle: 'dginev',
      activeBranch: null,
      description: '',
      now,
    });
    expect(sub.content).toContain('power');
    expect(sub.content).not.toContain('sum');
    expect(sub.title).toBe('delete: sum; by @dginev');
  });
});
