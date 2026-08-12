import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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

export interface ConfigFile {
  token?: string;
  /**
   * Shell command whose stdout is the token. Lets credentials live in the macOS
   * keychain, 1Password, `pass`, Vault, or anything else with a CLI, instead of
   * sitting in plaintext on disk.
   */
  token_command?: string;
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
 * Runs a `token_command` and returns its stdout as the token.
 *
 * The command comes from a file the user owns, so it carries the same trust as their
 * shell profile. stderr is inherited so an interactive unlock prompt (1Password, Vault)
 * is still visible, and stdout is captured rather than echoed so the secret is not
 * printed. A timeout keeps a hung helper from wedging every invocation.
 */
function runTokenCommand(command: string, source: string): string {
  let stdout: string;
  try {
    stdout = execFileSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    const signal = (err as { signal?: string | null }).signal;
    const reason = signal === "SIGTERM" ? "timed out after 30s" : `exited with status ${status ?? "unknown"}`;
    throw new CliError(`token command ${reason}`, {
      exitCode: 77,
      details: [`Command (from ${source}): ${command}`, "Run it yourself to see why it failed."],
    });
  }

  // Take the first line: helpers such as `op read` may append a trailing newline, and a
  // multi-line result is far more likely to be an error banner than a credential.
  const token = stdout.split("\n")[0]!.trim();
  if (token === "") {
    throw new CliError("token command produced no output", {
      exitCode: 77,
      details: [`Command (from ${source}): ${command}`, "It must print the `username:password` pair on stdout."],
    });
  }
  return token;
}

/**
 * Warns when a config file holding a literal token is readable beyond its owner.
 * Only a literal token is worth warning about: a `token_command` file holds no secret.
 */
function warnIfWorldReadable(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `bugcrowd: warning: ${path} is mode ${mode.toString(8).padStart(3, "0")} and holds a plaintext token.\n` +
          `bugcrowd: run \`chmod 600 ${path}\` to restrict it to your user.\n`,
      );
    }
  } catch {
    // A stat failure is not worth failing the command over.
  }
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
  } else if (process.env["BUGCROWD_TOKEN_COMMAND"]) {
    tokenSource = "BUGCROWD_TOKEN_COMMAND";
    token = runTokenCommand(process.env["BUGCROWD_TOKEN_COMMAND"]!, tokenSource);
  } else if (file?.data.token_command) {
    // Deliberately ahead of a literal `token`: someone who configured a command meant
    // it, and a leftover literal from before the switch must not silently win.
    tokenSource = `${file.path} (token_command)`;
    token = runTokenCommand(file.data.token_command, tokenSource);
  } else if (file?.data.token) {
    token = file.data.token;
    tokenSource = file.path;
    warnIfWorldReadable(file.path);
  }

  if (!token || token.trim() === "") {
    throw new CliError("no Bugcrowd API token configured", {
      exitCode: 77,
      details: [
        "Store credentials once so every later run — including ones agents start",
        "themselves — picks them up without any environment setup:",
        "",
        "  bugcrowd auth login              # saves to the config file, mode 600",
        "  bugcrowd auth login --keychain   # saves to the macOS keychain instead",
        "",
        "Or supply them per-invocation:",
        "  export BUGCROWD_API_TOKEN='username:password'",
        "  bugcrowd --token 'username:password' ...",
        "",
        "Bugcrowd API credentials are a username/password pair created under your",
        "account settings; pass them joined by a colon. See `bugcrowd auth login --help`.",
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
