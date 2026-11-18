import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RewardCurrency } from '../src/engine/types.ts';
import { findGainingTransferLoops, loadCatalogue, ROOT } from './load-catalog.ts';

const v = { status: 'unverified' as const, sourceUrls: [], lastVerified: '2026-01-01' };
const currency = (id: string, partners: [to: string, from: number, toUnits: number][] = []): RewardCurrency => ({
  id,
  name: id,
  kind: 'points',
  defaultPencePerUnit: 1,
  userAdjustable: true,
  transferPartners: partners.map(([toCurrencyId, fromUnits, toUnits]) => ({ toCurrencyId, fromUnits, toUnits, verification: v })),
  verification: v,
});

describe('circular conversions in the catalogue', () => {
  it('allows a two-way transfer that breaks even (like Avios <-> Qatar Avios 1:1)', () => {
    expect(findGainingTransferLoops([currency('avios', [['qatar-avios', 1, 1]]), currency('qatar-avios', [['avios', 1, 1]])])).toEqual([]);
  });

  it('allows a loop that loses value', () => {
    expect(findGainingTransferLoops([currency('a', [['b', 2, 1]]), currency('b', [['a', 1, 1]])])).toEqual([]);
  });

  it('rejects a two-way loop that gains value, and reports it once', () => {
    expect(findGainingTransferLoops([currency('a', [['b', 1, 2]]), currency('b', [['a', 1, 1]])])).toEqual([
      'transfer loop "a" -> "b" -> "a" turns 1 unit into 2',
    ]);
  });

  it('rejects a longer loop that gains value', () => {
    const loops = findGainingTransferLoops([
      currency('a', [['b', 1, 1]]),
      currency('b', [['c', 1, 1]]),
      currency('c', [['a', 4, 5]]),
    ]);
    expect(loops).toEqual(['transfer loop "a" -> "b" -> "c" -> "a" turns 1 unit into 1.25']);
  });

  it('the real catalogue has no gaining loops', async () => {
    const { catalogue } = await loadCatalogue();
    expect(findGainingTransferLoops(catalogue!.currencies)).toEqual([]);
  });

  describe('the full build', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('fails when a currency file creates a gaining loop', async () => {
      // Copy the real catalogue, then make Avios transfer back into RevPoints at 1:2.
      dir = mkdtempSync(path.join(tmpdir(), 'catalogue-'));
      cpSync(path.join(ROOT, 'catalogue'), path.join(dir, 'catalogue'), { recursive: true });
      const file = path.join(dir, 'catalogue', 'currencies.json');
      const currencies = JSON.parse(readFileSync(file, 'utf8'));
      const avios = currencies.find((c: { id: string }) => c.id === 'avios');
      avios.transferPartners = [{ toCurrencyId: 'revpoints', fromUnits: 1, toUnits: 2, verification: v }];
      writeFileSync(file, JSON.stringify(currencies));

      const result = await loadCatalogue(dir);
      expect(result.catalogue).toBeUndefined();
      expect(result.errors).toContain('transfer loop "avios" -> "revpoints" -> "avios" turns 1 unit into 2');
    });
  });
});
