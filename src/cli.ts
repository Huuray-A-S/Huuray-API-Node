#!/usr/bin/env node
/**
 * Entry point for the read-only command line interface.
 *
 * The commands, and why there are no value-moving ones, are in `cli-main.ts`.
 * This file only wires them to the process: argv in, exit code and errors out.
 */

import { main } from './cli-main.js';
import { HuurayApiError, HuurayError } from './errors.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof HuurayApiError) {
      console.error(`Error: ${err.message}`);
      if (err.httpStatus === 401 || err.httpStatus === 403) {
        console.error(
          '\nIf the credentials are correct, the X-API-HASH encoding may differ from this\n' +
            "client's default. See the README section \"Authentication\".",
        );
      }
    } else if (err instanceof HuurayError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
