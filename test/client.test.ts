import assert from "node:assert/strict";
import { test } from "node:test";

import { BugcrowdClient, clampLimit } from "../src/lib/client.js";
import type { ResolvedConfig } from "../src/lib/config.js";
import { ApiError } from "../src/lib/errors.js";
import type { Document } from "../src/lib/jsonapi.js";

const CONFIG: ResolvedConfig = {
  token: "user:secret",
  baseUrl: "https://api.example.test",
  apiVersion: "V1.1.0",
  tokenSource: "test",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Builds a fake fetch that replays the given responses and records every call. */
function stubFetch(responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index++;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    // null rather than "": the Response constructor rejects a body on 204/304.
    return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: spec.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(responses: Parameters<typeof stubFetch>[0], options: { maxRetries?: number } = {}) {
  const { impl, calls } = stubFetch(responses);
  const client = new BugcrowdClient(CONFIG, {
    fetchImpl: impl,
    sleepImpl: async () => {},
    maxRetries: options.maxRetries ?? 2,
  });
  return { client, calls };
}

test("sends auth, accept and version headers", async () => {
  const { client, calls } = makeClient([{ body: { data: [] } }]);
  await client.request("/submissions");

  assert.equal(calls[0]?.headers["Authorization"], "Token user:secret");
  assert.equal(calls[0]?.headers["Accept"], "application/vnd.bugcrowd+json");
  assert.equal(calls[0]?.headers["Bugcrowd-Version"], "V1.1.0");
});

test("builds query strings, skipping undefined and joining arrays", () => {
  const { client } = makeClient([{ body: {} }]);
  const url = client.buildUrl("/submissions", {
    "filter[state]": "new",
    "filter[severity]": ["1", "2"],
    "page[limit]": 25,
    include: undefined,
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/submissions");
  assert.equal(parsed.searchParams.get("filter[state]"), "new");
  assert.equal(parsed.searchParams.get("filter[severity]"), "1,2");
  assert.equal(parsed.searchParams.get("page[limit]"), "25");
  assert.equal(parsed.searchParams.has("include"), false);
});

test("non-2xx responses raise ApiError carrying the JSON:API errors", async () => {
  const { client } = makeClient([
    { status: 422, body: { errors: [{ title: "Invalid severity", detail: "must be 1..5" }] } },
  ]);

  await assert.rejects(
    () => client.request("/submissions/x", { method: "PATCH", body: {} }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 422);
      assert.ok(err.details.some((d) => d.includes("Invalid severity")));
      assert.ok(err.details.some((d) => d.includes("must be 1..5")));
      return true;
    },
  );
});

test("401 exits with the auth code and explains the token format", async () => {
  const { client } = makeClient([{ status: 401, body: { errors: [{ title: "Unauthorized" }] } }]);
  await assert.rejects(
    () => client.request("/programs"),
    (err: unknown) => err instanceof ApiError && err.exitCode === 77 && err.details.join("\n").includes("username:password"),
  );
});

test("retries 429 then succeeds", async () => {
  const { client, calls } = makeClient([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 200, body: { data: [{ type: "submission", id: "s1" }] } },
  ]);

  const doc = await client.request<Document>("/submissions");
  assert.equal(calls.length, 2);
  assert.equal(Array.isArray(doc.data) ? doc.data.length : 0, 1);
});

test("gives up after maxRetries and surfaces the last status", async () => {
  const { client, calls } = makeClient([{ status: 503 }], { maxRetries: 2 });
  await assert.rejects(() => client.request("/submissions"), ApiError);
  assert.equal(calls.length, 3);
});

test("4xx other than 429 is not retried", async () => {
  const { client, calls } = makeClient([{ status: 404, body: { errors: [{ title: "Not Found" }] } }]);
  await assert.rejects(() => client.request("/submissions/nope"), ApiError);
  assert.equal(calls.length, 1);
});

test("204 with an empty body resolves rather than failing to parse", async () => {
  const { client } = makeClient([{ status: 204 }]);
  assert.deepEqual(await client.request("/access_invitations/x", { method: "DELETE" }), {});
});

test("paginate follows links.next and stops on the last page", async () => {
  const page = (ids: string[], next: string | null): { body: Document } => ({
    body: {
      data: ids.map((id) => ({ type: "submission", id })),
      links: next === null ? {} : { next },
    },
  });

  const { client, calls } = makeClient([
    page(["a", "b"], "/submissions?page[offset]=2"),
    page(["c", "d"], "/submissions?page[offset]=4"),
    page(["e"], null),
  ]);

  const ids: string[] = [];
  for await (const doc of client.paginate("/submissions", { query: { "page[limit]": 2 } })) {
    for (const resource of Array.isArray(doc.data) ? doc.data : []) ids.push(resource.id);
  }

  assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1]!.url).searchParams.get("page[offset]"), "2");
});

test("paginate stops at max without over-fetching", async () => {
  const { client, calls } = makeClient([
    { body: { data: [{ type: "submission", id: "a" }, { type: "submission", id: "b" }], links: { next: "/submissions?page[offset]=2" } } },
  ]);

  const ids: string[] = [];
  for await (const doc of client.paginate("/submissions", { query: { "page[limit]": 100 }, max: 2 })) {
    for (const resource of Array.isArray(doc.data) ? doc.data : []) ids.push(resource.id);
  }

  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(calls.length, 1);
  // The page limit is narrowed to the remaining budget rather than the full 100.
  assert.equal(new URL(calls[0]!.url).searchParams.get("page[limit]"), "2");
});

test("paginate terminates when a short page arrives with no next link", async () => {
  const { client, calls } = makeClient([{ body: { data: [{ type: "submission", id: "a" }] } }]);
  let pages = 0;
  for await (const _doc of client.paginate("/submissions", { query: { "page[limit]": 25 } })) pages++;
  assert.equal(pages, 1);
  assert.equal(calls.length, 1);
});

test("clampLimit keeps page[limit] inside the API's bounds", () => {
  assert.equal(clampLimit(0), 25);
  assert.equal(clampLimit(-5), 25);
  assert.equal(clampLimit(50), 50);
  assert.equal(clampLimit(1000), 100);
  assert.equal(clampLimit(Number.NaN), 25);
});

test("POST bodies are serialized with a JSON content type", async () => {
  const { client, calls } = makeClient([{ body: { data: { type: "comment", id: "c1" } } }]);
  await client.request("/comments", { method: "POST", body: { data: { type: "comment" } } });

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["Content-Type"], "application/json");
  assert.equal(calls[0]?.body, '{"data":{"type":"comment"}}');
});
