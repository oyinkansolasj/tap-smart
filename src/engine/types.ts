// Core data types for the Smart Card Optimizer engine

export type Pence = number;
export type IsoDate = string;
export type VerificationStatus = 'confirmed' | 'third_party' | 'unverified';
export interface Verification {
  status: VerificationStatus;
  sourceUrls: string[];
  lastVerified: IsoDate;
  notes?: string;
}
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

// Currencies (what a reward is paid in): cash (£), points (e.g. NatWest Rewards), or miles (e.g. Avios).
export type CurrencyKind = 'cash' | 'points' | 'miles';

// A way to convert one currency into another, e.g. 1 RevPoint -> 1 Avios. 
export interface TransferPartner {
  toCurrencyId: string;
  fromUnits: number;
  toUnits: number;
  verification: Verification;
}

export interface RewardCurrency {
  id: string;
  name: string;
  kind: CurrencyKind;
  defaultPencePerUnit: number;
  userAdjustable: boolean;
  transferPartners?: TransferPartner[];
  minimumRedemptionUnits?: number;
  verification: Verification;
}

// Earn rates and rules (how a card earns on a purchase)

// Earn a percentage of the amount spent, paid in the card's currency (cash cards).
export interface PercentEarn {
  type: 'percent';
  percent: number;
}

// Earn N units for every £X spent (points cards), e.g. Revolut Standard: 1 point per £10.
export interface PerPoundEarn {
  type: 'per_pound';
  units: number;
  perPounds: number;
  rounding: 'exact' | 'floor';
}

export type EarnRate = PercentEarn | PerPoundEarn;
export interface SpendTier {
  upToPence?: Pence;
  earn: EarnRate;
}

export type CapPeriod = 'transaction' | 'month' | 'cardmember_year' | 'calendar_year' | 'offer_lifetime';

// Maximum reward that can be earned under a rule. 
export interface RewardCap {
  maxUnits: number;
  period: CapPeriod;
}

// Which purchases a rule applies to. All provided fields must match (AND). Omitted = any.
export interface RuleMatch {
  categories?: Category[];
  shopIds?: string[];
  excludeCategories?: Category[];
  foreignCurrency?: boolean;
}

// Only active for a limited time after opening the card (intro offers).
export interface IntroWindow {
  monthsFromCardOpen: number;
}

export interface RewardRule {
  id: string;
  description: string;
  match: RuleMatch;
  earn?: EarnRate;
  tiers?: SpendTier[];
  tierPeriod?: 'cardmember_year' | 'calendar_year' | 'month';
  cap?: RewardCap;
  introWindow?: IntroWindow;
  validFrom?: IsoDate;
  validUntil?: IsoDate;
  priority: number;
  verification: Verification;
}

// A condition that must be met in the period, or the card earns nothing for that period.
export interface MinimumSpendRequirement {
  minSpendPence: Pence;
  period: 'cardmember_year' | 'calendar_year' | 'month';
}

// Cards

export type CardIssuer = 'natwest' | 'revolut' | 'amex';
export type CardNetwork = 'visa' | 'mastercard' | 'amex';
export type CardType = 'credit' | 'debit';

export interface CardFees {
  annualFeePence: Pence;
  monthlyFeePence: Pence;
  feeNotes?: string;
}

export interface Card {
  id: string;
  issuer: CardIssuer;
  name: string;
  plan?: string;
  network: CardNetwork;
  type: CardType;
  currencyId: string;
  fees: CardFees;
  representativeAprPercent?: number;
  rules: RewardRule[];
  minimumSpend?: MinimumSpendRequirement;
  foreignTransactionFeePercent: number;
  verification: Verification;
}

// Shops

export type Acceptance = 'yes' | 'no' | 'unknown';
export interface ShopOffer {
  id: string;
  cardIds: string[];
  earn: EarnRate;
  stacksWithBaseRule: boolean;
  cap?: RewardCap;
  validFrom: IsoDate;
  validUntil: IsoDate;
  verification: Verification;
}

export interface Shop {
  id: string;
  name: string;
  aliases: string[];
  category: Category;
  mcc?: number;
  acceptance: Record<CardNetwork, Acceptance>;
  offers?: ShopOffer[];
}

// Goals (what the user wants their rewards for)

export type GoalKind = 'max_value' | 'cash_only' | 'collect_currency';

export interface Goal {
  kind: GoalKind;
  targetCurrencyId?: string;
  boostPercent?: number;
}

//  The user's own settings that change how rewards are valued. 
export interface UserPreferences {
  goal: Goal;
  pencePerUnitOverrides: Record<string, number>;
}

export interface UserCard {
  cardId: string;
  openedOn?: IsoDate;
  spendThisPeriodPence?: Pence;
  rewardEarnedByRuleUnits?: Record<string, number>;
}

// Catalogue (everything loaded from catalogue/ data files)

export interface Catalogue {
  builtOn: IsoDate;
  currencies: RewardCurrency[];
  cards: Card[];
  shops: Shop[];
}

// Ranking (input and output of rank())

// One purchase to rank the user's cards for. Give a shopId, a category, or both.
// A category the user chose wins over the shop's. A guessed one never does.
export interface Purchase {
  amountPence: Pence;
  shopId?: string;
  category?: Category;
  // True if the category was guessed (e.g. from an unknown shop name), not chosen by the user.
  categoryIsGuess?: boolean;
  foreignCurrency?: boolean;
  // Defaults to today. Used for intro offers and rule/offer dates.
  date?: IsoDate;
}

// One card's result for a purchase. rank() returns these best first.
export interface RankedCard {
  cardId: string;
  // The rule that earned the reward, or null if no rule on the card matches the purchase.
  ruleId: string | null;
  currencyId: string;
  // Reward in the card's own currency (£ for cash currencies, points/miles otherwise).
  rewardUnits: number;
  isCash: boolean;
  // Estimated £ value of the reward in pence, adjusted for the user's goal.
  rewardValuePence: number;
  // Foreign transaction fee for this purchase, in pence.
  feePence: number;
  // What the ranking sorts by: rewardValuePence - feePence.
  valuePence: number;
  // Shop offers that were applied.
  offerIds: string[];
  // True if a cap cut the reward short.
  capped: boolean;
  acceptance: Acceptance;
  // Things the user should know, e.g. a minimum annual spend.
  warnings: string[];
}
