import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeToken, redactToken, resolveConfig } from "../src/lib/config.js";
import { CliError } from "../src/lib/errors.js";

const ENV_KEYS = ["BUGCROWD_API_TOKEN", "BUGCROWD_TOKEN", "BUGCROWD_BASE_URL", "BUGCROWD_API_VERSION", "BUGCROWD_CONFIG", "XDG_CONFIG_HOME"];

/** Runs `fn` with a clean set of Bugcrowd env vars, then restores the originals. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bugcrowd-cli-"));
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}

test("the --token flag wins over the environment", () => {
  withEnv({ BUGCROWD_API_TOKEN: "env:tok" }, () => {
    const config = resolveConfig({ token: "flag:tok" });
    assert.equal(config.token, "flag:tok");
    assert.equal(config.tokenSource, "--token flag");
  });
});

test("BUGCROWD_API_TOKEN wins over BUGCROWD_TOKEN", () => {
  withEnv({ BUGCROWD_API_TOKEN: "primary:tok", BUGCROWD_TOKEN: "legacy:tok" }, () => {
    assert.equal(resolveConfig().token, "primary:tok");
  });
});

test("the config file is the last resort and is reported as the source", () => {
  const path = writeConfig(JSON.stringify({ token: "file:tok", base_url: "https://alt.example.test" }));
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    const config = resolveConfig();
    assert.equal(config.token, "file:tok");
    assert.equal(config.tokenSource, path);
    assert.equal(config.baseUrl, "https://alt.example.test");
  });
});

test("a missing token is a clean error with setup instructions", () => {
  withEnv({ BUGCROWD_CONFIG: join(tmpdir(), "definitely-absent.json") }, () => {
    assert.throws(
      () => resolveConfig(),
      (err: unknown) =>
        err instanceof CliError && err.exitCode === 77 && err.details.join("\n").includes("BUGCROWD_API_TOKEN"),
    );
  });
});

test("a malformed config file reports the path", () => {
  const path = writeConfig("{ not json");
  withEnv({ BUGCROWD_CONFIG: path }, () => {
    assert.throws(() => resolveConfig(), (err: unknown) => err instanceof CliError && err.message.includes(path));
  });
});

test("a trailing slash on the base URL is trimmed", () => {
  withEnv({ BUGCROWD_API_TOKEN: "a:b", BUGCROWD_BASE_URL: "https://api.example.test/" }, () => {
    assert.equal(resolveConfig().baseUrl, "https://api.example.test");
  });
});

test("a pasted `Token ...` header value is accepted", () => {
  assert.equal(normalizeToken("Token user:secret"), "user:secret");
  assert.equal(normalizeToken("token user:secret"), "user:secret");
  assert.equal(normalizeToken("  user:secret  "), "user:secret");
});

test("redactToken keeps the username and hides the secret", () => {
  const redacted = redactToken("alice:supersecretvalue");
  assert.ok(redacted.startsWith("alice:su"));
  assert.ok(!redacted.includes("supersecretvalue"));
  assert.ok(!redactToken("nocolonhere").includes("nocolonhere"));
});
