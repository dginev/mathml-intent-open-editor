import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearEdits } from './data/editCache';
import { conceptId } from './data/conceptId';
import { buildConceptIndex } from './data/conceptIndex';
import { conceptMatches, matchRank } from './data/conceptMatch';
import { classifyChange, type ChangeKind } from './data/pendingChanges';
import { hasHiddenInfo } from './data/entryPreview';
import { buildSubmission } from './github/submission';
import { useDictionary, type Review } from './hooks/useDictionary';
import { useIdentity } from './hooks/useIdentity';
import { useTheme } from './hooks/useTheme';
import { useGlobalFindShortcut } from './hooks/useGlobalFindShortcut';
import { useBackClose } from './hooks/useBackClose';
import { ConceptTable } from './components/ConceptTable';
import { Faq } from './components/Faq';
import { PrReviewPicker } from './components/PrReviewPicker';
import { InfoPopover, Toast } from './components/ui';
import { DATA_REPO, repoConfigFromEnv, serviceConfigFromEnv } from './github/config';
import { resetSession, submitToService } from './github/submitClient';
import { clearPr, fetchPullState, loadPr, savePr, type ActivePr } from './github/prSession';
import type { PullRequest } from './github/pulls';
import type { Concept } from './types';
import './App.css';

// The editor pulls in Temml (~the bulk of the bundle); load it only when a user starts editing.
const NotationEditor = lazy(() =>
  import('./components/NotationEditor').then((m) => ({ default: m.NotationEditor })),
);

const SESSION_EXPIRED =
  'Your session expired — you’ve been signed out. Sign in again to continue (your changes are kept).';

/** Read the deep-link filter from the current URL (`?filter=…`). */
const filterFromUrl = () => new URLSearchParams(window.location.search).get('filter') ?? '';

/** Read the deep-link speech language from the current URL (`?lang=…`, default English). */
const langFromUrl = () => new URLSearchParams(window.location.search).get('lang') ?? 'en';

/** Whether the URL fragment deep-links the About/FAQ dialog (`#faq` — a shareable docs link). */
const faqFromUrl = () => window.location.hash === '#faq';

export default function App() {
  const [filter, setFilter] = useState(filterFromUrl); // hydrate from ?filter= so the view is shareable
  const [speechLang, setSpeechLang] = useState(langFromUrl); // hydrate from ?lang= (Speech column)
  const [editing, setEditing] = useState<Concept | null>(null);
  const [creating, setCreating] = useState(false); // the open modal is for a brand-new concept
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null); // last Save failure → red button + toast
  const [savePrompt, setSavePrompt] = useState(false); // the "describe your changes" confirm modal
  const [saveTitle, setSaveTitle] = useState(''); // auto PR title (read-only preview)
  const [saveMessage, setSaveMessage] = useState(''); // the (editable) Markdown PR description
  // The PR the user's branch terminates in; when it closes/merges we reset the session and reload.
  const [activePr, setActivePr] = useState<ActivePr | null>(() => loadPr(localStorage));
  const [reloadKey, setReloadKey] = useState(0); // bump to force a fresh dictionary load
  const [faqOpen, setFaqOpen] = useState(faqFromUrl); // hydrate from #faq so the docs are linkable
  // PR-review mode: when a PR is selected the table shows ITS diff vs main (read-only); the picker lists
  // open PRs; "changed only" collapses the view to just the changed rows (the reviewer's main interest).
  const [reviewPr, setReviewPr] = useState<PullRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [viewing, setViewing] = useState<Concept | null>(null); // the row open in the full-entry preview
  const dialogRef = useRef<HTMLDialogElement>(null);
  const saveDialogRef = useRef<HTMLDialogElement>(null);
  const viewDialogRef = useRef<HTMLDialogElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // Whether the open editor holds unsaved changes (reported by NotationEditor) — dismissing the modal
  // via backdrop/Esc then asks before discarding. A ref: it must not re-render App on every keystroke.
  const editorDirty = useRef(false);
  // True-backdrop detection: `e.target === dialog` alone is NOT a backdrop click — clicks on the
  // dialog's own padding/scrollbar also target it, and a text-selection drag released outside
  // synthesizes a click targeting it. A dismissal requires BOTH the press and the release to land
  // geometrically outside the dialog's box.
  const pressOutside = useRef(false);
  const outsideBox = (e: { clientX: number; clientY: number }, d: HTMLElement) => {
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  /** onMouseDown on a <dialog>: record whether the press landed on the true backdrop. */
  const trackPress = (e: React.MouseEvent<HTMLDialogElement>) => {
    pressOutside.current = e.target === e.currentTarget && outsideBox(e, e.currentTarget);
  };
  /** True only for a full press-and-release on the real backdrop (then resets the press state). */
  const isBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    const pressed = pressOutside.current;
    pressOutside.current = false;
    return pressed && e.target === e.currentTarget && outsideBox(e, e.currentTarget);
  };
  useGlobalFindShortcut(filterRef); // Ctrl/⌘+F focuses the (whole-dictionary) Filter

  // Reflect the filter into the URL (`?filter=…`) so it's shareable/deep-linkable, preserving any other
  // query params. replaceState (not push) so each keystroke doesn't pile up history entries.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get('filter') ?? '') === filter) return; // already in sync (incl. the hydrated load)
    if (filter) params.set('filter', filter);
    else params.delete('filter');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, [filter]);

  // Reflect the Speech-column language into `?lang=` the same way (English is the default → no param).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get('lang') ?? 'en') === speechLang) return;
    if (speechLang !== 'en') params.set('lang', speechLang);
    else params.delete('lang');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, [speechLang]);

  // The About/FAQ dialog ↔ the `#faq` fragment, both ways: follow in-page links/pastes (hashchange),
  // and reflect open/close into the URL so the open dialog is a copyable documentation link.
  useEffect(() => {
    const onHash = () => setFaqOpen(faqFromUrl());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (faqOpen === faqFromUrl()) return; // in sync (incl. the hydrated load; other hashes read false)
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + (faqOpen ? '#faq' : ''),
    );
  }, [faqOpen]);

  // Drive the native modal dialog from `editing` (showModal centres + traps focus; close() on cancel).
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (editing && !d.open) d.showModal();
    else if (!editing && d.open) d.close();
  }, [editing]);

  // Drive the "describe your changes" confirm dialog the same way.
  useEffect(() => {
    const d = saveDialogRef.current;
    if (!d) return;
    if (savePrompt && !d.open) d.showModal();
    else if (!savePrompt && d.open) d.close();
  }, [savePrompt]);

  // Drive the read-only full-entry "view" dialog (the row ⤢) from `viewing`.
  useEffect(() => {
    const d = viewDialogRef.current;
    if (!d) return;
    if (viewing && !d.open) d.showModal();
    else if (!viewing && d.open) d.close();
  }, [viewing]);

  // Config: backing repo (raw reads) and the auth+PR service. Either may be absent → graceful fallback.
  const repo = useMemo(() => repoConfigFromEnv(), []);
  const service = useMemo(() => serviceConfigFromEnv(), []);

  // PR-review reads the configured repo, or the canonical data repo as a self-contained default — so the
  // feature works even in the seed dev server (no env). `review` set → the working set is that PR's diff.
  const reviewRepo = repo ?? DATA_REPO;
  const reviewing = reviewPr !== null;
  const review = useMemo<Review | null>(
    () => (reviewPr ? { repo: reviewRepo, pr: reviewPr } : null),
    [reviewPr, reviewRepo],
  );

  // The working set (load + paging + edits) lives in one reducer — no mutable source / parallel state.
  // While reviewing, it loads the PR diff instead of the edit session (read-only; edit cache untouched).
  const [dict, dispatch] = useDictionary(repo, reloadKey, review);
  const { concepts, loadedCount, baseMap, deletedIds, dirty, conflicts } = dict;
  const ready = dict.status === 'ready';
  const total = concepts.length;

  // Identity + session lifecycle (OAuth completion, sliding-TTL token, proactive sign-out, renew). The
  // status-line message + the expiry toast are page concerns, delivered via callbacks.
  const [submitState, setSubmitState] = useState<string | null>(null);
  const { identity, authPending, signIn, expireSession } = useIdentity({
    service,
    // Sign-in failures (incl. OAuth `?error=` returns) reach the user via the Toast — the status line is
    // hidden while signed out, which is exactly when these occur. Same channel as a session expiry.
    onSignInError: setSaveError,
    onSessionExpired: () => setSaveError(SESSION_EXPIRED),
  });

  // Sign out: drop the identity AND the PR pointer, then reload from base (no branch-reconciled view).
  const signOut = useCallback(() => {
    expireSession();
    clearPr(localStorage);
    setActivePr(null);
    setSubmitState(null);
    setReloadKey((k) => k + 1);
  }, [expireSession]);

  // When the user's working PR is closed or merged, end the session: ask the service to delete the
  // (now stale) intent/<handle> branch, drop local edits, and reload clean from the base branch. Checked
  // on mount and whenever the tab regains focus (e.g. after closing the PR on GitHub in another tab).
  const resetIfPrClosed = useCallback(async () => {
    if (!service || !repo || !identity || !activePr) return;
    if ((await fetchPullState(repo.owner, repo.repo, activePr.number)) !== 'closed') return;
    try {
      await resetSession(service.serviceUrl, identity.jwt, activePr.branch); // delete the closed branch (best-effort)
    } catch {
      /* lazy cleanup on the next /submit covers a failed reset */
    }
    clearEdits(localStorage);
    clearPr(localStorage);
    const closed = activePr.number;
    setActivePr(null);
    setSubmitState(`PR #${closed} closed — started a fresh session.`);
    setReloadKey((k) => k + 1);
  }, [service, repo, identity, activePr]);

  useEffect(() => {
    // resetIfPrClosed setStates only AFTER an async PR-status fetch (an external-state check), never
    // synchronously — the rule can't see past the await, so the warning is a false positive here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void resetIfPrClosed();
    const onFocus = () => void resetIfPrClosed();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [resetIfPrClosed]);

  // Reveal the next page (the reducer caps it at the row count; the first page shows on load).
  const loadMore = useCallback(() => dispatch({ type: 'loadMore' }), [dispatch]);

  const [theme, toggleTheme] = useTheme();

  // Enter read-only PR review: load the selected PR's diff into the table and default to the changed-only
  // view (the reviewer's primary interest). Any open editor/save prompt is dismissed first.
  const enterReview = useCallback((pr: PullRequest) => {
    setEditing(null);
    setCreating(false);
    setSavePrompt(false);
    setViewing(null);
    setReviewPr(pr);
    setChangedOnly(true);
    setPickerOpen(false);
  }, []);

  // Leave review mode — the reducer reloads the user's edit session from the (untouched) local cache.
  const exitReview = useCallback(() => {
    setReviewPr(null);
    setChangedOnly(false);
    setViewing(null);
  }, []);

  // Open the read-only full-entry preview for a row (the review workflow's 🔍).
  const openView = useCallback((concept: Concept) => setViewing(concept), []);

  // Editing/adding requires a signed-in identity only when a service is configured.
  const gated = useCallback(() => {
    if (service && !identity) {
      setSubmitState('Sign in with GitHub to suggest edits.');
      return false;
    }
    return true;
  }, [service, identity]);

  const openEditor = useCallback(
    (concept: Concept) => {
      if (!gated()) return;
      setCreating(false);
      setEditing(concept);
    },
    [gated],
  );

  // Open the modal on a blank concept — saved as a new row on "Done".
  const openCreate = useCallback(() => {
    if (!gated()) return;
    setCreating(true);
    setEditing({ slug: '', notations: [], links: [], alias: [], speech: [] });
  }, [gated]);

  const closeModal = useCallback(() => {
    editorDirty.current = false;
    setEditing(null);
    setCreating(false);
  }, []);

  /** Backdrop/Esc dismissal: silently fine when clean, but unsaved edits ask before being discarded. */
  const confirmDiscard = useCallback(
    () => !editorDirty.current || window.confirm('Discard your unsaved changes to this concept?'),
    [],
  );

  // Browser Back closes whichever dialog is open (it never leaves the page mid-dialog). The editor reuses
  // its unsaved-changes guard, so Back can be declined (the entry re-arms); the others close outright.
  useBackClose(!!editing, () => {
    if (!confirmDiscard()) return false; // kept editing — Back stays armed
    closeModal();
    return true;
  });
  useBackClose(!!viewing, () => {
    setViewing(null);
    return true;
  });
  useBackClose(pickerOpen, () => {
    setPickerOpen(false);
    return true;
  });
  useBackClose(savePrompt, () => {
    setSavePrompt(false);
    return true;
  });

  // "Done" — apply the edit/addition to the working set (batched); the global Save submits later.
  const handleSave = useCallback(
    (updated: Concept) => {
      if (creating) dispatch({ type: 'add', concept: updated });
      else if (editing) dispatch({ type: 'edit', id: conceptId(editing), updated }); // id when opened (rename-safe)
      setCreating(false);
      setEditing(null);
    },
    [editing, creating, dispatch],
  );

  // Row ✗: toggle the pending deletion (delete ⇄ restore). Held visible (red) until Save.
  const toggleRowDelete = useCallback(
    (concept: Concept) => {
      if (!gated()) return;
      dispatch({ type: 'setDeleted', concept, deleted: !deletedIds.has(conceptId(concept)) });
    },
    [gated, deletedIds, dispatch],
  );

  const handleDelete = useCallback(() => {
    if (editing) dispatch({ type: 'setDeleted', concept: editing, deleted: true });
    setEditing(null);
    setCreating(false);
  }, [editing, dispatch]);

  // Classify each row for its background colour (added / changed / pending-deleted), vs the baseline.
  const changeKind = useCallback(
    (c: Concept): ChangeKind | null => classifyChange(c, baseMap, deletedIds),
    [baseMap, deletedIds],
  );

  // Gate the "more to see" affordance. While reviewing a PR, offer it on EVERY row — the notation's
  // TeX/raw-MathML source is never in the table and is always worth checking. While browsing, offer it
  // selectively, wherever an entry simply holds more than the row shows (extra notations/languages,
  // aliases, raw extras). See entryPreview.
  const canView = useCallback(
    (concept: Concept) => reviewing || hasHiddenInfo(concept, speechLang),
    [reviewing, speechLang],
  );

  // While reviewing an EDITED row, the `main` version of the open entry — passed to the read-only view so
  // it renders a per-field old→new diff. (An add/delete is wholly new/gone, so there's nothing to diff.)
  const viewBase = useMemo(() => {
    if (!viewing || !reviewing || changeKind(viewing) !== 'changed') return undefined;
    return baseMap.get(conceptId(viewing));
  }, [viewing, reviewing, changeKind, baseMap]);

  const closeSavePrompt = useCallback(() => setSavePrompt(false), []);

  // "Save" → open the confirm modal: auto-generate the PR title + a Markdown description of the changes.
  const openSavePrompt = useCallback(() => {
    if (!ready) return;
    if (!gated()) return;
    const preview = buildSubmission({
      concepts,
      deletedIds,
      baseMap,
      handle: identity?.handle ?? 'me',
      activeBranch: activePr?.branch ?? null,
      description: '',
      now: new Date(),
    });
    setSaveTitle(preview.title);
    setSaveMessage(preview.description); // editable default; the user can refine it
    setSavePrompt(true);
  }, [ready, concepts, baseMap, deletedIds, gated, identity, activePr]);

  // Submit the whole batch to the service (bot → intent/<handle> branch + PR), using the user's
  // description as the commit message. On success the pushed content becomes the new baseline, so the
  // session returns to a clean state.
  const submitBatch = useCallback(() => {
    if (!ready) return;
    if (!gated()) return;
    if (!service || !identity) return; // local-only: nothing to submit
    // Reuse the open PR's branch (a new commit updates it); otherwise a fresh unique branch.
    const { content, branch, ...payload } = buildSubmission({
      concepts,
      deletedIds,
      baseMap,
      handle: identity.handle,
      activeBranch: activePr?.branch ?? null,
      description: saveMessage,
      now: new Date(),
    });
    void (async () => {
      try {
        setSaving(true);
        setSaveError(null); // clear any prior failure on retry
        setSubmitState('Submitting…');
        const { prNumber, prUrl } = await submitToService(service.serviceUrl, identity.jwt, {
          content,
          branch,
          ...payload, // message, title, description
        });
        // Enact deletions + adopt the pushed content as the new baseline (clean session); cache cleared
        // by the persist effect.
        dispatch({ type: 'committed', content });
        const isNewPr = !activePr || activePr.number !== prNumber;
        savePr(localStorage, { number: prNumber, url: prUrl, branch }); // track it so we can detect closure
        setActivePr({ number: prNumber, url: prUrl, branch });
        setSubmitState(isNewPr ? `PR #${prNumber}` : `PR #${prNumber} updated`);
        if (isNewPr) window.open(prUrl, '_blank', 'noopener'); // updates land on the same PR — no new tab
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 401 = the service rejected our session token (expired/invalid) — sign out so the UI reflects
        // it, then tell the user to sign in again. Other failures keep the session and just report.
        if (/\b401\b|invalid session|token|unauthor/i.test(msg)) {
          expireSession();
          setSaveError('Your session expired — you’ve been signed out. Sign in again to save (your changes are kept).');
        } else {
          setSaveError(`Save failed: ${msg}`);
        }
        setSubmitState(null); // drop the "Submitting…" status; the toast carries the error
      } finally {
        setSaving(false);
        setSavePrompt(false); // close the confirm modal so the toast / red Save button are visible
      }
    })();
  }, [ready, concepts, baseMap, deletedIds, gated, service, identity, activePr, saveMessage, dispatch, expireSession]);

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  // Editing affordances (Add entry / Save / row ✗) are shown only when the user can actually edit:
  // ungated in local-only mode (no service), otherwise only while signed in — and never while reviewing
  // a PR (that view is read-only).
  const canEdit = (!service || !!identity) && !reviewing;

  // The view is "restricted" — whole-dictionary, unpaged — when a text filter and/or the "changed only"
  // toggle is active; otherwise it's the paged prefix. Changed-only keeps rows whose pending change is
  // non-null (added/changed/deleted). Text matches are additionally ranked by which cell hit (concept →
  // speech → area → alias); a stable sort keeps canonical order within each rank. Clearing both resumes paging.
  const filtering = filter.trim() !== '';
  const restricting = filtering || changedOnly;
  const visible = restricting
    ? concepts
        .filter((c) => !changedOnly || changeKind(c) !== null)
        .filter((c) => !filtering || conceptMatches(c, filter))
        .map((c) => ({ c, rank: filtering ? matchRank(c, filter) : 0 }))
        .sort((a, b) => a.rank - b.rank)
        .map((x) => x.c)
    : concepts.slice(0, loadedCount);
  // While reviewing, a compact tally of the PR's diff for the banner (+added ~changed −deleted). Counted
  // per row (by conceptId, via the same changeKind the table tints with) so it matches the visible rows
  // exactly — not slug-deduped, so overloaded `(concept, arity)` rows each count.
  const reviewSummary = useMemo(() => {
    if (!reviewing) return null;
    let added = 0,
      changed = 0,
      deleted = 0;
    for (const c of concepts) {
      const k = changeKind(c);
      if (k === 'added') added++;
      else if (k === 'changed') changed++;
      else if (k === 'deleted') deleted++;
    }
    return { added, changed, deleted };
  }, [reviewing, concepts, changeKind]);
  // Languages present in the dictionary (en first, rest sorted) — the Speech column's dropdown options.
  const languages = useMemo(() => {
    const rest = new Set<string>();
    for (const c of concepts) for (const s of c.speech ?? []) if (s.lang && s.lang !== 'en') rest.add(s.lang);
    return ['en', ...[...rest].sort()];
  }, [concepts]);
  // All concept names — the editor highlights an alias that names a known concept.
  const knownSlugs = useMemo(() => new Set(concepts.map((c) => c.slug)), [concepts]);
  // Dictionary-wide indexes for the editor's authoring helpers (related concepts + alias warnings).
  const conceptIndex = useMemo(() => buildConceptIndex(concepts), [concepts]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>MathML Intent Open Editor</h1>
        <div className="toolbar">
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter concepts…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="count" data-testid="concept-count" data-total={total}>
            {filtering
              ? `${visible.length.toLocaleString()} match${visible.length === 1 ? '' : 'es'}`
              : changedOnly
                ? `${visible.length.toLocaleString()} changed`
                : `${total.toLocaleString()} concepts${
                    ready && loadedCount < total ? ` · ${loadedCount.toLocaleString()} loaded` : ''
                  }`}
          </span>
          <label className="changed-toggle" title="Show only rows with a pending change">
            <input
              type="checkbox"
              data-testid="changed-only"
              checked={changedOnly}
              onChange={(e) => setChangedOnly(e.target.checked)}
            />
            Changed only
          </label>
          <span className="session-status">
            {!service
              ? 'GitHub not configured — local only'
              : authPending
                ? 'Signing in…'
                : identity
                  ? (submitState ?? `signed in as @${identity.handle}`)
                  : 'Sign in to contribute'}
          </span>
          {service &&
            (authPending ? (
              <button type="button" className="auth-btn" disabled>
                <span className="spinner" aria-hidden="true" /> Signing in…
              </button>
            ) : identity ? (
              <button type="button" className="auth-btn" onClick={signOut}>
                Sign out (@{identity.handle})
              </button>
            ) : (
              <>
                <button type="button" className="auth-btn" onClick={signIn}>
                  Sign in with GitHub
                </button>
                {/* The reassurance at the moment of fear: what the OAuth consent actually contains. */}
                <InfoPopover label="About GitHub sign-in">
                  <p className="legend-note" data-testid="signin-help">
                    Signing in shares <strong>identity only</strong> — your public <code>@handle</code>.{' '}
                    <strong>No repository access, no email, no write scope.</strong> Edits are committed
                    by the project bot, authored as you. Revoke anytime under GitHub → Settings →
                    Applications. See the <a href="#faq">FAQ</a> for details.
                  </p>
                </InfoPopover>
              </>
            ))}
          <button
            type="button"
            className="review-btn"
            data-testid="review-pr"
            onClick={() => setPickerOpen(true)}
          >
            Review a PR
          </button>
          <button type="button" className="faq-btn" onClick={() => setFaqOpen(true)}>
            About / FAQ
          </button>
          <button
            type="button"
            className="theme-btn"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {conflicts.length > 0 && (
        <p className="conflicts" role="status" data-testid="conflicts">
          {conflicts.length} concept{conflicts.length > 1 ? 's' : ''} changed upstream while you were
          editing — review: {conflicts.slice(0, 6).join(', ')}
          {conflicts.length > 6 ? '…' : ''}
        </p>
      )}

      {reviewing && reviewPr && (
        <div className="review-banner" role="status" data-testid="review-banner">
          <span className="review-banner-text">
            Reviewing{' '}
            <a href={reviewPr.url} target="_blank" rel="noreferrer">
              PR #{reviewPr.number}
            </a>{' '}
            {reviewPr.state === 'closed' && (
              <span className={`review-state ${reviewPr.merged ? 'merged' : 'closed'}`}>
                {' '}
                {reviewPr.merged ? 'merged' : 'closed'}
              </span>
            )}{' '}
            — {reviewPr.title}
            {reviewPr.author && ` by @${reviewPr.author}`}
            {reviewPr.state === 'closed' && <span className="review-vs"> · vs its branch point</span>}
            {reviewSummary && (
              <span className="review-tally">
                {' · '}
                <span className="tally-add">+{reviewSummary.added}</span>{' '}
                <span className="tally-changed">~{reviewSummary.changed}</span>{' '}
                <span className="tally-del">−{reviewSummary.deleted}</span>
              </span>
            )}
          </span>
          <button type="button" className="review-exit" data-testid="review-exit" onClick={exitReview}>
            Exit review
          </button>
        </div>
      )}

      <div className="body">
        {dict.error && <p className="error">{dict.error}</p>}
        {!ready && !dict.error && <p className="status">Loading dictionary…</p>}
        {ready && (
          <ConceptTable
            data={visible}
            total={restricting ? visible.length : total}
            onEdit={canEdit ? openEditor : undefined}
            onLoadMore={restricting ? undefined : loadMore}
            editingId={editing ? conceptId(editing) : null}
            onDelete={canEdit ? toggleRowDelete : undefined}
            onView={openView}
            canView={canView}
            changeKind={changeKind}
            languages={languages}
            speechLang={speechLang}
            onSpeechLangChange={setSpeechLang}
            headerActions={
              canEdit ? (
                <>
                  <button type="button" className="add-entry" onClick={openCreate}>
                    + Add entry
                  </button>
                  {service && (
                    <button
                      type="button"
                      className={`save-batch${saveError ? ' error' : ''}`}
                      data-testid="save-batch"
                      disabled={!dirty || saving}
                      onClick={openSavePrompt}
                      title={
                        saveError ?? (dirty ? 'Submit all pending changes as one PR' : 'No pending changes')
                      }
                    >
                      {saving ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Saving…
                        </>
                      ) : saveError ? (
                        'Save failed'
                      ) : (
                        'Save'
                      )}
                    </button>
                  )}
                </>
              ) : null
            }
          />
        )}
      </div>

      {/* Native <dialog>: focus trap, Esc to close, focus restore, inert background — for free. */}
      <dialog
        ref={dialogRef}
        className="modal"
        aria-label={editing ? (creating ? 'Add concept' : `Edit notation: ${editing.slug}`) : undefined}
        onClose={closeModal}
        onCancel={(e) => {
          if (!confirmDiscard()) e.preventDefault(); // Esc with unsaved edits → keep the modal open
        }}
        onMouseDown={trackPress}
        onClick={(e) => {
          if (isBackdropClick(e) && confirmDiscard()) closeModal();
        }}
      >
        {editing && (
          <Suspense fallback={<p className="status">Loading editor…</p>}>
            <NotationEditor
              concept={editing}
              onSave={handleSave}
              onDelete={creating ? undefined : handleDelete} // nothing to delete for a brand-new row
              onCancel={closeModal}
              onDirtyChange={(d) => (editorDirty.current = d)}
              knownSlugs={knownSlugs}
              index={conceptIndex}
            />
          </Suspense>
        )}
      </dialog>

      {/* "Describe your changes" confirm modal — its text becomes the PR commit message. */}
      <dialog
        ref={saveDialogRef}
        className="modal save-modal"
        aria-label="Describe your changes"
        onClose={closeSavePrompt}
        onMouseDown={trackPress}
        onClick={(e) => {
          if (isBackdropClick(e)) closeSavePrompt();
        }}
      >
        <div className="save-prompt">
          <h2>Describe your changes</h2>
          <p className="save-prompt-hint">
            Opens/updates the GitHub pull request against the W3C Intent dictionary. The description is
            rendered as Markdown.
          </p>
          <div className="save-field">
            <span className="save-field-label">Pull request title</span>
            <div className="save-title" data-testid="save-title">
              {saveTitle}
            </div>
          </div>
          <label className="save-field">
            <span className="save-field-label">Description (Markdown)</span>
            <textarea
              data-testid="save-message"
              aria-label="Change description"
              rows={7}
              value={saveMessage}
              onChange={(e) => setSaveMessage(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              data-testid="save-confirm"
              disabled={saving || saveMessage.trim() === ''}
              onClick={submitBatch}
            >
              {saving ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Submitting…
                </>
              ) : (
                'Submit pull request'
              )}
            </button>
            <button type="button" onClick={closeSavePrompt} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </dialog>

      <Faq open={faqOpen} onClose={() => setFaqOpen(false)} />

      <PrReviewPicker
        repo={reviewRepo}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={enterReview}
      />

      {/* Read-only full-entry preview (the row ⤢): the SAME editor component with editing toggled off —
          all fields shown read-only, only "Close" in the footer. Backdrop/Esc just closes (nothing to lose). */}
      <dialog
        ref={viewDialogRef}
        className="modal"
        aria-label={viewing ? `View concept: ${viewing.slug}` : undefined}
        onClose={() => setViewing(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setViewing(null);
        }}
      >
        {viewing && (
          <Suspense fallback={<p className="status">Loading…</p>}>
            <NotationEditor
              concept={viewing}
              readOnly
              base={viewBase}
              onCancel={() => setViewing(null)}
              knownSlugs={knownSlugs}
            />
          </Suspense>
        )}
      </dialog>

      {saveError && <Toast message={saveError} onClose={dismissSaveError} />}
    </div>
  );
}
