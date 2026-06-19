# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**MathML Intent Open Editor** — a web app for open community curation (add / edit / remove) of
the *Intent Open* concept dictionary defined by [MathML 4 Intent](https://w3c.github.io/mathml/#mixing_intent).
The spec lives at `~/git/mathml/src/intent.html` (sibling checkout). The canonical concept list to
seed/reference is in `~/git/mathml-intent-open/` (sibling checkout).

> **Status:** greenfield, about to be (re)built. Two throwaway spikes exist and should be ignored as
> architecture: a deprecated SvelteKit spike under `svelte-deprecated-experiment/` and an abandoned
> Create-React-App spike on the `react-ag-grid` branch. The stack was reconsidered from first principles
> (see "Chosen stack").

## Requirements (the actual spec for this project)

These are the product requirements, independent of framework choice:

1. **GitHub-file-backed data.** The concept dictionary is a file (YAML, like `open.yml`) living in a
   GitHub repository. That file is the source of truth — there is no separate database/backend.
2. **Lazy-loading table.** The main UI is a virtualized/lazy table expected to hold **>10,000 entries**.
   Performance at that row count (virtual scrolling, incremental load) is a hard requirement, not a nice-to-have.
3. **Specialized cell features**, including a **custom TeX → MathML renderer** for previewing notations.
4. **Edit → "Save" → Pull Request flow.** Saving an edit opens (or appends to) a GitHub **pull request**
   against the backing file.
5. **Anonymous, branch-tracked sessions.** Each local session tracks the user's working branch, which
   terminates in their PR. A user keeps editing after the PR is open; new edits auto-append onto that PR.
   When the PR merges, the frontend starts a fresh branch. No accounts — sessions are anonymous (auth is
   GitHub OAuth/PKCE only, for opening PRs on the user's behalf).

## Data model

The canonical format is the **W3C MathML Intent `open.yml`** (`w3c/mathml-docs` `_data/open.yml`; the
backing repo `dginev/mathml-intent-open` mirrors it). **We do not change this schema** — changes need a
W3C group decision — so the parser/serializer conform to it and round-trip unknown fields. It's a single
`concepts:` group of `intents:` entries:

```yaml
concepts:
  - title: Open Concepts
    intents:
    - concept: abelian-category        # the name/slug
      arity: 0                          # argument count
      en: abelian category             # speech template; $1, $2… are positional arg refs
      property: symbol                  # notation form (symbol/indexed/prefix/function/…)
      area: "category theory"
      notations:                        # one or more renderings, each a {tex?, mathml} hash
       - tex: "\\mathrm{Ab}"            #   tex: optional — present only when authored in TeX
         mathml: "<math><mi intent='abelian-category'>Ab</mi></math>"  # mandatory, FULL <math>…</math>
      urls: ["…"]                       # reference URLs  (→ Concept.links)
      # optional: alias, notation/notationa…, comments
```

Mapping to `Concept` (`src/types.ts`): `concept→slug`, `urls→links`, plus `arity`/`property`; the
original entry is kept in `raw` for **lossless** serialization (preserves `notation*`/`comments`/key
order). **Renderings use the `notations:` shape** (round-2 decision, per @dginev): always a list, one
entry per rendering, each an inner hash of `tex:` (optional, first) + `mathml:` (mandatory). The
author writes one *or* the other; we always store the MathML — the pairing makes that explicit instead
of index-correlating parallel lists, and the list naturally accommodates additional notations.
`notations[0]` is the primary rendering shown in the table. This **replaced** the older `mathml:` list
+ scalar `tex:` via a one-time whole-file migration (`scripts/migrate-notations.ts`, run with
vite-node — generates output byte-identical to the editor's own serializer). The parser reads **both**
shapes (the W3C upstream file and pre-migration branches stay loadable); the serializer emits only the
new shape and drops the old raw keys on write. The plural name avoids the 16 legacy free-text
`notation:` sketches (+ `notationa:`/`notationb:`), which keep round-tripping untouched via `raw`.
A shared-format change — socialize with the W3C group before upstreaming; w3c/mathml-docs tooling
reading `mathml:` must adapt.

Key facts (verified against the real file, 1012 entries):
- A concept **name can be overloaded across arities** (`disjoint-union` 1&2, `whittaker-function` 2&3).
  `(concept, arity)` is globally **unique** and is the row identity — `conceptId(c)='${slug}#${arity}'`
  keys the reconcile map, edit cache, source index, and edits, so overloads never collapse.
- **Canonical order is `(concept, arity)`** — ASCII by name, then ascending arity (`byConcept`). The
  serializer emits this deterministically (`lineWidth:0`, lossless via `raw`); `canonical.test.ts` proves
  parse→serialize is lossless + idempotent. This is what keeps PR diffs minimal. The backing repo's
  `main` was canonicalized once (an "initial lint") so the first editor Save didn't reformat the whole
  file; with a canonical base, a single-concept edit is a one-line diff.
- Each notation's `mathml` is a full `<math>…</math>` carrying `intent='…'`/`arg='…'`; the editor
  stores edits the same way (`<math>` + the `texToIntent` fragment, minified).
- The editor does **not** keep a copy of the real list — it reads it from GitHub. `public/seed.fixture.yml`
  is a small *synthetic* fixture (dev/e2e only), cloned ×`DEV_MULTIPLIER` to hit the 10k-row target.

## Chosen stack

Reasoned from the requirements (static SPA, no backend; 10k+ rows with custom DOM cells; browser-side
GitHub OAuth; TeX→MathML). The framework matters little; the grid library matters a lot, and custom
MathML cells rule out canvas grids — so a headless, DOM-virtualized table won.

- **React 19 + Vite** — static SPA build (no SSR; the data lives in GitHub, not a server).
- **@tanstack/react-table + @tanstack/react-virtual** — headless table with DOM windowing. React is
  TanStack's reference adapter (the deprecated spike used the *community* Svelte 5 port). Each cell is a
  real component, so MathML rendering and inline editors are straightforward.
- **Octokit** — GitHub OAuth (PKCE), branch management, and PR create/append.
- **TeX→MathML** — **Temml**, via our fork at `~/git/Temml` (dep: `"temml": "file:../Temml"`). The fork
  adds native MathML-Intent commands (`\intent`/`\arg` + official `\MathMLintent`/`\MathMLarg` aliases);
  see "MathML Intent rendering" below. Synchronous and MathML-native — the right fit for rendering in 10k
  virtualized cells where MathJax's async typesetting would be a liability.

Rationale for the rejected paths: SvelteKit's SSR/server layer is dead weight with no backend and its
TanStack table binding is community-maintained; AG Grid is heavier and its custom-cell API is more
constraining than headless TanStack for MathML cells.

## Commands

The root is a Vite + React-TS project. From the repo root:

```bash
npm install
npm run dev            # vite dev server (http://localhost:5173)
npm run build          # tsc -b type-check + vite build → dist/
npm run preview        # serve the production build (http://localhost:4173)
npm run lint           # eslint (ignores svelte-deprecated-experiment/)
npm test               # vitest run (unit/jsdom) then playwright (e2e)
npm run test:unit      # vitest in watch mode
npm run test:unit -- src/data/loadSeed.test.ts   # single unit file
npm run test:e2e       # playwright e2e (auto-builds + previews)
npx playwright test e2e/paging.spec.ts           # single e2e file
```

### Testing & TDD

Work **red→green**: write the failing test first, watch it fail for the right reason, then implement.

- **Unit/component** — Vitest + jsdom + Testing Library. Tests live next to source as `*.test.ts(x)`
  under `src/`; setup is `src/test/setup.ts`; config is the `test` block in `vite.config.ts`.
- **E2E** — Playwright in `e2e/`, run against the production build (`vite preview` on :4173).
  `e2e/paging.spec.ts` asserts the full 10k+ row list is reachable by paging to exhaustion within
  60s with no page errors (currently ~22s). Keep it green — it's the guard for table performance.
- **Browser gotcha:** Playwright's bundled Chromium has no build for this OS, so the config uses the
  system Google Chrome via `channel: 'chrome'`. Don't switch it back to bundled chromium here.

## App structure (root)

**Data source is dual** (chosen in `App`'s load effect): when `repoConfigFromEnv()` is set
(`VITE_GH_OWNER`/`REPO`), the live path reads `open.yml` from GitHub (raw CDN) and reconciles
client-side; otherwise (dev/e2e) it falls back to the seed ×`DEV_MULTIPLIER` so the 10k-row perf guard
runs without a backend. So **don't remove the seed path** — the perf e2e depends on it.

- `public/seed.fixture.yml` — a small synthetic dev/e2e fixture (served statically), **not** the real list.
- `src/types.ts` — the `Concept` type (our model; see "Data model").
- `src/data/parse.ts` — `parseDictionary(text)`: YAML `open.yml` → normalized `Concept[]` (shared by
  the seed loader and the raw reader).
- `src/data/loadSeed.ts` — fetches `public/seed.fixture.yml` and clones ×`multiplier` to hit the 10k target.
- `src/data/githubRaw.ts` — `rawUrl()` + `fetchDictionary()`: read `open.yml` from
  `raw.githubusercontent` (ACAO:* → no CORS), `404 → null`.
- `src/data/reconcile.ts` — `threeWayMerge(ancestor, ours, theirs)` over the slug-keyed map: adopt
  upstream where untouched, keep user edits, report same-slug divergences as conflicts.
- `src/data/editCache.ts` — persist the user's edits (value + `baseAtEdit` fork point) in
  `localStorage` so a reload restores in-progress changes; `baseAtEdit` is the per-concept ancestor.
- `src/data/loadDictionary.ts` — orchestrator: raw base (+ the active PR `branch` when one is tracked)
  ∪ local edits → `threeWayMerge` → `{ concepts, conflicts, base }`. `App` shows a conflict banner.
- `src/hooks/useDictionary.ts` — the **working set** as one `useReducer` over immutable state
  (`concepts` (all, canonical order, incl. held-for-display deletions), `loadedCount`, `baseMap`,
  `baseline`, `deletedIds`, `dirty`, `conflicts`). Load/paging/edit/add/delete-toggle/commit are pure
  transitions (`dirty` recomputed in the reducer); the edit cache is persisted as a derived effect. The
  hook loads from GitHub (active branch or `main`, reconciled with the cache) or the seed fixture; `App`
  handlers just `dispatch`. Paging reveals `concepts.slice(0, loadedCount)` (PAGE=50 ≈ a couple of
  viewports); `ConceptTable` calls `onLoadMore` near the bottom. **Filtering searches the whole
  dictionary**: a non-empty filter shows `concepts.filter(conceptMatches)` (slug/en/speech/area/alias)
  **unpaged**; clearing it resumes the paged prefix. Ctrl/⌘+F focuses the filter (native find can't see
  the virtualized rows).
- `src/components/ConceptTable.tsx` — headless TanStack Table + TanStack Virtual. DOM row windowing
  with absolute-positioned rows; it renders exactly the `data` it's given (filtering happens upstream in
  `App`). Carries explicit **ARIA table semantics** (`role="table"/"rowgroup"/"row"/"columnheader"/
  "cell"`, `aria-rowcount` over the full dictionary + per-row `aria-rowindex` — screen readers see the
  windowing) and a leading **status column** (`+`/`✎`/`−` icon with accessible name per `ChangeKind`,
  WCAG 1.4.1 — pairs with the row tint + accent stripe; ratios verified in `index.css`). The **Speech
  column header is a language dropdown** when the data holds >1 language (`en` first; a row without a
  template in the selected language shows an **empty cell** — untranslated entries are visible at a
  glance, per @dginev; deep-links via `?lang=` like `?filter=`); single-language data (seed/e2e) keeps
  the plain header. The Notation column shows the **rich** render:
  `render/notationMarkup.ts` re-renders from `notations[0].tex` via Temml when present (the stored
  `mathml` is the *minified* form — see "Storage is minified, display is rich"), else it renders the
  stored `mathml` directly. Temml is lazy-loaded only when some visible row's primary notation has
  `tex` (the seed/e2e data has none, so the perf path never pulls it).
- `src/render/temmlEngine.ts` — loads Temml. **Must stay this way:** it imports the prebuilt
  `temml/dist/temml.mjs?url` and `import()`s that URL so Vite emits Temml **untransformed**. Temml
  registers its ~80 commands by mutating a module-level `const _functions = {}` at import time; when
  Vite/rolldown re-bundles the library it mishandles that mutated const and the command table ends up
  empty at runtime (every command → "Unsupported function name", *non-deterministically* per build).
  Loading it as an asset sidesteps the bundler. `loadTemml()` is async + cached.
- `src/render/intent.ts` — `texToIntent(temml, tex, concept)`: TeX → **annotated dictionary fragment**
  (takes the engine so it stays pure/sync/node-testable). Unwraps `<math>` and defaults the root `intent`
  to the concept (auto-composed from `\arg` names when no explicit `\intent`). Returns the **rich** Temml
  tree (cosmetic classes/struts intact) for the preview + table; `{ ok, mathml, arity }`. See "MathML
  Intent rendering" and "Storage is minified, display is rich".
- `src/render/minifyMathml.ts` — `minifyMathml(s)`: strips Temml's auxiliary tuning markup (`<mspace>`
  struts, `class`/`style` hooks, single-child wrapper `<mrow>`s, no-op `<mpadded lspace="0">` wraps) to a
  minimal load-bearing tree. **Never loses an `intent`/`arg` annotation** — those are load-bearing. When
  unwrapping a wrapper that carries one, it copies the annotation **down onto the single child**, but only
  when safe (the wrapper has exactly one child and that child has neither `intent` nor `arg`); otherwise
  the wrapper is kept (moving onto an annotated/multi-child inner could rebind or collide). So `\mathrm{Ab}`
  → the canonical `<mi intent='…'>Ab</mi>`. Also leaves semantic markers (U+2061 function-apply) and
  load-bearing attrs (`mathvariant`, `linethickness`, `stretchy`) alone. **Idempotent**
  (re-save never churns the diff; the canonical round-trip stays stable). Applied only at the storage
  boundary (the editor's Save).
- `src/render/notationMarkup.ts` — `notationMarkup(concept, engine)`: the table's display rule —
  re-render the rich MathML from `notations[0].tex` when present (cached per `(slug, tex)` so virtualized
  cells don't recompute on scroll), else the stored `mathml` directly. Falls back to stored on render
  failure or before the engine loads.
- `src/render/texToMathml.ts` — older raw `texToMathML(tex)` seam (`<math>`-wrapped). Not on the app
  path anymore (only its own node test uses it); kept for reference.
- `src/components/MathML.tsx` — renders a MathML string natively; wraps bare fragments in `<math>`
  (both seed notations and `texToIntent` output are fragment-only). One render path for stored
  notations and freshly converted TeX. Markup is **sanitized** (`render/sanitizeMathml.ts`, DOMPurify
  MathML profile + `intent`/`arg`) before `innerHTML`, since raw-MathML notations are user-authored and
  shared via `open.yml` — otherwise stored XSS.
- `src/components/NotationEditor.tsx` — the row editor: loads Temml (async, via `temmlEngine`). The
  primary **and every additional notation** use the same authoring block (`NotationAuthor`): a TeX |
  Raw MathML mode toggle, a full-width source line, a per-block **inline error slot**, and a two-panel
  preview line — **Rendered** (the rich Temml MathML) ∥ **MathML source (simplified)** (the
  `minifyMathml` form that gets stored). Neither preview inner-scrolls — both grow vertically and the
  modal's own scroll navigates; Done/Cancel sit in a **sticky bottom action bar** (Delete on the far
  side). Both are **always rendered**; Done gates on validity+dirty via **`aria-disabled` (never the
  native `disabled` attribute)** so it stays in the tab order and is announced as unavailable — a
  natively-disabled button drops out of the AT tab order, so a screen-reader user never finds it
  (round-3 feedback); the `onClick` guards activation. The sticky bar pins with `bottom:-1rem` to
  cancel the modal's `padding-bottom` (else it floats a 1rem gap above the modal floor). One
  derivation pipeline (`deriveNotation`) per notation: TeX → `texToIntent` → minify; raw →
  XML-validate, stored verbatim with no `tex` key. A TeX-authored extra persists `{tex, mathml}` and
  reopens in TeX mode. Reports `onDirtyChange` (content-state vs first-render snapshot; edit-then-revert
  reads clean) — `App` uses it to guard backdrop/Esc dismissal behind "Discard?". Lazy-loaded from
  `App.tsx`.
- `src/components/Faq.tsx` — the About/FAQ `<dialog>` (header "About / FAQ" link; deep-linked via the
  `#faq` fragment — App syncs it both ways, so the open dialog is a shareable docs URL). Leads with
  "What is this editor? / How does it work?" (round-3 "any documentation?" ask) — incl. a pending-change
  legend whose swatches reuse the `--diff-*` row variables (live under theme/palette changes; each
  carries an accessible color name) — then the sign-in/permissions Q&A. On open, focus moves to the
  title (`tabIndex=-1`) so reading starts at the top, not at the bottom Close button (`.modal` scrolls).
  Paired with an `InfoPopover` beside the Sign-in button (identity-only consent in one breath;
  Esc closes it innermost-first and refocuses the toggle; its "FAQ" mention is an `#faq` link). Both
  exist to dispel the "an app wants my GitHub" fear (round-2 feedback).
- `src/App.tsx` — shell: loads the dictionary, filter input (`?filter=`), speech-language state
  (`?lang=`), the About/FAQ dialog (`#faq` fragment, two-way sync), table; the row ✎ opens the
  editor; Save submits the batch as a PR. The generated PR title
  is hard-capped at 72 chars (`prTitle` — summary truncates at a name boundary, `by @handle` always
  survives). Error toasts persist until dismissed (info toasts auto-close after 12s).

## MathML Intent rendering

Curators author notations in TeX with native commands provided by the Temml fork:
- `\arg{name}{tex}` → `arg="name"` on the body's element. Names must be **valid NCNames** — they
  cannot start with a digit, so use alphabetic names (`\arg{x}{n}`), **not** positional numbers
  (`\arg{1}` is spec-invalid) and not underscore-prefixed (`\arg{_1}`).
- `\intent{expr}{tex}` → `intent="expr"` on the body's element. Argument references in `expr` use the
  `$` sigil (part of the MathML intent reference syntax): `\intent{additive-inverse($x)}{…}`.
- Official LaTeX aliases (latex3/latex2e#1836, signature `{value}{body}`): `\MathMLintent`/`\MMLintent`
  and `\MathMLarg`/`\MMLarg`.

`texToIntent` auto-composes the root intent as `concept($a,$b,…)` from the `\arg` names when the author
didn't write an explicit `\intent`; an explicit `\intent` always wins. (Authoring ergonomics are a
later-phase concern — skeleton/wiring first.) The fork repurposes `\arg` (was
the complex-argument operator) — use `\operatorname{arg}` for that. Rebuild the fork after editing it:
`cd ~/git/Temml && npx rollup -c utils/rollupConfig.mjs && node utils/insertPlugins.js && node utils/copyfiles.js`
then in the app `npm install temml@file:../Temml` (npm caches `file:` deps — bump the fork version or
force-reinstall, do **not** symlink: Vite-following a symlink can load Temml twice). *(The app now
consumes the fork as a git branch — `"temml": "github:dginev/Temml#intent-arg-annotations"` — not a
local `file:` checkout.)*

### Storage is minified, display is rich

Temml emits presentation **tuning** that's right for typesetting but is noise in a *synthetic* dictionary
sample (spacing struts, `tml-*` classes, wrapper `<mrow>`s). Decision (per @dginev): keep the polished
render **on screen** but write a **minimal** tree to `open.yml`. Rather than patch the fork to emit lean
MathML, we do it **app-side** so the engine stays stock and display keeps the cosmetics:

- **`texToIntent` → rich** (no stripping); feeds the editor preview and the table.
- **`minifyMathml`** runs at the **storage boundary only** (the editor's Save, via `deriveNotation` in
  `buildUpdated`), not in `serialize.ts` — so untouched entries round-trip verbatim (no whole-file
  reformat) and a single edit stays a minimal diff. Each notation's stored `mathml` is therefore the
  **minified** form, which is what `reconcile.ts::contentKey` compares — so a saved→reloaded entry
  reads as unchanged (no spurious dirty).
- **Display re-renders rich from `tex`** (`notationMarkup`): `notations[0].tex` present → rich Temml
  render; no `tex` (seed/legacy/raw-authored) → the stored `mathml` directly. So after a save+reload, a
  `tex`-bearing cell is still pretty even though the file holds the lean form.

(Considered but not taken: a `minimal`/`intent` flag inside the Temml fork — rejected because it would
minify the display too and add fork-maintenance burden for no gain over the app-side pass.)

## GitHub integration (`src/github/`)

The browser holds **no** GitHub token. It signs the user in (to get a `@handle`) and sends edits to the
service; the **bot** (in `service/`) does all the writing. The old browser-push modules
(`session.ts`/`submit.ts`/`repo.ts`/`octokitBackend.ts`) were removed — that logic now lives server-side
in `service/src/github.js`.

- `auth.ts` — sign-in client: `buildAuthorizeUrl` (GitHub App user OAuth, no scope), `parseCallback`,
  CSRF `state` helpers, `exchangeCodeForIdentity(serviceUrl, code)` → `{ handle, jwt }` (POSTs
  `/auth`), `renewIdentity(serviceUrl, jwt)` (POSTs `/renew` for the sliding session), and identity
  storage (`save/load/clearIdentity`). The session JWT is a sliding **7-day** TTL: `loadIdentity` reads
  the JWT `exp` and treats an expired token as signed-out (`isExpired`/`secondsUntilExpiry`); `App`
  auto-signs-out at expiry and renews on a visit once the token has aged past its first day. Unit-tested.
- `submitClient.ts` — `submitToService(serviceUrl, jwt, { content, message })` → POSTs `/submit`
  (Bearer JWT) → `{ prNumber, prUrl }`; `resetSession(serviceUrl, jwt)` → POSTs `/reset` to delete the
  caller's branch. Unit-tested.
- `prSession.ts` — tracks the active PR (`localStorage`) and `fetchPullState()` polls its open/closed
  state via the **public** `api.github.com` (plain `fetch`, no token — see [client GitHub access]).
- `config.ts` — `repoConfigFromEnv()` (`VITE_GH_OWNER`/`REPO`/`BASE`/`FILE`) and
  `serviceConfigFromEnv()` (`VITE_GH_CLIENT_ID`, `VITE_GH_SERVICE`). Either returns null → graceful
  fallback (no repo → seed fixture; no service → local-only, ungated editing). See `.env.example`.
- `src/data/serialize.ts` — concepts → `open.yml` (the content sent to `/submit`).

`App` flow: **sign in** (`/auth` → store `{handle, jwt}`) gates editing when a service is configured;
**Unique branch per PR.** The client picks a unique working branch `<handle>-<YYYYMMDD>-<first-concept>`
(`newBranchName` in `prSession.ts`), e.g. `dginev-20260531-additive-inverse`, and stores it with the
active PR (`ActivePr.branch`). **Save** → `submitToService({…, branch})`: while the PR is open the SAME
branch is reused, so each Save is a new commit that updates the open PR; once it closed/merged (or none
exists) a fresh branch name is minted and a new PR opened. The data load reconciles against the active
branch (`loadDictionary({branch})` reads its `open.yml`).

**Session reset on PR close.** `App` tracks the active PR and, on mount + window focus, polls its state
(`fetchPullState`); if it's `closed` (merged counts), it calls `/reset` with the branch (bot deletes it),
clears the local edit cache, and reloads from `main` — so the next edit starts a fresh branch with a
minimal diff. `/submit` also self-heals: if the (reused) branch has no open PR it drops the stale branch
before committing (lazy cleanup if `/reset` was missed).

The service itself is in **`service/`** (Fastify, deployed on `latexml.rs` behind Caddy at
`https://intent-api.latexml.rs`) — see `service/README.md`.

### Architecture (confirmed with the user — target design)

The earlier "user opens the PR with their own token" model was replaced. The agreed design:

- **Identity is a prerequisite to edit.** Sign-in resolves the contributor's GitHub `@handle` (+ numeric
  `id`) before any editing is possible. The contributor's OAuth grants **no repo scope** — the bot's
  write access comes from the maintainer's installation, so the contributor's consent is identity-only.
- **Bot opens the PRs via a single GitHub App, but commits are authored as the contributor.** One GitHub
  App does both: user-to-server OAuth (to read the `@handle`+`id`) and an installation token (to push).
  The commit **author** is set to the contributor (`<id>+<handle>@users.noreply.github.com`, carried in
  the JWT) so their name+avatar appear on every commit and link to their profile (authorship credit; not
  green-square contribution-graph credit, which GitHub gates behind a fork/PR/collaborator association
  the bot can't create); the **committer** is the bot. The PR **title** (`add: …; edit: …; by @handle`)
  and **Markdown body** are auto-generated client-side (`prTitle`/`markdownChangeSummary` in
  `pendingChanges.ts`); the bot appends a "Proposed by @handle" footer.
- **Backend = a Node/Fastify microservice on the `latexml.rs` VM**, behind the VM's existing **Caddy**
  (auto-HTTPS + CORS for the Pages origin). Stateless **JWT** sessions (no session store), a sliding
  **7-day** TTL. Endpoints: `/auth` (OAuth code → verified handle → JWT), `/renew` (verify a valid JWT →
  re-issue a fresh-TTL one), `/reset` (verify JWT → bot deletes `intent/<handle>`),
  and `/submit` (verify JWT → bot commits to
  `intent/<handle>` → ensure PR). **Deployed and verified** at `https://intent-api.latexml.rs`.
- **Reads are backend-free.** The client fetches `open.yml` from `raw.githubusercontent.com` for both
  `main` (base) and the user's `intent/<handle>` branch (raw serves `ACAO: *`, so no CORS issue), plus
  a `localStorage` cache of the last save (covers raw's ~5-min CDN lag). On load it does a **three-way,
  per-concept reconcile** (base ↔ branch ↔ local) over the slug-keyed map — same-slug changes on both
  sides surface as conflicts.
- **Data repo = public `dginev/mathml-intent-open`**, **single `open.yml`** (fetched whole, rendered
  lazily, rewritten whole). Revisit splitting if conflicts become real.
- **TeX round-trip: store both, MathML canonical.** Each notation hash holds its authored `tex:`
  (when present) alongside the stored `mathml:`, and reads it back so re-edits reopen the source. Seed
  entries lack `tex` and re-author from blank.
- **Hosting: app on GitHub Pages** (Actions deploy; `BASE_PATH=/mathml-intent-open-editor/` — the repo
  was renamed to `dginev/mathml-intent-open-editor` in round 2; Pages project paths don't redirect, so
  the BASE_PATH and the GitHub App's OAuth callback URL had to follow).

**Status:** deployed and verified end-to-end — the bot frontend (GitHub Pages) + the OAuth/PR service
(`latexml.rs`), sign-in → `/auth`, Save → `/submit`, with commits **authored as the contributor**. The
browser holds no push token; the contributor's GitHub-App OAuth grants no repo scope (identity-only
consent — the bot's write access comes from the maintainer's installation). The GitHub App is **public**
(round-1 404 cleared); a live smoke test confirmed sign-in → bot PR with the commit authored as the signer.

> **History / open question.** A client-side user-PR variant (the browser's own `public_repo` token forks
> + commits + opens the PR for genuine contribution-graph credit) was built and then **reverted**: it
> needed a broad `public_repo` consent *and* an automatic fork GitHub Apps can't reliably do, while a
> manual fork was unacceptable. We chose the narrow bot model (identity-only consent, authorship credit).
> Left empirically open: whether a bot-authored commit earns an *unaffiliated* contributor green-square
> credit too, or only the name-on-the-commit authorship display (the throwaway probe was deleted before
> it resolved; re-test with a fresh repo + ~24h wait if it matters).

### Maintainer succession (bus factor)

This is a one-maintainer project; the succession plan lives in `README.md` ("Maintainer succession (bus
factor)"). Key facts: the data source of truth is **`w3c/mathml-docs` `_data/open.yml`** (W3C-owned) and
reads are backend-free, so the data is never at risk — only the hosted editor's convenience is. The
personal-account dependencies a successor must re-create are the `dginev` repos + Pages site, the GitHub
App (ID `3916896`, its client secret + private key), and the stateless Fastify service on the `latexml.rs`
VM (`intent-api.latexml.rs`, secrets in `/etc/mathml-intent/`). The near-term plan to target
`w3c/mathml-docs` directly (retiring the `dginev/mathml-intent-open` mirror) is itself the main bus-factor
reduction.

## Round-2 feedback (2026-06-04) — landed

All ten round-2 items were implemented (see `w3c_plan.md` for the full plan): WCAG row marking
(status-icon column + accent stripes + table ARIA + verified contrast), 72-char PR-title cap, the
Speech-column language dropdown (`?lang=`), the `notations:` schema + full per-extra TeX/raw authoring,
the sign-in FAQ (ⓘ + dialog), the repo rename follow-through, and the data-repo CI checks
(duplicate-`(concept, arity)` validator + line-length disable in `dginev/mathml-intent-open`; the
Core-overlap check was **deferred** — revisit with the W3C group). Out-of-band/coordinated remainders:
the `open.yml` **migration commit** in the data repo (generate with `scripts/migrate-notations.ts`,
land together with the editor deploy, close old-shape PR branches first, regenerate `intent_open.json`
if it derives from `open.yml`), and socializing the `notations:` schema with the W3C group.

## Backlog — deferred community feedback

Ideas from the round-1 community feedback that were *not* implemented (the original meeting notes have
since been removed from the repo). Captured here so they aren't lost:

- **Wikidata-aware links.** Keep *both* Wikidata + Wikipedia links per concept; recognize/label each;
  weigh Wikidata QIDs vs Wikipedia URLs as the canonical reference. (A dedicated `wikidata:` field is a
  schema change needing a W3C decision; a Wikidata *URL* in `urls` needs none.)
- **Translation prefill from Wikidata.** When authoring a non-English speech template, offer to prefill
  from the concept's Wikidata label in that language (live Wikidata API, keyed off a WD link/QID).
- **Data cleaning.** Normalize `arg` names; migrate Wikipedia → Wikidata links (Moritz to supply the
  concept→Wikidata mapping). Eventually: add the MathML concept name into the Wikidata item itself.
- **Ontology / classification** (Patrick). Tag concepts with subfields — MSC classes and/or Wikidata
  categories — for browsing/filtering. A schema/convention question.
- **Concept refinement** (Moritz). Wikidata-style split / merge / consistency tooling (Lean has similar).
- **mardi4nfdi "profile pages for concepts."** A per-concept profile page; PRs proposed via this UI,
  Moritz syncs.
