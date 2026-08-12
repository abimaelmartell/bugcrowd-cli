import assert from "node:assert/strict";
import { test } from "node:test";

import { nextOffset, normalize, normalizeOne, type Document } from "../src/lib/jsonapi.js";

test("hoists attributes and drops the envelope", () => {
  const doc: Document = {
    data: [
      {
        type: "submission",
        id: "s1",
        attributes: { title: "XSS in login", severity: 2, state: "triaged" },
      },
    ],
  };
  assert.deepEqual(normalize(doc), [
    { id: "s1", type: "submission", title: "XSS in login", severity: 2, state: "triaged" },
  ]);
});

test("resolves relationships from the included array", () => {
  const doc: Document = {
    data: [
      {
        type: "submission",
        id: "s1",
        attributes: { title: "IDOR" },
        relationships: {
          program: { data: { type: "program", id: "p1" } },
          target: { data: { type: "target", id: "t1" } },
        },
      },
    ],
    included: [
      { type: "program", id: "p1", attributes: { code: "acme", name: "Acme" } },
      { type: "target", id: "t1", attributes: { name: "api.acme.test", category: "api" } },
    ],
  };

  const [record] = normalize(doc);
  assert.deepEqual(record?.["program"], { id: "p1", type: "program", code: "acme", name: "Acme" });
  assert.deepEqual(record?.["target"], { id: "t1", type: "target", name: "api.acme.test", category: "api" });
});

test("relationships that were not included collapse to their identifier", () => {
  const doc: Document = {
    data: {
      type: "submission",
      id: "s1",
      relationships: { program: { data: { type: "program", id: "p9" } } },
    },
  };
  assert.deepEqual(normalizeOne(doc)?.["program"], { type: "program", id: "p9" });
});

test("to-many relationships resolve into arrays and null stays null", () => {
  const doc: Document = {
    data: {
      type: "submission",
      id: "s1",
      relationships: {
        assignees: { data: [{ type: "identity", id: "i1" }, { type: "identity", id: "i2" }] },
        duplicate_of: { data: null },
      },
    },
    included: [
      { type: "identity", id: "i1", attributes: { email: "a@example.test" } },
      { type: "identity", id: "i2", attributes: { email: "b@example.test" } },
    ],
  };

  const record = normalizeOne(doc);
  assert.deepEqual(record?.["assignees"], [
    { id: "i1", type: "identity", email: "a@example.test" },
    { id: "i2", type: "identity", email: "b@example.test" },
  ]);
  assert.equal(record?.["duplicate_of"], null);
});

test("cycles terminate instead of recursing forever", () => {
  const doc: Document = {
    data: {
      type: "submission",
      id: "s1",
      attributes: { title: "original" },
      relationships: { duplicates: { data: [{ type: "submission", id: "s2" }] } },
    },
    included: [
      {
        type: "submission",
        id: "s2",
        attributes: { title: "dupe" },
        relationships: { duplicate_of: { data: { type: "submission", id: "s1" } } },
      },
    ],
  };

  const record = normalizeOne(doc);
  const duplicates = record?.["duplicates"] as Record<string, unknown>[];
  assert.equal(duplicates[0]?.["title"], "dupe");
  // The back-reference to s1 degrades to an identifier rather than looping.
  assert.deepEqual(duplicates[0]?.["duplicate_of"], { type: "submission", id: "s1" });
});

test("a sibling in data is NOT expanded, only what `included` side-loaded", () => {
  // This is the inverse of what an earlier version did, and the inversion is the point.
  // Expanding siblings from `data` made every record carry copies of its neighbours:
  // on real data, 44 submissions each expanded their program, whose `submissions`
  // to-many listed all 44 back again, producing 355MB of JSON. `include=` is the
  // contract for what gets expanded, and a sibling was never asked for.
  const doc: Document = {
    data: [
      {
        type: "submission",
        id: "s1",
        attributes: { title: "one" },
        relationships: { duplicate_of: { data: { type: "submission", id: "s2" } } },
      },
      { type: "submission", id: "s2", attributes: { title: "two" } },
    ],
  };
  const [first] = normalize(doc);
  assert.deepEqual(first?.["duplicate_of"], { type: "submission", id: "s2" });
});

test("a to-many relationship pointing back at the primary set stays linear in size", () => {
  // The exact shape that blew up: N submissions -> one program -> back to all N.
  const N = 40;
  const doc: Document = {
    data: Array.from({ length: N }, (_, i) => ({
      type: "submission",
      id: `s${i}`,
      // A large attribute, so any duplication shows up loudly in the output size.
      attributes: { title: `finding ${i}`, description: "x".repeat(4000) },
      relationships: { program: { data: { type: "program", id: "p1" } } },
    })),
    included: [
      {
        type: "program",
        id: "p1",
        attributes: { code: "acme" },
        relationships: {
          submissions: { data: Array.from({ length: N }, (_, i) => ({ type: "submission", id: `s${i}` })) },
        },
      },
    ],
  };

  const records = normalize(doc);
  assert.equal(records.length, N);

  const size = JSON.stringify(records).length;
  // Linear would be ~N * 4KB. Quadratic would be ~N * N * 4KB (6.4MB at N=40).
  assert.ok(size < N * 4000 * 3, `output should stay linear, got ${size} bytes for ${N} records`);

  // The program still expands, because it genuinely was included.
  const program = records[0]?.["program"] as Record<string, unknown>;
  assert.equal(program["code"], "acme");
  // But its to-many pointing back at the primary set is not carried along.
  assert.equal("submissions" in program, false);
});

test("nested resources keep relationships that were included", () => {
  const doc: Document = {
    data: {
      type: "submission",
      id: "s1",
      relationships: { program: { data: { type: "program", id: "p1" } } },
    },
    included: [
      {
        type: "program",
        id: "p1",
        attributes: { code: "acme" },
        relationships: { organization: { data: { type: "organization", id: "o1" } } },
      },
      { type: "organization", id: "o1", attributes: { name: "Acme" } },
    ],
  };

  // include=program.organization must survive two levels down.
  const program = normalizeOne(doc)?.["program"] as Record<string, unknown>;
  const org = program["organization"] as Record<string, unknown>;
  assert.equal(org["name"], "Acme");
});

test("deeply recursive includes terminate", () => {
  // A chain long enough to exceed the depth cap, each link resolvable.
  const included: Document["included"] = [];
  for (let i = 1; i <= 20; i++) {
    included.push({
      type: "node",
      id: `n${i}`,
      attributes: { depth: i },
      relationships: { child: { data: { type: "node", id: `n${i + 1}` } } },
    });
  }
  const doc: Document = {
    data: { type: "node", id: "n0", relationships: { child: { data: { type: "node", id: "n1" } } } },
    included,
  };

  // Terminating at all is the assertion; the cap keeps it from running away.
  const record = normalizeOne(doc);
  let node = record?.["child"] as Record<string, unknown> | undefined;
  let levels = 0;
  while (node && typeof node === "object" && "child" in node) {
    node = node["child"] as Record<string, unknown>;
    levels++;
    assert.ok(levels < 30, "expansion must terminate");
  }
  assert.ok(levels > 0);
});

test("attributes cannot shadow id or type", () => {
  const doc: Document = {
    data: { type: "submission", id: "real", attributes: { id: "fake", type: "fake", title: "t" } },
  };
  const record = normalizeOne(doc);
  assert.equal(record?.id, "real");
  assert.equal(record?.type, "submission");
});

test("empty and null data normalize to an empty list", () => {
  assert.deepEqual(normalize({ data: [] }), []);
  assert.deepEqual(normalize({ data: null }), []);
  assert.deepEqual(normalize({}), []);
});

test("nextOffset reads page[offset] out of links.next", () => {
  assert.equal(nextOffset({ links: { next: "/submissions?page%5Blimit%5D=25&page%5Boffset%5D=25" } }), 25);
  assert.equal(nextOffset({ links: { next: "https://api.bugcrowd.com/submissions?page[offset]=100" } }), 100);
  assert.equal(nextOffset({ links: { next: null } }), undefined);
  assert.equal(nextOffset({}), undefined);
  assert.equal(nextOffset({ links: { next: "/submissions" } }), undefined);
});
