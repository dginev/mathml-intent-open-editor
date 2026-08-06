import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import ISO6391 from 'iso-639-1';
import type { Concept } from '../types';
import { speechText } from '../types';
import { conceptId } from '../data/conceptId';
import type { ChangeKind } from '../data/pendingChanges';
import { linkDomain } from './linkDomain';
import { MathML } from './MathML';
import { notationMarkup } from '../render/notationMarkup';
import { loadTemml, type TemmlEngine } from '../render/temmlEngine';

const columnHelper = createColumnHelper<Concept>();

/** Per-row callbacks + the (lazily loaded) Temml engine the display columns reach through TanStack's `meta`. */
type TableMeta = {
  onEdit?: (c: Concept) => void;
  onDelete?: (c: Concept) => void;
  /** Open a read-only full-entry preview (the row's "more to see" affordance). */
  onView?: (c: Concept) => void;
  /** Gate the affordance to rows whose preview adds something the row hides (always true while reviewing). */
  canView?: (c: Concept) => boolean;
  changeKind?: (c: Concept) => ChangeKind | null;
  /** Loaded once any visible row has `tex`; lets the Notation cell re-render the rich form (else stored). */
  engine?: TemmlEngine | null;
  /** The Speech column's language selection: languages present in the data + the active pick. */
  languages?: string[];
  speechLang?: string;
  onSpeechLangChange?: (lang: string) => void;
};


/** Status-column icon + accessible name per pending-change kind (WCAG 1.4.1: state not by color alone). */
const STATUS: Record<ChangeKind, { icon: string; label: string }> = {
  added: { icon: '+', label: 'added' },
  changed: { icon: '✎', label: 'edited' },
  deleted: { icon: '−', label: 'pending deletion' },
};

const columns = [
  columnHelper.display({
    id: 'status',
    header: '',
    size: 36,
    // A leading icon naming the row's pending change — the redundant, non-color state cue that the
    // row tint + border stripe pair with. Empty for unchanged rows.
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta | undefined;
      const kind = meta?.changeKind?.(row.original) ?? null;
      if (!kind) return null;
      const s = STATUS[kind];
      return (
        <span className={`row-status status-${kind}`} role="img" aria-label={s.label} title={s.label}>
          {s.icon}
        </span>
      );
    },
  }),
  columnHelper.accessor('slug', { header: 'Concept', size: 240 }),
  columnHelper.display({
    id: 'speech',
    size: 280,
    // Header = the "Speech hint" column label with a slim language dropdown INLINE beside it — the
    // options show bare ISO codes (the selected language's full name rides on the select's title) so
    // the header stays a single line. With one language (the seed/e2e path) it stays plain text.
    header: ({ table }) => {
      const meta = table.options.meta as TableMeta | undefined;
      const lang = meta?.speechLang ?? 'en';
      const languages = meta?.languages ?? ['en'];
      const onChange = meta?.onSpeechLangChange;
      if (languages.length <= 1 || !onChange) return `Speech hint (${lang})`;
      // A ?lang= deep link may name a language absent from the data — keep the select consistent.
      const options = languages.includes(lang) ? languages : [...languages, lang];
      return (
        <span className="speech-head">
          <span className="speech-head-label">Speech hint</span>
          <select
            className="speech-lang"
            aria-label="Speech language"
            title={ISO6391.getName(lang) || lang}
            value={lang}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((l) => (
              <option key={l} value={l} title={ISO6391.getName(l) || l}>
                {l}
              </option>
            ))}
          </select>
        </span>
      );
    },
    // The selected language's template, carrying its `lang` attribute (screen-reader pronunciation).
    // A row without that language shows an EMPTY cell (decision per @dginev) — untranslated entries
    // are visible at a glance instead of being papered over with an English fallback.
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta | undefined;
      const lang = meta?.speechLang ?? 'en';
      const text = speechText(row.original, lang);
      return text.trim() !== '' ? <span lang={lang}>{text}</span> : null;
    },
  }),
  columnHelper.accessor('area', { header: 'Area', size: 180 }),
  columnHelper.display({
    id: 'notation',
    header: 'Notation',
    size: 160,
    // Re-render the rich MathML from `tex` when present (else the stored, minified mathml). The engine
    // rides in on `meta`; until it loads (or for tex-less rows) `notationMarkup` returns the stored form.
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta | undefined;
      return <MathML markup={notationMarkup(row.original, meta?.engine ?? null)} className="mathml" />;
    },
  }),
  columnHelper.accessor((c) => c.links, {
    id: 'links',
    header: 'Links',
    size: 220,
    cell: (info) => (
      <div className="link-chips">
        {info.getValue().map((url, i) => (
          <a
            key={i}
            className="link-chip"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={url}
          >
            {linkDomain(url)}
          </a>
        ))}
      </div>
    ),
  }),
  columnHelper.display({
    id: 'actions',
    header: '',
    size: 132, // fits up to three 1.5×-sized icon buttons (⤢ ✎ ✗) without clipping (.td clips overflow)
    cell: ({ row, table }) => {
      const meta = table.options.meta as TableMeta | undefined;
      const onEdit = meta?.onEdit;
      const onDelete = meta?.onDelete;
      const onView = meta?.onView;
      const kind = meta?.changeKind?.(row.original) ?? null;
      // Offer the preview when it would reveal something the row can't (per `canView`). The predicate is
      // passed the row's `kind` so it can short-circuit cheaply — in review mode unchanged rows return
      // `false` without running the full check.
      const showView = !!onView && (!meta?.canView || meta.canView(row.original));
      if (!onEdit && !onDelete && !onView) return null; // actions disabled for this view entirely
      const deleted = kind === 'deleted';
      // Each action KIND gets its own fixed-width sub-column so the icons line up into clean vertical
      // columns across rows. When a kind doesn't apply to a row (e.g. no "more to see"), its slot renders
      // an empty placeholder rather than collapsing — which would shift the neighbours. The set of slots
      // is uniform within a view (onView/onEdit/onDelete are table-wide), so columns stay aligned.
      return (
        <span className="row-actions">
          {onView &&
            (showView ? (
              <button
                type="button"
                className="row-view"
                aria-label={`Show full entry: ${row.original.slug} (more details)`}
                title="More details — show the full entry"
                onClick={() => onView(row.original)}
              >
                ⤢
              </button>
            ) : (
              <span className="row-slot" aria-hidden="true" />
            ))}
          {onEdit && (
            <button
              type="button"
              className="row-edit"
              aria-label={`Edit ${row.original.slug}`}
              title="Edit row"
              onClick={() => onEdit(row.original)}
            >
              ✎
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="row-x"
              aria-label={`${deleted ? 'Restore' : 'Delete'} ${row.original.slug}`}
              title={deleted ? 'Restore row' : 'Delete row'}
              onClick={() => onDelete(row.original)}
            >
              {deleted ? '↺' : '✗'}
            </button>
          )}
        </span>
      );
    },
  }),
];

const ROW_HEIGHT = 40;

/** Trigger `onLoadMore` when the user pages within this many rows of the loaded bottom. */
const LOAD_THRESHOLD = 20;

export function ConceptTable({
  data,
  total,
  onEdit,
  onLoadMore,
  editingId,
  onDelete,
  onView,
  canView,
  changeKind,
  headerActions,
  languages,
  speechLang,
  onSpeechLangChange,
}: {
  /** The exact rows to render (the paged prefix, or the full filtered set when a filter is active). */
  data: Concept[];
  /** Total rows available; `data.length < total` means more can be paged in (disabled while filtering). */
  total: number;
  /** Per-row edit (the ✎ button); rows themselves are not clickable. */
  onEdit?: (concept: Concept) => void;
  onLoadMore?: () => void;
  /** conceptId of the row being edited — highlighted and scrolled to centre while the modal is open. */
  editingId?: string | null;
  /** Per-row delete/restore (the ✗ / ↺ button). */
  onDelete?: (concept: Concept) => void;
  /** Per-row read-only full-entry preview (the "more to see" affordance). */
  onView?: (concept: Concept) => void;
  /** Gate it to rows whose preview adds something beyond the row (returns false → no button). */
  canView?: (concept: Concept) => boolean;
  /** Classify a row's pending change (added / changed / deleted) for its background colour. */
  changeKind?: (concept: Concept) => ChangeKind | null;
  /** Buttons rendered as a phantom rightmost column in the sticky header (Add entry + batch Save). */
  headerActions?: ReactNode;
  /** Languages present in the dictionary (en first); >1 turns the Speech header into a dropdown. */
  languages?: string[];
  /** The Speech column's selected language (default `en`). */
  speechLang?: string;
  onSpeechLangChange?: (lang: string) => void;
}) {
  // Lazily load Temml only when some row's primary notation has `tex` to re-render (the seed/e2e data
  // has none, so the perf path never pulls Temml). Cells render the stored mathml until the engine resolves.
  const [engine, setEngine] = useState<TemmlEngine | null>(null);
  const needsEngine = useMemo(
    () => data.some((c) => c.notations[0]?.tex != null && c.notations[0].tex.trim() !== ''),
    [data],
  );
  useEffect(() => {
    if (!needsEngine || engine) return;
    let live = true;
    loadTemml().then((e) => live && setEngine(e));
    return () => {
      live = false;
    };
  }, [needsEngine, engine]);

  // Concept column: wide enough for the longest slug on screen (canonical names run long —
  // `incomplete-elliptic-integral-of-the-second-kind` is 48 chars and overflowed the fixed 240px).
  // Estimated from character count (~8px/char at the cell's font), floored at the default, capped
  // against pathological names.
  const slugWidth = useMemo(() => {
    let max = 0;
    for (const c of data) if (c.slug.length > max) max = c.slug.length;
    return Math.min(Math.max(240, max * 8 + 24), 560);
  }, [data]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { columnSizing: { slug: slugWidth } },
    meta: { onEdit, onDelete, onView, canView, changeKind, engine, languages, speechLang, onSpeechLangChange },
  });

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const totalWidth = table.getTotalSize();
  const items = virtualizer.getVirtualItems();

  // Page in more data when the rendered window approaches the end of what's loaded.
  const lastIndex = items.length ? items[items.length - 1].index : 0;
  useEffect(() => {
    if (data.length < total && lastIndex >= rows.length - LOAD_THRESHOLD) onLoadMore?.();
  }, [lastIndex, rows.length, data.length, total, onLoadMore]);

  // When a row opens in the editor, scroll it to the centre (it sits behind the centred modal).
  useEffect(() => {
    if (!editingId) return;
    const idx = rows.findIndex((r) => conceptId(r.original) === editingId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  return (
    <div className="table-scroll" ref={scrollRef} data-testid="table-scroll">
      {/* width is intrinsic (max-content) so the phantom header-actions column extends the table to its
          right; minWidth keeps it at least as wide as the data columns. ARIA table semantics are
          explicit (the grid is divs): aria-rowcount spans the FULL dictionary (+1 for the header row)
          and each virtualized row carries its absolute aria-rowindex, so screen readers know the DOM
          holds a window of a larger table. */}
      <div
        className="table-inner"
        style={{ minWidth: totalWidth }}
        role="table"
        aria-label="Concept dictionary"
        aria-rowcount={total + 1}
      >
        <div className="thead" role="rowgroup">
          {table.getHeaderGroups().map((hg) => (
            <div className="tr" role="row" aria-rowindex={1} key={hg.id}>
              {hg.headers.map((h) => (
                <div
                  className={`th col-${h.column.id}`}
                  role="columnheader"
                  key={h.id}
                  style={{ width: h.getSize() }}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </div>
              ))}
              {headerActions && (
                <div className="th th-actions" role="columnheader" key="__header-actions">
                  {headerActions}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="tbody" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((vi) => {
            const row = rows[vi.index];
            const kind = changeKind?.(row.original) ?? null;
            return (
              <div
                className={`tr${conceptId(row.original) === editingId ? ' row-editing' : ''}${
                  kind ? ` row-${kind}` : ''
                }`}
                key={row.id}
                role="row"
                aria-rowindex={vi.index + 2} // 1-based, after the header row
                data-index={vi.index}
                data-row-index={vi.index}
                data-slug={row.original.slug}
                ref={virtualizer.measureElement} // dynamic height: rows grow when Links wrap
                style={{ transform: `translateY(${vi.start}px)`, minHeight: ROW_HEIGHT }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    className={`td col-${cell.column.id}`}
                    role="cell"
                    key={cell.id}
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
