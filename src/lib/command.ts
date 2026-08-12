import type { Args, FlagSpec, PositionalSpec } from "./args.js";
import type { BugcrowdClient } from "./client.js";
import type { Output } from "./output.js";
import { CliError } from "./errors.js";

export interface Context {
  args: Args;
  out: Output;
  /** Lazily constructed so `--help` and offline commands never require a token. */
  client: () => BugcrowdClient;
}

export interface Command {
  /** Space-separated path, e.g. "submissions list". */
  name: string;
  summary: string;
  /** Longer prose shown above the flag list in `--help`. */
  description?: string;
  positionals?: readonly PositionalSpec[];
  flags?: readonly FlagSpec[];
  examples?: readonly string[];
  run: (ctx: Context) => Promise<void>;
}

/** Flags accepted by every command. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "format",
    short: "f",
    type: "string",
    placeholder: "text|json|ndjson|raw",
    values: ["text", "json", "ndjson", "raw"],
    desc: "Output format. text is a table, json is normalized objects, raw is untouched JSON:API",
  },
  { name: "json", short: "j", type: "boolean", desc: "Shorthand for --format json" },
  { name: "raw", type: "boolean", desc: "Shorthand for --format raw" },
  { name: "token", type: "string", placeholder: "USER:SECRET", desc: "API token; overrides BUGCROWD_API_TOKEN" },
  { name: "api-version", type: "string", placeholder: "VERSION", desc: "Value for the Bugcrowd-Version header" },
  { name: "base-url", type: "string", placeholder: "URL", desc: "API base URL" },
  { name: "timeout", type: "int", placeholder: "SECONDS", desc: "Per-request timeout (default 30)" },
  { name: "color", type: "boolean", desc: "Force ANSI color on or off (--no-color to disable)" },
  { name: "verbose", short: "v", type: "boolean", desc: "Log requests and retries to stderr" },
  { name: "help", short: "h", type: "boolean", desc: "Show help for this command" },
];

/** Pagination flags shared by every list command. */
export const PAGE_FLAGS: readonly FlagSpec[] = [
  { name: "limit", short: "n", type: "int", placeholder: "N", desc: "Records per page, 1-100 (default 25)" },
  { name: "offset", type: "int", placeholder: "N", desc: "Records to skip before the first result" },
  { name: "all", type: "boolean", desc: "Follow pagination and return every matching record" },
  { name: "max", type: "int", placeholder: "N", desc: "Stop after N records; implies --all" },
];

export function requirePositional(ctx: Context, index: number, name: string): string {
  const value = ctx.args.positionals[index];
  if (value === undefined || value === "") {
    throw new CliError(`missing required argument <${name}>`, { exitCode: 2 });
  }
  return value;
}

export function rejectExtraPositionals(ctx: Context, allowed: number): void {
  const extra = ctx.args.positionals.slice(allowed);
  if (extra.length > 0) {
    throw new CliError(`unexpected argument ${JSON.stringify(extra[0])}`, {
      exitCode: 2,
      details: ["Run the command with --help to see the arguments it accepts."],
    });
  }
}

/**
 * Resolves the paging flags into the shape `client.paginate` expects.
 * `--max` implies `--all`, since capping only means anything while following pages.
 */
export function pageOptions(ctx: Context): { limit: number; offset: number; max: number | undefined; all: boolean } {
  const max = ctx.args.int("max");
  const all = ctx.args.bool("all") || max !== undefined;
  const limit = ctx.args.int("limit") ?? (all ? 100 : 25);
  return { limit, offset: ctx.args.int("offset") ?? 0, max, all };
}
