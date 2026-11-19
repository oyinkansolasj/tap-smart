// Builds public/catalog.json from the data files in catalogue --check: check only, write nothing (for CI)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCatalogue, ROOT } from './load-catalog.ts';

const OUTPUT_FILE = path.join(ROOT, 'public', 'catalog.json');

const { catalogue, errors, warnings, unconfirmed } = await loadCatalogue();

for (const w of warnings) console.warn(`warning: ${w}`);

if (!catalogue) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\n✗ Catalogue has ${errors.length} error(s). public/catalog.json was not written.`);
  process.exit(1);
}

const summary = `version ${catalogue.version}, ${catalogue.cards.length} cards, ${catalogue.currencies.length} currencies, ${catalogue.shops.length} shops (${unconfirmed} terms not yet confirmed on the issuer's site)`;

if (process.argv.includes('--check')) {
  console.log(`✓ Catalogue is valid: ${summary}`);
} else {
  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`✓ Wrote ${path.relative(ROOT, OUTPUT_FILE)}: ${summary}`);
}
