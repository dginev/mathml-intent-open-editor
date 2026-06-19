## MathML Intent Open Editor

A web app for open community curation (add / edit / remove) of the *Intent Open* concept list defined by [MathML 4 Intent](https://w3c.github.io/mathml-docs/intent/).

Use live at:

https://dginev.github.io/mathml-intent-open-editor/

## Tech stack

- **Frontend:** React 19 + Vite (static SPA on GitHub Pages); TanStack Table + TanStack Virtual for the
  virtualized 10k-row table; Temml for TeX→MathML; DOMPurify to sanitize rendered MathML.
- **Data:** the W3C `open.yml` dictionary, read straight from `raw.githubusercontent.com` and reconciled
  client-side (no DB). Edits open a pull request against [`dginev/mathml-intent-open`](https://github.com/dginev/mathml-intent-open).
- **Backend:** a small Fastify service (`service/`) on `latexml.rs` behind Caddy — GitHub-App OAuth +
  stateless JWT sessions; a bot account commits to a per-PR branch and opens/updates the PR.
- **Tooling:** TypeScript, ESLint, Vitest (unit) + Playwright (e2e); GitHub Actions for CI + the Pages deploy.

## Maintainer succession (bus factor)

This is a one-maintainer project. Everything in it is open source, public, and runs on free
infrastructure, so it can be taken over by another W3C maintainer with no proprietary lock-in. The
near-term plan already shrinks the bus factor: the editor will target `w3c/mathml-docs` `_data/open.yml`
directly (retiring the personal data mirror), so edits land as PRs against the W3C-owned repo.

**The data is never at risk.** The source of truth is `_data/open.yml` in
[`w3c/mathml-docs`](https://github.com/w3c/mathml-docs) (W3C-owned); the
[`dginev/mathml-intent-open`](https://github.com/dginev/mathml-intent-open) repo is only a mirror this
editor reads/PRs against. Reads are backend-free (straight from `raw.githubusercontent.com`), so even if
*all* of the infrastructure below disappears, the dictionary is intact and the app still browses it —
editing/PR submission is what degrades (to local-only). Nothing here is a single point of failure for the
data; it's only a single point of failure for the *convenience* of the hosted editor.

**What is currently tied to the maintainer's personal accounts** (the things a successor must re-create):

1. **GitHub repos & the Pages site** — under the personal `dginev` account: this editor repo, the
   `mathml-intent-open` data mirror, the `Temml` fork branch
   (`github:dginev/Temml#intent-arg-annotations`, the dep that adds the `\intent`/`\arg` commands), and
   the GitHub Pages deployment at `https://dginev.github.io/mathml-intent-open-editor/`.
2. **The GitHub App** (App ID `3916896`) — does identity-only user OAuth *and* holds the bot's
   installation token that writes the PRs. Its client secret + private key are secrets.
3. **The auth/PR service** — a stateless Fastify app (`service/`, no database) on the `latexml.rs` VM,
   reached at `https://intent-api.latexml.rs` (a subdomain of the maintainer's personal domain), behind
   that VM's Caddy. Its secrets live in `/etc/mathml-intent/` on the VM (App client secret, private-key
   `.pem`, JWT signing secret).

**Steps for a successor to take over** (all free, no data migration):

1. **Fork/transfer the repos** to the new owner (ideally the `w3c` org): this editor and the Temml fork
   branch. The data mirror is going away regardless — point the editor directly at `w3c/mathml-docs`
   `_data/open.yml` (set `VITE_GH_OWNER`/`VITE_GH_REPO`/`VITE_GH_FILE` accordingly) and install the App there.
2. **Re-host the frontend** on the new owner's GitHub Pages (the `deploy.yml` workflow already does this;
   just update `BASE_PATH` in it and the `VITE_GH_*` values in `.env.production`).
3. **Re-create the GitHub App** under the new owner: new App ID / client id / client secret / private
   key; set its OAuth callback URL to the new Pages URL; install it on the data repo with contents + PR
   write. Update `VITE_GH_CLIENT_ID` and the service's `GH_APP_ID`/`GH_CLIENT_ID`/`GH_INSTALLATION_ID`.
4. **Re-deploy the service** on any host with Node + a reverse proxy that does TLS (it's stateless — no
   state to migrate). Follow `service/README.md`; fill in the new App's client secret + private key and a
   fresh `JWT_SECRET` (`openssl rand -hex 32`). Point `VITE_GH_SERVICE` at the new URL.

Until step 4 is done the app still works in read-only/local-only mode, so there is no hard outage —
takeover can happen at a deliberate pace.