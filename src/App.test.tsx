// @vitest-environment jsdom
// Clicks through the real screens in a simulated browser, with an in-memory IndexedDB and a fake catalogue download.
import 'fake-indexeddb/auto';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.tsx';
import { addCard, db, getPreferences, listCards, savePreferences } from './db/db.ts';
import { miniCatalogue } from './engine/__fixtures__/mini-catalogue.ts';
import type { Catalogue } from './engine/types.ts';

// The mini catalogue plus a second Revolut plan, so the "pick one plan" group has a choice.
const metal = miniCatalogue.cards.find((c) => c.id === 'revolut-metal')!;
const catalogue: Catalogue = {
  ...miniCatalogue,
  cards: [...miniCatalogue.cards, { ...metal, id: 'revolut-plus', name: 'Revolut Plus', plan: 'plus', fees: { annualFeePence: 0, monthlyFeePence: 399 } }],
};

const serveCatalogue = (body: unknown = catalogue, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

beforeEach(async () => {
  await db.delete();
  await db.open();
  serveCatalogue();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('choosing the screen', () => {
  it('shows setup when no cards are saved yet, with no way to skip it', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set up' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('goes straight to the till when cards are saved', async () => {
    await addCard({ cardId: 'natwest-reward-credit' });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Which card?' })).toBeTruthy();
  });

  it('ignores a saved card that is no longer in the catalogue', async () => {
    await addCard({ cardId: 'card-that-was-removed' });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set up' })).toBeTruthy();
  });

  it('shows which card rules are in use, on setup and on the till', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up' });
    expect(screen.getByRole('contentinfo').textContent).toBe('Card rules from 1 Jan 2026 · version test0001');

    cleanup();
    await addCard({ cardId: 'natwest-reward-credit' });
    render(<App />);
    await screen.findByRole('heading', { name: 'Which card?' });
    expect(screen.getByRole('contentinfo').textContent).toBe('Card rules from 1 Jan 2026 · version test0001');
  });

  it('shows an error if the catalogue cannot be loaded', async () => {
    serveCatalogue({}, 404);
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 404');
  });

  it('shows an error if the catalogue file is damaged', async () => {
    serveCatalogue({ cards: 'nope' });
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('damaged');
  });
});

describe('the setup screen', () => {
  it('saves the ticked cards and the goal, then shows the till', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up' });

    await user.click(screen.getByRole('radio', { name: /Cash only/ }));
    await user.click(screen.getByRole('checkbox', { name: /NatWest Reward Credit Card/ }));
    await user.click(screen.getByRole('checkbox', { name: /Amex Cashback/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { name: 'Which card?' })).toBeTruthy();
    expect((await listCards()).map((c) => c.cardId).sort()).toEqual(['amex-cashback', 'natwest-reward-credit']);
    expect(await getPreferences()).toEqual({ goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} });
  });

  it('will not save with no cards ticked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Tick at least one card.');
    expect(await listCards()).toEqual([]);
  });

  it('only lets you pick one Revolut plan', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up' });
    const revolut = screen.getByRole('heading', { name: 'Revolut' }).parentElement!;

    expect(within(revolut).getByRole('radio', { name: 'None' })).toHaveProperty('checked', true);
    await user.click(within(revolut).getByRole('radio', { name: /Revolut Metal/ }));
    await user.click(within(revolut).getByRole('radio', { name: /Revolut Plus/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('heading', { name: 'Which card?' });
    expect((await listCards()).map((c) => c.cardId)).toEqual(['revolut-plus']);
  });

  it('shows each card’s type and fee', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up' });
    expect(screen.getByRole('radio', { name: /Revolut Plus/ }).closest('label')!.textContent).toContain('Debit card · £3.99 a month');
  });

  it('saves a "collect points" goal with the chosen currency and extra value', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up' });

    await user.click(screen.getByRole('radio', { name: /Collect one kind of points/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Points to collect' }), 'avios');
    await user.selectOptions(screen.getByRole('combobox', { name: /How much more/ }), '50');
    await user.click(screen.getByRole('checkbox', { name: /Amex Gold/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('heading', { name: 'Which card?' });
    expect((await getPreferences()).goal).toEqual({ kind: 'collect_currency', targetCurrencyId: 'avios', boostPercent: 50 });
  });

  it('"Setup" opens it with the saved choices, keeps card details, and Cancel changes nothing', async () => {
    await addCard({ cardId: 'natwest-reward-credit', openedOn: '2025-03-01' });
    await savePreferences({ goal: { kind: 'cash_only' }, pencePerUnitOverrides: { revpoints: 1.5 } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    expect(screen.getByRole('radio', { name: /Cash only/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: /NatWest Reward Credit Card/ })).toHaveProperty('checked', true);

    // Cancel goes back without saving.
    await user.click(screen.getByRole('checkbox', { name: /NatWest Reward Credit Card/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Which card?' });
    expect(await listCards()).toEqual([{ cardId: 'natwest-reward-credit', openedOn: '2025-03-01' }]);

    // Add a card and save: the existing card keeps its opening date, and the user's own point values are kept.
    await user.click(screen.getByRole('button', { name: 'Setup' }));
    await user.click(screen.getByRole('checkbox', { name: /Amex Cashback/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Which card?' });
    expect(await listCards()).toEqual([{ cardId: 'natwest-reward-credit', openedOn: '2025-03-01' }, { cardId: 'amex-cashback' }]);
    expect((await getPreferences()).pencePerUnitOverrides).toEqual({ revpoints: 1.5 });
  });
});
