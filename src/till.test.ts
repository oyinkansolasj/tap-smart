import { describe, expect, it } from 'vitest';
import type { Shop } from './engine/types.ts';
import { formatMoney, formatReward, parseAmount, searchShops, todayLocal } from './till.ts';

const shop = (id: string, name: string, aliases: string[] = []): Shop => ({
  id,
  name,
  aliases,
  category: 'other',
  acceptance: { visa: 'yes', mastercard: 'yes', amex: 'yes' },
});
const shops = [
  shop('tesco', 'Tesco', ['tesco express']),
  shop('tesco-petrol', 'Tesco petrol station'),
  shop('sainsburys', "Sainsbury's"),
  shop('booking-com', 'Booking.com', ['booking']),
  shop('amazon', 'Amazon UK', ['amazon.co.uk']),
  shop('trainline', 'Trainline'),
];
const ids = (list: Shop[]) => list.map((s) => s.id);

describe('searchShops', () => {
  it('finds nothing for an empty search', () => {
    expect(searchShops(shops, '  ')).toEqual([]);
  });

  it('ignores case, spaces and punctuation', () => {
    expect(ids(searchShops(shops, 'SAINSBURYS'))).toEqual(['sainsburys']);
    expect(ids(searchShops(shops, "sainsbury's"))).toEqual(['sainsburys']);
    expect(ids(searchShops(shops, 'booking com'))).toEqual(['booking-com']);
  });

  it('matches aliases', () => {
    expect(ids(searchShops(shops, 'amazon.co'))).toEqual(['amazon']);
  });

  it('matches the start of a name, the start of a later word, or inside a word', () => {
    expect(ids(searchShops(shops, 'tes'))).toEqual(['tesco', 'tesco-petrol']);
    expect(ids(searchShops(shops, 'petrol'))).toEqual(['tesco-petrol']);
    expect(ids(searchShops(shops, 'line'))).toEqual(['trainline']);
  });

  it('ranks a name that starts with the search above one that only contains it', () => {
    const list = [shop('a', 'Big Bear'), shop('b', 'Bearsden Deli'), shop('c', 'Unbearable')];
    expect(ids(searchShops(list, 'bear'))).toEqual(['b', 'a', 'c']);
  });

  it('limits the number of results', () => {
    expect(searchShops(shops, 'o', 2)).toHaveLength(2);
  });
});

describe('parseAmount', () => {
  it.each([
    ['40', 4000],
    ['£40', 4000],
    ['40.5', 4050],
    ['40.50', 4050],
    ['.99', 99],
    ['1,250.99', 125099],
    [' 12 ', 1200],
    ['0.1', 10],
    ['19.99', 1999],
  ])('%s -> %i pence', (text, pence) => {
    expect(parseAmount(text)).toBe(pence);
  });

  it.each(['', '0', '0.00', 'abc', '12.345', '-5', '1e3', '£', '.'])('rejects %j', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats money', () => {
    expect(formatMoney(40)).toBe('40p');
    expect(formatMoney(3.125)).toBe('3.13p');
    expect(formatMoney(250)).toBe('£2.50');
    expect(formatMoney(-249)).toBe('−£2.49');
    expect(formatMoney(0)).toBe('0p');
  });

  it('formats a reward in its own currency', () => {
    const cash = { id: 'c', name: 'NatWest Rewards', kind: 'cash' as const, defaultPencePerUnit: 100, userAdjustable: false, verification: { status: 'confirmed' as const, sourceUrls: [], lastVerified: '2026-01-01' } };
    expect(formatReward(0.4, cash)).toBe('£0.40 NatWest Rewards');
    expect(formatReward(0, cash)).toBe('£0.00 NatWest Rewards');
    expect(formatReward(1250, { ...cash, name: 'Avios', kind: 'miles' })).toBe('1,250 Avios');
  });

  it('shows a reward exactly, without rounding it', () => {
    const cash = { id: 'c', name: 'NatWest Rewards', kind: 'cash' as const, defaultPencePerUnit: 100, userAdjustable: false, verification: { status: 'confirmed' as const, sourceUrls: [], lastVerified: '2026-01-01' } };
    expect(formatReward(0.125, cash)).toBe('£0.125 NatWest Rewards'); // 1% of £12.50
    expect(formatReward(0.03125, cash)).toBe('£0.03125 NatWest Rewards'); // 0.25% of £12.50
    expect(formatReward(1234.5, cash)).toBe('£1,234.50 NatWest Rewards');
    expect(formatReward(12.5, { ...cash, name: 'Avios', kind: 'miles' })).toBe('12.5 Avios');
    expect(formatReward(6.255, { ...cash, name: 'Revolut RevPoints', kind: 'points' })).toBe('6.255 Revolut RevPoints');
  });

  it('gives the local date, not the UTC one', () => {
    expect(todayLocal(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
