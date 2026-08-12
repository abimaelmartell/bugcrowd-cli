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
    return { records, docs: [doc], truncated: records.length === clampLimit(limit) };
  }

  const records: Normalized[] = [];
  const docs: Document[] = [];
  for await (const doc of client.paginate(path, { query: baseQuery, max })) {
    docs.push(doc);
    records.push(...normalize(doc));
    if (max !== undefined && records.length >= max) break;
  }
  const trimmed = max !== undefined ? records.slice(0, max) : records;
  return { records: trimmed, docs, truncated: max !== undefined && records.length > max };
}

/** Footer hint shown under a text table when more records exist than were shown. */
export function moreHint(collected: Collected, ctx: Context): string | undefined {
  if (!collected.truncated) return undefined;
  const { all } = pageOptions(ctx);
  const shown = collected.records.length;
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
