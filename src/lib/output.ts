import type { Document, Normalized } from "./jsonapi.js";

export type Format = "text" | "json" | "ndjson" | "raw";

export interface Column<T> {
  header: string;
  get: (record: T) => string;
  /** Truncate to this many characters when writing to a terminal. */
  maxWidth?: number;
  align?: "left" | "right";
}

export class Output {
  readonly format: Format;
  private readonly color: boolean;
  private buffer: string[] = [];

  constructor(options: { format: Format; color?: boolean }) {
    this.format = options.format;
    this.color = options.color ?? false;
  }

  get isText(): boolean {
    return this.format === "text";
  }

  write(text: string): void {
    this.buffer.push(text);
  }

  line(text = ""): void {
    this.buffer.push(`${text}\n`);
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    process.stdout.write(this.buffer.join(""));
    this.buffer = [];
  }

  bold(text: string): string {
    return this.color ? `\u001b[1m${text}\u001b[0m` : text;
  }

  dim(text: string): string {
    return this.color ? `\u001b[2m${text}\u001b[0m` : text;
  }

  /** Emits a raw JSON:API document verbatim. */
  raw(doc: unknown): void {
    this.line(JSON.stringify(doc, null, 2));
  }

  json(value: unknown): void {
    this.line(JSON.stringify(value, null, 2));
  }

  ndjson(records: readonly unknown[]): void {
    for (const record of records) this.line(JSON.stringify(record));
  }

  /**
   * Renders a collection. `json`/`ndjson`/`raw` bypass the columns entirely so
   * machine consumers always get the full record, never the truncated view.
   */
  collection<T extends Normalized>(
    records: readonly T[],
    columns: readonly Column<T>[],
    options: { rawDocs?: readonly Document[]; emptyMessage?: string; footer?: string } = {},
  ): void {
    switch (this.format) {
      case "raw":
        this.raw(options.rawDocs?.length === 1 ? options.rawDocs[0] : (options.rawDocs ?? []));
        return;
      case "json":
        this.json(records);
        return;
      case "ndjson":
        this.ndjson(records);
        return;
      case "text":
        break;
    }

    if (records.length === 0) {
      this.line(this.dim(options.emptyMessage ?? "No results."));
      return;
    }
    this.table(records, columns);
    if (options.footer) {
      this.line();
      this.line(this.dim(options.footer));
    }
  }

  /** Renders a single record: a field block in text mode, the object otherwise. */
  record<T extends Normalized>(
    value: T,
    sections: readonly RecordSection<T>[],
    options: { rawDoc?: unknown } = {},
  ): void {
    switch (this.format) {
      case "raw":
        this.raw(options.rawDoc ?? value);
        return;
      case "json":
        this.json(value);
        return;
      case "ndjson":
        this.ndjson([value]);
        return;
      case "text":
        break;
    }

    const fields: [string, string][] = [];
    const blocks: [string, string][] = [];
    for (const section of sections) {
      const rendered = section.get(value);
      if (rendered === undefined || rendered === "") continue;
      if (section.block) blocks.push([section.label, rendered]);
      else fields.push([section.label, rendered]);
    }

    const labelWidth = Math.max(0, ...fields.map(([label]) => label.length));
    for (const [label, rendered] of fields) {
      this.line(`${this.dim(`${label}:`.padEnd(labelWidth + 1))} ${rendered}`);
    }
    for (const [label, rendered] of blocks) {
      this.line();
      this.line(this.bold(label));
      for (const textLine of rendered.split("\n")) this.line(`  ${textLine}`);
    }
  }

  private table<T>(records: readonly T[], columns: readonly Column<T>[]): void {
    const terminalWidth = process.stdout.isTTY ? (process.stdout.columns ?? 100) : undefined;

    const cells = records.map((record) =>
      columns.map((column) => {
        const raw = oneLine(column.get(record));
        // Truncation only applies to terminals. Piped output (scripts, agents) keeps
        // every character so no data is silently lost.
        return terminalWidth !== undefined && column.maxWidth ? truncate(raw, column.maxWidth) : raw;
      }),
    );

    const widths = columns.map((column, i) =>
      Math.max(column.header.length, ...cells.map((row) => displayWidth(row[i] ?? ""))),
    );

    if (terminalWidth !== undefined) shrinkToFit(widths, columns, terminalWidth);

    const renderRow = (values: readonly string[]): string =>
      values
        .map((value, i) => {
          const width = widths[i]!;
          const clipped = truncate(value, width);
          // The last left-aligned column needs no padding; trailing spaces would only
          // add noise for anything reading this output.
          if (i === columns.length - 1 && columns[i]!.align !== "right") return clipped;
          return columns[i]!.align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
        })
        .join("  ")
        .replace(/\s+$/, "");

    this.line(this.bold(renderRow(columns.map((c) => c.header))));
    for (const row of cells) this.line(renderRow(row));
  }
}

export interface RecordSection<T> {
  label: string;
  get: (record: T) => string | undefined;
  /** Render as an indented paragraph below the fields instead of a single line. */
  block?: boolean;
}

/** Distributes an over-budget table's overflow onto the widest shrinkable columns. */
function shrinkToFit<T>(widths: number[], columns: readonly Column<T>[], terminalWidth: number): void {
  const gutters = (columns.length - 1) * 2;
  for (;;) {
    const total = widths.reduce((sum, w) => sum + w, 0) + gutters;
    if (total <= terminalWidth) return;
    let widestIndex = -1;
    let widest = 0;
    for (let i = 0; i < widths.length; i++) {
      const floor = Math.min(columns[i]!.header.length, 8);
      if (widths[i]! > widest && widths[i]! > floor) {
        widest = widths[i]!;
        widestIndex = i;
      }
    }
    if (widestIndex === -1) return;
    widths[widestIndex] = widest - Math.min(widest - 1, total - terminalWidth);
  }
}

function displayWidth(text: string): number {
  // Good enough for the ASCII-dominant data this CLI prints.
  return text.length;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** Bugcrowd severities are integers 1-5, displayed as P1-P5 across their product. */
export function severityLabel(severity: unknown): string {
  if (typeof severity !== "number" || !Number.isInteger(severity)) return "-";
  if (severity < 1 || severity > 5) return String(severity);
  return `P${severity}`;
}

/** Compacts an ISO-8601 timestamp to `YYYY-MM-DD HH:MM` UTC. */
export function shortTime(value: unknown): string {
  if (typeof value !== "string" || value === "") return "-";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

export function isoTime(value: unknown): string {
  if (typeof value !== "string" || value === "") return "-";
  return value;
}

export function text(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Reads a display name out of a related resource, which may be a fully included
 * object or a bare `{type, id}` identifier.
 */
export function relatedName(related: unknown, keys: readonly string[] = ["name", "code", "title", "email"]): string {
  if (!related || typeof related !== "object") return "-";
  const record = related as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const id = record["id"];
  return typeof id === "string" ? id : "-";
}

export function relatedNames(related: unknown, keys?: readonly string[]): string {
  if (!Array.isArray(related) || related.length === 0) return "-";
  return related.map((item) => relatedName(item, keys)).join(", ");
}
