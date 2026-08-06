import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ISO6391 from 'iso-639-1';
import { missingSpeechRefs, texToIntent, unusedArgRefs } from '../render/intent';
import { minifyMathml } from '../render/minifyMathml';
import { loadTemml, type TemmlEngine } from '../render/temmlEngine';
import { MathML } from './MathML';
import { MathMLSource, MathMLSourceDiff } from './MathMLSource';
import { IconButton, InfoPopover, RowControls } from './ui';
import { aliasWarnings, relatedConcepts, type ConceptIndex } from '../data/conceptIndex';
import { uniq } from '../uniq';
import type { Concept, Notation, Reading, SpeechLang } from '../types';
import { readingFor, speechText } from '../types';

/** One editable speech template row: a stable id, an ISO 639-1 language code, the template, and edit state. */
type SpeechRow = { id: number; lang: string; text: string; editing: boolean };

/** One editable link/alias row: a stable id (edit state survives add/remove), its value, and edit state. */
type EditRow = { id: number; value: string; editing: boolean };

/** One additional-notation row — the same dual-mode authoring state the primary has. */
type NotationRow = { id: number; mode: 'tex' | 'mathml'; tex: string; mathml: string; editing: boolean };

/** All ISO 639-1 codes, for the language autocomplete (`<datalist>`). */
const LANG_CODES = ISO6391.getAllCodes();

const NO_SLUGS: ReadonlySet<string> = new Set();

/** Next stable row id: one past the current max, so it stays unique as rows are added/removed. */
const nextId = (rows: { id: number }[]) => rows.reduce((m, r) => Math.max(m, r.id), -1) + 1;

/** A fresh link/alias/notation row (blank, open for editing). */
const blankEntry = () => ({ value: '' });

/** True if a string isn't well-formed XML (used to validate raw-MathML notations before saving). */
const xmlError = (s: string): boolean =>
  new DOMParser().parseFromString(s, 'application/xml').querySelector('parsererror') !== null;

/** What one notation's authoring state derives to — shared by the primary and every extra. */
type NotationDraft = {
  /** Nothing authored (in the active mode). */
  empty: boolean;
  /** The storable MathML (TeX render minified / raw verbatim); null when empty or blocked. */
  out: string | null;
  /** Rich form for the Rendered panel (TeX keeps Temml's cosmetics; raw shows as typed). */
  display: string | null;
  /** What the file will hold — the "MathML source" panel. */
  source: string | null;
  error: string | null;
  /** True while this notation can't be saved (render error, malformed XML, engine still loading). */
  blocks: boolean;
};

const EMPTY_DRAFT: NotationDraft = { empty: true, out: null, display: null, source: null, error: null, blocks: false };

/**
 * Derive a notation's render/store/error state from its authoring mode + sources. TeX renders through
 * `texToIntent` (root intent defaulting to the concept) and stores the **minified** form; raw MathML is
 * validated as XML and stored **verbatim**. Identical pipeline for the primary and each extra.
 */
function deriveNotation(
  engine: TemmlEngine | null,
  slug: string,
  mode: 'tex' | 'mathml',
  tex: string,
  mathml: string,
): NotationDraft {
  if (mode === 'tex') {
    const t = tex.trim();
    if (t === '') return EMPTY_DRAFT;
    if (!engine) return { empty: false, out: null, display: null, source: null, error: null, blocks: true };
    const r = texToIntent(engine, t, slug);
    if (!r.ok) return { empty: false, out: null, display: null, source: null, error: r.error, blocks: true };
    const rich = `<math>${r.mathml}</math>`;
    const lean = minifyMathml(rich);
    return { empty: false, out: lean, display: rich, source: lean, error: null, blocks: false };
  }
  const m = mathml.trim();
  if (m === '') return EMPTY_DRAFT;
  if (xmlError(m)) {
    return { empty: false, out: null, display: null, source: null, error: 'Malformed XML / MathML', blocks: true };
  }
  return { empty: false, out: m, display: m, source: m, error: null, blocks: false };
}
/**
 * Render a scalar field's old→new change for the review diff view: a removed/old value is struck through
 * in red, the new value is green, with an arrow between when both are present (a pure add is green only,
 * a pure removal red only). Unchanged → the value as-is.
 */
function ValueDiff({ before, after }: { before?: string | null; after?: string | null }) {
  const b = (before ?? '').trim();
  const a = (after ?? '').trim();
  if (b === a) return <>{a || '—'}</>;
  return (
    <span className="value-diff">
      {b && <del className="diff-del">{b}</del>}
      {b && a && (
        <span className="diff-arrow" aria-hidden="true">
          →
        </span>
      )}
      {a && <ins className="diff-add">{a}</ins>}
    </span>
  );
}

/** A fresh speech row — the first one defaults to English, later ones start with an empty code. */
const blankSpeech = (rows: SpeechRow[]) => ({
  lang: rows.some((r) => r.lang.trim() === 'en') ? '' : 'en',
  text: '',
});

/**
 * State + operations for one of the editor's row lists (links, aliases, speech). `patch` updates any
 * subset of a row's fields, `add` appends a fresh row (from `blank`) open for editing, `remove` drops
 * one. New ids are computed inside the (deferred) updater, so no render-time ref is needed.
 */
function useRowList<T extends { id: number; editing: boolean }>(
  init: () => T[],
  blank: (rows: T[]) => Omit<T, 'id' | 'editing'>,
) {
  const [rows, setRows] = useState<T[]>(init);
  const ops = useMemo(
    () => ({
      patch: (id: number, p: Partial<T>) =>
        setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))),
      add: () => setRows((rs) => [...rs, { id: nextId(rs), editing: true, ...blank(rs) } as T]),
      remove: (id: number) => setRows((rs) => rs.filter((r) => r.id !== id)),
    }),
    [blank],
  );
  return [rows, ops] as const;
}

/** Short guidance on how to name a concept, surfaced from the Concept field's ⓘ button. */
function NamingGuide() {
  return (
    <div className="legend-note naming-guide" data-testid="naming-help">
      <p>
        Name a concept by its common <strong>English name</strong>, lowercase, with words joined by
        hyphens — e.g. <code>additive-inverse</code>, <code>abelian-group</code>.
      </p>
      <ul>
        <li>
          Prefer the everyday name over the formal one: <code>power</code> not{' '}
          <code>exponentiation</code>, <code>gcd</code> not <code>greatest-common-divisor</code>.
        </li>
        <li>
          A name <em>and its arity together</em> identify a concept; the same name may recur at
          different arities (<code>disjoint-union</code> at 1 and 2). Set arity to the argument count.
        </li>
        <li>
          Reference each argument in speech with <code>$</code> and a{' '}
          <strong>letter-initial name</strong> (<code>$base</code>, <code>$power</code>,{' '}
          <code>$x</code>) — name it by its role or kind, not positionally (<code>$1</code>).
        </li>
        <li>Scan “Related concepts” below first, so you don’t add a duplicate.</li>
      </ul>
      <p>
        See the{' '}
        <a href="https://w3c.github.io/mathml-docs/concept-lists/" target="_blank" rel="noreferrer">
          W3C concept lists
        </a>{' '}
        and the{' '}
        <a href="https://w3c.github.io/mathml/#mixing_intent" target="_blank" rel="noreferrer">
          Intent spec
        </a>
        .
      </p>
    </div>
  );
}

function MacroLegend() {
  return (
    <>
    <table className="legend" data-testid="legend">
      <thead>
        <tr>
          <th>Macro</th>
          <th>Use</th>
          <th>Example</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>{'\\arg{name}'}</code>
          </td>
          <td>mark an argument</td>
          <td>
            <code>{'\\arg{argname}{value}'}</code>
          </td>
        </tr>
        <tr>
          <td>
            <code>{'\\intent{expr}{notation}'}</code>
          </td>
          <td>mark an intent expression</td>
          <td>
            <code>{'\\intent{biconditional($lhs,$rhs)}{\\arg{lhs}{A}\\iff\\arg{rhs}{B}}'}</code>
          </td>
        </tr>
        <tr>
          <td>
            <code>{'\\MathMLarg'}</code>,<br />
            <code>{'\\MathMLintent'}</code>
          </td>
          <td>official aliases of the above</td>
          <td>
            <code>{'\\MathMLarg{x}{n}'}</code>
          </td>
        </tr>
      </tbody>
    </table>
    <p className="legend-note" data-testid="intent-default-help">
      <code>{'\\intent'}</code> is optional: if you omit it, the root intent is filled in automatically
      as <code>{'concept($arg1, $arg2, …)'}</code> — the concept name applied to your{' '}
      <code>{'\\arg'}</code> names, in the order they appear. So{' '}
      <code>{'\\arg{base}{x}^{\\arg{power}{n}}'}</code> on the concept <code>power</code> already means{' '}
      <code>{'power($base,$power)'}</code>. Write <code>{'\\intent'}</code> only to <em>override</em> that
      default: a different name, reordered/renamed arguments, a nested expression, or an argument-free
      symbol (e.g. <code>{'\\intent{the-reals}{\\mathbb{R}}'}</code>).
    </p>
    </>
  );
}

/**
 * One notation's authoring block — the structure the primary established, reused by every extra:
 * a head line (mode toggle + macro help + optional remove), a full-width source textarea, an inline
 * error slot scoped to THIS block, and the two-panel preview row (Rendered ∥ MathML source).
 */
function NotationAuthor({
  label,
  mode,
  tex,
  mathml,
  draft,
  fallback = null,
  loading,
  onMode,
  onTex,
  onMathml,
  onRemove,
  testId,
  readOnly = false,
  beforeTex,
  beforeMathml,
}: {
  label: ReactNode;
  mode: 'tex' | 'mathml';
  tex: string;
  mathml: string;
  draft: NotationDraft;
  /** Existing stored MathML shown while nothing (new) is authored — the primary's "keep current". */
  fallback?: string | null;
  /** Engine still loading (used for the Rendered panel hint). */
  loading: boolean;
  onMode: (m: 'tex' | 'mathml') => void;
  onTex: (v: string) => void;
  onMathml: (v: string) => void;
  /** Present on extras only — the ✕ that removes the whole block. */
  onRemove?: () => void;
  testId?: string;
  /** View-only: drop the mode toggle, source textarea and remove control — keep just the previews. */
  readOnly?: boolean;
  /** Review diff (read-only): the main version's TeX / stored MathML — the "before" side of each source
   *  diff. When provided, the TeX and MathML source panels render old→new (red removed / green added). */
  beforeTex?: string;
  beforeMathml?: string;
}) {
  const display = draft.display ?? fallback;
  const source = draft.source ?? fallback;
  const diffSource = beforeTex != null || beforeMathml != null; // a review diff is in effect
  const mathChanged = (beforeMathml ?? '').trim() !== (source ?? '').trim();
  return (
    <div className="notation-block" data-testid={testId}>
      {/* The authoring head (label + mode toggle + source textarea) is editing-only. In a read-only view
          the label is dropped — the sub-labels (Rendered / TeX source / MathML source) make it clear. */}
      {!readOnly && (
        <div className="field">
          <span className="notation-head">
            {label}
            <span className="mode-toggle" role="tablist" aria-label="Notation input mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'tex'}
                className={mode === 'tex' ? 'active' : ''}
                onClick={() => onMode('tex')}
              >
                TeX
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'mathml'}
                className={mode === 'mathml' ? 'active' : ''}
                onClick={() => onMode('mathml')}
              >
                Raw MathML
              </button>
            </span>
            {mode === 'tex' && (
              <InfoPopover label="Macro help">
                <MacroLegend />
              </InfoPopover>
            )}
            {onRemove && (
              <IconButton className="icon-btn remove-notation" label="Remove notation" icon="×" title="Remove" onClick={onRemove} />
            )}
          </span>
          {mode === 'tex' ? (
            <textarea
              data-testid={testId ? `${testId}-tex` : 'tex-input'}
              aria-label="Notation TeX"
              value={tex}
              spellCheck={false}
              rows={2}
              placeholder={'-\\arg{x}{n}'}
              onChange={(e) => onTex(e.target.value)}
            />
          ) : (
            <textarea
              data-testid={testId ? `${testId}-mathml` : 'mathml-input'}
              aria-label="Raw MathML"
              value={mathml}
              spellCheck={false}
              rows={onRemove ? 4 : 15}
              placeholder="<math>…</math>"
              onChange={(e) => onMathml(e.target.value)}
            />
          )}
        </div>
      )}
      {draft.error ? (
        <span className="error" role="alert" data-testid={testId ? `${testId}-error` : 'error'}>
          {draft.error}
        </span>
      ) : (
        <div className="previews">
          <div className="preview-cell">
            <span className="preview-label">Rendered</span>
            {display ? (
              <MathML className="preview" markup={display} data-testid={testId ? `${testId}-preview` : 'preview'} />
            ) : (
              <span className="hint">
                {mode === 'tex' && tex.trim() !== '' && loading ? 'Loading renderer…' : 'no notation'}
              </span>
            )}
          </div>
          {/* The authored TeX source — read-only only, when this notation (or its main version) has TeX.
              In a review diff it renders old→new (red removed / green added). */}
          {readOnly && (tex.trim() !== '' || (beforeTex ?? '').trim() !== '') && (
            <div className="preview-cell">
              <span className="preview-label">TeX source</span>
              <code className="tex-source" data-testid={testId ? `${testId}-texsrc` : 'tex-source'}>
                {diffSource ? <ValueDiff before={beforeTex} after={tex} /> : tex}
              </code>
            </div>
          )}
          <div className="preview-cell">
            <span className="preview-label">MathML source</span>
            {diffSource && mathChanged ? (
              <MathMLSourceDiff before={beforeMathml ?? ''} after={source ?? ''} />
            ) : source ? (
              <MathMLSource markup={source} />
            ) : (
              <span className="hint">—</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Full row editor (shown in the modal): every field of a concept is editable, the notation is authored
 * in TeX with a live MathML preview, and the row can be deleted. `onSave` receives the updated Concept;
 * `onDelete` removes it. The original `concept.raw` rides along (via the spread) for lossless writes.
 */
export function NotationEditor({
  concept,
  onSave,
  onDelete,
  onCancel,
  onDirtyChange,
  knownSlugs = NO_SLUGS,
  index,
  readOnly = false,
  base,
}: {
  concept: Concept;
  onSave?: (updated: Concept) => void;
  onDelete?: () => void;
  onCancel?: () => void;
  /** Reports whether the editor holds unsaved content changes (App's dismissal guard listens). */
  onDirtyChange?: (dirty: boolean) => void;
  /** All concept names in the dictionary — an alias highlights when it names a known concept. */
  knownSlugs?: ReadonlySet<string>;
  /** Dictionary-wide index powering the "related concepts" overview + alias-collision warnings. */
  index?: ConceptIndex;
  /** View-only mode: every field renders as read-only display, all editing/interactivity is removed, and
   *  the footer offers only "Close". Reuses the whole editor as the "expand"/full-entry preview. */
  readOnly?: boolean;
  /** In a review view, the `main` version of this entry — when set, each field renders an old→new diff
   *  (removed values red/struck, added values green) so a reviewer sees how each field changed. */
  base?: Concept;
}) {
  const isNew = concept.slug === ''; // a brand-new row (opened via "Add entry") starts slug-less
  const [slug, setSlug] = useState(concept.slug);
  const [area, setArea] = useState(concept.area ?? '');
  const [property, setProperty] = useState(concept.property ?? '');
  const [tex, setTex] = useState(concept.notations[0]?.tex ?? '');

  const [linkRows, linkOps] = useRowList<EditRow>(
    () => concept.links.map((value, i) => ({ id: i, value, editing: false })),
    blankEntry,
  );
  const [aliasRows, aliasOps] = useRowList<EditRow>(
    () => concept.alias.map((value, i) => ({ id: i, value, editing: false })),
    blankEntry,
  );
  // One editable text per language — its `default` reading (the common case). `en` is the anchor row;
  // any non-default readings (verbose/terse/condition) round-trip untouched via the model on save.
  const [speechRows, speechOps] = useRowList<SpeechRow>(() => {
    const rows: SpeechRow[] = [];
    if (concept.speech.some((s) => s.lang === 'en'))
      rows.push({ id: 0, lang: 'en', text: speechText(concept, 'en'), editing: false });
    for (const s of concept.speech)
      if (s.lang !== 'en')
        rows.push({ id: rows.length, lang: s.lang, text: readingFor(concept, s.lang)?.text ?? '', editing: false });
    return rows;
  }, blankSpeech);

  // Primary notation: authored EITHER as TeX (rendered to MathML) OR as raw MathML, seeded with the
  // current. Opens in TeX mode (prefilled when `notations[0].tex` was persisted; blank TeX = keep the
  // stored rendering).
  const [mode, setMode] = useState<'tex' | 'mathml'>('tex');
  const [rawMathml, setRawMathml] = useState(concept.notations[0]?.mathml ?? '');
  // Additional renderings (notations[1..]) — each with the SAME dual-mode authoring block as the
  // primary; a persisted `tex` reopens that extra in TeX mode with its source.
  const [extraRows, extraOps] = useRowList<NotationRow>(
    () =>
      concept.notations.slice(1).map((n, i) => ({
        id: i,
        mode: n.tex != null ? ('tex' as const) : ('mathml' as const),
        tex: n.tex ?? '',
        mathml: n.mathml,
        editing: false,
      })),
    () => ({ mode: 'tex' as const, tex: '', mathml: '' }),
  );

  const [engine, setEngine] = useState<TemmlEngine | null>(null);
  useEffect(() => {
    let live = true;
    loadTemml().then((e) => live && setEngine(e));
    return () => {
      live = false;
    };
  }, []);

  // One pipeline for every notation (primary + extras): TeX → texToIntent → minify, raw → XML check.
  const primaryDraft = useMemo(
    () => deriveNotation(engine, slug, mode, tex, rawMathml),
    [engine, slug, mode, tex, rawMathml],
  );
  const extraDrafts = useMemo(
    () => extraRows.map((r) => deriveNotation(engine, slug, r.mode, r.tex, r.mathml)),
    [engine, slug, extraRows],
  );
  const extraBlocked = extraDrafts.some((d) => d.blocks);
  const canSave = slug.trim() !== '' && !primaryDraft.blocks && !extraBlocked;

  // The primary's preview falls back to the concept's existing stored rendering while nothing new is
  // authored (blank TeX = keep current); the "MathML source" panel mirrors what the file will hold.
  const effectiveMathml = primaryDraft.display ?? concept.notations[0]?.mathml ?? null;
  // Validation spans all languages: a `$ref` in any template, an `arg` referenced by none of them.
  const allSpeech = useMemo(() => speechRows.map((r) => r.text).join('\n'), [speechRows]);
  const missingRefs = useMemo(
    () => (effectiveMathml ? missingSpeechRefs(allSpeech, effectiveMathml) : []),
    [allSpeech, effectiveMathml],
  );
  const unusedArgs = useMemo(
    () => (effectiveMathml && allSpeech.trim() !== '' ? unusedArgRefs(allSpeech, effectiveMathml) : []),
    [allSpeech, effectiveMathml],
  );
  const invalidLangs = useMemo(
    () => speechRows.map((r) => r.lang.trim()).filter((l) => l !== '' && !ISO6391.validate(l)),
    [speechRows],
  );

  // Authoring helpers (only when the dictionary index is supplied): concepts related to what's being
  // authored (dedup aid) and warnings about aliases that collide with other concepts. `concept.slug`
  // (the row's original identity) is excluded so a concept never flags itself or its own aliases.
  const typedAliases = useMemo(() => aliasRows.map((r) => r.value), [aliasRows]);
  const related = useMemo(
    () =>
      index ? relatedConcepts(index, { slug, aliases: typedAliases, area }, concept.slug) : { items: [], total: 0 },
    [index, slug, typedAliases, area, concept.slug],
  );
  const aliasWarns = useMemo(
    () => (index ? aliasWarnings(index, concept.slug, typedAliases) : []),
    [index, typedAliases, concept.slug],
  );

  const buildUpdated = (): Concept => {
    // Each notation stores `{tex?, mathml}`: the TeX-derived rendering keeps its source (and stores the
    // minified MathML — the web re-renders the rich form from `tex`); raw MathML is verbatim with no
    // `tex` key. An untouched primary keeps the concept's existing first rendering.
    const notations: Notation[] = [];
    const primaryOut = primaryDraft.out ?? concept.notations[0]?.mathml ?? null;
    const primaryTex = mode === 'tex' ? tex.trim() || undefined : undefined;
    if (primaryOut != null && primaryOut !== '') {
      notations.push(primaryTex !== undefined ? { tex: primaryTex, mathml: primaryOut } : { mathml: primaryOut });
    }
    extraRows.forEach((r, i) => {
      const out = extraDrafts[i]?.out;
      if (out == null || out === '') return; // empty extras drop out
      notations.push(r.mode === 'tex' ? { tex: r.tex.trim(), mathml: out } : { mathml: out });
    });
    // Intent is derived from the primary notation's root intent (`concept($args)`); omitted for a bare
    // arity-0 concept. Falls back to the concept's own intent while nothing new is authored.
    let intent = concept.intent;
    if (primaryOut != null && primaryOut !== '') {
      const ri = primaryOut.match(/intent="([^"]*)"/)?.[1];
      intent = ri && ri.includes('(') ? ri : undefined;
    }
    // Each speech row is a language's `default` reading; any non-default readings (verbose/terse/
    // condition) already on that language are preserved from the current model.
    const speech = speechRows
      .map((r): SpeechLang | null => {
        const lang = r.lang.trim();
        const text = r.text.trim();
        if (lang === '' || !ISO6391.validate(lang)) return null;
        const orig = concept.speech.find((s) => s.lang === lang);
        let readings: Reading[];
        if (orig) {
          readings = orig.readings.flatMap((rd) =>
            rd.verbosity === 'default' ? (text !== '' ? [{ ...rd, text }] : []) : [rd],
          );
          if (text !== '' && !orig.readings.some((rd) => rd.verbosity === 'default'))
            readings.push({ verbosity: 'default', text });
        } else {
          readings = text !== '' ? [{ verbosity: 'default', text }] : [];
        }
        return readings.length ? { lang, readings } : null;
      })
      .filter((s): s is SpeechLang => s !== null);
    return {
      ...concept, // carries `raw` (and `comment`) for lossless serialization
      slug: slug.trim(),
      intent,
      speech,
      area: area.trim() || undefined,
      property: property.trim() || undefined,
      notations,
      // Links/aliases are sets — drop blanks and de-duplicate (first occurrence wins).
      links: uniq(linkRows.map((r) => r.value.trim()).filter(Boolean)),
      alias: uniq(aliasRows.map((r) => r.value.trim()).filter(Boolean)),
    };
  };

  // Unsaved-content signal for App's dismissal guard: the CONTENT state (not transient UI state like
  // open-for-editing flags or a peeked mode toggle) compared against its first-render snapshot — so an
  // edit-then-revert reads clean again.
  const contentState = JSON.stringify([
    slug,
    area,
    property,
    tex,
    rawMathml,
    linkRows.map((r) => r.value),
    aliasRows.map((r) => r.value),
    speechRows.map((r) => [r.lang, r.text]),
    extraRows.map((r) => [r.mode, r.tex, r.mathml]),
  ]);
  // Snapshot the first render's content (lazy state init, never updated) so `dirty` is readable during
  // render — a ref read in render scope trips react-hooks/refs, and we need `dirty` for Done's state.
  const [initialContent] = useState(() => contentState);
  const dirty = contentState !== initialContent;
  useEffect(() => {
    if (!readOnly) onDirtyChange?.(dirty); // a view never reports dirtiness (nothing can change)
  }, [dirty, onDirtyChange, readOnly]);
  // Done is unavailable while invalid (canSave) or while there is nothing to stage (dirty) — but via
  // aria-disabled, never the native attribute: a disabled button drops out of the tab order, so a
  // screen-reader user tabbing the dialog never finds it (round-3 feedback). aria-disabled keeps it
  // focusable and announced as unavailable; the onClick guard makes it inert.
  const saveDisabled = !canSave || !dirty;

  // A review view diffs each field against `base` (the main version); a plain browse view just displays.
  const diffing = readOnly && base != null;
  // The main version's speech, keyed by language (English under `en`) — the "before" side of a speech diff.
  const baseSpeech = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of base?.speech ?? []) {
      const def = s.readings.find((r) => r.verbosity === 'default') ?? s.readings[0];
      if (def) m.set(s.lang, def.text);
    }
    return m;
  }, [base]);
  // The main version's links/aliases as sets — to mark added items (green) and list removed ones (red).
  const baseLinks = useMemo(() => new Set(base?.links ?? []), [base]);
  const baseAliases = useMemo(() => new Set(base?.alias ?? []), [base]);

  /** A read-only scalar field; in a review diff `before` (the main value) drives an old→new render. */
  const viewField = (head: string, after: string, before?: string | null, testId?: string) => (
    <div className="field">
      <span className="field-head">{head}</span>
      <span className="field-value" data-testid={testId}>
        {diffing ? <ValueDiff before={before} after={after} /> : after.trim() || '—'}
      </span>
    </div>
  );

  return (
    <div className={`notation-editor${readOnly ? ' read-only' : ''}`} data-testid="notation-editor">
      <h2>
        {readOnly ? (
          <>View concept: <code>{concept.slug}</code></>
        ) : isNew ? (
          'Add concept'
        ) : (
          <>Edit concept: <code>{concept.slug}</code></>
        )}
      </h2>

      <div className="fields">
        {readOnly ? (
          <>
            {viewField('Concept', slug, base?.slug, 'slug-value')}
            {viewField('Intent', concept.intent ?? '', base?.intent ?? '', 'intent-value')}
            {viewField('Area', area, base?.area, 'area-value')}
            {viewField('Properties', property, base?.property, 'property-value')}
          </>
        ) : (
          <>
            <div className="field">
              <span className="field-head">
                Concept
                <InfoPopover label="Naming help">
                  <NamingGuide />
                </InfoPopover>
              </span>
              <input
                data-testid="slug-input"
                aria-label="Concept"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <label className="field">
              <span>Area</span>
              <input value={area} onChange={(e) => setArea(e.target.value)} />
            </label>
            <div className="field">
              <span className="field-head">
                Properties
                <InfoPopover label="Properties help">
                  <p className="legend-note" data-testid="properties-help">
                    Space-separated list of notation forms — e.g. <code>symbol</code>{' '}
                    <code>indexed</code> <code>prefix</code> <code>function</code>.
                  </p>
                </InfoPopover>
              </span>
              <input
                data-testid="property-input"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      {!readOnly && related.items.length > 0 && (
        <div className="related" data-testid="related-concepts">
          <span className="related-head">Related concepts already in the list</span>
          <ul className="related-list">
            {related.items.map((r) => (
              <li key={r.slug} className={`related-item ${r.kind}`}>
                <code className="related-slug">{r.slug}</code>
                {r.arities.length > 0 && (
                  <span className="related-arity">arity {r.arities.join(', ')}</span>
                )}
                {r.area && <span className="related-area">{r.area}</span>}
                {r.kind === 'collision' && (
                  <span className="related-flag" title="A concept with this name or alias already exists">
                    possible duplicate
                  </span>
                )}
              </li>
            ))}
          </ul>
          {related.total > related.items.length && (
            <span className="related-more">+{related.total - related.items.length} more</span>
          )}
        </div>
      )}

      {/* Read-only lays Notation (left) and Speech (right) side by side (CSS), filling the otherwise-empty
          space next to the speech hints; while editing they stack (the wrapper is a single-column grid). */}
      <div className="ns-split">
      {/* Speech is full-width and multilingual: one template per language (ISO 639-1 key). */}
      <div className="field">
        <span className="field-head">
          Speech
          {!readOnly && (
            <InfoPopover label="Language help">
              <p className="legend-note" data-testid="language-help">
                Each template is keyed by an ISO 639-1 language code — <code>en</code> (English),{' '}
                <code>de</code> (German), <code>fr</code> (French)… Start typing a code to autocomplete.
                Speak each argument with a <code>$ref</code> (e.g. <code>$x</code>, <code>$1</code>).
              </p>
            </InfoPopover>
          )}
        </span>
        <div className="speech-list" data-testid="speech-list">
          {speechRows.map((row) =>
            !readOnly && (row.editing || row.text.trim() === '') ? (
              <div
                className="speech-row editing"
                key={row.id}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) speechOps.patch(row.id, { editing: false });
                }}
              >
                <input
                  className="lang-input"
                  list="iso-639-langs"
                  aria-label="Language"
                  placeholder="en"
                  value={row.lang}
                  spellCheck={false}
                  size={4}
                  onChange={(e) => speechOps.patch(row.id, { lang: e.target.value })}
                />
                <textarea
                  className="speech-input"
                  aria-label="Speech template"
                  rows={2}
                  value={row.text}
                  spellCheck={false}
                  placeholder="additive inverse of $x"
                  onChange={(e) => speechOps.patch(row.id, { text: e.target.value })}
                />
                <RowControls noun="speech" onRemove={() => speechOps.remove(row.id)} />
              </div>
            ) : (
              <div className="speech-row" key={row.id}>
                <span className="lang-badge" data-testid="lang-badge" title={ISO6391.getName(row.lang) || row.lang}>
                  {row.lang || '—'}
                </span>
                <span className="speech-text" lang={row.lang || undefined}>
                  {diffing ? <ValueDiff before={baseSpeech.get(row.lang)} after={row.text} /> : row.text}
                </span>
                {!readOnly && (
                  <RowControls
                    noun="speech"
                    onEdit={() => speechOps.patch(row.id, { editing: true })}
                    onRemove={() => speechOps.remove(row.id)}
                  />
                )}
              </div>
            ),
          )}
          {/* Languages the PR removed (present in main, gone now) — shown struck through in red. */}
          {diffing &&
            [...baseSpeech.keys()]
              .filter((lang) => !speechRows.some((r) => r.lang === lang))
              .map((lang) => (
                <div className="speech-row" key={`removed-${lang}`}>
                  <span className="lang-badge" title={ISO6391.getName(lang) || lang}>
                    {lang}
                  </span>
                  <span className="speech-text">
                    <del className="diff-del">{baseSpeech.get(lang)}</del>
                  </span>
                </div>
              ))}
          {!readOnly && (
            <button type="button" className="add-link" onClick={speechOps.add}>
              + Add language
            </button>
          )}
        </div>
        {!readOnly && (
          <datalist id="iso-639-langs">
            {LANG_CODES.map((code) => (
              <option key={code} value={code}>
                {ISO6391.getName(code)}
              </option>
            ))}
          </datalist>
        )}
      </div>

      <NotationAuthor
        label={readOnly && extraRows.length > 0 ? 'Notation (primary)' : 'Notation'}
        mode={mode}
        tex={tex}
        mathml={rawMathml}
        draft={primaryDraft}
        fallback={concept.notations[0]?.mathml ?? null}
        loading={!engine}
        onMode={setMode}
        onTex={setTex}
        onMathml={setRawMathml}
        readOnly={readOnly}
        beforeTex={diffing ? base?.notations[0]?.tex ?? '' : undefined}
        beforeMathml={diffing ? base?.notations[0]?.mathml ?? '' : undefined}
      />
      </div>

      {!readOnly && missingRefs.length > 0 && (
        <p className="warn" role="status" data-testid="ref-warning">
          Speech references not marked in the notation: {missingRefs.join(', ')}
        </p>
      )}
      {!readOnly && unusedArgs.length > 0 && (
        <p className="warn" role="status" data-testid="unused-warning">
          Notation arguments never used in the speech: {unusedArgs.map((a) => `arg="${a}"`).join(', ')}
        </p>
      )}
      {!readOnly && invalidLangs.length > 0 && (
        <p className="warn" role="status" data-testid="lang-warning">
          Not valid ISO 639-1 language codes (won’t be saved): {invalidLangs.join(', ')}
        </p>
      )}

      {/* Additional renderings (notations[1..]) — each authored exactly like the primary. Hidden in a
          view that has none (nothing to show); otherwise each is a preview-only block while read-only. */}
      {(!readOnly || extraRows.length > 0) && (
        <div className="field">
          <span className="field-head">
            Additional notations
            {!readOnly && (
              <InfoPopover label="Additional notations help">
                <p className="legend-note">
                  Extra renderings of this concept. Author each in TeX (with <code>{'\\arg'}</code>/
                  <code>{'\\intent'}</code>) or as a full raw <code>{'<math>…</math>'}</code>, keeping its{' '}
                  <code>arg</code>/<code>intent</code> names in sync with the concept.
                </p>
              </InfoPopover>
            )}
          </span>
          <div className="notation-list" data-testid="notation-list">
            {extraRows.map((row, i) => (
              <NotationAuthor
                key={row.id}
                testId="extra-notation"
                label={null}
                mode={row.mode}
                tex={row.tex}
                mathml={row.mathml}
                draft={extraDrafts[i] ?? EMPTY_DRAFT}
                loading={!engine}
                onMode={(m) => extraOps.patch(row.id, { mode: m })}
                onTex={(v) => extraOps.patch(row.id, { tex: v })}
                onMathml={(v) => extraOps.patch(row.id, { mathml: v })}
                onRemove={() => extraOps.remove(row.id)}
                readOnly={readOnly}
              />
            ))}
            {!readOnly && (
              <button type="button" className="add-link" onClick={extraOps.add}>
                + Add notation
              </button>
            )}
          </div>
        </div>
      )}

      {(!readOnly || linkRows.length > 0 || aliasRows.length > 0) && (
        <div className="pair">
          {(!readOnly || linkRows.length > 0 || (diffing && baseLinks.size > 0)) && (
            <div className="field">
              <span>Links</span>
              <div className="link-list" data-testid="link-list">
                {linkRows.map((row) =>
                  !readOnly && (row.editing || row.value.trim() === '') ? (
                    <div className="link-row" key={row.id}>
                      <input
                        className="link-input"
                        type="url"
                        aria-label="Link URL"
                        placeholder="https://…"
                        value={row.value}
                        spellCheck={false}
                        autoFocus
                        onChange={(e) => linkOps.patch(row.id, { value: e.target.value })}
                        onBlur={() => linkOps.patch(row.id, { editing: false })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            linkOps.patch(row.id, { editing: false });
                          }
                        }}
                      />
                      <RowControls noun="link" onRemove={() => linkOps.remove(row.id)} />
                    </div>
                  ) : (
                    <div className="link-row" key={row.id}>
                      {/* not active → clickable; in a review diff a brand-new link reads green */}
                      <a
                        className={`link-display${diffing && !baseLinks.has(row.value) ? ' diff-add' : ''}`}
                        href={row.value}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.value}
                      </a>
                      {!readOnly && (
                        <RowControls
                          noun="link"
                          onEdit={() => linkOps.patch(row.id, { editing: true })}
                          onRemove={() => linkOps.remove(row.id)}
                        />
                      )}
                    </div>
                  ),
                )}
                {/* Links the PR removed (in main, gone now) — struck through in red. */}
                {diffing &&
                  [...baseLinks]
                    .filter((url) => !linkRows.some((r) => r.value === url))
                    .map((url) => (
                      <div className="link-row" key={`removed-${url}`}>
                        <del className="diff-del">{url}</del>
                      </div>
                    ))}
                {!readOnly && (
                  <button type="button" className="add-link" onClick={linkOps.add}>
                    + Add link
                  </button>
                )}
              </div>
            </div>
          )}
          {(!readOnly || aliasRows.length > 0 || (diffing && baseAliases.size > 0)) && (
            <div className="field">
              <span>Aliases</span>
              <div className="alias-list" data-testid="alias-list">
                {aliasRows.map((row) =>
                  !readOnly && (row.editing || row.value.trim() === '') ? (
                    <span className="alias-edit" key={row.id}>
                      <input
                        className="alias-input"
                        aria-label="Alias"
                        placeholder="snake_case"
                        value={row.value}
                        spellCheck={false}
                        autoFocus
                        size={Math.max(row.value.length + 1, 8)}
                        onChange={(e) => aliasOps.patch(row.id, { value: e.target.value })}
                        onBlur={() => aliasOps.patch(row.id, { editing: false })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            aliasOps.patch(row.id, { editing: false });
                          }
                        }}
                      />
                      <RowControls noun="alias" onRemove={() => aliasOps.remove(row.id)} />
                    </span>
                  ) : (
                    // A completed alias is a chip: highlighted when it names a known concept, muted when
                    // not; in a review diff a brand-new alias reads green.
                    <span
                      className={`alias-chip ${knownSlugs.has(row.value.trim()) ? 'known' : 'unknown'}${
                        diffing && !baseAliases.has(row.value) ? ' diff-add' : ''
                      }`}
                      key={row.id}
                      data-testid="alias-chip"
                    >
                      <span className="alias-text">{row.value}</span>
                      {!readOnly && (
                        <RowControls
                          noun="alias"
                          onEdit={() => aliasOps.patch(row.id, { editing: true })}
                          onRemove={() => aliasOps.remove(row.id)}
                        />
                      )}
                    </span>
                  ),
                )}
                {/* Aliases the PR removed (in main, gone now) — struck through in red. */}
                {diffing &&
                  [...baseAliases]
                    .filter((a) => !aliasRows.some((r) => r.value === a))
                    .map((a) => (
                      <span className="alias-chip removed" key={`removed-${a}`}>
                        <del className="diff-del">{a}</del>
                      </span>
                    ))}
                {!readOnly && <IconButton className="add-alias" label="Add alias" icon="+" onClick={aliasOps.add} />}
              </div>
              {!readOnly && aliasWarns.length > 0 && (
                <p className="warn" role="status" data-testid="alias-warning">
                  {aliasWarns.join('; ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sticky footer. In a view it's just "Close"; while editing, Done/Cancel stay reachable as the
          (tall) body scrolls, with the destructive Delete on the opposite side from a Done/Cancel slip. */}
      <div className="actions">
        {readOnly ? (
          onCancel && (
            <button type="button" data-testid="close" onClick={onCancel}>
              Close
            </button>
          )
        ) : (
          <>
            <button
              type="button"
              data-testid="save"
              aria-disabled={saveDisabled}
              onClick={() => !saveDisabled && onSave?.(buildUpdated())}
            >
              Done
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
            )}
            {onDelete && (
              <button type="button" className="danger" data-testid="delete" onClick={onDelete}>
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
