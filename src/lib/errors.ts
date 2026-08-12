/** Errors that represent a clean, expected failure: printed without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  /** Extra lines printed after the message, e.g. a hint or a list of valid values. */
  readonly details: string[];

  constructor(message: string, options: { exitCode?: number; details?: string[] } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details ?? [];
  }
}

/** A non-2xx response from the Bugcrowd API. */
export class ApiError extends CliError {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;

  constructor(args: { status: number; method: string; url: string; body: unknown; tokenSource?: string }) {
    super(`${args.method} ${stripBase(args.url)} failed with HTTP ${args.status}`, {
      exitCode: args.status === 401 || args.status === 403 ? 77 : 1,
      details: describeApiErrors(args.body, args.status, args.tokenSource),
    });
    this.name = "ApiError";
    this.status = args.status;
    this.method = args.method;
    this.url = args.url;
    this.body = args.body;
  }
}

function stripBase(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/**
 * Bugcrowd returns JSON:API error objects. Pull out the human-readable parts so the
 * caller sees "severity must be between 1 and 5" instead of a bare status code.
 */
function describeApiErrors(body: unknown, status: number, tokenSource?: string): string[] {
  const lines: string[] = [];

  if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors)) {
    for (const raw of (body as { errors: unknown[] }).errors) {
      if (!raw || typeof raw !== "object") continue;
      const err = raw as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof err["title"] === "string") parts.push(err["title"]);
      if (typeof err["detail"] === "string" && err["detail"] !== err["title"]) parts.push(err["detail"]);
      const source = err["source"];
      if (source && typeof source === "object") {
        const pointer = (source as Record<string, unknown>)["pointer"];
        const parameter = (source as Record<string, unknown>)["parameter"];
        if (typeof pointer === "string") parts.push(`at ${pointer}`);
        else if (typeof parameter === "string") parts.push(`at ${parameter}`);
      }
      if (parts.length > 0) lines.push(`- ${parts.join(" — ")}`);
    }
  } else if (typeof body === "string" && body.trim() !== "") {
    lines.push(`- ${body.trim().slice(0, 500)}`);
  }

  if (status === 401) {
    lines.push("");
    // Name where the credentials actually came from; "check BUGCROWD_API_TOKEN" is
    // misleading advice when they were loaded from a config file or helper command.
    lines.push(
      tokenSource
        ? `The token from ${tokenSource} was rejected.`
        : "The token was rejected.",
    );
    lines.push("It must be the `username:password` pair shown on the Bugcrowd API credentials");
    lines.push("page. Run `bugcrowd auth login` to store a new one, or `bugcrowd auth status` to retest.");
  } else if (status === 403) {
    lines.push("");
    lines.push("The token authenticated but lacks access to this resource. API tokens inherit the");
    lines.push("permissions of the user that created them.");
  } else if (status === 404) {
    lines.push("");
    lines.push("Not found. Note that a resource outside your token's organizations also reads as 404.");
  }

  return lines;
}
