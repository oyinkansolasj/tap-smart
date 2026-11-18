// The on-device database (IndexedDB via Dexie). Holds the user's own data only: which cards they have
// and how they value rewards. The catalogue is not stored here; it comes from public/catalog.json.
// Nothing in this database leaves the device.

import { Dexie, type EntityTable } from 'dexie';
import type { Category, IsoDate, Pence, UserCard, UserPreferences } from '../engine/types.ts';

// A card the user has, plus when they added it (so the list keeps its order).
export interface StoredCard extends UserCard {
  addedAt: string;
}

// The user's preferences, stored as a single row.
export interface StoredPreferences extends UserPreferences {
  id: 'me';
}

export const DEFAULT_PREFERENCES: UserPreferences = { goal: { kind: 'max_value' }, pencePerUnitOverrides: {} };

// A purchase the user logged with "Paid with this", with what the app worked out it would earn.
export interface LoggedPurchase {
  id?: number;
  // When it was logged (full timestamp), and the day of the purchase (local date).
  loggedAt: string;
  date: IsoDate;
  amountPence: Pence;
  // Missing when the shop wasn't in the catalogue and the user picked a category instead.
  shopId?: string;
  category: Category;
  foreignCurrency: boolean;
  cardId: string;
  ruleId: string | null;
  currencyId: string;
  rewardUnits: number;
  valuePence: number;
}

export class WhichCardDB extends Dexie {
  // `declare` (not `!`) so the class fields don't overwrite the tables Dexie sets up.
  declare cards: EntityTable<StoredCard, 'cardId'>;
  declare preferences: EntityTable<StoredPreferences, 'id'>;
  declare purchases: EntityTable<LoggedPurchase, 'id'>;

  constructor(name = 'which-card') {
    super(name);
    // Only the primary key and fields we search by are listed here. To change the schema,
    // add a new version below; never edit an old one (users' devices already have it).
    this.version(1).stores({
      cards: 'cardId, addedAt',
      preferences: 'id',
    });
    // v2: purchases logged with "Paid with this". Cards and preferences are kept as they are.
    this.version(2).stores({
      purchases: '++id, loggedAt, shopId, cardId',
    });
  }
}

export const db = new WhichCardDB();

// Cards

// The user's cards, oldest first (cards added at the same moment by card id), in the shape rank() takes.
export async function listCards(): Promise<UserCard[]> {
  const rows = await db.cards.orderBy('addedAt').toArray();
  return rows.map((row) => {
    const card: UserCard & { addedAt?: string } = { ...row };
    delete card.addedAt;
    return card;
  });
}

// Adds a card. Throws if the user already has it.
export async function addCard(card: UserCard): Promise<void> {
  if (await db.cards.get(card.cardId)) throw new Error(`card "${card.cardId}" is already added`);
  await db.cards.add({ ...card, addedAt: new Date().toISOString() });
}

// Changes details of a card the user has, e.g. when it was opened or how much has been spent on it.
export async function updateCard(cardId: string, changes: Partial<Omit<UserCard, 'cardId'>>): Promise<void> {
  const updated = await db.cards.update(cardId, changes);
  if (updated === 0) throw new Error(`card "${cardId}" has not been added`);
}

export async function removeCard(cardId: string): Promise<void> {
  await db.cards.delete(cardId);
}

// Preferences

export async function getPreferences(): Promise<UserPreferences> {
  const row = await db.preferences.get('me');
  if (!row) return DEFAULT_PREFERENCES;
  return { goal: row.goal, pencePerUnitOverrides: row.pencePerUnitOverrides };
}

export async function savePreferences(preferences: UserPreferences): Promise<void> {
  await db.preferences.put({ ...preferences, id: 'me' });
}

// Purchases

export async function logPurchase(purchase: Omit<LoggedPurchase, 'id' | 'loggedAt'>): Promise<void> {
  await db.purchases.add({ ...purchase, loggedAt: new Date().toISOString() });
}

// Shops the user has paid at, most recent first, each once.
export async function recentShopIds(limit = 6): Promise<string[]> {
  const ids: string[] = [];
  // Only look at recent purchases, so this stays fast however long the history gets.
  for (const p of await db.purchases.orderBy('loggedAt').reverse().limit(200).toArray()) {
    if (p.shopId && !ids.includes(p.shopId)) ids.push(p.shopId);
    if (ids.length === limit) break;
  }
  return ids;
}

// Setup screen

// Saves the setup screen in one go: the ticked cards and the goal. Cards that were already added keep
// their details (opening date, spend so far); unticked cards are removed. Either all of it is saved or none.
export async function saveSetup(cardIds: string[], preferences: UserPreferences): Promise<void> {
  const keep = new Set(cardIds);
  await db.transaction('rw', db.cards, db.preferences, async () => {
    const existing = await db.cards.toArray();
    const have = new Set(existing.map((c) => c.cardId));
    await db.cards.bulkDelete(existing.filter((c) => !keep.has(c.cardId)).map((c) => c.cardId));
    const now = new Date().toISOString();
    await db.cards.bulkAdd([...keep].filter((id) => !have.has(id)).map((cardId) => ({ cardId, addedAt: now })));
    await db.preferences.put({ ...preferences, id: 'me' });
  });
}
