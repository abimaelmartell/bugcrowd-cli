import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, type FlagSpec } from "../src/lib/args.js";
import { CliError } from "../src/lib/errors.js";

const SPECS: readonly FlagSpec[] = [
  { name: "state", short: "s", type: "string", repeat: true, values: ["new", "triaged"], desc: "" },
  { name: "limit", short: "n", type: "int", desc: "" },
  { name: "all", type: "boolean", desc: "" },
  { name: "color", type: "boolean", desc: "" },
  { name: "search", type: "string", desc: "" },
  { name: "query", short: "q", type: "string", repeat: true, split: false, desc: "" },
];

test("parses positionals and separated flag values", () => {
  const args = parseArgs(["abc", "--state", "new", "-n", "50"], SPECS);
  assert.deepEqual(args.positionals, ["abc"]);
  assert.deepEqual(args.list("state"), ["new"]);
  assert.equal(args.int("limit"), 50);
});

test("parses --flag=value form", () => {
  const args = parseArgs(["--state=triaged", "--limit=5"], SPECS);
  assert.deepEqual(args.list("state"), ["triaged"]);
  assert.equal(args.int("limit"), 5);
});

test("repeatable flags accumulate across occurrences and comma splits", () => {
  const args = parseArgs(["--state", "new,triaged", "--state", "new"], SPECS);
  assert.deepEqual(args.list("state"), ["new", "triaged", "new"]);
});

test("split:false keeps commas inside a single value", () => {
  const args = parseArgs(["-q", "filter[state]=new,triaged", "-q", "page[limit]=5"], SPECS);
  assert.deepEqual(args.list("query"), ["filter[state]=new,triaged", "page[limit]=5"]);
});

test("booleans default true and support --no- negation", () => {
  assert.equal(parseArgs(["--all"], SPECS).bool("all"), true);
  assert.equal(parseArgs(["--no-all"], SPECS).bool("all"), false);
  assert.equal(parseArgs([], SPECS).boolOrUndefined("all"), undefined);
  assert.equal(parseArgs(["--no-color"], SPECS).boolOrUndefined("color"), false);
});

test("bundled short booleans are expanded", () => {
  const specs: FlagSpec[] = [
    { name: "json", short: "j", type: "boolean", desc: "" },
    { name: "verbose", short: "v", type: "boolean", desc: "" },
  ];
  const args = parseArgs(["-jv"], specs);
  assert.equal(args.bool("json"), true);
  assert.equal(args.bool("verbose"), true);
});

test("short flag accepts an attached value", () => {
  assert.equal(parseArgs(["-n25"], SPECS).int("limit"), 25);
});

test("everything after -- is positional", () => {
  const args = parseArgs(["--all", "--", "--state", "weird"], SPECS);
  assert.equal(args.bool("all"), true);
  assert.deepEqual(args.positionals, ["--state", "weird"]);
});

test("unknown flags are rejected with a suggestion", () => {
  assert.throws(
    () => parseArgs(["--stat", "new"], SPECS),
    (err: unknown) => err instanceof CliError && /unknown flag --stat/.test(err.message) && err.details.some((d) => d.includes("--state")),
  );
});

test("values outside the allowed set are rejected", () => {
  assert.throws(
    () => parseArgs(["--state", "bogus"], SPECS),
    (err: unknown) => err instanceof CliError && /invalid value "bogus"/.test(err.message),
  );
});

test("non-integer values are rejected for int flags", () => {
  assert.throws(() => parseArgs(["--limit", "many"], SPECS), CliError);
});

test("a flag needing a value at the end of argv errors", () => {
  assert.throws(() => parseArgs(["--search"], SPECS), CliError);
});

test("values that look like flags are still accepted after a string flag", () => {
  const args = parseArgs(["--search", "-weird-text"], SPECS);
  assert.equal(args.str("search"), "-weird-text");
});
