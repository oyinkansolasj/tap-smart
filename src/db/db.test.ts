// Runs the real Dexie code against an in-memory IndexedDB, since Node has no IndexedDB of its own.
import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCard,
  db,
  DEFAULT_PREFERENCES,
  getPreferences,
  listCards,
  logPurchase,
  recentShopIds,
  removeCard,
  savePreferences,
  saveSetup,
  updateCard,
  WhichCardDB,
} from './db.ts';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('cards', () => {
  it('starts with no cards', async () => {
    expect(await listCards()).toEqual([]);
  });

  it('lists added cards oldest first, in the shape rank() takes', async () => {
    await addCard({ cardId: 'revolut-metal' });
    await new Promise((r) => setTimeout(r, 2)); // so the two cards get different addedAt times
    await addCard({ cardId: 'natwest-reward-credit', openedOn: '2025-03-01' });
    expect(await listCards()).toEqual([{ cardId: 'revolut-metal' }, { cardId: 'natwest-reward-credit', openedOn: '2025-03-01' }]);
  });

  it('refuses to add the same card twice', async () => {
    await addCard({ cardId: 'revolut-metal' });
    await expect(addCard({ cardId: 'revolut-metal' })).rejects.toThrow('card "revolut-metal" is already added');
  });

  it('updates a card without touching its other details', async () => {
    await addCard({ cardId: 'amex-platinum-cashback-everyday', openedOn: '2026-06-01' });
    await updateCard('amex-platinum-cashback-everyday', { spendThisPeriodPence: 120000 });
    expect(await listCards()).toEqual([
      { cardId: 'amex-platinum-cashback-everyday', openedOn: '2026-06-01', spendThisPeriodPence: 120000 },
    ]);
  });

  it('refuses to update a card that was never added', async () => {
    await expect(updateCard('nope', { openedOn: '2026-01-01' })).rejects.toThrow('card "nope" has not been added');
  });

  it('removes a card', async () => {
    await addCard({ cardId: 'revolut-metal' });
    await removeCard('revolut-metal');
    expect(await listCards()).toEqual([]);
  });
});

describe('preferences', () => {
  it('uses the defaults (max value, no overrides) until the user saves some', async () => {
    expect(await getPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('saves and replaces preferences', async () => {
    await savePreferences({ goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} });
    await savePreferences({ goal: { kind: 'collect_currency', targetCurrencyId: 'avios' }, pencePerUnitOverrides: { revpoints: 1.5 } });
    expect(await getPreferences()).toEqual({
      goal: { kind: 'collect_currency', targetCurrencyId: 'avios' },
      pencePerUnitOverrides: { revpoints: 1.5 },
    });
    expect(await db.preferences.count()).toBe(1);
  });
});

describe('saving the setup screen', () => {
  it('adds ticked cards, removes unticked ones, keeps details of cards that stay, and saves the goal', async () => {
    await addCard({ cardId: 'natwest-reward-credit', openedOn: '2025-03-01', spendThisPeriodPence: 5000 });
    await addCard({ cardId: 'revolut-plus' });

    const goal = { goal: { kind: 'cash_only' as const }, pencePerUnitOverrides: {} };
    await saveSetup(['natwest-reward-credit', 'revolut-metal'], goal);

    const cards = await listCards();
    expect(cards.map((c) => c.cardId).sort()).toEqual(['natwest-reward-credit', 'revolut-metal']);
    expect(cards.find((c) => c.cardId === 'natwest-reward-credit')).toEqual({
      cardId: 'natwest-reward-credit',
      openedOn: '2025-03-01',
      spendThisPeriodPence: 5000,
    });
    expect(await getPreferences()).toEqual(goal);
  });

  it('saves nothing if any part fails', async () => {
    await addCard({ cardId: 'revolut-plus' });
    // A card id that IndexedDB can't use as a key makes the add fail part-way through.
    await expect(saveSetup([null as unknown as string], { goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} })).rejects.toThrow();
    expect(await listCards()).toEqual([{ cardId: 'revolut-plus' }]);
    expect(await getPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('purchases', () => {
  const base = {
    date: '2026-11-18',
    amountPence: 4000,
    category: 'supermarket' as const,
    foreignCurrency: false,
    cardId: 'natwest-reward-credit',
    ruleId: 'natwest-credit-supermarket',
    currencyId: 'natwest-rewards',
    rewardUnits: 0.4,
    valuePence: 40,
  };
  const tick = () => new Promise((r) => setTimeout(r, 2)); // so purchases get different loggedAt times

  it('logs a purchase with the time it was logged', async () => {
    await logPurchase({ ...base, shopId: 'tesco' });
    const [row] = await db.purchases.toArray();
    expect(row).toMatchObject({ ...base, shopId: 'tesco' });
    expect(Date.parse(row.loggedAt)).not.toBeNaN();
  });

  it('lists recent shops newest first, each once, skipping purchases with no shop', async () => {
    for (const shopId of ['tesco', 'tfl', 'tesco', undefined, 'amazon']) {
      await logPurchase({ ...base, shopId });
      await tick();
    }
    expect(await recentShopIds()).toEqual(['amazon', 'tesco', 'tfl']);
    expect(await recentShopIds(2)).toEqual(['amazon', 'tesco']);
  });
});

it('upgrading from version 1 keeps saved cards and preferences, and adds the purchases table', async () => {
  const name = 'upgrade-test';
  const v1 = new Dexie(name);
  v1.version(1).stores({ cards: 'cardId, addedAt', preferences: 'id' });
  await v1.table('cards').add({ cardId: 'revolut-metal', addedAt: '2026-01-01T00:00:00.000Z' });
  await v1.table('preferences').put({ id: 'me', goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} });
  v1.close();

  const v2 = new WhichCardDB(name);
  expect(await v2.cards.toArray()).toEqual([{ cardId: 'revolut-metal', addedAt: '2026-01-01T00:00:00.000Z' }]);
  expect(await v2.preferences.get('me')).toMatchObject({ goal: { kind: 'cash_only' } });
  expect(await v2.purchases.count()).toBe(0);
  await v2.delete();
});

it('keeps data after the database is closed and opened again (like reloading the app)', async () => {
  await addCard({ cardId: 'revolut-metal' });
  await savePreferences({ goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} });
  db.close();

  const reopened = new WhichCardDB();
  expect(await reopened.cards.toArray()).toMatchObject([{ cardId: 'revolut-metal' }]);
  expect(await reopened.preferences.get('me')).toMatchObject({ goal: { kind: 'cash_only' } });
  reopened.close();
  await db.open();
});
