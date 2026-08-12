import { collect, filterValue, moreHint } from "../lib/collect.js";
import { PAGE_FLAGS, rejectExtraPositionals, requirePositional, type Command, type Context } from "../lib/command.js";
import { CliError } from "../lib/errors.js";
import type { Document, Normalized } from "../lib/jsonapi.js";
import { normalize, normalizeOne } from "../lib/jsonapi.js";
import { isoTime, relatedName, shortTime, text, type Column, type RecordSection } from "../lib/output.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Programs are addressed by UUID in the API but humans and the submission filters both
 * use the short program code. Accept either: pass a UUID straight through, otherwise
 * page through /programs and match on code (case-insensitive), then name.
 */
async function resolveProgramId(ctx: Context, codeOrId: string): Promise<string> {
  if (UUID_RE.test(codeOrId)) return codeOrId;

  const client = ctx.client();
  const wanted = codeOrId.toLowerCase();
  const names: string[] = [];

  for await (const doc of client.paginate("/programs", { query: { "page[limit]": 100 } })) {
    for (const resource of Array.isArray(doc.data) ? doc.data : []) {
      const code = String(resource.attributes?.["code"] ?? "");
      const name = String(resource.attributes?.["name"] ?? "");
      if (code.toLowerCase() === wanted || name.toLowerCase() === wanted) return resource.id;
      if (code !== "") names.push(code);
    }
  }

  throw new CliError(`no program matched ${JSON.stringify(codeOrId)}`, {
    details:
      names.length > 0
        ? [`Programs visible to this token: ${names.sort().join(", ")}`]
        : ["This token cannot see any programs. Check `bugcrowd auth status`."],
  });
}

const PROGRAM_COLUMNS: readonly Column<Normalized>[] = [
  { header: "CODE", get: (r) => text(r["code"]) },
  { header: "NAME", get: (r) => text(r["name"]), maxWidth: 48 },
  { header: "ORGANIZATION", get: (r) => relatedName(r["organization"], ["name"]), maxWidth: 32 },
  { header: "ID", get: (r) => r.id },
];

const programsList: Command = {
  name: "programs list",
  summary: "List programs this token can see",
  flags: [
    ...PAGE_FLAGS,
    { name: "organization", type: "string", placeholder: "UUID", desc: "Only programs in this organization" },
    { name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" },
    { name: "sort", type: "string", repeat: true, placeholder: "FIELD-DIR", desc: "Sort order" },
  ],
  examples: ["bugcrowd programs list", "bugcrowd programs list --all --json"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const include = ctx.args.list("include");
    const collected = await collect(ctx, "/programs", {
      "filter[organization_id]": ctx.args.str("organization"),
      include: filterValue(include.length > 0 ? include : ["organization"]),
      sort: filterValue(ctx.args.list("sort")),
    });
    ctx.out.collection(collected.records, PROGRAM_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No programs visible to this token.",
      footer: moreHint(collected, ctx),
    });
  },
};

const programsGet: Command = {
  name: "programs get",
  summary: "Show one program by code or UUID",
  positionals: [{ name: "program", desc: "Program code or UUID", required: true }],
  flags: [{ name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" }],
  examples: ["bugcrowd programs get acme"],
  async run(ctx) {
    const ref = requirePositional(ctx, 0, "program");
    rejectExtraPositionals(ctx, 1);
    const id = await resolveProgramId(ctx, ref);
    const include = ctx.args.list("include");

    const doc = await ctx.client().request<Document>(`/programs/${encodeURIComponent(id)}`, {
      query: { include: filterValue(include.length > 0 ? include : ["organization", "engagements"]) },
    });
    const record = normalizeOne(doc);
    if (!record) throw new CliError(`program ${ref} returned no data`);

    const sections: readonly RecordSection<Normalized>[] = [
      { label: "ID", get: (r) => r.id },
      { label: "Code", get: (r) => text(r["code"]) },
      { label: "Name", get: (r) => text(r["name"]) },
      { label: "Organization", get: (r) => relatedName(r["organization"], ["name"]) },
      {
        label: "Engagements",
        get: (r) => {
          const engagements = r["engagements"];
          if (!Array.isArray(engagements) || engagements.length === 0) return "-";
          return engagements
            .map((e) => {
              const record = e as Record<string, unknown>;
              return `${text(record["code"] ?? record["id"])}${record["state"] ? ` (${text(record["state"])})` : ""}`;
            })
            .join(", ");
        },
      },
    ];
    ctx.out.record(record, sections, { rawDoc: doc });
  },
};

const ENGAGEMENT_COLUMNS: readonly Column<Normalized>[] = [
  { header: "CODE", get: (r) => text(r["code"]) },
  { header: "TYPE", get: (r) => text(r["engagement_type"]) },
  { header: "STATE", get: (r) => text(r["state"]) },
  { header: "STARTS", get: (r) => shortTime(r["starts_at"]) },
  { header: "ENDS", get: (r) => shortTime(r["ends_at"]) },
  { header: "ID", get: (r) => r.id },
];

const engagementsList: Command = {
  name: "engagements list",
  summary: "List engagements (the scoped, time-boxed runs inside a program)",
  flags: [
    ...PAGE_FLAGS,
    { name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" },
    {
      name: "sort",
      type: "string",
      repeat: true,
      values: ["created_at-asc", "created_at-desc"],
      desc: "Sort order",
    },
  ],
  examples: ["bugcrowd engagements list --all"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const collected = await collect(ctx, "/engagements", {
      include: filterValue(ctx.args.list("include")),
      sort: filterValue(ctx.args.list("sort")),
    });
    ctx.out.collection(collected.records, ENGAGEMENT_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No engagements visible to this token.",
      footer: moreHint(collected, ctx),
    });
  },
};

const engagementsGet: Command = {
  name: "engagements get",
  summary: "Show one engagement, including its brief and scope",
  positionals: [{ name: "id", desc: "Engagement UUID", required: true }],
  flags: [{ name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" }],
  examples: ["bugcrowd engagements get <id>"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);
    const include = ctx.args.list("include");
    const fallback = [
      "engagement_brief",
      "engagement_brief.engagement_brief_target_groups",
      "engagement_brief.engagement_brief_target_groups.targets",
    ];

    const doc = await ctx.client().request<Document>(`/engagements/${encodeURIComponent(id)}`, {
      query: { include: filterValue(include.length > 0 ? include : fallback) },
    });
    const record = normalizeOne(doc);
    if (!record) throw new CliError(`engagement ${id} returned no data`);

    const sections: readonly RecordSection<Normalized>[] = [
      { label: "ID", get: (r) => r.id },
      { label: "Code", get: (r) => text(r["code"]) },
      { label: "Type", get: (r) => text(r["engagement_type"]) },
      { label: "State", get: (r) => text(r["state"]) },
      { label: "Starts", get: (r) => isoTime(r["starts_at"]) },
      { label: "Ends", get: (r) => isoTime(r["ends_at"]) },
      { label: "Expected completion", get: (r) => isoTime(r["expected_completed_at"]) },
      { label: "Paused reason", get: (r) => (r["paused_reason"] ? text(r["paused_reason"]) : undefined) },
      { label: "Cancelled reason", get: (r) => (r["cancellation_reason"] ? text(r["cancellation_reason"]) : undefined) },
      {
        label: "Scope",
        block: true,
        get: (r) => {
          const brief = r["engagement_brief"];
          if (!brief || typeof brief !== "object") return undefined;
          const groups = (brief as Record<string, unknown>)["engagement_brief_target_groups"];
          if (!Array.isArray(groups) || groups.length === 0) return undefined;
          const lines: string[] = [];
          for (const group of groups) {
            const record = group as Record<string, unknown>;
            lines.push(text(record["name"] ?? record["id"]));
            const targets = record["targets"];
            if (Array.isArray(targets)) {
              for (const target of targets) {
                const t = target as Record<string, unknown>;
                lines.push(`  - ${text(t["name"])}${t["category"] ? ` [${text(t["category"])}]` : ""}`);
              }
            }
          }
          return lines.join("\n");
        },
      },
    ];
    ctx.out.record(record, sections, { rawDoc: doc });
  },
};

const TARGET_COLUMNS: readonly Column<Normalized>[] = [
  { header: "NAME", get: (r) => text(r["name"]), maxWidth: 60 },
  { header: "CATEGORY", get: (r) => text(r["category"]) },
  { header: "ORGANIZATION", get: (r) => relatedName(r["organization"], ["name"]), maxWidth: 30 },
  { header: "ID", get: (r) => r.id },
];

const targetsList: Command = {
  name: "targets list",
  summary: "List targets (assets in scope)",
  flags: [
    ...PAGE_FLAGS,
    { name: "organization", type: "string", placeholder: "UUID", desc: "Only targets in this organization" },
    { name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" },
  ],
  examples: ["bugcrowd targets list --all"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const include = ctx.args.list("include");
    const collected = await collect(ctx, "/targets", {
      "filter[organization_id]": ctx.args.str("organization"),
      include: filterValue(include.length > 0 ? include : ["organization"]),
    });
    ctx.out.collection(collected.records, TARGET_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No targets visible to this token.",
      footer: moreHint(collected, ctx),
    });
  },
};

const ORG_COLUMNS: readonly Column<Normalized>[] = [
  { header: "NAME", get: (r) => text(r["name"]), maxWidth: 48 },
  { header: "ID", get: (r) => r.id },
];

const organizationsList: Command = {
  name: "organizations list",
  summary: "List organizations this token can see",
  flags: [
    ...PAGE_FLAGS,
    { name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" },
    { name: "sort", type: "string", repeat: true, values: ["name-asc", "name-desc"], desc: "Sort order" },
  ],
  examples: ["bugcrowd organizations list"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    const collected = await collect(ctx, "/organizations", {
      include: filterValue(ctx.args.list("include")),
      sort: filterValue(ctx.args.list("sort")),
    });
    ctx.out.collection(collected.records, ORG_COLUMNS, {
      rawDocs: collected.docs,
      emptyMessage: "No organizations visible to this token.",
      footer: moreHint(collected, ctx),
    });
  },
};

const organizationsGet: Command = {
  name: "organizations get",
  summary: "Show one organization",
  positionals: [{ name: "id", desc: "Organization UUID", required: true }],
  flags: [{ name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" }],
  examples: ["bugcrowd organizations get <id> --include programs"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);
    const doc = await ctx.client().request<Document>(`/organizations/${encodeURIComponent(id)}`, {
      query: { include: filterValue(ctx.args.list("include")) },
    });
    const record = normalizeOne(doc);
    if (!record) throw new CliError(`organization ${id} returned no data`);
    ctx.out.record(
      record,
      [
        { label: "ID", get: (r) => r.id },
        { label: "Name", get: (r) => text(r["name"]) },
      ],
      { rawDoc: doc },
    );
  },
};

const rewardsGet: Command = {
  name: "rewards get",
  summary: "Show one monetary reward",
  positionals: [{ name: "id", desc: "Monetary reward UUID", required: true }],
  flags: [{ name: "include", type: "string", repeat: true, placeholder: "REL", desc: "Relationships to side-load" }],
  examples: ["bugcrowd rewards get <id>"],
  async run(ctx) {
    const id = requirePositional(ctx, 0, "id");
    rejectExtraPositionals(ctx, 1);
    const include = ctx.args.list("include");
    const doc = await ctx.client().request<Document>(`/monetary_rewards/${encodeURIComponent(id)}`, {
      query: { include: filterValue(include.length > 0 ? include : ["submission", "rewarded_by"]) },
    });
    const record = normalizeOne(doc);
    if (!record) throw new CliError(`reward ${id} returned no data`);
    ctx.out.record(
      record,
      [
        { label: "ID", get: (r) => r.id },
        { label: "Amount", get: (r) => text(r["formatted_amount"] ?? r["amount_cents"]) },
        { label: "Reason", get: (r) => text(r["reason"]) },
        { label: "Comment", get: (r) => text(r["comment"]) },
        { label: "Rewarded at", get: (r) => isoTime(r["rewarded_at"]) },
        { label: "Rewarded by", get: (r) => relatedName(r["rewarded_by"], ["name", "email"]) },
        { label: "Cancelled", get: (r) => (r["cancelled"] === true ? `yes — ${text(r["cancellation_reason"])}` : "no") },
        { label: "Submission", get: (r) => relatedName(r["submission"], ["title", "id"]) },
      ],
      { rawDoc: doc },
    );
  },
};

const DISCLOSURE_COLUMNS: readonly Column<Normalized>[] = [
  { header: "ID", get: (r) => r.id },
  { header: "STATUS", get: (r) => text(r["status"] ?? r["state"]) },
  { header: "CREATED", get: (r) => shortTime(r["created_at"]) },
];

const disclosuresList: Command = {
  name: "disclosures list",
  summary: "List disclosure requests",
  flags: [
    {
      name: "status",
      type: "string",
      repeat: true,
      values: ["requested", "draft", "denied", "approved", "cancelled"],
      desc: "Filter by status",
    },
  ],
  examples: ["bugcrowd disclosures list --status requested"],
  async run(ctx) {
    rejectExtraPositionals(ctx, 0);
    // This endpoint takes no pagination parameters, so issue a plain request.
    const doc = await ctx.client().request<Document>("/disclosure_requests", {
      query: { "filter[status]": filterValue(ctx.args.list("status")) },
    });
    ctx.out.collection(normalize(doc), DISCLOSURE_COLUMNS, {
      rawDocs: [doc],
      emptyMessage: "No disclosure requests.",
    });
  },
};

export const resourceCommands: readonly Command[] = [
  programsList,
  programsGet,
  engagementsList,
  engagementsGet,
  targetsList,
  organizationsList,
  organizationsGet,
  rewardsGet,
  disclosuresList,
];

export { resolveProgramId };
