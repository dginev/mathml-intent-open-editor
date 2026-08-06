import { stringify } from 'yaml';

/** Build an `open.yml` document — a flat top-level list of records — from raw entries. */
export function w3cYaml(records: Array<Record<string, unknown>>): string {
  return stringify(records);
}

/** A minimal record with sensible defaults; override/extend via `extra`. */
export function entry(concept: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    concept,
    notations: [{ mathml: `<math><mi intent="${concept}">${concept}</mi></math>` }],
    ...extra,
  };
}
