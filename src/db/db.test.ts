// Runs the real Dexie code against an in-memory IndexedDB, since Node has no IndexedDB of its own.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCard,
  db,
  DEFAULT_PREFERENCES,
  getPreferences,
  listCards,
  removeCard,
  savePreferences,
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
