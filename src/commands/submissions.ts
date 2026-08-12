import { clampLimit } from "../lib/client.js";
import { collect, filterValue, moreHint } from "../lib/collect.js";
import {
  PAGE_FLAGS,
  pageOptions,
  rejectExtraPositionals,
  requirePositional,
  type Command,
  type Context,
} from "../lib/command.js";
import { CliError } from "../lib/errors.js";
import type { Document, Normalized } from "../lib/jsonapi.js";
import { nextOffset, normalize, normalizeOne } from "../lib/jsonapi.js";
import {
  isoTime,
  relatedName,
  relatedNames,
  severityLabel,
  shortTime,
  text,
  type Column,
  type RecordSection,
} from "../lib/output.js";

/**
 * The submissions filter spells multi-word states with hyphens (`out-of-scope`) while
 * the resource attribute and the PATCH body use underscores (`out_of_scope`). Each side
 * advertises its own spelling in --help but accepts the other via `normalize`, so
 * `--state out_of_scope` and `--state out-of-scope` both work everywhere.
 */
const FILTER_STATES = [
  "new",
  "triaged",
  "unresolved",
  "resolved",
  "informational",
  "out-of-scope",
  "not-applicable",
  "not-reproducible",
] as const;

const WRITE_STATES = FILTER_STATES.map((state) => state.replace(/-/g, "_"));

const toFilterState = (value: string): string => value.replace(/_/g, "-");
const toWriteState = (value: string): string => value.replace(/-/g, "_");

const SOURCES = ["api", "csv", "platform", "qualys", "external_form", "email", "jira", "customer_source"] as const;

const TARGET_TYPES = [
  "website",
  "api",
  "ios",
  "android",
  "iot",
  "hardware",
  "network",
  "other",
  "ip_address",
  "collection",
] as const;

const BLOCKED_BY = ["present", "none", "bugcrowd-operations", "customer", "researcher"] as const;
const RETEST = ["pending", "completed", "patched", "failed", "present", "none"] as const;
const PRESENCE = ["present", "none"] as const;

const SORTS = ["submitted-asc", "submitted-desc", "severity-asc", "severity-desc", "updated-asc", "updated-desc"] as const;

const VISIBILITY = ["everyone", "bugcrowd_and_researcher", "bugcrowd_and_customer", "customer", "bugcrowd"] as const;

/** Included by default so list output can show program and target names, not bare UUIDs. */
const LIST_INCLUDES = "program,target,assignee";

/** A single submission is worth fetching in full; these are the relationships people read. */
const GET_INCLUDES =
  "program,program.organization,target,assignee,assignees,cvss_vector,engagement,monetary_rewards,duplicate_of,active_blocker,researcher";

const FILTER_FLAGS = [
  {
    name: "program",
    short: "p",
    type: "string" as const,
    repeat: true,
    placeholder: "CODE",
    desc: "Program code (see `bugcrowd programs list`)",
  },
  { name: "engagement", type: "string" as const, repeat: true, placeholder: "CODE", desc: "Engagement code" },
  {
    name: "state",
    short: "s",
    type: "string" as const,
    repeat: true,
    values: FILTER_STATES,
    normalize: toFilterState,
    desc: "Submission state",
  },
  {
    name: "severity",
    type: "string" as const,
    repeat: true,
    values: ["1", "2", "3", "4", "5"],
    placeholder: "1-5",
    desc: "Severity as a number, where 1 is P1/critical",
  },
  {
    name: "assignee",
    short: "a",
    type: "string" as const,
    repeat: true,
    placeholder: "EMAIL|me|none",
    desc: "Assignee email, or the keywords me / none",
  },
  { name: "researcher", type: "string" as const, repeat: true, placeholder: "USERNAME", desc: "Researcher username" },
  { name: "target", short: "t", type: "string" as const, repeat: true, placeholder: "NAME", desc: "Target name" },
  { name: "target-type", type: "string" as const, repeat: true, values: TARGET_TYPES, desc: "Target type" },
  { name: "source", type: "string" as const, repeat: true, values: SOURCES, desc: "How the submission was created" },
  { name: "vrt", type: "string" as const, placeholder: "VRT_ID", desc: "Dot-separated VRT id, e.g. cross_site_scripting_xss" },
  { name: "search", type: "string" as const, placeholder: "TEXT", desc: "Free-text search over title, description and comments" },
  { name: "duplicate", type: "boolean" as const, desc: "Only duplicates (--no-duplicate for only non-duplicates)" },
  { name: "blocked-by", type: "string" as const, repeat: true, values: BLOCKED_BY, desc: "Who the submission is blocked on" },
  { name: "retest", type: "string" as const, repeat: true, values: RETEST, desc: "Retest status" },
  { name: "payments", type: "string" as const, values: PRESENCE, desc: "Whether a payment exists" },
  { name: "points", type: "string" as const, values: PRESENCE, desc: "Whether points were awarded" },
  {
    name: "submitted",
    type: "string" as const,
    placeholder: "RANGE",
    desc: "Submitted date filter, e.g. 2026-01-01 or from.2026-01-01,to.2026-02-01",
  },
  { name: "updated", type: "string" as const, placeholder: "RANGE", desc: "Updated date filter, same syntax as --submitted" },
  {
    name: "last-activity",
    type: "string" as const,
    placeholder: "RANGE",
    desc: "Last activity date filter, same syntax as --submitted",
  },
];

/** Translates the filter flags into `filter[...]` query parameters. */
function buildFilters(ctx: Context): Record<string, string | undefined> {
  const { args } = ctx;
  const states = args.list("state");
  const duplicate = args.boolOrUndefined("duplicate");

  return {
    "filter[program]": filterValue(args.list("program")),
    "filter[engagement]": filterValue(args.list("engagement")),
    "filter[state]": filterValue(states),
    "filter[severity]": filterValue(args.list("severity")),
    "filter[assignee]": filterValue(args.list("assignee")),
    "filter[researcher]": filterValue(args.list("researcher")),
    "filter[target]": filterValue(args.list("target")),
    "filter[target_type]": filterValue(args.list("target-type")),
    "filter[source]": filterValue(args.list("source")),
    "filter[vrt]": args.str("vrt"),
    "filter[search]": args.str("search"),
    "filter[duplicate]": duplicate === undefined ? undefined : String(duplicate),
    "filter[blocked_by]": filterValue(args.list("blocked-by")),
    "filter[retest]": filterValue(args.list("retest")),
    "filter[payments]": args.str("payments"),
    "filter[points]": args.str("points"),
    "filter[submitted]": args.str("submitted"),
    "filter[updated]": args.str("updated"),
    "filter[last_activity_feed_item_created_at]": args.str("last-activity"),
  };
}

const LIST_COLUMNS: readonly Column<Normalized>[] = [
  { header: "ID", get: (r) => r.id },
  { header: "SEV", get: (r) => severityLabel(r["severity"]) },
  { header: "STATE", get: (r) => text(r["state"]) },
  { header: "SUBMITTED", get: (r) => shortTime(r["submitted_at"]) },
  { header: "PROGRAM", get: (r) => relatedName(r["program"], ["code", "name"]), maxWidth: 22 },
  { header: "TARGET", get: (r) => relatedName(r["target"], ["name"]), maxWidth: 22 },
  { header: "TITLE", get: (r) => text(r["title"]), maxWidth: 70 },
];

const listCommand: Command = {
  name: "submissions list",
  summary: "List submissions, newest first",
  description:
    "Filters combine with AND; repeating a single filter is an OR over its values.\n" +
    "Program and target names are resolved by default, so `--format json` gives you\n" +
    "nested objects rather than bare relationship ids.",
  flags: [
    ...FILTER_FLAGS,
    ...PAGE_FLAGS,
    { name: "sort", type: "string", repeat: true, values: SORTS, desc: "Sort order (default submitted-desc)" },
    {
      name: "include",
      type: "string",
      repeat: true,
      placeholder: "REL",
      desc: `Relationships to side-load (default ${LIST_INCLUDES})`,
    },
    { name: "fields", type: "string", repeat: true, placeholder: "ATTR", desc: "Limit submission attributes returned" },
  ],
  examples: [
    "bugcrowd submissions list --state new --sort severity-asc",
    "bugcrowd submissions list --program acme --severity 1 --severity 2 --all",
    "bugcrowd submissions list --assignee me --state triaged --json",
    "bugcrowd submissions list --search 'idor' --submitted from.2026-01-01 --max 200",
  ],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const include = ctx.args.list("include");
    const fields = ctx.args.list("fields");
    const sort = ctx.args.list("sort");

    const collected = await collect(ctx, "/submissions", {
      ...buildFilters(ctx),
      include: filterValue(include.length > 0 ? include : [LIST_INCLUDES]),
      "fields[submission]": filterValue(fields),
      sort: filterValue(sort.length > 0 ? sort : ["submitted-desc"]),
    });

    ctx.out.collection(collected.records, LIST_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No submissions matched those filters.",
      footer: moreHint(collected, ctx),
    });
  },
};

const GET_SECTIONS: readonly RecordSection<Normalized>[] = [
  { label: "ID", get: (r) => r.id },
  { label: "Title", get: (r) => text(r["title"]) },
  { label: "State", get: (r) => text(r["state"]) },
  {
    label: "Severity",
    get: (r) => {
      const cvss = r["cvss_vector"];
      const score =
        cvss && typeof cvss === "object" ? (cvss as Record<string, unknown>)["score"] : undefined;
      const base = severityLabel(r["severity"]);
      return typeof score === "number" ? `${base} (CVSS ${score})` : base;
    },
  },
  { label: "Duplicate", get: (r) => (r["duplicate"] === true ? `yes (of ${relatedName(r["duplicate_of"], ["id"])})` : "no") },
  { label: "Program", get: (r) => relatedName(r["program"], ["code", "name"]) },
  { label: "Engagement", get: (r) => relatedName(r["engagement"], ["code"]) },
  { label: "Target", get: (r) => relatedName(r["target"], ["name"]) },
  { label: "Researcher", get: (r) => relatedName(r["researcher"], ["name", "email"]) },
  { label: "Assignees", get: (r) => relatedNames(r["assignees"], ["email", "name"]) },
  { label: "VRT", get: (r) => text(r["vrt_id"]) },
  { label: "Submitted", get: (r) => isoTime(r["submitted_at"]) },
  { label: "Last activity", get: (r) => isoTime(r["last_activity_feed_item_created_at"]) },
  { label: "Bug URL", get: (r) => text(r["bug_url"]) },
  {
    label: "Reward",
    get: (r) => {
      const rewards = r["monetary_rewards"];
      if (!Array.isArray(rewards) || rewards.length === 0) return "-";
      return rewards
        .map((reward) => {
          const record = reward as Record<string, unknown>;
          const amount = record["formatted_amount"] ?? record["amount_cents"];
          return record["cancelled"] === true ? `${text(amount)} (cancelled)` : text(amount);
        })
        .join(", ");
    },
  },
  {
    label: "Blocked",
    get: (r) => {
      const blocker = r["active_blocker"];
      if (!blocker || typeof blocker !== "object") return undefined;
      const record = blocker as Record<string, unknown>;
      return `${text(record["blocked_by"])}${record["reason"] ? ` — ${text(record["reason"])}` : ""}`;
    },
  },
  { label: "Description", get: (r) => (typeof r["description"] === "string" ? r["description"] : undefined), block: true },
  { label: "Extra info", get: (r) => (typeof r["extra_info"] === "string" ? r["extra_info"] : undefined), block: true },
  {
    label: "HTTP request",
    get: (r) => (typeof r["http_request"] === "string" ? r["http_request"] : undefined),
    block: true,
  },
  {
    label: "Remediation advice",
    get: (r) => (typeof r["remediation_advice"] === "string" ? r["remediation_advice"] : undefined),
    block: true,
  },
  {
    label: "References",
    get: (r) => (typeof r["vulnerability_references"] === "string" ? r["vulnerability_references"] : undefined),
    block: true,
  },
];

const getCommand: Command = {
  name: "submissions get",
  summary: "Show one submission in full",
  positionals: [{ name: "id", desc: "Submission UUID", required: true }],
  flags: [
    {
      name: "include",
      type: "string",
      repeat: true,
      placeholder: "REL",
      desc: "Relationships to side-load (defaults to the common set)",
    },
  ],
  examples: ["bugcrowd submissions get 10000000-0000-0000-0000-000000000000", "bugcrowd submissions get <id> --json"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);
    const include = ctx.args.list("include");

    const doc = await ctx.client().request<Document>(`/submissions/${encodeURIComponent(id)}`, {
      query: { include: filterValue(include.length > 0 ? include : [GET_INCLUDES]) },
    });
    const record = normalizeOne(doc);
    if (!record) throw new CliError(`submission ${id} returned no data`);
    ctx.out.record(record, GET_SECTIONS, { rawDoc: doc });
  },
};

const commentsCommand: Command = {
  name: "submissions comments",
  summary: "List the comment thread on a submission",
  positionals: [{ name: "id", desc: "Submission UUID", required: true }],
  flags: [
    ...PAGE_FLAGS,
    { name: "visibility", type: "string", repeat: true, values: VISIBILITY, desc: "Filter by visibility scope" },
  ],
  examples: ["bugcrowd submissions comments <id>", "bugcrowd submissions comments <id> --visibility everyone"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);

    const collected = await collect(ctx, `/submissions/${encodeURIComponent(id)}/comments`, {
      include: "author",
      "filter[visibility_scope]": filterValue(ctx.args.list("visibility")),
    });

    if (ctx.out.isText) {
      // A comment thread reads better as prose than as a table.
      if (collected.records.length === 0) {
        ctx.out.line("No comments.");
      }
      for (const [index, comment] of collected.records.entries()) {
        if (index > 0) ctx.out.line();
        const author = relatedName(comment["author"], ["name", "email"]);
        ctx.out.line(
          ctx.out.bold(`${author} · ${shortTime(comment["created_at"])} · ${text(comment["visibility_scope"])}`),
        );
        for (const commentLine of text(comment["body"], "").split("\n")) ctx.out.line(`  ${commentLine}`);
      }
      const hint = moreHint(collected, ctx);
      if (hint) {
        ctx.out.line();
        ctx.out.line(ctx.out.dim(hint));
      }
      return;
    }

    ctx.out.collection(collected.records, [], { rawDocs: collected.docs });
  },
};

const ACTIVITY_COLUMNS: readonly Column<Normalized>[] = [
  { header: "CREATED", get: (r) => shortTime(r["created_at"]) },
  { header: "KEY", get: (r) => text(r["key"]) },
  { header: "ACTOR", get: (r) => relatedName(r["actor"], ["name", "email"]) },
];

const activitiesCommand: Command = {
  name: "submissions activities",
  summary: "List the activity/audit feed for a submission",
  positionals: [{ name: "id", desc: "Submission UUID", required: true }],
  flags: [
    ...PAGE_FLAGS,
    { name: "key", type: "string", repeat: true, placeholder: "KEY", desc: "Filter by activity key" },
  ],
  examples: ["bugcrowd submissions activities <id> --all"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);

    const collected = await collect(ctx, `/submissions/${encodeURIComponent(id)}/activities`, {
      include: "actor,event",
      "filter[key]": filterValue(ctx.args.list("key")),
    });

    ctx.out.collection(collected.records, ACTIVITY_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No activity.",
      footer: moreHint(collected, ctx),
    });
  },
};

const updateCommand: Command = {
  name: "submissions update",
  summary: "Update a submission's state, severity or other fields",
  description:
    "Only the flags you pass are sent, so unspecified fields are left untouched.\n" +
    "This writes to the Bugcrowd platform and is visible to the program.",
  positionals: [{ name: "id", desc: "Submission UUID", required: true }],
  flags: [
    { name: "state", type: "string", values: WRITE_STATES, normalize: toWriteState, desc: "New state" },
    { name: "severity", type: "int", placeholder: "1-5", desc: "New severity, 1 (critical) to 5 (informational)" },
    { name: "title", type: "string", placeholder: "TEXT", desc: "New title" },
    { name: "vrt-id", type: "string", placeholder: "VRT_ID", desc: "New VRT classification" },
    { name: "bug-url", type: "string", placeholder: "URL", desc: "New bug URL" },
    { name: "http-request", type: "string", placeholder: "TEXT", desc: "Replacement HTTP request body" },
    { name: "remediation-advice", type: "string", placeholder: "TEXT", desc: "Replacement remediation advice" },
    { name: "references", type: "string", placeholder: "TEXT", desc: "Replacement vulnerability references" },
    {
      name: "assignee",
      type: "string",
      placeholder: "EMAIL|none",
      desc: "Set the assignee by email, or `none` to unassign",
    },
    {
      name: "duplicate-of",
      type: "string",
      placeholder: "UUID|none",
      desc: "Mark as a duplicate of another submission, or `none` to clear",
    },
  ],
  examples: [
    "bugcrowd submissions update <id> --state triaged --severity 2",
    "bugcrowd submissions update <id> --assignee alice@example.com",
    "bugcrowd submissions update <id> --duplicate-of <other-id>",
  ],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);
    const { args } = ctx;

    const attributes: Record<string, unknown> = {};
    const setIf = (flag: string, key: string) => {
      const value = args.str(flag);
      if (value !== undefined) attributes[key] = value;
    };
    setIf("state", "state");
    setIf("title", "title");
    setIf("vrt-id", "vrt_id");
    setIf("bug-url", "bug_url");
    setIf("http-request", "http_request");
    setIf("remediation-advice", "remediation_advice");
    setIf("references", "vulnerability_references");

    const severity = args.int("severity");
    if (severity !== undefined) {
      if (severity < 1 || severity > 5) throw new CliError("--severity must be between 1 and 5");
      attributes["severity"] = severity;
    }

    const relationships: Record<string, unknown> = {};
    const assignee = args.str("assignee");
    if (assignee !== undefined) {
      relationships["assignee"] =
        assignee === "none" ? { data: null } : { data: { type: "identity", attributes: { email: assignee } } };
    }
    const duplicateOf = args.str("duplicate-of");
    if (duplicateOf !== undefined) {
      relationships["duplicate_of"] =
        duplicateOf === "none" ? { data: null } : { data: { type: "submission", id: duplicateOf } };
    }

    if (Object.keys(attributes).length === 0 && Object.keys(relationships).length === 0) {
      throw new CliError("nothing to update", {
        exitCode: 2,
        details: ["Pass at least one field, e.g. --state triaged. See `bugcrowd submissions update --help`."],
      });
    }

    const data: Record<string, unknown> = { type: "submission" };
    if (Object.keys(attributes).length > 0) data["attributes"] = attributes;
    if (Object.keys(relationships).length > 0) data["relationships"] = relationships;

    const doc = await ctx.client().request<Document>(`/submissions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { data },
    });

    const record = normalizeOne(doc);
    if (!record) {
      ctx.out.line("Updated.");
      return;
    }
    if (ctx.out.isText) {
      ctx.out.line(`Updated ${record.id}: state=${text(record["state"])} severity=${severityLabel(record["severity"])}`);
      return;
    }
    ctx.out.record(record, GET_SECTIONS, { rawDoc: doc });
  },
};

const commentCommand: Command = {
  name: "submissions comment",
  summary: "Post a comment on a submission",
  description:
    "Comments are visible on the Bugcrowd platform. --visibility is required so the\n" +
    "audience is always an explicit choice rather than a default.",
  positionals: [{ name: "id", desc: "Submission UUID", required: true }],
  flags: [
    { name: "body", short: "b", type: "string", placeholder: "TEXT", desc: "Comment body; use - to read stdin" },
    {
      name: "visibility",
      type: "string",
      values: VISIBILITY,
      desc: "Who can see the comment (required)",
    },
  ],
  examples: [
    "bugcrowd submissions comment <id> --body 'Reproduced, escalating.' --visibility bugcrowd_and_researcher",
    "cat notes.md | bugcrowd submissions comment <id> --body - --visibility customer",
  ],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);

    const visibility = ctx.args.str("visibility");
    if (visibility === undefined) {
      throw new CliError("--visibility is required when posting a comment", {
        exitCode: 2,
        details: [`Valid values: ${VISIBILITY.join(", ")}`],
      });
    }

    let body = ctx.args.str("body");
    if (body === undefined) throw new CliError("--body is required", { exitCode: 2 });
    if (body === "-") body = await readStdin();
    if (body.trim() === "") throw new CliError("comment body is empty");

    const doc = await ctx.client().request<Document>("/comments", {
      method: "POST",
      body: {
        data: {
          type: "comment",
          attributes: { body, visibility_scope: visibility },
          relationships: { submission: { data: { type: "submission", id } } },
        },
      },
    });

    const record = normalizeOne(doc);
    if (ctx.out.isText) {
      ctx.out.line(`Comment posted${record ? ` (${record.id})` : ""}.`);
      return;
    }
    ctx.out.raw(record ?? doc);
  },
};

const searchCommand: Command = {
  name: "submissions search",
  summary: "Search submissions via POST, for filters too long for a URL",
  description:
    "Identical filtering to `submissions list`, but sent as a JSON request body.\n" +
    "Use this when a filter list (many targets, many programs) would overflow the URL.",
  flags: [
    ...FILTER_FLAGS,
    ...PAGE_FLAGS,
    { name: "sort", type: "string", repeat: true, values: SORTS, desc: "Sort order" },
    { name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" },
  ],
  examples: ["bugcrowd submissions search --target-type website --state new --all"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);

    const filters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(buildFilters(ctx))) {
      if (value === undefined) continue;
      const name = key.slice("filter[".length, -1);
      // The POST body takes arrays where the query string takes comma-joined strings.
      filters[name] = value.includes(",") ? value.split(",") : value;
    }

    const include = ctx.args.list("include");
    const sort = ctx.args.list("sort");
    const { limit, offset, max, all } = pageOptions(ctx);
    const pageLimit = clampLimit(limit);

    const body: Record<string, unknown> = { filter: filters };
    if (sort.length > 0) body["sort"] = sort;
    if (include.length > 0) body["include"] = include;
    else body["include"] = LIST_INCLUDES.split(",");

    const client = ctx.client();
    const records: Normalized[] = [];
    const docs: Document[] = [];
    let cursor = offset;

    // POST /submissions/search takes the same offset pagination as the GET endpoint,
    // just inside the request body, so --all/--max walk it the same way.
    for (;;) {
      const remaining = max === undefined ? pageLimit : Math.min(pageLimit, max - records.length);
      if (remaining <= 0) break;

      const doc = await client.request<Document>("/submissions/search", {
        method: "POST",
        body: { ...body, page: { limit: remaining, offset: cursor } },
      });
      docs.push(doc);
      const page = normalize(doc);
      records.push(...page);

      if (!all || page.length === 0) break;
      if (max !== undefined && records.length >= max) break;

      const advertised = nextOffset(doc);
      if (advertised !== undefined && advertised !== cursor) cursor = advertised;
      else if (page.length < remaining) break;
      else cursor += page.length;
    }

    const trimmed = max === undefined ? records : records.slice(0, max);
    ctx.out.collection(trimmed, LIST_COLUMNS, {
      rawDocs: docs,
      emptyMessage: "No submissions matched those filters.",
    });
  },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export const submissionCommands: readonly Command[] = [
  listCommand,
  getCommand,
  commentsCommand,
  activitiesCommand,
  searchCommand,
  updateCommand,
  commentCommand,
];
