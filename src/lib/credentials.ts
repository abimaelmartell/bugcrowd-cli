import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:process";

import { configPath, type ConfigFile } from "./config.js";
import { CliError } from "./errors.js";

/** Keychain service name; the account is fixed so lookups need no extra state. */
export const KEYCHAIN_SERVICE = "bugcrowd-cli";
export const KEYCHAIN_ACCOUNT = "api-token";

/** The command written into the config file when credentials live in the keychain. */
export const KEYCHAIN_TOKEN_COMMAND = `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`;

export function isMacOS(): boolean {
  return platform === "darwin";
}

/** Reads the existing config file, or an empty object when there is none. */
export function readConfigForWrite(path: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ConfigFile;
  } catch {
    throw new CliError(`refusing to overwrite ${path}: it is not valid JSON`, {
      exitCode: 2,
      details: ["Fix or delete the file, then run `bugcrowd auth login` again."],
    });
  }
}

/**
 * Writes the config file with owner-only permissions.
 *
 * The mode is applied before the content is written, so the token is never briefly
 * present in a world-readable file.
 */
export function writeConfig(path: string, config: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when creating the file, so enforce it either way.
  chmodSync(path, 0o600);
}

/**
 * Stores a token in the macOS keychain, then reads it back to prove it took.
 *
 * The value goes in on stdin rather than as an argv element, so it never appears in
 * `ps` output. `security add-generic-password -w` with no inline value reads the
 * password twice (entry plus confirmation), hence the doubled input.
 *
 * `detached` is essential rather than incidental. `security` reads the password with
 * readpassphrase(3), which opens /dev/tty directly whenever the process has a
 * controlling terminal — so piped stdin is ignored, and an interactive user instead
 * gets a bare "password data for new item:" prompt. setsid (what `detached` does on
 * POSIX) leaves the child with no controlling terminal, so readpassphrase falls back
 * to stdin. Without this, an interactive `auth login --keychain` silently stores an
 * empty password.
 *
 * The read-back is the safety net: a keychain write that appears to succeed but stores
 * the wrong value must not leave the config file pointing at a broken entry.
 */
export async function keychainStore(token: string): Promise<void> {
  const result = await run(
    "security",
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-U", "-w"],
    { input: `${token}\n${token}\n`, detached: true },
  );

  if (result.code !== 0) {
    throw new CliError(`could not write to the keychain: ${firstLine(result.stderr) || `exit ${result.code}`}`, {
      exitCode: 1,
    });
  }

  const stored = keychainRead();
  if (stored !== token) {
    // Leave nothing half-configured behind.
    keychainDelete();
    throw new CliError("the keychain did not store the credentials correctly", {
      exitCode: 1,
      details: [
        stored === undefined
          ? "The entry could not be read back after writing."
          : "The value read back did not match what was written.",
        "Nothing was saved. Use `bugcrowd auth login` without --keychain to store it in",
        "the config file (mode 600) instead.",
      ],
    });
  }
}

/** Reads the stored token, or undefined when there is no readable entry. */
export function keychainRead(): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    );
    const value = out.replace(/\n$/, "");
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

interface RunResult {
  code: number;
  stderr: string;
}

/** Promise wrapper over spawn, needed because execFileSync cannot detach. */
function run(
  command: string,
  args: readonly string[],
  options: { input?: string; detached?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      // stderr is captured, not inherited: `security` writes its password prompts there,
      // and they would otherwise appear on the user's terminal looking like a real prompt.
      stdio: ["pipe", "ignore", "pipe"],
      detached: options.detached ?? false,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));

    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", () => clearTimeout(timer));

    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/** Removes the keychain entry. Returns false when there was nothing stored. */
export function keychainDelete(): boolean {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompts for a secret on the terminal with echo disabled.
 *
 * Reads the tty directly through raw mode rather than readline, so nothing is echoed
 * and nothing lands in shell history. Falls back to reading stdin when it is a pipe,
 * which is what makes `echo 'u:p' | bugcrowd auth login --stdin` work.
 */
export async function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return readAllStdin();

  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (result: string | Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        switch (byte) {
          case 0x03: // Ctrl-C
            finish(new CliError("cancelled", { exitCode: 130 }));
            return;
          case 0x04: // Ctrl-D
          case 0x0a: // \n
          case 0x0d: // \r
            finish(value);
            return;
          case 0x7f: // Backspace
          case 0x08:
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters; keep printable input only.
            if (byte >= 0x20) value += String.fromCharCode(byte);
        }
      }
    };

    input.on("data", onData);
  });
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export { configPath };
