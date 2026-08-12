import type { FlagSpec } from "./args.js";
import type { Command } from "./command.js";
import { GLOBAL_FLAGS } from "./command.js";

const BINARY = "bugcrowd";

/** Top-level help: every command, grouped by its first word. */
export function rootHelp(commands: readonly Command[]): string {
  const lines: string[] = [];
  lines.push("bugcrowd — command-line client for the Bugcrowd REST API");
  lines.push("");
  lines.push(`Usage: ${BINARY} <group> <command> [flags]`);
  lines.push(`       ${BINARY} <command> --help`);
  lines.push("");

  const groups = new Map<string, Command[]>();
  for (const command of commands) {
    const [group] = command.name.split(" ");
    const key = group ?? command.name;
    const bucket = groups.get(key);
    if (bucket) bucket.push(command);
    else groups.set(key, [command]);
  }

  const width = Math.max(...commands.map((c) => c.name.length));
  for (const [group, members] of groups) {
    lines.push(`${group}`);
    for (const command of members) {
      lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
    }
    lines.push("");
  }

  lines.push("Global flags");
  lines.push(...renderFlags(GLOBAL_FLAGS, 2));
  lines.push("");
  lines.push("Authentication");
  lines.push("  Set BUGCROWD_API_TOKEN to your `username:password` API credential pair.");
  lines.push(`  Verify it with \`${BINARY} auth status\`.`);
  lines.push("");
  lines.push("Output");
  lines.push("  text (default)  aligned table, truncated only when attached to a terminal");
  lines.push("  json            normalized objects with relationships resolved inline");
  lines.push("  ndjson          one normalized object per line");
  lines.push("  raw             the untouched JSON:API response");
  lines.push("");
  lines.push(`Examples`);
  lines.push(`  ${BINARY} auth status`);
  lines.push(`  ${BINARY} programs list`);
  lines.push(`  ${BINARY} submissions list --state new --sort severity-asc`);
  lines.push(`  ${BINARY} submissions get <id> --json`);
  lines.push("");
  lines.push("Full API reference: https://docs.bugcrowd.com/api/1.1.0/");

  return lines.join("\n");
}

/** Per-command help: usage line, description, positionals, flags, examples. */
export function commandHelp(command: Command): string {
  const lines: string[] = [];
  const usageArgs = (command.positionals ?? [])
    .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`) + (p.variadic ? "..." : ""))
    .join(" ");

  lines.push(`${BINARY} ${command.name} — ${command.summary}`);
  lines.push("");
  lines.push(`Usage: ${BINARY} ${command.name}${usageArgs ? ` ${usageArgs}` : ""} [flags]`);

  if (command.description) {
    lines.push("");
    lines.push(...command.description.split("\n"));
  }

  if (command.positionals && command.positionals.length > 0) {
    lines.push("");
    lines.push("Arguments");
    const width = Math.max(...command.positionals.map((p) => p.name.length));
    for (const positional of command.positionals) {
      lines.push(`  ${positional.name.padEnd(width)}  ${positional.desc}`);
    }
  }

  const flags = command.flags ?? [];
  if (flags.length > 0) {
    lines.push("");
    lines.push("Flags");
    lines.push(...renderFlags(flags, 2));
  }

  lines.push("");
  lines.push("Global flags");
  lines.push(...renderFlags(GLOBAL_FLAGS, 2));

  if (command.examples && command.examples.length > 0) {
    lines.push("");
    lines.push("Examples");
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  return lines.join("\n");
}

function renderFlags(flags: readonly FlagSpec[], indent: number): string[] {
  const pad = " ".repeat(indent);
  const labels = flags.map(flagLabel);
  const width = Math.max(...labels.map((l) => l.length));
  const lines: string[] = [];

  for (const [i, flag] of flags.entries()) {
    let desc = flag.desc;
    if (flag.repeat) desc += " (repeatable)";

    const joined = flag.values?.join(" ") ?? "";
    // Short enumerations sit inline; long ones move to their own indented line so the
    // description stays readable while every valid value is still discoverable.
    const inline = flag.values && joined.length <= 52;
    if (inline) desc += ` [${flag.values!.join("|")}]`;

    lines.push(`${pad}${labels[i]!.padEnd(width)}  ${desc}`);

    if (flag.values && !inline) {
      const gutter = `${pad}${" ".repeat(width)}  `;
      const wrapped = wrap(flag.values, 96 - gutter.length - 8);
      for (const [n, chunk] of wrapped.entries()) {
        // "values:" labels the block once; later lines align under it.
        lines.push(`${gutter}${n === 0 ? "values: " : "        "}${chunk}`);
      }
    }
  }

  return lines;
}

/** Packs values into `|`-joined lines no longer than `width`. */
function wrap(values: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const value of values) {
    const candidate = current === "" ? value : `${current}|${value}`;
    if (candidate.length > width && current !== "") {
      lines.push(current);
      current = value;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function flagLabel(flag: FlagSpec): string {
  const short = flag.short ? `-${flag.short}, ` : "    ";
  if (flag.type === "boolean") return `${short}--${flag.name}`;
  const placeholder = flag.placeholder ?? (flag.type === "int" ? "N" : "VALUE");
  return `${short}--${flag.name} <${placeholder}>`;
}
