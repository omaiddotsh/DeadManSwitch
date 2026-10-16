#!/usr/bin/env node
// `dms` — CLI entry point. Commands live in cli.ts; run `dms --help`.

import dotenv from "dotenv";
import { USAGE } from "./args.js";
import { runCli } from "./cli.js";
import { describeError, exitCodeOf, UsageError } from "./errors.js";

dotenv.config({ quiet: true });

const main = async (): Promise<number> => {
  try {
    await runCli(process.argv.slice(2), {
      env: process.env,
      io: { out: (l) => console.log(l), err: (l) => console.error(l) },
    });
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      console.error(USAGE);
      return 2;
    }
    console.error(`error: ${describeError(err)}`);
    if (process.env.DMS_DEBUG) console.error(err);
    return exitCodeOf(err);
  }
};

// The SDK can keep worker handles alive; exit explicitly once the command is done.
main().then((code) => process.exit(code));
