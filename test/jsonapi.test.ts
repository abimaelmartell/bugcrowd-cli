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

test("a relationship pointing at a sibling in data resolves", () => {
  const doc: Document = {
    data: [
      { type: "submission", id: "s1", attributes: { title: "one" }, relationships: { duplicate_of: { data: { type: "submission", id: "s2" } } } },
      { type: "submission", id: "s2", attributes: { title: "two" } },
    ],
  };
  const [first] = normalize(doc);
  assert.equal((first?.["duplicate_of"] as Record<string, unknown>)["title"], "two");
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
