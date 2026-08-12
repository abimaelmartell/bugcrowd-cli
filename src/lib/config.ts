import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.bugcrowd.com";

/**
 * Pinned so responses stay stable as Bugcrowd ships new versions. The API accepts a
 * `Bugcrowd-Version` header; without it, requests use whatever version the account is
 * pinned to, which can change under you. Override with --api-version.
 */
export const DEFAULT_API_VERSION = "V1.1.0";

export interface ResolvedConfig {
  token: string;
  baseUrl: string;
  apiVersion: string;
  /** Where the token came from, for `auth status` output. Never includes the token itself. */
  tokenSource: string;
}

interface ConfigFile {
  token?: string;
  base_url?: string;
  api_version?: string;
}

export function configPath(): string {
  const explicit = process.env["BUGCROWD_CONFIG"];
  if (explicit && explicit !== "") return explicit;
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "bugcrowd", "config.json");
}

function readConfigFile(): { data: ConfigFile; path: string } | undefined {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return { data: parsed as ConfigFile, path };
  } catch (err) {
    throw new CliError(`could not parse config file ${path}: ${(err as Error).message}`, {
      details: ['Expected a JSON object, e.g. {"token": "username:password"}'],
    });
  }
}

export interface ConfigOverrides {
  token?: string;
  baseUrl?: string;
  apiVersion?: string;
}

/**
 * Resolves credentials from, in order of precedence: explicit flag, environment,
 * config file. Throws a CliError with setup instructions when nothing is found.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const file = readConfigFile();

  let token: string | undefined;
  let tokenSource = "";

  if (overrides.token && overrides.token !== "") {
    token = overrides.token;
    tokenSource = "--token flag";
  } else if (process.env["BUGCROWD_API_TOKEN"]) {
    token = process.env["BUGCROWD_API_TOKEN"];
    tokenSource = "BUGCROWD_API_TOKEN";
  } else if (process.env["BUGCROWD_TOKEN"]) {
    token = process.env["BUGCROWD_TOKEN"];
    tokenSource = "BUGCROWD_TOKEN";
  } else if (file?.data.token) {
    token = file.data.token;
    tokenSource = file.path;
  }

  if (!token || token.trim() === "") {
    throw new CliError("no Bugcrowd API token configured", {
      exitCode: 77,
      details: [
        "Set one of the following:",
        "  export BUGCROWD_API_TOKEN='username:password'",
        `  ${configPath()}  ->  {"token": "username:password"}`,
        "  bugcrowd --token 'username:password' ...",
        "",
        "Bugcrowd API credentials are a username/password pair created under your",
        "account settings; pass them joined by a colon. See `bugcrowd auth --help`.",
      ],
    });
  }

  return {
    token: normalizeToken(token.trim()),
    baseUrl: trimSlash(overrides.baseUrl ?? process.env["BUGCROWD_BASE_URL"] ?? file?.data.base_url ?? DEFAULT_BASE_URL),
    apiVersion:
      overrides.apiVersion ?? process.env["BUGCROWD_API_VERSION"] ?? file?.data.api_version ?? DEFAULT_API_VERSION,
    tokenSource,
  };
}

/**
 * Accepts either the bare `username:password` pair or a full `Token username:password`
 * header value, so pasting straight from the docs works.
 */
export function normalizeToken(token: string): string {
  const stripped = token.replace(/^Token\s+/i, "").trim();
  if (stripped === "") throw new CliError("the configured Bugcrowd API token is empty");
  return stripped;
}

/** Redacts a token for display: keeps the username, masks the secret. */
export function redactToken(token: string): string {
  const colon = token.indexOf(":");
  if (colon === -1) return `${token.slice(0, 4)}${"*".repeat(Math.max(4, token.length - 4))}`;
  const username = token.slice(0, colon);
  const secret = token.slice(colon + 1);
  return `${username}:${secret.slice(0, 2)}${"*".repeat(Math.max(6, secret.length - 2))}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
