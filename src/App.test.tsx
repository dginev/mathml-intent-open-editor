import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { w3cYaml } from './test/dictFixture';
import type { Concept } from './types';

// Configure a backing repo + service so App takes the live (GitHub) path, not the seed fallback.
vi.mock('./github/config', () => ({
  repoConfigFromEnv: () => ({ owner: 'o', repo: 'r', baseBranch: 'main', filePath: 'open.yml' }),
  serviceConfigFromEnv: () => ({ serviceUrl: 'https://svc.example', clientId: 'cid' }),
}));

// The (lazy) NotationEditor loads Temml via `?url` + dynamic import, which only works in the browser
// bundle; in jsdom we substitute the Node-native Temml build.
vi.mock('./render/temmlEngine', async () => {
  const temml = (await import('temml')).default;
  return { loadTemml: () => Promise.resolve(temml) };
});

import App from './App';

/** A JWT-shaped token whose `exp` is `days` out (so the renew-on-visit threshold isn't tripped). */
const jwtExp = (days: number): string => {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const body = btoa(JSON.stringify({ handle: 'dginev', exp }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `h.${body}.s`;
};

const base: Concept = {
  slug: 'power',
  intent: 'power($a,$b)',
  speech: [{ lang: 'en', readings: [{ verbosity: 'default', text: '$1 to the $2' }] }],
  notations: [{ mathml: '<math><msup><mi>x</mi><mn>2</mn></msup></math>' }],
  links: [],
  alias: [],
};
const edited: Concept = {
  ...base,
  speech: [{ lang: 'en', readings: [{ verbosity: 'default', text: '$1 raised to $2' }] }],
};
const baseYaml = w3cYaml([
  { concept: 'power', intent: 'power($a,$b)', speech: { en: [{ default: '$1 to the $2' }] }, notations: base.notations },
]);

const textRes = (status: number, text: string) => ({ ok: status < 400, status, text: async () => text });
const jsonRes = (obj: unknown) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

const submitBodies: Array<Record<string, string>> = [];
const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('raw.githubusercontent.com')) return u.includes('/main/') ? textRes(200, baseYaml) : textRes(404, '');
  if (u.includes('/submit')) {
    submitBodies.push(JSON.parse(String(init?.body)));
    return jsonRes({ prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' });
  }
  if (u.includes('/renew')) return jsonRes({ handle: 'dginev', jwt: jwtExp(7) });
  return textRes(404, '');
});

describe('App (integration: save/branch flow)', () => {
  beforeAll(() => {
    // jsdom's <dialog> may lack showModal/close; no-op polyfills keep App's dialog effects from throwing.
    HTMLDialogElement.prototype.showModal ||= function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close ||= function (this: HTMLDialogElement) { this.open = false; };
    // jsdom does no layout: give elements a viewport-sized box so TanStack Virtual renders table rows.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/'); // isolate the ?filter= URL between tests
    submitBodies.length = 0;
    fetchStub.mockClear();
    vi.stubGlobal('fetch', fetchStub);
    vi.stubGlobal('open', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('submits the batch as a PR: builds the payload + a fresh unique branch, then tracks the PR', async () => {
    // Signed in, with one pending edit restored from the cache → the session loads dirty.
    localStorage.setItem('intent-editor.identity', JSON.stringify({ handle: 'dginev', jwt: jwtExp(7) }));
    localStorage.setItem(
      'intent-editor.edits',
      JSON.stringify({ 'power#2': { value: edited, baseAtEdit: base } }),
    );

    render(<App />);

    const save = await screen.findByTestId('save-batch');
    await waitFor(() => expect(save).toBeEnabled()); // dirty from the cached edit

    fireEvent.click(save); // open the "Describe your changes" confirm modal
    const confirm = await screen.findByTestId('save-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(submitBodies).toHaveLength(1));
    const body = submitBodies[0];
    expect(body.branch).toMatch(/^dginev-\d{8}-power$/); // fresh unique branch (no open PR yet)
    expect(body.title).toBe('edit: power; by @dginev');
    expect(body.content).toContain('$1 raised to $2'); // the edited value, serialized

    await screen.findByText(/PR #1/); // PR tracked + status shown
    expect(JSON.parse(localStorage.getItem('intent-editor.pr')!).number).toBe(1);
  });

  it('hydrates the filter from ?filter= and syncs edits back into the URL', async () => {
    window.history.replaceState(null, '', '/?filter=power');
    render(<App />);

    const input = (await screen.findByPlaceholderText('Filter concepts…')) as HTMLInputElement;
    expect(input.value).toBe('power'); // hydrated from the URL
    await screen.findByText(/match/); // count reflects a filtered view

    fireEvent.change(input, { target: { value: '' } }); // clearing drops the param
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('hydrates the speech language from ?lang= and shows that language column', async () => {
    // A dictionary carrying a Bulgarian template alongside English.
    const bgYaml = w3cYaml([
      {
        concept: 'power',
        intent: 'power($a,$b)',
        speech: { en: [{ default: '$1 to the $2' }], bg: [{ default: 'степен' }] },
        notations: base.notations,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('raw.githubusercontent.com')) return u.includes('/main/') ? textRes(200, bgYaml) : textRes(404, '');
        return textRes(404, '');
      }),
    );
    window.history.replaceState(null, '', '/?lang=bg');
    render(<App />);

    const select = (await screen.findByRole('combobox', { name: 'Speech language' })) as HTMLSelectElement;
    expect(select.value).toBe('bg'); // hydrated from the URL
    await screen.findByText('степен'); // the bg template is shown in the Speech column

    // Switching back to English drops the param from the URL (en is the default).
    fireEvent.change(select, { target: { value: 'en' } });
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('dismissing a dirty editor via the backdrop asks before discarding; clean closes silently', async () => {
    localStorage.setItem('intent-editor.identity', JSON.stringify({ handle: 'dginev', jwt: jwtExp(7) }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);

    // Open the editor on the row, make no change, backdrop-click → closes without any prompt.
    // (jsdom rects are 0×0, so any nonzero coordinates count as outside the dialog's box; a true
    // backdrop dismissal needs BOTH the press and the click outside — see App's isBackdropClick.)
    fireEvent.click(await screen.findByLabelText('Edit power'));
    await screen.findByTestId('notation-editor');
    const dialog = () => document.querySelector('dialog.modal') as HTMLDialogElement;
    const backdropClick = () => {
      fireEvent.mouseDown(dialog(), { clientX: 999, clientY: 999 });
      fireEvent.click(dialog(), { clientX: 999, clientY: 999 });
    };
    backdropClick();
    await waitFor(() => expect(screen.queryByTestId('notation-editor')).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();

    // Reopen, edit a field — a refused prompt keeps the editor (and the unsaved work) open.
    fireEvent.click(await screen.findByLabelText('Edit power'));
    await screen.findByTestId('notation-editor');
    fireEvent.change(screen.getByTestId('slug-input'), { target: { value: 'power-renamed' } });
    backdropClick();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('notation-editor')).toBeInTheDocument();

    // A click that targets the dialog WITHOUT a press outside (padding/scrollbar/drag-out) never
    // dismisses — and never prompts.
    fireEvent.click(dialog(), { clientX: 999, clientY: 999 }); // no preceding outside mousedown
    expect(confirmSpy).toHaveBeenCalledTimes(1); // unchanged
    expect(screen.getByTestId('notation-editor')).toBeInTheDocument();

    // Accepting the prompt discards and closes.
    confirmSpy.mockReturnValue(true);
    backdropClick();
    await waitFor(() => expect(screen.queryByTestId('notation-editor')).toBeNull());
    confirmSpy.mockRestore();
  });

  it('gates editing behind sign-in when a service is configured', async () => {
    render(<App />); // no identity in storage
    await screen.findByTestId('concept-count');
    // The login-gated affordances are absent until signed in.
    expect(screen.queryByTestId('save-batch')).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add entry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
  });

  it('reassures about sign-in permissions: ⓘ popover at the button + FAQ from the header', async () => {
    render(<App />); // signed out — the moment the permission fear strikes
    await screen.findByTestId('concept-count');

    // The ⓘ next to "Sign in with GitHub": identity-only consent in one breath.
    fireEvent.click(screen.getByLabelText('About GitHub sign-in'));
    const pop = screen.getByTestId('signin-help');
    expect(pop).toHaveTextContent(/@handle/);
    expect(pop).toHaveTextContent(/no repository access/i);

    // The popover's "FAQ" is a real link into the dialog (deep-link fragment, keyboard-followable).
    const faqLink = screen.getByRole('link', { name: 'FAQ' });
    expect(faqLink).toHaveAttribute('href', '#faq');

    // The fuller About/FAQ dialog opens from the header link.
    fireEvent.click(screen.getByRole('button', { name: 'About / FAQ' }));
    expect(screen.getByTestId('faq')).toHaveTextContent(/why sign in/i);
    fireEvent.click(screen.getByRole('button', { name: 'Close FAQ' }));
  });

  it('deep-links the FAQ: loading with #faq opens it, and the dialog reflects into the fragment', async () => {
    window.history.replaceState(null, '', '/#faq');
    render(<App />);
    await screen.findByTestId('concept-count');
    const faq = () => screen.getByTestId('faq') as HTMLDialogElement;
    expect(faq().open).toBe(true); // arrived via the shared link → documentation is already open

    // Closing strips the fragment (the URL stays shareable-clean)…
    fireEvent.click(screen.getByRole('button', { name: 'Close FAQ' }));
    expect(faq().open).toBe(false);
    expect(window.location.hash).toBe('');

    // …and reopening from the header restores it (copyable answer URL).
    fireEvent.click(screen.getByRole('button', { name: 'About / FAQ' }));
    expect(faq().open).toBe(true);
    expect(window.location.hash).toBe('#faq');
  });

  it('follows in-page #faq navigation (hashchange) while the app is running', async () => {
    render(<App />);
    await screen.findByTestId('concept-count');
    expect((screen.getByTestId('faq') as HTMLDialogElement).open).toBe(false);

    window.location.hash = '#faq'; // e.g. the sign-in popover's FAQ link
    fireEvent(window, new HashChangeEvent('hashchange'));
    await waitFor(() => expect((screen.getByTestId('faq') as HTMLDialogElement).open).toBe(true));
  });
});
