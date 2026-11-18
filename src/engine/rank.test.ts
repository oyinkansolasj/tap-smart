import { describe, expect, it } from 'vitest';
import { miniCatalogue } from './__fixtures__/mini-catalogue.ts';
import { rank, type RankInput } from './rank.ts';
import type { UserPreferences } from './types.ts';

const maxValue: UserPreferences = { goal: { kind: 'max_value' }, pencePerUnitOverrides: {} };

//rank() with the mini catalogue and "max value" unless a test says otherwise. 
const run = (input: Omit<RankInput, 'catalogue' | 'preferences'> & Partial<Pick<RankInput, 'preferences'>>) =>
  rank({ catalogue: miniCatalogue, preferences: maxValue, ...input });

describe('rank', () => {
  it('£40 at Tesco: NatWest credit (1% supermarket) beats Revolut Metal (points) and NatWest debit (0%)', () => {
    const results = run({
      purchase: { amountPence: 4000, shopId: 'tesco' },
      userCards: [
        { cardId: 'natwest-reward-debit' },
        { cardId: 'revolut-metal' },
        { cardId: 'natwest-reward-credit' },
      ],
    });

    // Best card first, regardless of the order the user's cards were given in.
    expect(results.map((r) => r.cardId)).toEqual([
      'natwest-reward-credit',
      'revolut-metal',
      'natwest-reward-debit',
    ]);

    // NatWest credit: Tesco is a supermarket -> 1% of £40 = 40p, paid as cash.
    expect(results[0]).toMatchObject({
      cardId: 'natwest-reward-credit',
      ruleId: 'natwest-credit-supermarket',
      currencyId: 'natwest-rewards',
      valuePence: 40,
      isCash: true,
    });
    expect(results[0].rewardUnits).toBeCloseTo(0.4); // £0.40 in NatWest Rewards

    // Revolut Metal: 1 RevPoint per £2 -> 20 points, worth 20p at the default 1p per point.
    expect(results[1]).toMatchObject({
      cardId: 'revolut-metal',
      ruleId: 'revolut-metal-everywhere',
      currencyId: 'revpoints',
      rewardUnits: 20,
      valuePence: 20,
      isCash: false,
    });

    // NatWest debit: no reward on everyday spending.
    expect(results[2]).toMatchObject({
      cardId: 'natwest-reward-debit',
      ruleId: 'natwest-debit-everywhere',
      valuePence: 0,
    });
  });

  describe('picking the rule', () => {
    it('uses the "everywhere else" rule when no category rule matches', () => {
      const [natwest] = run({
        purchase: { amountPence: 4000, category: 'online_shopping' },
        userCards: [{ cardId: 'natwest-reward-credit' }],
      });
      expect(natwest).toMatchObject({ ruleId: 'natwest-credit-everywhere', valuePence: 10 }); // 0.25% of £40
    });

    it('prefers a shop rule over a category rule with the same priority', () => {
      const [gold] = run({
        purchase: { amountPence: 10000, shopId: 'amex-travel' }, // Amex Travel is also in "flights"
        userCards: [{ cardId: 'amex-gold' }],
      });
      expect(gold).toMatchObject({ ruleId: 'amex-gold-amex-travel', rewardUnits: 300, valuePence: 300 });
    });

    it('only counts complete £ blocks when rounding is "floor"', () => {
      const [revolut] = run({
        purchase: { amountPence: 4199, category: 'other' }, // £41.99 -> 20 full £2 blocks
        userCards: [{ cardId: 'revolut-metal' }],
      });
      expect(revolut.rewardUnits).toBe(20);
    });

    it('skips an intro offer when the card opening date is unknown', () => {
      const [amex] = run({
        purchase: { amountPence: 10000, category: 'other', date: '2026-11-17' },
        userCards: [{ cardId: 'amex-cashback', spendThisPeriodPence: 500000 }],
      });
      expect(amex).toMatchObject({ ruleId: 'amex-cashback-everywhere', valuePence: 50 });
    });

    it('ends the intro offer after its window', () => {
      const [amex] = run({
        purchase: { amountPence: 10000, category: 'other', date: '2026-11-17' },
        userCards: [{ cardId: 'amex-cashback', openedOn: '2025-11-01', spendThisPeriodPence: 500000 }],
      });
      expect(amex.ruleId).toBe('amex-cashback-everywhere');
    });
  });

  describe('caps and tiers', () => {
    it('when the intro cap runs out part-way, the rest of the spend earns the normal rate', () => {
      const [amex] = run({
        purchase: { amountPence: 10000, category: 'other', date: '2026-11-17' },
        userCards: [
          {
            cardId: 'amex-cashback',
            openedOn: '2026-06-01',
            spendThisPeriodPence: 500000,
            rewardEarnedByRuleUnits: { 'amex-cashback-intro': 199.5 },
          },
        ],
      });
      expect(amex).toMatchObject({ ruleId: 'amex-cashback-intro', capped: true, valuePence: 87.5 });
    });

    it('skips a rule whose cap is fully used', () => {
      const [amex] = run({
        purchase: { amountPence: 10000, category: 'other', date: '2026-11-17' },
        userCards: [
          {
            cardId: 'amex-cashback',
            openedOn: '2026-06-01',
            spendThisPeriodPence: 500000,
            rewardEarnedByRuleUnits: { 'amex-cashback-intro': 200 },
          },
        ],
      });
      expect(amex).toMatchObject({ ruleId: 'amex-cashback-everywhere', capped: false, valuePence: 50 });
    });

    it('splits a purchase across spend tiers', () => {
      // £9,990 spent so far: the first £10 of this £20 earns 0.5% (5p), the next £10 earns 1% (10p).
      const [amex] = run({
        purchase: { amountPence: 2000, category: 'other' },
        userCards: [{ cardId: 'amex-cashback', spendThisPeriodPence: 999000 }],
      });
      expect(amex.valuePence).toBe(15);
    });

    it('warns when the minimum annual spend has not been reached', () => {
      const [amex] = run({
        purchase: { amountPence: 2000, category: 'other' },
        userCards: [{ cardId: 'amex-cashback', spendThisPeriodPence: 0 }],
      });
      expect(amex.warnings).toContain('Only paid if you spend £3,000 in the cardmember year.');
    });
  });

  describe('valuing for the goal', () => {
    const cards = [{ cardId: 'revolut-metal' }, { cardId: 'natwest-reward-credit' }];
    const purchase = { amountPence: 4000, shopId: 'tesco' };

    it('cash_only: points are worth nothing', () => {
      const results = run({ purchase, userCards: cards, preferences: { goal: { kind: 'cash_only' }, pencePerUnitOverrides: {} } });
      expect(results.find((r) => r.cardId === 'revolut-metal')?.valuePence).toBe(0);
      expect(results.find((r) => r.cardId === 'natwest-reward-credit')?.valuePence).toBe(40);
    });

    it('uses the user’s own value per point', () => {
      const results = run({ purchase, userCards: cards, preferences: { goal: { kind: 'max_value' }, pencePerUnitOverrides: { revpoints: 2.5 } } });
      // 20 RevPoints x 2.5p = 50p, which now beats NatWest's 40p.
      expect(results[0]).toMatchObject({ cardId: 'revolut-metal', valuePence: 50 });
    });

    it('ignores a value override on a cash currency', () => {
      const results = run({ purchase, userCards: cards, preferences: { goal: { kind: 'max_value' }, pencePerUnitOverrides: { 'natwest-rewards': 500 } } });
      expect(results.find((r) => r.cardId === 'natwest-reward-credit')?.valuePence).toBe(40);
    });

    it('collect_currency: boosts points that transfer into the target currency', () => {
      const results = run({
        purchase,
        userCards: cards,
        preferences: { goal: { kind: 'collect_currency', targetCurrencyId: 'avios', boostPercent: 50 }, pencePerUnitOverrides: {} },
      });
      // 20 RevPoints -> 20 Avios x 1p x 1.5 = 30p. NatWest cash isn't boosted (still 40p).
      expect(results.find((r) => r.cardId === 'revolut-metal')?.valuePence).toBe(30);
      expect(results.find((r) => r.cardId === 'natwest-reward-credit')?.valuePence).toBe(40);
    });
  });

  describe('fees and acceptance', () => {
    it('subtracts the foreign transaction fee from the value', () => {
      const results = run({
        purchase: { amountPence: 10000, category: 'other', foreignCurrency: true },
        userCards: [{ cardId: 'amex-cashback', spendThisPeriodPence: 500000 }, { cardId: 'revolut-metal' }],
      });
      // Amex: 50p cashback - £2.99 fee = -249p. Revolut: 50 points = 50p, no fee.
      expect(results.map((r) => r.cardId)).toEqual(['revolut-metal', 'amex-cashback']);
      expect(results[1]).toMatchObject({ rewardValuePence: 50, feePence: 299, valuePence: -249 });
    });

    it('puts a card the shop does not accept last, with a warning', () => {
      const results = run({
        purchase: { amountPence: 4000, shopId: 'corner-shop', date: '2026-11-17' },
        // Amex's 2% intro (80p) would win, but the shop doesn't take Amex.
        userCards: [{ cardId: 'amex-cashback', openedOn: '2026-06-01', spendThisPeriodPence: 500000 }, { cardId: 'natwest-reward-credit' }],
      });
      expect(results.map((r) => r.cardId)).toEqual(['natwest-reward-credit', 'amex-cashback']);
      expect(results[1]).toMatchObject({ acceptance: 'no', valuePence: 80 });
      expect(results[1].warnings).toContain('Corner Shop does not accept amex cards.');
    });

    it('prefers cash over points when the value is equal', () => {
      const results = run({
        purchase: { amountPence: 4000, shopId: 'tesco' },
        userCards: [{ cardId: 'revolut-metal' }, { cardId: 'natwest-reward-credit' }],
        preferences: { goal: { kind: 'max_value' }, pencePerUnitOverrides: { revpoints: 2 } }, // both 40p
      });
      expect(results.map((r) => r.cardId)).toEqual(['natwest-reward-credit', 'revolut-metal']);
    });
  });

  describe('bad input', () => {
    it('throws for an unknown card or shop', () => {
      expect(() => run({ purchase: { amountPence: 100 }, userCards: [{ cardId: 'nope' }] })).toThrow('unknown card "nope"');
      expect(() => run({ purchase: { amountPence: 100, shopId: 'nope' }, userCards: [] })).toThrow('unknown shop "nope"');
    });

    it('throws for a negative amount', () => {
      expect(() => run({ purchase: { amountPence: -1 }, userCards: [] })).toThrow('amountPence');
    });
  });
});
