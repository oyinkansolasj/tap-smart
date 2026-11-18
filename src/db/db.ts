// The on-device database (IndexedDB via Dexie). Holds the user's own data only: which cards they have
// and how they value rewards. The catalogue is not stored here; it comes from public/catalog.json.
// Nothing in this database leaves the device.

import { Dexie, type EntityTable } from 'dexie';
import type { UserCard, UserPreferences } from '../engine/types.ts';

// A card the user has, plus when they added it (so the list keeps its order).
export interface StoredCard extends UserCard {
  addedAt: string;
}

// The user's preferences, stored as a single row.
export interface StoredPreferences extends UserPreferences {
  id: 'me';
}

export const DEFAULT_PREFERENCES: UserPreferences = { goal: { kind: 'max_value' }, pencePerUnitOverrides: {} };

export class WhichCardDB extends Dexie {
  // `declare` (not `!`) so the class fields don't overwrite the tables Dexie sets up.
  declare cards: EntityTable<StoredCard, 'cardId'>;
  declare preferences: EntityTable<StoredPreferences, 'id'>;

  constructor(name = 'which-card') {
    super(name);
    // Only the primary key and fields we search by are listed here. To change this later,
    // add version(2) below with the new schema; never edit version(1).
    this.version(1).stores({
      cards: 'cardId, addedAt',
      preferences: 'id',
    });
  }
}

export const db = new WhichCardDB();

// Cards

// The user's cards, oldest first, in the shape rank() takes.
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
