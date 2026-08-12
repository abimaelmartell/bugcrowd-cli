import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/lib/config.js";
import { readConfigForWrite, writeConfig } from "../src/lib/credentials.js";
import { CliError } from "../src/lib/errors.js";

const ENV_KEYS = [
  "BUGCROWD_API_TOKEN",
  "BUGCROWD_TOKEN",
  "BUGCROWD_TOKEN_COMMAND",
  "BUGCROWD_BASE_URL",
  "BUGCROWD_API_VERSION",
  "BUGCROWD_CONFIG",
  "XDG_CONFIG_HOME",
];

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bugcrowd-creds-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

test("token_command output is used as the token", () => {
  const path = tempConfig({ token_command: "printf 'cmd-user:cmd-secret'" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    const config = resolveConfig();
    assert.equal(config.token, "cmd-user:cmd-secret");
    assert.match(config.tokenSource, /token_command/);
  });
});

test("token_command output is trimmed and only the first line is used", () => {
  const path = tempConfig({ token_command: "printf 'u:s\\n\\n'" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.equal(resolveConfig().token, "u:s");
  });
});

test("token_command wins over a stale literal token in the same file", () => {
  const path = tempConfig({ token: "stale:literal", token_command: "printf 'fresh:secret'" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.equal(resolveConfig().token, "fresh:secret");
  });
});

test("environment credentials still outrank the config file", () => {
  const path = tempConfig({ token_command: "printf 'file:secret'" });
  withEnv({ BUGCROWD_CONFIG: path, BUGCROWD_API_TOKEN: "env:secret" }, () => {
    assert.equal(resolveConfig().token, "env:secret");
  });
});

test("BUGCROWD_TOKEN_COMMAND is honoured", () => {
  const path = tempConfig({});
  withEnv({ BUGCROWD_CONFIG: path, BUGCROWD_TOKEN_COMMAND: "printf 'envcmd:secret'" }, () => {
    const config = resolveConfig();
    assert.equal(config.token, "envcmd:secret");
    assert.equal(config.tokenSource, "BUGCROWD_TOKEN_COMMAND");
  });
});

test("a failing token_command reports the command and exits 77", () => {
  const path = tempConfig({ token_command: "exit 3" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.throws(
      () => resolveConfig(),
      (err: unknown) =>
        err instanceof CliError &&
        err.exitCode === 77 &&
        /status 3/.test(err.message) &&
        err.details.join("\n").includes("exit 3"),
    );
  });
});

test("a token_command producing no output is an error, not an empty token", () => {
  const path = tempConfig({ token_command: "true" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.throws(
      () => resolveConfig(),
      (err: unknown) => err instanceof CliError && /no output/.test(err.message) && err.exitCode === 77,
    );
  });
});

test("a `Token ...` prefix from a helper is stripped", () => {
  const path = tempConfig({ token_command: "printf 'Token helper:secret'" });
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.equal(resolveConfig().token, "helper:secret");
  });
});

test("writeConfig creates the file mode 600", () => {
  const dir = mkdtempSync(join(tmpdir(), "bugcrowd-write-"));
  const path = join(dir, "nested", "config.json");
  writeConfig(path, { token: "a:b" });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { token: "a:b" });
});

test("writeConfig tightens the mode of an already-loose file", () => {
  const path = tempConfig({ token: "a:b" });
  chmodSync(path, 0o644);
  writeConfig(path, { token: "c:d" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeConfig preserves unrelated keys already in the file", () => {
  const path = tempConfig({ base_url: "https://alt.example.test", api_version: "V1.1.0" });
  const existing = readConfigForWrite(path);
  existing.token = "new:secret";
  writeConfig(path, existing);

  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  assert.equal(written["base_url"], "https://alt.example.test");
  assert.equal(written["api_version"], "V1.1.0");
  assert.equal(written["token"], "new:secret");
});

test("readConfigForWrite refuses to clobber a malformed file", () => {
  const path = tempConfig("{ not json at all");
  assert.throws(
    () => readConfigForWrite(path),
    (err: unknown) => err instanceof CliError && /refusing to overwrite/.test(err.message),
  );
});

test("readConfigForWrite treats a missing file as empty", () => {
  assert.deepEqual(readConfigForWrite(join(tmpdir(), "bugcrowd-absent-config.json")), {});
});

test("a world-readable literal token warns on stderr but still resolves", () => {
  const path = tempConfig({ token: "loose:secret" });
  chmodSync(path, 0o644);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    withEnv({ BUGCROWD_CONFIG: path }, () => {
      assert.equal(resolveConfig().token, "loose:secret");
    });
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }

  const output = written.join("");
  assert.match(output, /warning/);
  assert.match(output, /chmod 600/);
  // The warning must never echo the secret itself.
  assert.ok(!output.includes("loose:secret"));
});

test("a token_command file is not warned about even when loose", () => {
  const path = tempConfig({ token_command: "printf 'a:b'" });
  chmodSync(path, 0o644);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    withEnv({ BUGCROWD_CONFIG: path }, () => resolveConfig());
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }

  assert.equal(written.join(""), "");
});

/**
 * macOS-only: exercises the keychain round trip against an isolated service name.
 *
 * BUGCROWD_KEYCHAIN_SERVICE exists precisely so this test cannot touch the real
 * `bugcrowd-cli` entry. The keychain is one global namespace with no equivalent of
 * BUGCROWD_CONFIG, so an earlier version of this test destroyed a live credential.
 *
 * It is also the regression guard for the write itself: `security` reads the password
 * from /dev/tty rather than piped stdin whenever it has a controlling terminal, so the
 * spawn must be detached. A test cannot create a controlling terminal, but it can assert
 * that what goes in comes back out — the property that was silently violated.
 */
const macOnly = { skip: process.platform !== "darwin" ? "macOS only" : false };
const TEST_SERVICE = "bugcrowd-cli-test-do-not-use";

test("keychain store/read/delete round-trips the exact value", macOnly, async () => {
  const { keychainDelete, keychainRead, keychainService, keychainStore, DEFAULT_KEYCHAIN_SERVICE } = await import(
    "../src/lib/credentials.js"
  );

  const saved = process.env["BUGCROWD_KEYCHAIN_SERVICE"];
  process.env["BUGCROWD_KEYCHAIN_SERVICE"] = TEST_SERVICE;
  try {
    // Guard the guard: if the override ever stops working, fail rather than proceed to
    // mutate the real entry.
    assert.equal(keychainService(), TEST_SERVICE);
    assert.notEqual(keychainService(), DEFAULT_KEYCHAIN_SERVICE);

    // A value with characters that would be mangled by shell interpolation.
    const token = "round:trip$test with spaces&more";
    await keychainStore(token);
    assert.equal(keychainRead(), token);

    // -U must overwrite rather than create a second entry.
    await keychainStore("second:value");
    assert.equal(keychainRead(), "second:value");

    assert.equal(keychainDelete(), true);
    assert.equal(keychainRead(), undefined);
    assert.equal(keychainDelete(), false, "deleting a missing entry reports false");
  } finally {
    keychainDelete();
    if (saved === undefined) delete process.env["BUGCROWD_KEYCHAIN_SERVICE"];
    else process.env["BUGCROWD_KEYCHAIN_SERVICE"] = saved;
  }
});

test("isKeychainCommand recognises keychain lookups by shape, not exact text", async () => {
  const { isKeychainCommand } = await import("../src/lib/credentials.js");

  assert.equal(isKeychainCommand("security find-generic-password -s bugcrowd-cli -a api-token -w"), true);
  // A config written under a different service is still keychain-backed.
  assert.equal(isKeychainCommand("security find-generic-password -s other -a api-token -w"), true);
  assert.equal(isKeychainCommand("  security   find-generic-password -s x -w"), true);
  // Unrelated helpers must not be mistaken for one, or login would delete their entry.
  assert.equal(isKeychainCommand("op read op://Private/Bugcrowd/credential"), false);
  assert.equal(isKeychainCommand("pass show bugcrowd/api"), false);
  assert.equal(isKeychainCommand("security add-generic-password -s x"), false);
  assert.equal(isKeychainCommand(undefined), false);
});
