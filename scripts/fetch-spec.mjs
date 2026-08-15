/**
 * Re-downloads the live v4 spec over the vendored copy.
 *
 * Run by .github/workflows/spec-drift.yml on a schedule. If the download differs
 * from the committed copy, the workflow regenerates types and opens a PR — that
 * PR is the early warning that the API changed under us.
 *
 * Exits 0 whether or not anything changed; the workflow diffs the working tree.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, '../openapi/huuray-v4.json');
const URL_ = process.env.HUURAY_SPEC_URL ?? 'https://api.huuray.com/swagger/v4/swagger.json';

const res = await fetch(URL_);
if (!res.ok) {
  console.error(`Failed to fetch spec: HTTP ${res.status} from ${URL_}`);
  process.exit(1);
}

const incoming = await res.json();

if (incoming.info?.version !== 'v4') {
  console.error(`Refusing to write: expected info.version "v4", got "${incoming.info?.version}".`);
  console.error('This SDK targets v4 only. A version change is a deliberate decision, not a sync.');
  process.exit(1);
}

const next = JSON.stringify(incoming, null, 2) + '\n';
const prev = await readFile(SPEC, 'utf8').catch(() => '');

if (prev === next) {
  console.log('Spec unchanged.');
  process.exit(0);
}

await writeFile(SPEC, next, 'utf8');
console.log('Spec CHANGED — types must be regenerated and the diff reviewed.');
