/**
 * Generates src/types.gen.ts from openapi/huuray-v4.json.
 *
 * The vendored spec is the only source of truth for request and response shapes
 * (see CONTRIBUTING.md, "Spec fidelity"). This file is generated — never edit
 * src/types.gen.ts by hand; edit the spec or the ergonomics layer instead.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const SPEC = resolve(repo, 'openapi/huuray-v4.json');
const OUT = resolve(repo, 'src/types.gen.ts');

const spec = JSON.parse(await readFile(SPEC, 'utf8'));
const ast = await openapiTS(spec, { alphabetize: true });

const banner = `/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Source:    openapi/huuray-v4.json
 * API:       ${spec.info?.title ?? 'unknown'} ${spec.info?.version ?? ''}
 * Regenerate: npm run codegen
 *
 * Editing this file by hand breaks the spec-fidelity guarantee the SDK is built
 * on. If a type is wrong here, the spec is wrong — fix it upstream.
 */

/* eslint-disable */

`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, banner + astToString(ast), 'utf8');

// The package version, generated so the User-Agent can never drift from
// package.json across releases (npm version bumps only package.json).
const pkg = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
await writeFile(
  resolve(repo, 'src/version.gen.ts'),
  `/** AUTO-GENERATED from package.json — do not edit. Regenerate: npm run codegen */\nexport const VERSION = ${JSON.stringify(pkg.version)};\n`,
  'utf8',
);

const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
const opCount = Object.values(spec.paths ?? {}).reduce(
  (n, item) => n + Object.keys(item).filter((k) => k !== 'parameters').length,
  0,
);

console.log(`types.gen.ts written — ${opCount} operations, ${schemaCount} schemas`);
