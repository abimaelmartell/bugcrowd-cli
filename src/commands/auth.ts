import { readFileSync } from "node:fs";

import { clampLimit, type QueryValue } from "../lib/client.js";
import { rejectExtraPositionals, requirePositional, type Command } from "../lib/command.js";
import { configPath, DEFAULT_API_VERSION, redactToken, resolveConfig } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import type { Document } from "../lib/jsonapi.js";
import { normalize } from "../lib/jsonapi.js";
import { text } from "../lib/output.js";

const authStatus: Command = {
  name: "auth status",
  summary: "Verify the configured token and show what it can reach",
  description:
    "Resolves credentials, calls the API once, and reports the organizations and\n" +
    "programs the token can see. Exits non-zero if the token is missing or rejected.\n" +
    "\n" +
    "Credentials are read in this order:\n" +
    "  1. --token\n" +
    "  2. BUGCROWD_API_TOKEN, then BUGCROWD_TOKEN\n" +
    `  3. ${configPath()} (key "token")\n` +
    "\n" +
    "The value is the `username:password` pair Bugcrowd shows when you create an API\n" +
    "credential. A full `Token username:password` header value is also accepted.",
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

export const DEFAULT_VERSION_NOTE = DEFAULT_API_VERSION;
export const authCommands: readonly Command[] = [authStatus, rawApi];
