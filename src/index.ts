#!/usr/bin/env node
import { authCommands } from "./commands/auth.js";
import { resourceCommands } from "./commands/resources.js";
import { submissionCommands } from "./commands/submissions.js";
import { parseArgs, type FlagSpec } from "./lib/args.js";
import { BugcrowdClient } from "./lib/client.js";
import { GLOBAL_FLAGS, type Command, type Context } from "./lib/command.js";
import { resolveConfig } from "./lib/config.js";
import { ApiError, CliError } from "./lib/errors.js";
import { commandHelp, rootHelp } from "./lib/help.js";
import { Output, type Format } from "./lib/output.js";

const VERSION = "0.1.0";

const COMMANDS: readonly Command[] = [...authCommands, ...submissionCommands, ...resourceCommands];

/** Short aliases for the groups people reach for most. */
const GROUP_ALIASES: Record<string, string> = {
  sub: "submissions",
  subs: "submissions",
  submission: "submissions",
  program: "programs",
  prog: "programs",
  progs: "programs",
  org: "organizations",
  orgs: "organizations",
  organization: "organizations",
  engagement: "engagements",
  eng: "engagements",
  target: "targets",
  reward: "rewards",
  disclosure: "disclosures",
};

/**
 * `submissions <uuid>` with no verb is treated as `submissions get <uuid>`.
 * Deliberately gated on the argument being a UUID: without that, a mistyped
 * subcommand like `submissions lst` would silently become an id lookup and fail
 * with a confusing 404 instead of "unknown command".
 */
const DEFAULT_VERB: Record<string, string> = {
  submissions: "get",
  programs: "get",
  engagements: "get",
  organizations: "get",
  rewards: "get",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(`${rootHelp(COMMANDS)}\n`);
    return 0;
  }

  if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const resolution = resolveCommand(argv);

  if (resolution === undefined) {
    if (wantsHelp) {
      process.stdout.write(`${rootHelp(COMMANDS)}\n`);
      return 0;
    }
    throw unknownCommand(argv);
  }

  const { command, rest } = resolution;
  if (wantsHelp) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return 0;
  }

  const specs: FlagSpec[] = [...(command.flags ?? []), ...GLOBAL_FLAGS];
  const args = parseArgs(rest, specs);

  const out = new Output({ format: pickFormat(args.str("format"), args.bool("json"), args.bool("raw")), color: useColor(args.boolOrUndefined("color")) });

  let client: BugcrowdClient | undefined;
  const ctx: Context = {
    args,
    out,
    client: () => {
      client ??= new BugcrowdClient(
        resolveConfig({
          token: args.str("token"),
          baseUrl: args.str("base-url"),
          apiVersion: args.str("api-version"),
        }),
        {
          timeoutMs: (args.int("timeout") ?? 30) * 1000,
          verbose: args.bool("verbose"),
        },
      );
      return client;
    },
  };

  try {
    await command.run(ctx);
  } finally {
    out.flush();
  }

  if (args.bool("verbose") && client) {
    process.stderr.write(`! ${client.requestCount} request(s) issued\n`);
  }
  return 0;
}

/**
 * Matches the longest command name against the leading argv words, so a two-word
 * command ("submissions list") wins over a one-word one ("api").
 */
function resolveCommand(argv: string[]): { command: Command; rest: string[] } | undefined {
  const words = [...argv];
  const first = words[0];
  if (first !== undefined && GROUP_ALIASES[first] !== undefined) words[0] = GROUP_ALIASES[first]!;

  for (const length of [2, 1]) {
    const candidate = words.slice(0, length).join(" ");
    const command = COMMANDS.find((c) => c.name === candidate);
    if (command) return { command, rest: words.slice(length) };
  }

  // `submissions <uuid>` -> `submissions get <uuid>`
  const group = words[0];
  const second = words[1];
  if (group !== undefined && second !== undefined && UUID_RE.test(second)) {
    const verb = DEFAULT_VERB[group];
    if (verb) {
      const command = COMMANDS.find((c) => c.name === `${group} ${verb}`);
      if (command) return { command, rest: words.slice(1) };
    }
  }

  return undefined;
}

function unknownCommand(argv: string[]): CliError {
  const attempted = argv.filter((token) => !token.startsWith("-")).slice(0, 2).join(" ");
  const groups = [...new Set(COMMANDS.map((c) => c.name.split(" ")[0]!))];
  const details = [`Available groups: ${groups.join(", ")}`, "Run `bugcrowd --help` for the full command list."];

  const group = argv[0] !== undefined ? (GROUP_ALIASES[argv[0]] ?? argv[0]) : undefined;
  const siblings = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  if (siblings.length > 0) {
    details.unshift(`Commands in \`${group}\`: ${siblings.map((c) => c.name.split(" ")[1]).join(", ")}`);
  }

  return new CliError(`unknown command ${JSON.stringify(attempted || argv.join(" "))}`, { exitCode: 2, details });
}

function pickFormat(explicit: string | undefined, json: boolean, raw: boolean): Format {
  if (explicit !== undefined) return explicit as Format;
  if (raw) return "raw";
  if (json) return "json";
  return "text";
}

function useColor(override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  if (process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "") return false;
  if (process.env["FORCE_COLOR"] !== undefined && process.env["FORCE_COLOR"] !== "0") return true;
  return process.stdout.isTTY === true;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`bugcrowd: ${err.message}\n`);
    for (const detail of err.details) process.stderr.write(`${detail}\n`);
    if (err instanceof ApiError && err.status >= 500) {
      process.stderr.write("Re-run with --verbose to see the request and retry sequence.\n");
    }
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`bugcrowd: unexpected error: ${(err as Error).message}\n`);
    if (process.env["BUGCROWD_DEBUG"]) process.stderr.write(`${(err as Error).stack}\n`);
    else process.stderr.write("Set BUGCROWD_DEBUG=1 for a stack trace.\n");
    process.exitCode = 70;
  }
}
