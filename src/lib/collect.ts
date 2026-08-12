import type { QueryValue } from "./client.js";
import { clampLimit } from "./client.js";
import { pageOptions, type Context } from "./command.js";
import type { Document, Normalized } from "./jsonapi.js";
import { normalize } from "./jsonapi.js";

export interface Collected {
  records: Normalized[];
  /** Every page's untouched document, for --format raw. */
  docs: Document[];
  /** True when the API had more records than were fetched. */
  truncated: boolean;
  /** `meta.total_hits`, when the endpoint reports how many records match in total. */
  total?: number;
}

/** Reads `meta.total_hits`, which most list endpoints return alongside the page. */
function totalHits(doc: Document | undefined): number | undefined {
  const value = doc?.meta?.["total_hits"];
  return typeof value === "number" ? value : undefined;
}

/**
 * Runs a list endpoint honouring --limit/--offset/--all/--max and returns both the
 * normalized records and the raw documents.
 */
export async function collect(
  ctx: Context,
  path: string,
  query: Record<string, QueryValue> = {},
): Promise<Collected> {
  const { limit, offset, max, all } = pageOptions(ctx);
  const client = ctx.client();
  const baseQuery = { ...query, "page[limit]": clampLimit(limit), "page[offset]": offset };

  if (!all) {
    const doc = await client.request<Document>(path, { query: baseQuery });
    const records = normalize(doc);
    const total = totalHits(doc);
    return {
      records,
      docs: [doc],
      // Prefer the reported total; fall back to "a full page came back" as the signal.
      truncated: total !== undefined ? offset + records.length < total : records.length === clampLimit(limit),
      total,
    };
  }

  const records: Normalized[] = [];
  const docs: Document[] = [];
  for await (const doc of client.paginate(path, { query: baseQuery, max })) {
    docs.push(doc);
    records.push(...normalize(doc));
    if (max !== undefined && records.length >= max) break;
  }
  const trimmed = max !== undefined ? records.slice(0, max) : records;
  const total = totalHits(docs[0]);
  return {
    records: trimmed,
    docs,
    truncated: total !== undefined ? trimmed.length < total : max !== undefined && records.length > max,
    total,
  };
}

/**
 * Footer hint shown under a text table. Reports the total when the API provides one, so
 * "showing 25" is not mistaken for "there are 25".
 */
export function moreHint(collected: Collected, ctx: Context): string | undefined {
  const shown = collected.records.length;
  const { all } = pageOptions(ctx);

  if (collected.total !== undefined) {
    if (!collected.truncated) return shown === collected.total ? undefined : `Showing all ${shown} of ${collected.total}.`;
    return all
      ? `Showing ${shown} of ${collected.total} (--max reached). Raise or drop --max for the rest.`
      : `Showing ${shown} of ${collected.total}. Use --all for every match, or --limit/--offset to page.`;
  }

  if (!collected.truncated) return undefined;
  return all
    ? `Showing ${shown} records (--max reached). Raise or drop --max for the full set.`
    : `Showing ${shown} records. Use --all for every match, or --limit/--offset to page.`;
}

/**
 * Joins repeatable filter flags into the comma-separated form the API expects, and
 * returns undefined when the flag was not supplied so the key is omitted entirely.
 */
export function filterValue(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : values.join(",");
}
