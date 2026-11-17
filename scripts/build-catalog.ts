// Builds public/catalog.json from the data files in catalogue

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CATEGORIES } from '../src/engine/types.ts';
import type { Card, Catalogue, RewardCurrency, RewardRule, Shop, ShopOffer } from '../src/engine/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE_DIR = path.join(ROOT, 'catalogue');
const CARDS_DIR = path.join(CATALOGUE_DIR, 'cards');
const OUTPUT_FILE = path.join(ROOT, 'public', 'catalog.json');

// Terms checked longer ago than this produce a warning. 
const STALE_AFTER_DAYS = 30;

const today = new Date().toISOString().slice(0, 10);
const errors: string[] = [];
const warnings: string[] = [];

// Schemas: one per type in src/engine/types.ts.

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase kebab-case, e.g. "natwest-reward-credit"');
const pence = z.int().min(0);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like "2026-11-17"')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'is not a real date');
const category = z.enum(CATEGORIES);
const period = z.enum(['cardmember_year', 'calendar_year', 'month']);

const verification = z
  .strictObject({
    status: z.enum(['confirmed', 'third_party', 'unverified']),
    sourceUrls: z.array(z.url()),
    lastVerified: isoDate,
    notes: z.string().optional(),
  })
  .refine((v) => v.status === 'unverified' || v.sourceUrls.length > 0, {
    message: 'confirmed and third_party values need at least one source URL',
    path: ['sourceUrls'],
  });

const earn = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('percent'), percent: z.number().min(0).max(100) }),
  z.strictObject({
    type: z.literal('per_pound'),
    units: z.number().positive(),
    perPounds: z.number().positive(),
    rounding: z.enum(['exact', 'floor']),
  }),
]);

const cap = z.strictObject({
  maxUnits: z.number().positive(),
  period: z.enum(['transaction', 'month', 'cardmember_year', 'calendar_year', 'offer_lifetime']),
});

const rule = z
  .strictObject({
    id,
    description: z.string().min(1),
    match: z.strictObject({
      categories: z.array(category).min(1).optional(),
      shopIds: z.array(id).min(1).optional(),
      excludeCategories: z.array(category).min(1).optional(),
      foreignCurrency: z.boolean().optional(),
    }),
    earn: earn.optional(),
    tiers: z.array(z.strictObject({ upToPence: z.int().positive().optional(), earn })).min(2).optional(),
    tierPeriod: period.optional(),
    cap: cap.optional(),
    introWindow: z.strictObject({ monthsFromCardOpen: z.int().positive() }).optional(),
    validFrom: isoDate.optional(),
    validUntil: isoDate.optional(),
    priority: z.int().min(0),
    verification,
  })
  .superRefine((r, ctx) => {
    if ((r.earn === undefined) === (r.tiers === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'needs exactly one of "earn" or "tiers"' });
    }
    if (r.tiers && !r.tierPeriod) ctx.addIssue({ code: 'custom', message: '"tiers" needs a "tierPeriod"', path: ['tierPeriod'] });
    if (!r.tiers && r.tierPeriod) ctx.addIssue({ code: 'custom', message: '"tierPeriod" without "tiers"', path: ['tierPeriod'] });
    if (r.tiers) {
      r.tiers.forEach((t, i) => {
        const isLast = i === r.tiers!.length - 1;
        if (isLast && t.upToPence !== undefined) {
          ctx.addIssue({ code: 'custom', message: 'last tier must have no "upToPence" (it covers everything above)', path: ['tiers', i] });
        }
        if (!isLast && t.upToPence === undefined) {
          ctx.addIssue({ code: 'custom', message: 'only the last tier may omit "upToPence"', path: ['tiers', i] });
        }
        const prev = r.tiers![i - 1]?.upToPence;
        if (prev !== undefined && t.upToPence !== undefined && t.upToPence <= prev) {
          ctx.addIssue({ code: 'custom', message: 'tier limits must go up', path: ['tiers', i, 'upToPence'] });
        }
      });
    }
    if (r.validFrom && r.validUntil && r.validFrom > r.validUntil) {
      ctx.addIssue({ code: 'custom', message: '"validFrom" is after "validUntil"', path: ['validUntil'] });
    }
  }) satisfies z.ZodType<RewardRule>;

const card = z
  .strictObject({
    id,
    issuer: z.enum(['natwest', 'revolut', 'amex']),
    name: z.string().min(1),
    plan: z.string().min(1).optional(),
    network: z.enum(['visa', 'mastercard', 'amex']),
    type: z.enum(['credit', 'debit']),
    currencyId: id,
    fees: z.strictObject({ annualFeePence: pence, monthlyFeePence: pence, feeNotes: z.string().optional() }),
    representativeAprPercent: z.number().min(0).optional(),
    rules: z.array(rule).min(1),
    minimumSpend: z.strictObject({ minSpendPence: pence, period }).optional(),
    foreignTransactionFeePercent: z.number().min(0).max(100),
    verification,
  })
  .superRefine((c, ctx) => {
    const hasBase = c.rules.some(
      (r) => Object.keys(r.match).length === 0 && !r.introWindow && !r.validFrom && !r.validUntil,
    );
    if (!hasBase) {
      ctx.addIssue({ code: 'custom', message: 'needs a base rule with an empty "match" and no intro/date limits', path: ['rules'] });
    }
    if (c.type === 'credit' && c.representativeAprPercent === undefined) {
      warnings.push(`card "${c.id}": credit card has no representativeAprPercent`);
    }
  }) satisfies z.ZodType<Card>;

const currency = z
  .strictObject({
    id,
    name: z.string().min(1),
    kind: z.enum(['cash', 'points', 'miles']),
    defaultPencePerUnit: z.number().positive(),
    userAdjustable: z.boolean(),
    transferPartners: z
      .array(
        z.strictObject({
          toCurrencyId: id,
          fromUnits: z.number().positive(),
          toUnits: z.number().positive(),
          verification,
        }),
      )
      .optional(),
    minimumRedemptionUnits: z.number().positive().optional(),
    verification,
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'cash' && (c.defaultPencePerUnit !== 100 || c.userAdjustable)) {
      ctx.addIssue({ code: 'custom', message: 'cash currencies must use £1 per unit (100) and not be user-adjustable' });
    }
  }) satisfies z.ZodType<RewardCurrency>;

const acceptance = z.enum(['yes', 'no', 'unknown']);

const offer = z
  .strictObject({
    id,
    cardIds: z.array(id).min(1),
    earn,
    stacksWithBaseRule: z.boolean(),
    cap: cap.optional(),
    validFrom: isoDate,
    validUntil: isoDate,
    verification,
  })
  .refine((o) => o.validFrom <= o.validUntil, { message: '"validFrom" is after "validUntil"', path: ['validUntil'] }) satisfies z.ZodType<ShopOffer>;

const shop = z.strictObject({
  id,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  category,
  mcc: z.int().min(0).max(9999).optional(),
  acceptance: z.strictObject({ visa: acceptance, mastercard: acceptance, amex: acceptance }),
  offers: z.array(offer).optional(),
}) satisfies z.ZodType<Shop>;

// Loading

// Reads and validates one JSON file. Returns undefined (and records errors) if it's invalid.
async function load<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const rel = path.relative(ROOT, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    errors.push(`${rel}: not valid JSON (${(err as Error).message})`);
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length ? issue.path.join('.') : '(file)';
      errors.push(`${rel}: ${where}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

const currencies = (await load(path.join(CATALOGUE_DIR, 'currencies.json'), z.array(currency))) ?? [];
const shops = (await load(path.join(CATALOGUE_DIR, 'shops.json'), z.array(shop))) ?? [];

const cardFiles = (await readdir(CARDS_DIR)).filter((f) => f.endsWith('.json')).sort();
if (cardFiles.length === 0) errors.push('catalogue/cards: no card files found');

const cards: Card[] = [];
for (const file of cardFiles) {
  const c = await load(path.join(CARDS_DIR, file), card);
  if (!c) continue;
  if (file !== `${c.id}.json`) errors.push(`catalogue/cards/${file}: file name must match the card id ("${c.id}.json")`);
  cards.push(c);
}

// Cross-file checks (ids exist, nothing is duplicated)

function checkUnique(kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const i of ids) {
    if (seen.has(i)) errors.push(`duplicate ${kind} id "${i}"`);
    seen.add(i);
  }
}

checkUnique('currency', currencies.map((c) => c.id));
checkUnique('card', cards.map((c) => c.id));
checkUnique('shop', shops.map((s) => s.id));
checkUnique('rule', cards.flatMap((c) => c.rules.map((r) => r.id)));
checkUnique('offer', shops.flatMap((s) => (s.offers ?? []).map((o) => o.id)));

const currencyIds = new Set(currencies.map((c) => c.id));
const cardIds = new Set(cards.map((c) => c.id));
const shopIds = new Set(shops.map((s) => s.id));

for (const c of currencies) {
  for (const t of c.transferPartners ?? []) {
    if (!currencyIds.has(t.toCurrencyId)) errors.push(`currency "${c.id}": transfer partner "${t.toCurrencyId}" does not exist`);
    if (t.toCurrencyId === c.id) errors.push(`currency "${c.id}": cannot transfer to itself`);
  }
}

for (const c of cards) {
  if (!currencyIds.has(c.currencyId)) errors.push(`card "${c.id}": currency "${c.currencyId}" does not exist`);
  for (const r of c.rules) {
    for (const s of r.match.shopIds ?? []) {
      if (!shopIds.has(s)) errors.push(`card "${c.id}" rule "${r.id}": shop "${s}" does not exist`);
    }
  }
}

// Aliases must point to exactly one shop, or shop search becomes ambiguous.
const nameOwner = new Map<string, string>();
for (const s of shops) {
  for (const name of new Set([s.name, ...s.aliases].map((n) => n.trim().toLowerCase()))) {
    const owner = nameOwner.get(name);
    if (owner && owner !== s.id) errors.push(`shop "${s.id}": name/alias "${name}" is already used by shop "${owner}"`);
    else nameOwner.set(name, s.id);
  }
  for (const o of s.offers ?? []) {
    for (const cid of o.cardIds) {
      if (!cardIds.has(cid)) errors.push(`shop "${s.id}" offer "${o.id}": card "${cid}" does not exist`);
    }
    if (o.validUntil < today) warnings.push(`shop "${s.id}" offer "${o.id}": expired on ${o.validUntil}`);
  }
}

// Warnings: stale or unconfirmed terms

const daysSince = (d: string) => Math.floor((Date.parse(today) - Date.parse(d)) / 86_400_000);
let unconfirmed = 0;
const noteVerification = (label: string, v: { status: string; lastVerified: string }) => {
  if (v.status !== 'confirmed') unconfirmed++;
  const age = daysSince(v.lastVerified);
  if (age > STALE_AFTER_DAYS) warnings.push(`${label}: last verified ${age} days ago (${v.lastVerified})`);
};
for (const c of currencies) {
  noteVerification(`currency "${c.id}"`, c.verification);
  for (const t of c.transferPartners ?? []) noteVerification(`currency "${c.id}" -> "${t.toCurrencyId}"`, t.verification);
}
for (const c of cards) {
  noteVerification(`card "${c.id}"`, c.verification);
  for (const r of c.rules) noteVerification(`rule "${r.id}"`, r.verification);
}

// Report and write

for (const w of warnings) console.warn(`warning: ${w}`);

if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\n✗ Catalogue has ${errors.length} error(s). public/catalog.json was not written.`);
  process.exit(1);
}

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const catalogue: Catalogue = {
  builtOn: today,
  currencies: [...currencies].sort(byId),
  cards: [...cards].sort(byId),
  shops: [...shops].sort(byId),
};

const summary = `${catalogue.cards.length} cards, ${catalogue.currencies.length} currencies, ${catalogue.shops.length} shops (${unconfirmed} terms not yet confirmed on the issuer's site)`;

if (process.argv.includes('--check')) {
  console.log(`✓ Catalogue is valid: ${summary}`);
} else {
  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`✓ Wrote ${path.relative(ROOT, OUTPUT_FILE)}: ${summary}`);
}
