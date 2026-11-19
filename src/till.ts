// Helpers for the till screen: shop search, reading the amount typed, and display text.

import type { Category, IsoDate, Pence, RewardCurrency, Shop } from './engine/types.ts';

export const CATEGORY_LABELS: Record<Category, string> = {
  supermarket: 'Supermarket',
  supermarket_petrol: 'Supermarket petrol station',
  fuel: 'Fuel',
  public_transport: 'Public transport',
  taxi_rideshare: 'Taxi or ride-hailing',
  flights: 'Flights',
  hotels: 'Hotels',
  travel_other: 'Other travel',
  online_shopping: 'Online shopping',
  dining: 'Eating out',
  entertainment: 'Entertainment',
  bills_utilities: 'Bills and utilities',
  other: 'Something else',
};

// Lower case, letters and digits only, so "Sainsbury's" matches "sainsburys" and "booking.com" matches "booking com".
const normalise = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

// Shops whose name or alias matches what was typed. Best matches first:
// the start of the name, then the start of any word, then anywhere.
export function searchShops(shops: Shop[], query: string, limit = 8): Shop[] {
  const q = normalise(query);
  if (!q) return [];
  const score = (shop: Shop): number => {
    let best = Infinity;
    for (const text of [shop.name, ...shop.aliases]) {
      if (normalise(text).startsWith(q)) best = Math.min(best, 0);
      else if (text.split(/[\s.\-/]+/).some((word) => normalise(word).startsWith(q))) best = Math.min(best, 1);
      else if (normalise(text).includes(q)) best = Math.min(best, 2);
    }
    return best;
  };
  return shops
    .map((shop) => ({ shop, s: score(shop) }))
    .filter(({ s }) => s < Infinity)
    .sort((a, b) => a.s - b.s || a.shop.name.localeCompare(b.shop.name))
    .slice(0, limit)
    .map(({ shop }) => shop);
}

// "40", "£40", "40.5", "1,250.99" -> pence. Anything else, or zero, -> null.
export function parseAmount(text: string): Pence | null {
  const cleaned = text.replace(/[£,\s]/g, '');
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const pence = Math.round(Number(cleaned) * 100);
  return pence > 0 ? pence : null;
}

// 40 -> "40p", 3.125 -> "3.13p", 250 -> "£2.50", -249 -> "−£2.49".
export function formatMoney(pence: number): string {
  const sign = pence < 0 ? '−' : '';
  const abs = Math.abs(pence);
  if (abs >= 100) return `${sign}£${(abs / 100).toFixed(2)}`;
  return `${sign}${Number(abs.toFixed(2))}p`;
}

// The reward in the card's own currency, exactly as earned (no rounding):
// "£0.40 NatWest Rewards", "£0.125 NatWest Rewards", "20 Revolut RevPoints", "12.5 Avios".
// Up to 8 decimal places, which is as precise as rank() works to.
export function formatReward(units: number, currency: RewardCurrency): string {
  if (currency.kind === 'cash') {
    return `£${units.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${currency.name}`;
  }
  return `${units.toLocaleString('en-GB', { maximumFractionDigits: 8 })} ${currency.name}`;
}

// Today's date where the user is (not UTC), as "YYYY-MM-DD".
export function todayLocal(now = new Date()): IsoDate {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
