import { ApiError, CliError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";
import type { Document } from "./jsonapi.js";
import { nextOffset } from "./jsonapi.js";

/** Bugcrowd's documented ceiling is 60 requests/minute per IP; stay just under it. */
const REQUESTS_PER_MINUTE = 55;
const WINDOW_MS = 60_000;

/** Server-side maximum for page[limit]. */
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 25;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type QueryValue = string | number | boolean | undefined | null | string[];

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Extra header pairs; used by the raw `api` command. */
  headers?: Record<string, string>;
}

export interface ClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  verbose?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so retry logic does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class BugcrowdClient {
  private readonly timestamps: number[] = [];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly verbose: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Count of requests issued, surfaced by --verbose. */
  requestCount = 0;

  constructor(
    private readonly config: ResolvedConfig,
    options: ClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.verbose = options.verbose ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.config.baseUrl + normalizedPath);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        url.searchParams.set(name, value.join(","));
      } else {
        url.searchParams.set(name, String(value));
      }
    }
    return url.toString();
  }

  /** Issues a single request and returns the parsed JSON body (or undefined for 204). */
  async request<T = Document>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Accept: "application/vnd.bugcrowd+json",
      Authorization: `Token ${this.config.token}`,
      "User-Agent": "bugcrowd-cli",
      ...options.headers,
    };
    if (this.config.apiVersion !== "") headers["Bugcrowd-Version"] = this.config.apiVersion;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();
      if (this.verbose) process.stderr.write(`> ${method} ${url}\n`);
      this.requestCount++;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) break;
        const wait = backoffMs(attempt);
        if (this.verbose) {
          process.stderr.write(`! ${describeNetworkError(err)} — retrying in ${wait}ms\n`);
        }
        await this.sleepImpl(wait);
        continue;
      }

      if (this.verbose) process.stderr.write(`< ${response.status} ${response.statusText}\n`);

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
        const wait = retryAfterMs(response) ?? backoffMs(attempt);
        if (this.verbose) process.stderr.write(`! HTTP ${response.status} — retrying in ${wait}ms\n`);
        await response.arrayBuffer().catch(() => undefined);
        await this.sleepImpl(wait);
        continue;
      }

      const text = await response.text();
      const parsed = parseMaybeJson(text);

      if (!response.ok) {
        throw new ApiError({ status: response.status, method, url, body: parsed ?? text });
      }
      return (parsed ?? {}) as T;
    }

    throw new CliError(`request to ${url} failed: ${describeNetworkError(lastError)}`, {
      details: ["Retries exhausted. Check network access to api.bugcrowd.com, or raise --timeout."],
    });
  }

  /**
   * Walks offset pagination until `max` records are collected or the API stops
   * returning a `next` link. Yields one document per page so callers can stream.
   */
  async *paginate(
    path: string,
    options: RequestOptions & { max?: number } = {},
  ): AsyncGenerator<Document, void, void> {
    const query = { ...(options.query ?? {}) };
    const max = options.max ?? Infinity;
    const pageLimit = clampLimit(Number(query["page[limit]"] ?? DEFAULT_PAGE_LIMIT));

    let offset = Number(query["page[offset]"] ?? 0);
    let collected = 0;

    while (collected < max) {
      const remaining = max === Infinity ? pageLimit : Math.min(pageLimit, max - collected);
      const doc = await this.request<Document>(path, {
        ...options,
        query: { ...query, "page[limit]": remaining, "page[offset]": offset },
      });

      const count = Array.isArray(doc.data) ? doc.data.length : doc.data ? 1 : 0;
      yield doc;
      collected += count;

      if (count === 0) return;
      const advertised = nextOffset(doc);
      // Trust links.next when present; otherwise fall back to a short-page heuristic.
      if (advertised !== undefined && advertised !== offset) {
        offset = advertised;
      } else if (count < remaining) {
        return;
      } else {
        offset += count;
      }
    }
  }

  /** Self-paces requests so long `--all` walks do not trip the API rate limit. */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.timestamps.length > 0 && now - this.timestamps[0]! >= WINDOW_MS) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < REQUESTS_PER_MINUTE) {
        this.timestamps.push(now);
        return;
      }
      const wait = WINDOW_MS - (now - this.timestamps[0]!) + 50;
      if (this.verbose) process.stderr.write(`! local rate limit reached — pausing ${wait}ms\n`);
      await this.sleepImpl(wait);
    }
  }
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

function parseMaybeJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000) + 100;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now()) + 100;
  return undefined;
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "request timed out";
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}
