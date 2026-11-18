// @vitest-environment jsdom
// The till screen, driven through the real app with an in-memory IndexedDB and a fake catalogue download.
import 'fake-indexeddb/auto';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.tsx';
import { addCard, db, savePreferences } from '../db/db.ts';
import { miniCatalogue } from '../engine/__fixtures__/mini-catalogue.ts';
import type { Catalogue, UserCard } from '../engine/types.ts';

const TERMS_URL = 'https://example.com/natwest-terms';

// The mini catalogue, with a terms link on NatWest's supermarket rule so there's a "Terms" link to show.
const catalogue: Catalogue = {
  ...miniCatalogue,
  cards: miniCatalogue.cards.map((card) =>
    card.id !== 'natwest-reward-credit'
      ? card
      : {
          ...card,
          rules: card.rules.map((r) =>
            r.id === 'natwest-credit-supermarket'
              ? { ...r, verification: { status: 'confirmed' as const, sourceUrls: [TERMS_URL], lastVerified: '2026-11-17' } }
              : r,
          ),
        },
  ),
};

async function openTill(cards: UserCard[] = [{ cardId: 'natwest-reward-debit' }, { cardId: 'revolut-metal' }, { cardId: 'natwest-reward-credit' }]) {
  for (const card of cards) await addCard(card);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Which card?' });
  return user;
}

// The ranked cards, best first (the top-level items only, not the warnings inside them).
const resultItems = () => [...screen.getByRole('list', { name: 'Your cards, best first' }).children] as HTMLElement[];
const resultNames = () => resultItems().map((li) => li.querySelector('.result-name')!.textContent);

beforeEach(async () => {
  await db.delete();
  await db.open();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalogue))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('finding the shop', () => {
  it('searches shops by name or alias', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox', { name: 'Where are you paying?' }), 'tesco exp');
    expect(within(screen.getByRole('group', { name: 'Matching shops' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tesco']);
  });

  it('says when nothing matches', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('No shops match “zzz”.')).toBeTruthy();
  });

  it('shows no recent shops on a first visit', async () => {
    await openTill();
    expect(screen.queryByRole('group', { name: 'Recent shops' })).toBeNull();
  });

  it('picking a shop moves straight on to the amount', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Amount' })));
    expect(screen.getByText('Supermarket')).toBeTruthy(); // the shop's category is shown
  });
});

describe('ranking', () => {
  it('ranks the cards with the value, reward, reason and a link to the terms', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');

    expect(resultNames()).toEqual(['NatWest Reward Credit Card', 'Revolut Metal', 'NatWest Reward Debit Card']);

    const best = resultItems()[0];
    expect(within(best).getByText('Best')).toBeTruthy();
    expect(best.querySelector('.result-value')!.textContent).toBe('40p');
    expect(best.querySelector('.result-reward')!.textContent).toBe('£0.40 NatWest Rewards');
    expect(best.querySelector('.result-reason')!.textContent).toBe('Why: 1% at supermarkets');
    // Just the link to the terms, opening in a new tab: no "confirmed" / "third-party" status or checked date.
    const terms = within(best).getByRole('link', { name: 'Terms' });
    expect(terms.getAttribute('href')).toBe(TERMS_URL);
    expect(terms.getAttribute('target')).toBe('_blank');
    expect(best.querySelector('.result-terms')!.textContent).toBe('Terms');
    expect(screen.queryByText(/confirmed|third-party|not verified|checked/i)).toBeNull();
    // A rule with no published terms shows no link at all.
    expect(within(resultItems()[1]).queryByRole('link')).toBeNull();

    // Points show their £ estimate too.
    expect(resultItems()[1].querySelector('.result-reward')!.textContent).toBe('20 Revolut RevPoints (about 20p for your goal)');
  });

  it('shows nothing until the amount is valid, and says how to fix it', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '12.345');
    expect(screen.getByText('Enter an amount like 12.50')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Your cards, best first' })).toBeNull();
  });

  it('shows warnings, and puts a card the shop does not take last', async () => {
    const user = await openTill([{ cardId: 'amex-cashback', openedOn: '2026-06-01', spendThisPeriodPence: 500000 }, { cardId: 'natwest-reward-credit' }]);
    await user.type(screen.getByRole('searchbox'), 'corner');
    await user.click(screen.getByRole('button', { name: 'Corner Shop' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');

    expect(resultNames()).toEqual(['NatWest Reward Credit Card', 'Amex Cashback']);
    const amex = resultItems()[1];
    expect(within(within(amex).getByRole('list', { name: 'Warnings' })).getByText('Corner Shop does not accept amex cards.')).toBeTruthy();
    expect(within(amex).queryByText('Best')).toBeNull();
  });

  it('uses a category when the shop is not listed', async () => {
    const user = await openTill([{ cardId: 'natwest-reward-credit' }]);
    await user.click(screen.getByRole('button', { name: 'Not listed? Choose a category' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'What are you buying?' }), 'online_shopping');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');

    expect(screen.getByText('Shop not listed')).toBeTruthy();
    expect(resultItems()[0].querySelector('.result-reason')!.textContent).toBe('Why: 0.25% everywhere else');
    expect(resultItems()[0].querySelector('.result-value')!.textContent).toBe('10p');
  });

  it('includes the foreign transaction fee when paying in another currency', async () => {
    const user = await openTill([{ cardId: 'amex-cashback', spendThisPeriodPence: 500000 }, { cardId: 'revolut-metal' }]);
    await user.click(screen.getByRole('button', { name: 'Not listed? Choose a category' }));
    await user.selectOptions(screen.getByRole('combobox'), 'other');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '100');
    await user.click(screen.getByRole('checkbox', { name: /Paying in a foreign currency/ }));

    expect(resultNames()).toEqual(['Revolut Metal', 'Amex Cashback']);
    const [revolut, amex] = resultItems();
    expect(revolut.querySelector('.result-fee')!.textContent).toBe('No foreign fee');
    expect(amex.querySelector('.result-value')!.textContent).toBe('−£2.49');
    expect(amex.querySelector('.result-reward')!.textContent).toBe('£0.50 Amex Cashback');
    expect(amex.querySelector('.result-fee')!.textContent).toBe('Foreign fee 2.99%: −£2.99');
  });

  it('does not show the fee line for a UK purchase', async () => {
    const user = await openTill([{ cardId: 'amex-cashback' }]);
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');
    expect(resultItems()[0].querySelector('.result-fee')).toBeNull();
  });

  it('marks the card that costs least as Best abroad, even when it earns 0p', async () => {
    // £1 abroad: Revolut Metal earns nothing (1 point per full £2) but has no fee; Amex loses its 2.99% fee.
    const user = await openTill([{ cardId: 'amex-cashback', spendThisPeriodPence: 500000 }, { cardId: 'revolut-metal' }]);
    await user.click(screen.getByRole('button', { name: 'Not listed? Choose a category' }));
    await user.selectOptions(screen.getByRole('combobox'), 'other');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '1');
    await user.click(screen.getByRole('checkbox', { name: /Paying in a foreign currency/ }));

    const [revolut, amex] = resultItems();
    expect(revolut.querySelector('.result-value')!.textContent).toBe('0p');
    expect(within(revolut).getByText('Best')).toBeTruthy();
    expect(within(amex).queryByText('Best')).toBeNull();
  });

  it('marks no card Best when the top two are equal', async () => {
    // £1 in the UK: Revolut Metal and NatWest debit both earn 0p.
    const user = await openTill([{ cardId: 'natwest-reward-debit' }, { cardId: 'revolut-metal' }]);
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '1');
    expect(screen.queryByText('Best')).toBeNull();
  });

  it('values rewards for the saved goal', async () => {
    await savePreferences({ goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} });
    const user = await openTill([{ cardId: 'revolut-metal' }]);
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');
    expect(resultItems()[0].querySelector('.result-value')!.textContent).toBe('0p');
    expect(within(resultItems()[0]).queryByText('Best')).toBeNull();
  });
});

describe('"Paid with this"', () => {
  it('logs the purchase, confirms it, clears the form, and offers the shop as a recent one', async () => {
    const user = await openTill();
    await user.type(screen.getByRole('searchbox'), 'tesco');
    await user.click(screen.getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '40');
    await user.click(within(resultItems()[1]).getByRole('button', { name: 'Paid with this' })); // Revolut, not the best

    expect((await screen.findByRole('status')).textContent).toBe('Logged £40.00 at Tesco with Revolut Metal.');
    const [row] = await db.purchases.toArray();
    expect(row).toMatchObject({
      amountPence: 4000,
      shopId: 'tesco',
      category: 'supermarket',
      foreignCurrency: false,
      cardId: 'revolut-metal',
      ruleId: 'revolut-metal-everywhere',
      currencyId: 'revpoints',
      rewardUnits: 20,
      valuePence: 20,
    });
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The form is ready for the next purchase, with Tesco one tap away.
    expect((screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('list', { name: 'Your cards, best first' })).toBeNull();
    const recent = await screen.findByRole('group', { name: 'Recent shops' });
    await user.click(within(recent).getByRole('button', { name: 'Tesco' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '10');
    expect(resultNames()[0]).toBe('NatWest Reward Credit Card');
  });

  it('logs a purchase at a shop that is not listed with its category and no shop', async () => {
    const user = await openTill([{ cardId: 'natwest-reward-credit' }]);
    await user.click(screen.getByRole('button', { name: 'Not listed? Choose a category' }));
    await user.selectOptions(screen.getByRole('combobox'), 'dining');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '25');
    await user.click(screen.getByRole('button', { name: 'Paid with this' }));

    expect((await screen.findByRole('status')).textContent).toBe('Logged £25.00 at eating out with NatWest Reward Credit Card.');
    const [row] = await db.purchases.toArray();
    expect(row).toMatchObject({ category: 'dining', amountPence: 2500 });
    expect(row.shopId).toBeUndefined();
    expect(screen.queryByRole('group', { name: 'Recent shops' })).toBeNull();
  });

  it('shows recent shops from earlier visits before anything is typed', async () => {
    await db.purchases.add({
      loggedAt: '2026-11-17T12:00:00.000Z',
      date: '2026-11-17',
      amountPence: 500,
      shopId: 'corner-shop',
      category: 'supermarket',
      foreignCurrency: false,
      cardId: 'natwest-reward-credit',
      ruleId: 'natwest-credit-supermarket',
      currencyId: 'natwest-rewards',
      rewardUnits: 0.05,
      valuePence: 5,
    });
    await openTill();
    expect(within(await screen.findByRole('group', { name: 'Recent shops' })).getByRole('button', { name: 'Corner Shop' })).toBeTruthy();
  });
});
