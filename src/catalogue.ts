// Loads the catalogue the build script wrote to public/catalog.json. The build script has already
// checked every rule, so this only checks the file arrived and has the right top-level shape.

import type { Catalogue } from './engine/types.ts';

export const CATALOGUE_URL = `${import.meta.env.BASE_URL}catalog.json`;

export async function fetchCatalogue(): Promise<Catalogue> {
  const response = await fetch(CATALOGUE_URL);
  if (!response.ok) throw new Error(`Could not load the card catalogue (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!isCatalogue(data)) throw new Error('The card catalogue file is damaged. Try reloading the page.');
  return data;
}

function isCatalogue(data: unknown): data is Catalogue {
  if (typeof data !== 'object' || data === null) return false;
  const c = data as Record<string, unknown>;
  return typeof c.builtOn === 'string' && Array.isArray(c.currencies) && Array.isArray(c.cards) && Array.isArray(c.shops);
}
