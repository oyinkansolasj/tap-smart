// Edge cases for rank(): caps that are almost used up, cards with no matching rule, guessed categories, and currency conversions that loop.

import { describe, expect, it } from 'vitest';
import { miniCatalogue } from './__fixtures__/mini-catalogue.ts';
import { rank, type RankInput } from './rank.ts';
import type { Catalogue, UserPreferences } from './types.ts';

const maxValue: UserPreferences = { goal: { kind: 'max_value' }, pencePerUnitOverrides: {} };

const run = (input: Omit<RankInput, 'catalogue' | 'preferences'> & Partial<Pick<RankInput, 'catalogue' | 'preferences'>>) =>
  rank({ catalogue: miniCatalogue, preferences: maxValue, ...input });

describe('caps that are almost used up', () => {
  const purchase = { amountPence: 10000, category: 'other' as const }; // £100 at 5% = £5 before the cap

  it('pays exactly what is left when only 1p of the cap remains', () => {
    const [r] = run({ purchase, userCards: [{ cardId: 'capped-cashback', rewardEarnedByRuleUnits: { 'capped-cashback-everywhere': 9.99 } }] });
    expect(r).toMatchObject({ ruleId: 'capped-cashback-everywhere', capped: true, valuePence: 1 });
    expect(r.rewardUnits).toBeCloseTo(0.01, 8);
  });

  it('is not marked capped when the reward exactly fills the cap', () => {
    const [r] = run({ purchase, userCards: [{ cardId: 'capped-cashback', rewardEarnedByRuleUnits: { 'capped-cashback-everywhere': 5 } }] });
    expect(r).toMatchObject({ capped: false, valuePence: 500 });
  });

  it('a cap used up except for float noise pays nothing and does not crash', () => {
    const [r] = run({ purchase, userCards: [{ cardId: 'capped-cashback', rewardEarnedByRuleUnits: { 'capped-cashback-everywhere': 9.9999999999 } }] });
    expect(r).toMatchObject({ capped: true, rewardUnits: 0, valuePence: 0 });
  });

  it('a fully used cap with nothing to fall back to pays 0 with a warning, instead of throwing', () => {
    const [r] = run({ purchase, userCards: [{ cardId: 'capped-cashback', rewardEarnedByRuleUnits: { 'capped-cashback-everywhere': 10 } }] });
    expect(r).toMatchObject({ ruleId: 'capped-cashback-everywhere', capped: true, rewardUnits: 0, valuePence: 0 });
    expect(r.warnings).toContain('The reward cap on this card has been reached, so this purchase earns nothing.');
  });

  it('more already earned than the cap allows (bad input) is treated as fully used', () => {
    const [r] = run({ purchase, userCards: [{ cardId: 'capped-cashback', rewardEarnedByRuleUnits: { 'capped-cashback-everywhere': 50 } }] });
    expect(r).toMatchObject({ rewardUnits: 0, capped: true });
  });

  it('1p left on an intro cap: 1p covers 50p of spend at 2%, the other £99.50 earns 0.5%', () => {
    const [r] = run({
      purchase: { ...purchase, date: '2026-11-18' },
      userCards: [
        {
          cardId: 'amex-cashback',
          openedOn: '2026-06-01',
          spendThisPeriodPence: 500000,
          rewardEarnedByRuleUnits: { 'amex-cashback-intro': 199.99 },
        },
      ],
    });
    // 1p + (£99.50 x 0.5% = 49.75p) = 50.75p
    expect(r).toMatchObject({ ruleId: 'amex-cashback-intro', capped: true, valuePence: 50.75 });
  });
});

describe('a card with no matching rule', () => {
  it('earns 0 with a warning instead of throwing', () => {
    const [r] = run({ purchase: { amountPence: 4000, category: 'flights' }, userCards: [{ cardId: 'supermarket-only' }] });
    expect(r).toMatchObject({ cardId: 'supermarket-only', ruleId: null, rewardUnits: 0, valuePence: 0, capped: false });
    expect(r.warnings).toContain('No reward rule on this card matches this purchase, so it earns nothing.');
  });

  it('does not stop the other cards being ranked', () => {
    const results = run({
      purchase: { amountPence: 4000, category: 'flights' },
      userCards: [{ cardId: 'supermarket-only' }, { cardId: 'revolut-metal' }],
    });
    expect(results.map((r) => r.cardId)).toEqual(['revolut-metal', 'supermarket-only']);
  });

  it('still uses its rule when the purchase does match', () => {
    const [r] = run({ purchase: { amountPence: 4000, shopId: 'tesco' }, userCards: [{ cardId: 'supermarket-only' }] });
    expect(r).toMatchObject({ ruleId: 'supermarket-only-supermarket', valuePence: 40 });
  });
});

describe('a guessed category', () => {
  it('is used when the shop is unknown, with a warning on cards whose reward depends on it', () => {
    const results = run({
      purchase: { amountPence: 4000, category: 'supermarket', categoryIsGuess: true },
      userCards: [{ cardId: 'natwest-reward-credit' }, { cardId: 'revolut-metal' }],
    });
    const natwest = results.find((r) => r.cardId === 'natwest-reward-credit')!;
    const revolut = results.find((r) => r.cardId === 'revolut-metal')!;

    expect(natwest).toMatchObject({ ruleId: 'natwest-credit-supermarket', valuePence: 40 });
    expect(natwest.warnings).toContain(
      'This assumes the purchase counts as "supermarket". If the card issuer classes it differently, this card would earn 10p instead.',
    );
    // Revolut earns the same everywhere, so the guess can't change its reward: no warning.
    expect(revolut.warnings).toEqual([]);
  });

  it('never overrides the category of a known shop', () => {
    const [natwest] = run({
      purchase: { amountPence: 4000, shopId: 'tesco', category: 'other', categoryIsGuess: true },
      userCards: [{ cardId: 'natwest-reward-credit' }],
    });
    expect(natwest).toMatchObject({ ruleId: 'natwest-credit-supermarket', valuePence: 40 });
    expect(natwest.warnings).toEqual([]);
  });

  it('a category the user chose (not a guess) still overrides the shop', () => {
    const [natwest] = run({
      purchase: { amountPence: 4000, shopId: 'tesco', category: 'fuel' },
      userCards: [{ cardId: 'natwest-reward-credit' }],
    });
    expect(natwest).toMatchObject({ ruleId: 'natwest-credit-everywhere', valuePence: 10 });
  });

  it('no shop and no category falls back to "other" (the everywhere-else rate)', () => {
    const [natwest] = run({ purchase: { amountPence: 4000 }, userCards: [{ cardId: 'natwest-reward-credit' }] });
    expect(natwest).toMatchObject({ ruleId: 'natwest-credit-everywhere', valuePence: 10 });
  });
});

describe('circular conversions', () => {
  // The mini catalogue with RevPoints <-> Avios transfers that loop and gain value each lap. 
  const loopingCatalogue: Catalogue = {
    ...miniCatalogue,
    currencies: miniCatalogue.currencies.map((c) => {
      const t = c.transferPartners?.[0]?.verification ?? c.verification;
      if (c.id === 'revpoints') return { ...c, transferPartners: [{ toCurrencyId: 'avios', fromUnits: 1, toUnits: 2, verification: t }] };
      if (c.id === 'avios') return { ...c, transferPartners: [{ toCurrencyId: 'revpoints', fromUnits: 1, toUnits: 1, verification: t }] };
      return c;
    }),
  };
  const purchase = { amountPence: 4000, shopId: 'tesco' }; // Revolut Metal: 20 RevPoints

  it('follows one transfer only, so a loop cannot multiply the value', () => {
    const [r] = run({
      catalogue: loopingCatalogue,
      purchase,
      userCards: [{ cardId: 'revolut-metal' }],
      preferences: { goal: { kind: 'collect_currency', targetCurrencyId: 'avios' }, pencePerUnitOverrides: {} },
    });
    // 20 RevPoints -> 40 Avios x 1p = 40p. Not 80p, 160p, ... from going round the loop.
    expect(r.valuePence).toBe(40);
  });

  it('collecting the currency you already earn ignores the loop back to it', () => {
    const [r] = run({
      catalogue: loopingCatalogue,
      purchase,
      userCards: [{ cardId: 'revolut-metal' }],
      preferences: { goal: { kind: 'collect_currency', targetCurrencyId: 'revpoints', boostPercent: 10 }, pencePerUnitOverrides: {} },
    });
    // 20 RevPoints x 1p x 1.1 = 22p. It must not convert out to Avios and back.
    expect(r.valuePence).toBe(22);
  });
});
