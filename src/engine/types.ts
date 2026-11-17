/**
 * Core data types for the Smart Card Optimizer engine.
 *
 * Conventions:
 * - Money is always an integer number of PENCE (e.g. £24 = 2400) to avoid float errors.
 * - Percentages are plain percent numbers (e.g. 0.25 means 0.25%, not 25%).
 * - Dates are ISO strings: "YYYY-MM-DD".
 * - IDs are lowercase kebab-case strings (e.g. "natwest-reward-credit").
 *
 * These types describe the catalogue data files (cards, currencies, shops) and the
 * user's goal. They contain no logic.
 */

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Integer number of pence. */
export type Pence = number;

/** ISO date string, "YYYY-MM-DD". */
export type IsoDate = string;

/**
 * How sure we are that a value matches the issuer's current terms.
 * - "confirmed": checked on the issuer's own page.
 * - "third_party": only found in reviews/blogs; must be re-checked.
 * - "unverified": assumption or placeholder.
 */
export type VerificationStatus = 'confirmed' | 'third_party' | 'unverified';

/** Where a value came from and when it was last checked (used by the weekly terms check). */
export interface Verification {
  status: VerificationStatus;
  sourceUrls: string[];
  lastVerified: IsoDate;
  notes?: string;
}

/**
 * Spending categories. Issuers decide these from the merchant category code (MCC),
 * so each category maps to a group of MCCs in the catalogue.
 *
 * "supermarket" and "supermarket_petrol" are separate because NatWest pays
 * 1% at supermarkets but only 0.25% at supermarket petrol stations.
 */
export const CATEGORIES = [
  'supermarket',
  'supermarket_petrol',
  'fuel',
  'public_transport',
  'taxi_rideshare',
  'flights',
  'hotels',
  'travel_other',
  'online_shopping',
  'dining',
  'entertainment',
  'bills_utilities',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Currencies (what a reward is paid in)
// ---------------------------------------------------------------------------

/**
 * - "cash": already money (NatWest Rewards, Amex Cashback). Value is fixed.
 * - "points": a loyalty currency with no fixed cash value (RevPoints, Amex Membership Rewards).
 * - "miles": an airline/hotel currency (Avios). Value depends on how it's redeemed.
 */
export type CurrencyKind = 'cash' | 'points' | 'miles';

/** A way to convert one currency into another, e.g. 1 RevPoint -> 1 Avios. */
export interface TransferPartner {
  toCurrencyId: string;
  /** Units of THIS currency given up. */
  fromUnits: number;
  /** Units of the partner currency received. */
  toUnits: number;
  verification: Verification;
}

export interface RewardCurrency {
  id: string;
  name: string;
  kind: CurrencyKind;
  /**
   * Default estimated value of ONE unit, in pence. Fractions allowed (e.g. 1.0 = 1p per point).
   * Cash currencies always use £1 as one unit, so this is 100 (NatWest Rewards, Amex Cashback).
   */
  defaultPencePerUnit: number;
  /** True if the user may override the value (points/miles). Cash is never adjustable. */
  userAdjustable: boolean;
  transferPartners?: TransferPartner[];
  /** Minimum balance before it can be redeemed, in units (NatWest: £5 -> 5). */
  minimumRedemptionUnits?: number;
  verification: Verification;
}

// ---------------------------------------------------------------------------
// Earn rates and rules (how a card earns on a purchase)
// ---------------------------------------------------------------------------

/** Earn a percentage of the amount spent, paid in the card's currency (cash cards). */
export interface PercentEarn {
  type: 'percent';
  /** e.g. 1 = 1%, 0.25 = 0.25%. */
  percent: number;
}

/** Earn N units for every £X spent (points cards), e.g. Revolut Standard: 1 point per £10. */
export interface PerPoundEarn {
  type: 'per_pound';
  units: number;
  /** Spend in whole pounds needed to earn `units`. */
  perPounds: number;
  /**
   * - "exact": proportional (spend £15 at 1 per £10 -> 1.5 points).
   * - "floor": only complete blocks count (spend £15 -> 1 point).
   */
  rounding: 'exact' | 'floor';
}

export type EarnRate = PercentEarn | PerPoundEarn;

/** Earn rate that changes with total spend in the period (Amex Cashback: 0.5% to £10k, then 1%). */
export interface SpendTier {
  /** Upper bound of this tier in pence within the period; omit for "and above". */
  upToPence?: Pence;
  earn: EarnRate;
}

export type CapPeriod = 'transaction' | 'month' | 'cardmember_year' | 'calendar_year' | 'offer_lifetime';

/** Maximum reward that can be earned under a rule. */
export interface RewardCap {
  /**
   * Cap in the card currency's units. Cash currencies use £1 as one unit,
   * so Amex's £200 intro cap -> 200. For points, it's a number of points.
   */
  maxUnits: number;
  period: CapPeriod;
}

/** Which purchases a rule applies to. All provided fields must match (AND). Omitted = any. */
export interface RuleMatch {
  categories?: Category[];
  /** Specific shops (e.g. "amex-travel" for Amex Travel bookings). */
  shopIds?: string[];
  excludeCategories?: Category[];
  /** true = only foreign-currency spend, false = only GBP spend, omitted = either. */
  foreignCurrency?: boolean;
}

/** Only active for a limited time after opening the card (intro offers). */
export interface IntroWindow {
  /** Months from the date the user got the card. */
  monthsFromCardOpen: number;
}

export interface RewardRule {
  id: string;
  description: string;
  match: RuleMatch;
  /** Use `earn` for a flat rate, or `tiers` when the rate depends on period spend. */
  earn?: EarnRate;
  tiers?: SpendTier[];
  /** Period over which `tiers` are counted. Required when `tiers` is set. */
  tierPeriod?: 'cardmember_year' | 'calendar_year' | 'month';
  cap?: RewardCap;
  introWindow?: IntroWindow;
  /** Rule is only valid between these dates (e.g. a limited-time promo). */
  validFrom?: IsoDate;
  validUntil?: IsoDate;
  /**
   * When several rules match, the one with the HIGHEST priority wins (rules do not stack).
   * Convention: default "everywhere else" rule = 0, category rules = 10, shop rules = 20, intro = 30.
   */
  priority: number;
  verification: Verification;
}

/** A condition that must be met in the period, or the card earns nothing for that period. */
export interface MinimumSpendRequirement {
  /** Amex Cashback: £3,000 in the cardmember year -> 300000. */
  minSpendPence: Pence;
  period: 'cardmember_year' | 'calendar_year' | 'month';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type CardIssuer = 'natwest' | 'revolut' | 'amex';
export type CardNetwork = 'visa' | 'mastercard' | 'amex';
export type CardType = 'credit' | 'debit';

export interface CardFees {
  annualFeePence: Pence;
  monthlyFeePence: Pence;
  /** e.g. "First year free" or "Refunded if you hold a NatWest Reward current account". */
  feeNotes?: string;
}

export interface Card {
  id: string;
  issuer: CardIssuer;
  /** Product name as the issuer writes it, e.g. "Reward Credit Card". */
  name: string;
  /** For cards with plans (Revolut): "standard" | "plus" | "premium" | "metal" | "ultra". */
  plan?: string;
  network: CardNetwork;
  type: CardType;
  /** The currency every rule on this card earns in. */
  currencyId: string;
  fees: CardFees;
  /** Representative APR for credit cards, as a percent (e.g. 31.0). */
  representativeAprPercent?: number;
  rules: RewardRule[];
  minimumSpend?: MinimumSpendRequirement;
  /** Charged on foreign-currency spend, as a percent (0 if none). Reduces the net value abroad. */
  foreignTransactionFeePercent: number;
  verification: Verification;
}

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------

/** Whether a shop takes a card network. "unknown" lets the app warn and suggest a fallback. */
export type Acceptance = 'yes' | 'no' | 'unknown';

/**
 * A time-limited retailer offer attached to a shop, e.g. a NatWest MyRewards partner offer.
 * These change often (MyRewards: every two weeks), so they carry their own dates.
 */
export interface ShopOffer {
  id: string;
  /** Cards that get this offer (e.g. both NatWest Reward credit and debit). */
  cardIds: string[];
  earn: EarnRate;
  /** true = paid on top of the card's normal rule; false = replaces it. */
  stacksWithBaseRule: boolean;
  cap?: RewardCap;
  validFrom: IsoDate;
  validUntil: IsoDate;
  verification: Verification;
}

export interface Shop {
  id: string;
  name: string;
  /** Other names the user might type, e.g. ["sainsburys", "sainsbury's local"]. */
  aliases: string[];
  /** The category the issuer will most likely see (based on the shop's MCC). */
  category: Category;
  /** Merchant category code, if known (e.g. 5411 = supermarkets). */
  mcc?: number;
  acceptance: Record<CardNetwork, Acceptance>;
  offers?: ShopOffer[];
}

// ---------------------------------------------------------------------------
// Goals (what the user wants their rewards for)
// ---------------------------------------------------------------------------

/**
 * - "max_value": pick the card with the highest estimated £ value, cash or points.
 * - "cash_only": only count cash rewards; points/miles are valued at 0.
 * - "collect_currency": favour one currency (e.g. Avios for flights), using `boostPercent`.
 */
export type GoalKind = 'max_value' | 'cash_only' | 'collect_currency';

export interface Goal {
  kind: GoalKind;
  /** Required for "collect_currency": the currency the user is saving for (e.g. "avios"). */
  targetCurrencyId?: string;
  /**
   * For "collect_currency": how much extra the user values the target currency, as a percent.
   * e.g. 20 = treat it as worth 20% more than its normal estimate.
   */
  boostPercent?: number;
}

/** The user's own settings that change how rewards are valued. */
export interface UserPreferences {
  goal: Goal;
  /** Override the default pence-per-unit for points/miles currencies, keyed by currency id. */
  pencePerUnitOverrides: Record<string, number>;
}

/** A card the user actually holds, plus the facts needed for tiers, caps and intro offers. */
export interface UserCard {
  cardId: string;
  /** Date the user got the card; needed for intro offers and cardmember years. */
  openedOn?: IsoDate;
  /** Spend so far in the current period, used for tiers and minimum-spend checks. */
  spendThisPeriodPence?: Pence;
  /** Reward already earned under capped rules (in currency units), keyed by rule id. */
  rewardEarnedByRuleUnits?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Catalogue (everything loaded from catalogue/ data files)
// ---------------------------------------------------------------------------

export interface Catalogue {
  /** Version/date of the built catalogue, set by the build script. */
  builtOn: IsoDate;
  currencies: RewardCurrency[];
  cards: Card[];
  shops: Shop[];
}
