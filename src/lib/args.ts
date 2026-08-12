import { CliError } from "./errors.js";

export interface FlagSpec {
  name: string;
  short?: string;
  type: "string" | "boolean" | "int";
  /** May be given more than once; every occurrence is collected. */
  repeat?: boolean;
  /**
   * Whether a single occurrence containing commas is split into multiple values.
   * Defaults to `repeat`. Set false for flags whose values legitimately contain
   * commas, such as `--query 'filter[state]=new,triaged'`.
   */
  split?: boolean;
  desc: string;
  /** Allowed values. Validated, and shown in `--help`. */
  values?: readonly string[];
  /**
   * Applied to each value before validation, so a command can accept alternative
   * spellings without advertising all of them in `--help`.
   */
  normalize?: (value: string) => string;
  /** Shown in help as `--name <placeholder>`. */
  placeholder?: string;
}

export interface PositionalSpec {
  name: string;
  desc: string;
  required?: boolean;
  variadic?: boolean;
}

export class Args {
  constructor(
    readonly positionals: string[],
    private readonly values: Map<string, string[] | boolean | number>,
  ) {}

  /** First value of a string flag, or undefined if absent. */
  str(name: string): string | undefined {
    const v = this.values.get(name);
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0];
    return String(v);
  }

  /** All values of a repeatable flag, comma-splits already expanded. */
  list(name: string): string[] {
    const v = this.values.get(name);
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [String(v)];
  }

  bool(name: string): boolean {
    return this.values.get(name) === true;
  }

  /** Distinguishes `--flag=false` from an absent flag. */
  boolOrUndefined(name: string): boolean | undefined {
    const v = this.values.get(name);
    return typeof v === "boolean" ? v : undefined;
  }

  int(name: string): number | undefined {
    const v = this.values.get(name);
    if (v === undefined) return undefined;
    return typeof v === "number" ? v : Number(Array.isArray(v) ? v[0] : v);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }
}

const BOOL_TRUE = new Set(["true", "yes", "1", "on"]);
const BOOL_FALSE = new Set(["false", "no", "0", "off"]);

/**
 * Parses `argv` against `specs`. Unknown flags are an error rather than being
 * silently ignored — a typo should fail loudly instead of quietly changing the query.
 */
export function parseArgs(argv: string[], specs: readonly FlagSpec[]): Args {
  const byName = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  const positionals: string[] = [];
  const values = new Map<string, string[] | boolean | number>();

  // `true` stands for "flag present with no value", which only booleans accept.
  const setValue = (spec: FlagSpec, input: string | true) => {
    if (spec.type === "boolean") {
      values.set(spec.name, input === true || BOOL_TRUE.has(input.toLowerCase()));
      return;
    }
    if (input === true) throw new CliError(`--${spec.name} requires a value`, { exitCode: 2 });
    const raw: string = input;

    if (spec.type === "int") {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        throw new CliError(`--${spec.name} must be an integer, got ${JSON.stringify(raw)}`, { exitCode: 2 });
      }
      values.set(spec.name, n);
      return;
    }

    const shouldSplit = spec.split ?? spec.repeat ?? false;
    let incoming = shouldSplit ? raw.split(",").map((s) => s.trim()).filter((s) => s !== "") : [raw];
    if (spec.normalize) incoming = incoming.map(spec.normalize);
    if (spec.values) {
      for (const item of incoming) {
        if (!spec.values.includes(item)) {
          throw new CliError(`invalid value ${JSON.stringify(item)} for --${spec.name}`, {
            exitCode: 2,
            details: [`Valid values: ${spec.values.join(", ")}`],
          });
        }
      }
    }
    const existing = values.get(spec.name);
    if (spec.repeat && Array.isArray(existing)) existing.push(...incoming);
    else values.set(spec.name, incoming);
  };

  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

      let spec = byName.get(rawName);
      let negated = false;
      if (!spec && rawName.startsWith("no-")) {
        const candidate = byName.get(rawName.slice(3));
        if (candidate?.type === "boolean") {
          spec = candidate;
          negated = true;
        }
      }
      if (!spec) throw unknownFlag(`--${rawName}`, specs);

      if (negated) {
        values.set(spec.name, inlineValue !== undefined ? BOOL_FALSE.has(inlineValue.toLowerCase()) : false);
        continue;
      }
      if (inlineValue !== undefined) {
        setValue(spec, inlineValue);
        continue;
      }
      if (spec.type === "boolean") {
        setValue(spec, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) throw new CliError(`--${spec.name} requires a value`, { exitCode: 2 });
      setValue(spec, next);
      i++;
      continue;
    }

    // Short flags: -j, and bundled booleans like -jv.
    if (token.length > 1 && token.startsWith("-")) {
      const chars = token.slice(1);
      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c]!;
        const spec = byShort.get(ch);
        if (!spec) throw unknownFlag(`-${ch}`, specs);
        if (spec.type === "boolean") {
          setValue(spec, true);
          continue;
        }
        const rest = chars.slice(c + 1);
        if (rest !== "") {
          setValue(spec, rest.startsWith("=") ? rest.slice(1) : rest);
          break;
        }
        const next = argv[i + 1];
        if (next === undefined) throw new CliError(`-${ch} requires a value`, { exitCode: 2 });
        setValue(spec, next);
        i++;
        break;
      }
      continue;
    }

    positionals.push(token);
  }

  return new Args(positionals, values);
}

function unknownFlag(flag: string, specs: readonly FlagSpec[]): CliError {
  const names = specs.map((s) => `--${s.name}`).sort();
  const suggestion = closest(flag.replace(/^-+/, ""), specs.map((s) => s.name));
  const details: string[] = [];
  if (suggestion) details.push(`Did you mean --${suggestion}?`);
  details.push(`Available flags: ${names.join(", ")}`);
  return new CliError(`unknown flag ${flag}`, { exitCode: 2, details });
}

/** Levenshtein-based nearest match, used only to make typo errors friendlier. */
function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = distance(input, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestScore <= threshold ? best : undefined;
}

function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
