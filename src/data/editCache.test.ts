import { describe, expect, it } from 'vitest';
import { loadEdits, recordEdit } from './editCache';
import type { Concept } from '../types';

const fakeStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
};

const c = (slug: string, mathml: string): Concept => ({
  slug,
  area: undefined,
  speech: [],
  notations: [{ mathml }],
  links: [],
  alias: [],
});

describe('editCache', () => {
  it('records an edit under the given id with the base value it started from', () => {
    const s = fakeStorage();
    recordEdit(s, 'power#', c('power', 'v2'), c('power', 'v1'));
    const edits = loadEdits(s);
    expect(edits['power#'].value?.notations).toEqual([{ mathml: 'v2' }]);
    expect(edits['power#'].baseAtEdit?.notations).toEqual([{ mathml: 'v1' }]);
  });

  it('keeps the ORIGINAL baseAtEdit when the same row is edited again', () => {
    const s = fakeStorage();
    recordEdit(s, 'power#', c('power', 'v2'), c('power', 'v1'));
    recordEdit(s, 'power#', c('power', 'v3'), c('power', 'v2-upstream')); // later base differs
    const edits = loadEdits(s);
    expect(edits['power#'].value?.notations).toEqual([{ mathml: 'v3' }]); // latest user value
    expect(edits['power#'].baseAtEdit?.notations).toEqual([{ mathml: 'v1' }]); // original fork point preserved
  });

  it('records a deletion as a null value (tombstone)', () => {
    const s = fakeStorage();
    recordEdit(s, 'power#', null, c('power', 'v1'));
    expect(loadEdits(s)['power#'].value).toBeNull();
    expect(loadEdits(s)['power#'].baseAtEdit?.notations).toEqual([{ mathml: 'v1' }]);
  });

  it('keeps overloaded ids (same name, different arity) as separate entries', () => {
    const s = fakeStorage();
    recordEdit(s, 'disjoint-union#1', c('disjoint-union', 'v1'), null);
    recordEdit(s, 'disjoint-union#2', c('disjoint-union', 'v2'), null);
    expect(Object.keys(loadEdits(s)).sort()).toEqual(['disjoint-union#1', 'disjoint-union#2']);
  });

  it('returns an empty cache when nothing is stored or data is corrupt', () => {
    const s = fakeStorage();
    expect(loadEdits(s)).toEqual({});
    s.setItem('intent-editor.edits', 'not json');
    expect(loadEdits(s)).toEqual({});
  });

  it('clears a stale pre-notations cache (prototype: no migration, just a clean discard)', () => {
    const s = fakeStorage();
    // An old-shape cached edit: Concept values carrying mathml[]/tex instead of notations.
    s.setItem(
      'intent-editor.edits',
      JSON.stringify({
        'power#2': {
          value: { slug: 'power', mathml: ['<math/>'], tex: 'x^n', links: [], alias: [] },
          baseAtEdit: null,
        },
      }),
    );
    expect(loadEdits(s)).toEqual({}); // stale shape → discarded…
    expect(s.getItem('intent-editor.edits')).toBeNull(); // …and removed from storage
  });
});
