---
name: bugcrowd
description: Browse, filter, and triage Bugcrowd vulnerability submissions from the command line. Use when the user asks about bug bounty submissions, security reports, vulnerability triage, Bugcrowd programs, engagements, targets, or wants to read/update a submission, its comments, or its activity history.
---

# Bugcrowd

Read and triage Bugcrowd submissions via the `bugcrowd` CLI.

## Prerequisites

Confirm the CLI is installed and the token works:

```bash
bugcrowd auth status --json
```

- Command not found → `npm install -g bugcrowd-cli`
- Exit code `77` → credentials missing or rejected. Do not retry. Ask the user to run
  `bugcrowd auth login` (or `--keychain` on macOS) once; that stores them so every run,
  including ones you start yourself, picks them up with no environment setup. Do not ask
  them to export a variable into your shell, and never put a credential in a command line.

The output lists the organizations and program codes the token can reach. You need a
program code for most filters, so start here rather than guessing.

## Core commands

```bash
# Find submissions. Severity 1 is the most severe (P1).
bugcrowd submissions list --program <code> --state new --severity 1,2 --max 50 --json

# Read one in full: description, HTTP request, remediation advice, reward
bugcrowd submissions get <id> --json

# The discussion, and the audit trail of state changes
bugcrowd submissions comments <id> --json
bugcrowd submissions activities <id> --json

# Context
bugcrowd programs list --json
bugcrowd engagements list --json      # scoped, time-boxed runs within a program
bugcrowd targets list --json          # assets in scope
```

Always pass `--json`: relationships are resolved inline, so `.program.code`,
`.target.name`, and `.assignee.email` are directly readable. The default text output is a
table sized for human terminals.

## Discovering options

Do not guess flags. Each command documents its full set, including valid values for every
enumerated filter:

```bash
bugcrowd submissions list --help
```

Filters combine with AND; repeating one is an OR (`--severity 1,2`). Dates take a day or a
range (`--submitted from.2026-01-01,to.2026-02-01`).

For anything not wrapped by a flag, use the escape hatch — it keeps auth, retries, and
pagination:

```bash
bugcrowd api /submissions -q 'filter[some_field]=value'
```

## Cost control

`--all` collects every match, which can be thousands of records. Prefer `--max N` and
narrow with filters first. When scanning rather than reading, request only what you need:

```bash
bugcrowd submissions list --fields title,state,severity,submitted_at --max 200 --json
```

Rate limiting and retries are handled internally — no sleeps or backoff needed.

## Writes require confirmation

These are visible on the Bugcrowd platform, and at some visibility scopes visible to
external researchers:

```bash
bugcrowd submissions update <id> --state triaged --severity 2
bugcrowd submissions comment <id> --body '...' --visibility bugcrowd_and_researcher
```

Quote the exact command and get the user's approval before running it. Never batch writes
across multiple submissions without approval for the batch.

`--visibility` is mandatory on comments — `bugcrowd` is internal only, `customer` reaches
the program, `bugcrowd_and_researcher` reaches the reporter, `everyone` reaches all
parties.

## Exit codes

`0` success · `1` API error · `2` your command was malformed · `70` internal bug ·
`77` credentials. Branch on these rather than parsing stderr. Add `--verbose` to trace
requests on stderr while stdout stays parseable.

A `404` can mean the resource is outside the token's organizations, not that it is absent.
