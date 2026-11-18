// One test per receipt in eval/receipts.json, run against the REAL catalogue.
// If one fails, fix the cause (card file, shop category or engine), not the receipt,unless the receipt itself is wrong.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../scripts/load-catalog.ts';
import { rank } from '../src/engine/rank.ts';
import type { Category, IsoDate, Pence, UserCard } from '../src/engine/types.ts';

interface Receipt {
  id: string;
  description: string;
  date: IsoDate;
  cardId: string;
  shopId?: string;
  category?: Category;
  foreignCurrency?: boolean;
  amountPence: Pence;
  cardState?: Omit<UserCard, 'cardId'>;
  expected: { currencyId: string; rewardUnits: number; feePence?: Pence };
  working: string;
  terms: string;
  checked: boolean;
}

const receipts: Receipt[] = JSON.parse(readFileSync(new URL('./receipts.json', import.meta.url), 'utf8'));
const { catalogue, errors } = await loadCatalogue();

describe('receipts (real catalogue)', () => {
  it('the real catalogue loads without errors', () => {
    expect(errors).toEqual([]);
  });

  it('receipt ids are unique', () => {
    const ids = receipts.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const r of receipts) {
    it(`${r.id}: ${r.description}`, () => {
      const [result] = rank({
        catalogue: catalogue!,
        purchase: {
          amountPence: r.amountPence,
          shopId: r.shopId,
          category: r.category,
          foreignCurrency: r.foreignCurrency,
          date: r.date,
        },
        userCards: [{ cardId: r.cardId, ...r.cardState }],
        preferences: { goal: { kind: 'max_value' }, pencePerUnitOverrides: {} },
      });

      const why = `${r.working} (${r.terms})`;
      expect(result.currencyId, why).toBe(r.expected.currencyId);
      expect(result.rewardUnits, why).toBeCloseTo(r.expected.rewardUnits, 4);
      if (r.expected.feePence !== undefined) expect(result.feePence, why).toBeCloseTo(r.expected.feePence, 4);
    });
  }
});
