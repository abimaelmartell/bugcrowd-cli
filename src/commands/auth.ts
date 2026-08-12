import { readFileSync } from "node:fs";

import { BugcrowdClient, clampLimit, type QueryValue } from "../lib/client.js";
import { rejectExtraPositionals, requirePositional, type Command } from "../lib/command.js";
import { configPath, DEFAULT_API_VERSION, normalizeToken, redactToken, resolveConfig } from "../lib/config.js";
import {
  isMacOS,
  keychainDelete,
  keychainStore,
  keychainTokenCommand,
  isKeychainCommand,
  promptSecret,
  readAllStdin,
  readConfigForWrite,
  writeConfig,
} from "../lib/credentials.js";
import { CliError } from "../lib/errors.js";
import type { Document } from "../lib/jsonapi.js";
import { normalize } from "../lib/jsonapi.js";
import { text } from "../lib/output.js";

const authLogin: Command = {
  name: "auth login",
  summary: "Store credentials once so later runs need no environment setup",
  description:
    "Prompts for your Bugcrowd API credential pair (input is not echoed), verifies it\n" +
    "against the API, and saves it locally. Every later invocation — including runs an\n" +
    "agent or script starts on its own — picks it up with no environment variables.\n" +
    "\n" +
    "Two storage backends:\n" +
    "  default      the config file, created mode 600 (owner read/write only)\n" +
    "  --keychain   the macOS keychain; the config file then holds only a lookup\n" +
    "               command, so no secret is written to disk in plaintext\n" +
    "\n" +
    "For any other secret manager, skip this command and set `token_command` in the\n" +
    "config file to something that prints the pair on stdout, for example:\n" +
    '  {"token_command": "op read op://Private/Bugcrowd/credential"}\n' +
    '  {"token_command": "pass show bugcrowd/api"}',
  flags: [
    {
      name: "keychain",
      type: "boolean",
      desc: "Store in the macOS keychain instead of the config file (macOS only)",
    },
    { name: "stdin", type: "boolean", desc: "Read the credential pair from stdin instead of prompting" },
    { name: "verify", type: "boolean", desc: "Check the credentials against the API before saving (--no-verify to skip)" },
  ],
  examples: [
    "bugcrowd auth login",
    "bugcrowd auth login --keychain",
    "echo 'api-user:api-secret' | bugcrowd auth login --stdin",
  ],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const useKeychain = ctx.args.bool("keychain");

    if (useKeychain && !isMacOS()) {
      throw new CliError("--keychain is only available on macOS", {
        exitCode: 2,
        details: [
          "On Linux, either use the default config-file storage (mode 600), or point",
          "`token_command` at your own secret manager. See `bugcrowd auth login --help`.",
        ],
      });
    }

    // Say up front when this would replace working credentials. Re-running `auth login`
    // is a legitimate way to rotate a token, but doing it by accident should not be
    // silent — especially when it would move the secret to weaker storage.
    const existingPath = configPath();
    const existing = readConfigForWrite(existingPath);
    const storedIn =
      isKeychainCommand(existing.token_command)
        ? "the macOS keychain"
        : existing.token_command !== undefined
          ? `a token_command in ${existingPath}`
          : existing.token !== undefined
            ? existingPath
            : undefined;

    if (storedIn !== undefined && !ctx.args.bool("stdin")) {
      process.stderr.write(`Credentials are already stored in ${storedIn}.\n`);
      if (isKeychainCommand(existing.token_command) && !useKeychain) {
        process.stderr.write(
          "Continuing will move them out of the keychain into a plaintext config file.\n" +
            "Re-run with --keychain to keep keychain storage, or Ctrl-C to leave things as they are.\n",
        );
      } else {
        process.stderr.write("Continuing replaces them. Ctrl-C to leave things as they are.\n");
      }
    }

    const raw = ctx.args.bool("stdin")
      ? await readAllStdin()
      : await promptSecret("Bugcrowd API credentials (username:password): ");

    const entered = raw.split("\n")[0]!.trim();
    if (entered === "") {
      // Reached when stdin is empty or closed, which is the usual shape of a
      // non-interactive invocation that forgot to pipe anything in.
      throw new CliError("no credentials entered", {
        exitCode: 2,
        details: [
          "Run `bugcrowd auth login` from a terminal to be prompted, or pipe the pair in:",
          "  echo 'api-user:api-secret' | bugcrowd auth login --stdin",
        ],
      });
    }

    const token = normalizeToken(entered);
    if (!token.includes(":")) {
      throw new CliError("credentials must be in `username:password` form", {
        exitCode: 2,
        details: [
          "Bugcrowd API credentials are a pair, shown when you create them in your",
          "account settings. Join them with a colon, e.g. `abc123:def456`.",
        ],
      });
    }

    // Verify before persisting, so a typo is caught now rather than on the next command.
    if (ctx.args.boolOrUndefined("verify") !== false) {
      const probe = new BugcrowdClient(
        {
          token,
          baseUrl: ctx.args.str("base-url") ?? process.env["BUGCROWD_BASE_URL"] ?? "https://api.bugcrowd.com",
          apiVersion: ctx.args.str("api-version") ?? DEFAULT_API_VERSION,
          tokenSource: "auth login",
        },
        { timeoutMs: (ctx.args.int("timeout") ?? 30) * 1000, verbose: ctx.args.bool("verbose") },
      );
      await probe.request<Document>("/organizations", { query: { "page[limit]": 1 } });
    }

    const path = configPath();
    const config = readConfigForWrite(path);
    let movedOutOfKeychain = false;

    if (useKeychain) {
      await keychainStore(token);
      config.token_command = keychainTokenCommand();
      // Drop any literal token so the keychain becomes the single source of truth.
      delete config.token;
    } else {
      config.token = token;
      if (isKeychainCommand(config.token_command)) {
        delete config.token_command;
        // Switching backends moves the credential rather than duplicating it: leaving
        // the old entry behind would strand a secret nothing references any more.
        movedOutOfKeychain = isMacOS() && keychainDelete();
      }
    }
    writeConfig(path, config);

    if (!ctx.out.isText) {
      ctx.out.json({
        ok: true,
        storage: useKeychain ? "keychain" : "config-file",
        config_path: path,
        removed_keychain_entry: movedOutOfKeychain,
      });
      return;
    }
    ctx.out.line(
      useKeychain
        ? `Stored in the macOS keychain. ${path} now holds only a lookup command.`
        : `Stored in ${path} (mode 600).`,
    );
    if (movedOutOfKeychain) ctx.out.line("Removed the previous keychain entry.");
    ctx.out.line("Later runs pick this up automatically — no environment variables needed.");
  },
};

const authLogout: Command = {
  name: "auth logout",
  summary: "Remove locally stored credentials",
  description: "Clears the token from the config file and, if present, from the macOS keychain.",
  examples: ["bugcrowd auth logout"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const path = configPath();
    const config = readConfigForWrite(path);
    const removed: string[] = [];

    if (config.token !== undefined) {
      delete config.token;
      removed.push(`token in ${path}`);
    }
    if (isKeychainCommand(config.token_command)) {
      delete config.token_command;
      removed.push(`keychain lookup in ${path}`);
    }
    if (removed.length > 0) writeConfig(path, config);

    if (isMacOS() && keychainDelete()) removed.push("macOS keychain entry");

    if (!ctx.out.isText) {
      ctx.out.json({ ok: true, removed });
      return;
    }
    if (removed.length === 0) {
      ctx.out.line("Nothing stored locally.");
    } else {
      for (const item of removed) ctx.out.line(`Removed ${item}.`);
    }
    // An env var would keep working after this and silently override storage later.
    for (const name of ["BUGCROWD_API_TOKEN", "BUGCROWD_TOKEN", "BUGCROWD_TOKEN_COMMAND"]) {
      if (process.env[name]) ctx.out.line(ctx.out.dim(`Note: ${name} is still set in this shell and takes precedence.`));
    }
  },
};

const authStatus: Command = {
  name: "auth status",
  summary: "Verify the configured token and show what it can reach",
  description:
    "Resolves credentials, calls the API once, and reports the organizations and\n" +
    "programs the token can see. Exits non-zero if the token is missing or rejected.\n" +
    "\n" +
    "Credentials are read in this order, first match wins:\n" +
    "  1. --token\n" +
    "  2. BUGCROWD_API_TOKEN, then BUGCROWD_TOKEN\n" +
    "  3. BUGCROWD_TOKEN_COMMAND\n" +
    `  4. ${configPath()} -> token_command\n` +
    `  5. ${configPath()} -> token\n` +
    "\n" +
    "The value is the `username:password` pair Bugcrowd shows when you create an API\n" +
    "credential. A full `Token username:password` header value is also accepted.\n" +
    "\n" +
    "Run `bugcrowd auth login` to store credentials so 4 or 5 applies and no shell\n" +
    "setup is needed.",
  examples: ["bugcrowd auth status", "bugcrowd auth status --json"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const config = resolveConfig({
      token: ctx.args.str("token"),
      baseUrl: ctx.args.str("base-url"),
      apiVersion: ctx.args.str("api-version"),
    });

    const client = ctx.client();
    const orgsDoc = await client.request<Document>("/organizations", { query: { "page[limit]": 100 } });
    const orgs = normalize(orgsDoc);
    const programsDoc = await client.request<Document>("/programs", {
      query: { "page[limit]": 100, include: "organization" },
    });
    const programs = normalize(programsDoc);

    if (!ctx.out.isText) {
      ctx.out.json({
        ok: true,
        token_source: config.tokenSource,
        token: redactToken(config.token),
        base_url: config.baseUrl,
        api_version: config.apiVersion,
        organizations: orgs.map((o) => ({ id: o.id, name: o["name"] })),
        programs: programs.map((p) => ({ id: p.id, code: p["code"], name: p["name"] })),
      });
      return;
    }

    ctx.out.line(`${ctx.out.bold("Authenticated")} as ${redactToken(config.token)}`);
    ctx.out.line(`Token source:  ${config.tokenSource}`);
    ctx.out.line(`Base URL:      ${config.baseUrl}`);
    ctx.out.line(`API version:   ${config.apiVersion}`);
    // Credentials coming from the environment will not be there for a run started by
    // something else, which is exactly the case people trip over.
    if (config.tokenSource.startsWith("BUGCROWD_") || config.tokenSource === "--token flag") {
      ctx.out.line();
      ctx.out.line(
        ctx.out.dim("Credentials came from this shell, so a run started elsewhere will not see them."),
      );
      ctx.out.line(ctx.out.dim("Run `bugcrowd auth login` to store them for every later run."));
    }
    ctx.out.line();
    ctx.out.line(`${ctx.out.bold("Organizations")} (${orgs.length})`);
    for (const org of orgs) ctx.out.line(`  ${text(org["name"])}  ${ctx.out.dim(org.id)}`);
    if (orgs.length === 0) ctx.out.line(ctx.out.dim("  none"));
    ctx.out.line();
    ctx.out.line(`${ctx.out.bold("Programs")} (${programs.length}${programs.length === 100 ? "+" : ""})`);
    for (const program of programs) {
      ctx.out.line(`  ${text(program["code"]).padEnd(24)} ${text(program["name"])}`);
    }
    if (programs.length === 0) ctx.out.line(ctx.out.dim("  none"));
  },
};

const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

const rawApi: Command = {
  name: "api",
  summary: "Call any Bugcrowd API endpoint directly",
  description:
    "An escape hatch for endpoints this CLI does not wrap yet. The path is sent as\n" +
    "given, with authentication, the version header and retry handling applied.\n" +
    "Output is the raw response body unless you pass --normalize.\n" +
    "\n" +
    "Full endpoint reference: https://docs.bugcrowd.com/api/1.1.0/",
  positionals: [
    { name: "method-or-path", desc: "HTTP method, or the path if the method is GET", required: true },
    { name: "path", desc: "Request path, e.g. /submissions" },
  ],
  flags: [
    {
      name: "query",
      short: "q",
      type: "string",
      repeat: true,
      split: false,
      placeholder: "NAME=VALUE",
      desc: "Query parameter; repeatable. Values may contain commas",
    },
    {
      name: "body",
      short: "b",
      type: "string",
      placeholder: "JSON|@FILE|-",
      desc: "Request body: inline JSON, @path to read a file, or - for stdin",
    },
    {
      name: "header",
      short: "H",
      type: "string",
      repeat: true,
      split: false,
      placeholder: "NAME:VALUE",
      desc: "Extra request header; repeatable",
    },
    { name: "normalize", type: "boolean", desc: "Flatten the JSON:API response instead of printing it raw" },
    { name: "paginate", type: "boolean", desc: "Follow pagination and print every page's records (GET only)" },
    { name: "max", type: "int", placeholder: "N", desc: "With --paginate, stop after N records" },
  ],
  examples: [
    "bugcrowd api /submissions -q 'filter[state]=new' -q 'page[limit]=5'",
    "bugcrowd api GET /teams --normalize",
    "bugcrowd api PATCH /submissions/<id> -b '{\"data\":{\"type\":\"submission\",\"attributes\":{\"severity\":3}}}'",
  ],
  async run(ctx) {
    const first = requirePositional(ctx, 0, "method-or-path");
    const second = ctx.args.positionals[1];
    rejectExtraPositionals(ctx, 2);

    const upper = first.toUpperCase();
    const isMethod = (METHODS as readonly string[]).includes(upper);
    const method = (isMethod ? upper : "GET") as (typeof METHODS)[number];
    const path = isMethod ? second : first;

    if (path === undefined || path === "") {
      throw new CliError("missing request path", {
        exitCode: 2,
        details: ["Usage: bugcrowd api [METHOD] <PATH> [--query name=value]"],
      });
    }
    if (!isMethod && second !== undefined) {
      throw new CliError(`unknown HTTP method ${JSON.stringify(first)}`, {
        exitCode: 2,
        details: [`Valid methods: ${METHODS.join(", ")}`],
      });
    }

    // A path may carry its own query string; merge it with any --query flags.
    const [rawPath, inlineQuery] = splitOnce(path, "?");
    const query: Record<string, QueryValue> = {};
    if (inlineQuery !== undefined) {
      for (const [name, value] of new URLSearchParams(inlineQuery)) query[name] = value;
    }
    for (const pair of ctx.args.list("query")) {
      const [name, value] = splitOnce(pair, "=");
      if (value === undefined) {
        throw new CliError(`--query expects name=value, got ${JSON.stringify(pair)}`, { exitCode: 2 });
      }
      query[name] = value;
    }

    const headers: Record<string, string> = {};
    for (const pair of ctx.args.list("header")) {
      const [name, value] = splitOnce(pair, ":");
      if (value === undefined) {
        throw new CliError(`--header expects NAME:VALUE, got ${JSON.stringify(pair)}`, { exitCode: 2 });
      }
      headers[name.trim()] = value.trim();
    }

    const body = await readBody(ctx.args.str("body"));
    if (body !== undefined && method === "GET") {
      throw new CliError("--body cannot be used with GET", {
        exitCode: 2,
        details: ["Pick a method that carries a body, e.g. `bugcrowd api POST /submissions/search -b '{...}'`."],
      });
    }

    const client = ctx.client();
    const shouldNormalize = ctx.args.bool("normalize");

    if (ctx.args.bool("paginate")) {
      if (method !== "GET") throw new CliError("--paginate only applies to GET requests", { exitCode: 2 });
      const max = ctx.args.int("max");
      const limit = clampLimit(Number(query["page[limit]"] ?? 100));
      const pages: Document[] = [];
      const records: unknown[] = [];
      for await (const doc of client.paginate(rawPath, {
        query: { ...query, "page[limit]": limit },
        headers,
        max,
      })) {
        pages.push(doc);
        records.push(...normalize(doc));
        if (max !== undefined && records.length >= max) break;
      }
      const trimmed = max === undefined ? records : records.slice(0, max);
      ctx.out.json(shouldNormalize ? trimmed : pages);
      return;
    }

    const doc = await client.request<Document>(rawPath, { method, query, body, headers });
    ctx.out.json(shouldNormalize ? normalize(doc) : doc);
  },
};

async function readBody(spec: string | undefined): Promise<unknown> {
  if (spec === undefined) return undefined;
  let raw: string;
  if (spec === "-") {
    raw = await readStdin();
  } else if (spec.startsWith("@")) {
    const path = spec.slice(1);
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new CliError(`could not read body file ${path}: ${(err as Error).message}`, { exitCode: 2 });
    }
  } else {
    raw = spec;
  }
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CliError(`request body is not valid JSON: ${(err as Error).message}`, { exitCode: 2 });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export const authCommands: readonly Command[] = [authStatus, authLogin, authLogout, rawApi];
