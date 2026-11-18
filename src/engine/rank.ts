/** rank(): given a purchase and the user's cards, return every card's reward, best first.

For each card:
 1. Pick the most specific rule that matches the purchase (highest priority, then most specific match).
 2. Apply caps. If a rule's cap runs out part-way, the rest of the spend falls to the next matching rule.
 3. Add any shop offers (e.g. NatWest MyRewards).
 4. Value the reward in pence for the user's goal, then subtract any foreign transaction fee. Then sort: cards the shop doesn't accept go last, otherwise highest value first.
Annual/monthly fees are not included: they're paid whatever the user buys, so they don't change which card is best for a single purchase. **/

import type {
  Card,
  Catalogue,
  Category,
  EarnRate,
  IsoDate,
  Pence,
  Purchase,
  RankedCard,
  RewardCurrency,
  RewardRule,
  RuleMatch,
  Shop,
  SpendTier,
  UserCard,
  UserPreferences,
} from './types.ts';

export interface RankInput {
  catalogue: Catalogue;
  purchase: Purchase;
  userCards: UserCard[];
  preferences: UserPreferences;
}

interface PurchaseContext {
  amountPence: Pence;
  category: Category;
  // True only if a guessed category is actually being used (i.e. there's no known shop).
  categoryIsGuess: boolean;
  shop?: Shop;
  foreign: boolean;
  date: IsoDate;
}

export function rank({ catalogue, purchase, userCards, preferences }: RankInput): RankedCard[] {
  if (!Number.isFinite(purchase.amountPence) || purchase.amountPence < 0) {
    throw new Error(`rank: amountPence must be 0 or more, got ${purchase.amountPence}`);
  }
  const shop = purchase.shopId ? findById(catalogue.shops, purchase.shopId, 'shop') : undefined;
  // A known shop's category comes from catalogue data, so a guess never replaces it.
  const useGuess = purchase.categoryIsGuess === true && !shop;
  const ctx: PurchaseContext = {
    amountPence: purchase.amountPence,
    category: (purchase.categoryIsGuess && shop ? shop.category : purchase.category) ?? shop?.category ?? 'other',
    categoryIsGuess: useGuess && purchase.category !== undefined,
    shop,
    foreign: purchase.foreignCurrency ?? false,
    date: purchase.date ?? new Date().toISOString().slice(0, 10),
  };

  return userCards
    .map((userCard) => rankCard(catalogue, ctx, userCard, preferences))
    .sort(compareResults);
}

// One card

function rankCard(catalogue: Catalogue, ctx: PurchaseContext, userCard: UserCard, prefs: UserPreferences): RankedCard {
  const card = findById(catalogue.cards, userCard.cardId, 'card');
  const currency = findById(catalogue.currencies, card.currencyId, 'currency');
  const warnings: string[] = [];

  // 1 + 2: rules, most specific first, with caps spilling over to the next rule.
  const candidates = card.rules
    .filter((r) => ruleApplies(r, ctx, userCard))
    .sort((a, b) => b.priority - a.priority || specificity(b.match) - specificity(a.match));

  let units = 0;
  let spendLeft = ctx.amountPence;
  let ruleId: string | undefined;
  let capped = false;

  for (const rule of candidates) {
    if (spendLeft <= 0) break;
    const capLeft = capRemaining(rule.cap, rule.id, userCard);
    if (capLeft <= 0) continue; // this rule's cap is used up; try the next one

    const spentSoFar = ctx.amountPence - spendLeft;
    const earned = ruleUnits(rule, spendLeft, (userCard.spendThisPeriodPence ?? 0) + spentSoFar, currency);
    ruleId ??= rule.id;

    if (earned <= capLeft) {
      units += earned;
      spendLeft = 0;
    } else {
      // Cap reached part-way: take what's left of the cap, pass the uncovered spend on.
      units += capLeft;
      spendLeft -= spendLeft * (capLeft / earned);
      capped = true;
    }
  }

  // Nothing earned: either every matching rule's cap is used up, or no rule matches at all.
  // This card earns 0, but the other cards must still be ranked, so don't throw.
  if (ruleId === undefined) {
    if (candidates.length > 0) {
      ruleId = candidates[0].id;
      capped = true;
      warnings.push('The reward cap on this card has been reached, so this purchase earns nothing.');
    } else {
      warnings.push('No reward rule on this card matches this purchase, so it earns nothing.');
    }
  }

  // 3: shop offers for this card.
  const offerIds: string[] = [];
  for (const offer of ctx.shop?.offers ?? []) {
    if (!offer.cardIds.includes(card.id) || ctx.date < offer.validFrom || ctx.date > offer.validUntil) continue;
    const capLeft = capRemaining(offer.cap, offer.id, userCard);
    if (capLeft <= 0) continue;
    let offerUnits = earnUnits(offer.earn, ctx.amountPence, currency);
    if (offerUnits > capLeft) {
      offerUnits = capLeft;
      capped = true;
    }
    units = offer.stacksWithBaseRule ? units + offerUnits : offerUnits;
    offerIds.push(offer.id);
  }

  // 4: value for the goal, minus foreign fees.
  const rewardValuePence = valueForGoal(units, currency, catalogue, prefs);
  const feePence = ctx.foreign ? (ctx.amountPence * card.foreignTransactionFeePercent) / 100 : 0;

  const acceptance = ctx.shop?.acceptance[card.network] ?? 'unknown';
  if (ctx.shop && acceptance === 'no') warnings.push(`${ctx.shop.name} does not accept ${card.network} cards.`);
  if (ctx.shop && acceptance === 'unknown') warnings.push(`${ctx.shop.name} may not accept ${card.network} cards.`);
  addMinimumSpendWarning(card, ctx, userCard, warnings);

  const valuePence = round(rewardValuePence - feePence);

  // If the category was guessed, say what this card would earn if the issuer sees it as "other".
  if (ctx.categoryIsGuess && ctx.category !== 'other') {
    const fallback = rankCard(catalogue, { ...ctx, category: 'other', categoryIsGuess: false }, userCard, prefs);
    if (fallback.valuePence !== valuePence) {
      warnings.push(
        `This assumes the purchase counts as "${ctx.category}". If the card issuer classes it differently, this card would earn ${formatValue(fallback.valuePence)} instead.`,
      );
    }
  }

  return {
    cardId: card.id,
    ruleId: ruleId ?? null,
    currencyId: currency.id,
    rewardUnits: round(units),
    isCash: currency.kind === 'cash',
    rewardValuePence: round(rewardValuePence),
    feePence: round(feePence),
    valuePence,
    offerIds,
    capped,
    acceptance,
    warnings,
  };
}

// Rule matching

function ruleApplies(rule: RewardRule, ctx: PurchaseContext, userCard: UserCard): boolean {
  const m = rule.match;
  if (m.categories && !m.categories.includes(ctx.category)) return false;
  if (m.excludeCategories?.includes(ctx.category)) return false;
  if (m.shopIds && !(ctx.shop && m.shopIds.includes(ctx.shop.id))) return false;
  if (m.foreignCurrency !== undefined && m.foreignCurrency !== ctx.foreign) return false;
  if (rule.validFrom && ctx.date < rule.validFrom) return false;
  if (rule.validUntil && ctx.date > rule.validUntil) return false;
  if (rule.introWindow) {
    // Without an opening date we can't tell if the intro offer still applies, so don't assume it does.
    if (!userCard.openedOn) return false;
    if (ctx.date >= addMonths(userCard.openedOn, rule.introWindow.monthsFromCardOpen)) return false;
  }
  return true;
}

//Tie-breaker when two rules share a priority: a shop beats a category beats a currency condition.
function specificity(m: RuleMatch): number {
  return (m.shopIds ? 4 : 0) + (m.categories ? 2 : 0) + (m.foreignCurrency !== undefined ? 1 : 0) + (m.excludeCategories ? 1 : 0);
}

// Earning

//Units earned under a rule. `periodSpendBefore` is spend already counted this period (for tiers). 
function ruleUnits(rule: RewardRule, spendPence: Pence, periodSpendBefore: Pence, currency: RewardCurrency): number {
  if (rule.tiers) return tieredUnits(rule.tiers, spendPence, periodSpendBefore, currency);
  if (rule.earn) return earnUnits(rule.earn, spendPence, currency);
  throw new Error(`rank: rule "${rule.id}" has neither "earn" nor "tiers"`);
}

/**
 * Units for a flat earn rate.
 * - percent: that % of the spend as a £ value, converted into the currency's units (cash: £1 = 1 unit).
 * - per_pound: `units` for every `perPounds` spent, optionally only counting complete blocks.
 */
function earnUnits(earn: EarnRate, spendPence: Pence, currency: RewardCurrency): number {
  if (earn.type === 'percent') {
    return (spendPence * earn.percent) / 100 / currency.defaultPencePerUnit;
  }
  const blocks = spendPence / 100 / earn.perPounds;
  // The small epsilon stops float noise (e.g. 2.9999999) from losing a whole block.
  const counted = earn.rounding === 'floor' ? Math.floor(blocks + 1e-9) : blocks;
  return counted * earn.units;
}

//Splits the spend across tiers, starting from where the user already is in the period. 
function tieredUnits(tiers: SpendTier[], spendPence: Pence, periodSpendBefore: Pence, currency: RewardCurrency): number {
  let units = 0;
  let position = periodSpendBefore;
  let left = spendPence;
  for (const tier of tiers) {
    if (left <= 0) break;
    const upper = tier.upToPence ?? Infinity;
    if (position >= upper) continue;
    const portion = Math.min(left, upper - position);
    units += earnUnits(tier.earn, portion, currency);
    position += portion;
    left -= portion;
  }
  return units;
}

// How many units can still be earned under a cap (Infinity if there's no cap). 
function capRemaining(cap: RewardRule['cap'], key: string, userCard: UserCard): number {
  if (!cap) return Infinity;
  const used = cap.period === 'transaction' ? 0 : (userCard.rewardEarnedByRuleUnits?.[key] ?? 0);
  const left = cap.maxUnits - used;
  // Anything below a billionth of a unit is float noise (200 - 199.9999999999), not money left.
  return left > 1e-9 ? left : 0;
}

// Valuing

function pencePerUnit(currency: RewardCurrency, prefs: UserPreferences): number {
  if (!currency.userAdjustable) return currency.defaultPencePerUnit;
  return prefs.pencePerUnitOverrides[currency.id] ?? currency.defaultPencePerUnit;
}


function valueForGoal(units: number, currency: RewardCurrency, catalogue: Catalogue, prefs: UserPreferences): number {
  const base = units * pencePerUnit(currency, prefs);
  const goal = prefs.goal;

  if (goal.kind === 'cash_only') return currency.kind === 'cash' ? base : 0;

  if (goal.kind === 'collect_currency' && goal.targetCurrencyId) {
    const boost = 1 + (goal.boostPercent ?? 0) / 100;
    if (currency.id === goal.targetCurrencyId) return base * boost;

    const partner = currency.transferPartners?.find((t) => t.toCurrencyId === goal.targetCurrencyId);
    if (partner) {
      const target = findById(catalogue.currencies, partner.toCurrencyId, 'currency');
      const targetUnits = (units * partner.toUnits) / partner.fromUnits;
      // The user can keep the points or transfer them, so take whichever is worth more.
      return Math.max(base, targetUnits * pencePerUnit(target, prefs) * boost);
    }
  }
  return base;
}

// Helpers

function addMinimumSpendWarning(card: Card, ctx: PurchaseContext, userCard: UserCard, warnings: string[]): void {
  const min = card.minimumSpend;
  if (!min) return;
  const after = (userCard.spendThisPeriodPence ?? 0) + ctx.amountPence;
  if (after < min.minSpendPence) {
    const period = min.period === 'month' ? 'month' : min.period === 'calendar_year' ? 'calendar year' : 'cardmember year';
    warnings.push(`Only paid if you spend ${formatPounds(min.minSpendPence)} in the ${period}.`);
  }
}

// Most important first: accepted before not accepted, then value, then cash over points, then id.
function compareResults(a: RankedCard, b: RankedCard): number {
  return (
    Number(a.acceptance === 'no') - Number(b.acceptance === 'no') ||
    b.valuePence - a.valuePence ||
    Number(b.isCash) - Number(a.isCash) ||
    a.cardId.localeCompare(b.cardId)
  );
}

function findById<T extends { id: string }>(items: T[], id: string, kind: string): T {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`rank: unknown ${kind} "${id}"`);
  return found;
}

// Adds months to a "YYYY-MM-DD" date (UTC).
function addMonths(date: IsoDate, months: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Removes float noise (0.4 * 100 = 40.00000000000001) without losing real precision.
// Cash currencies count in £, so 4 decimal places would already cut 0.03125 (3.125p) to 0.0313.

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

// 10 -> "10p", 3.125 -> "3.13p", 250 -> "£2.50".
function formatValue(pence: number): string {
  if (Math.abs(pence) >= 100) return `£${(pence / 100).toFixed(2)}`;
  return `${Number(pence.toFixed(2))}p`;
}

// 300000 -> "£3,000", 1499 -> "£14.99".
export function formatPounds(pence: Pence): string {
  return `£${(pence / 100).toLocaleString('en-GB')}`;
}
