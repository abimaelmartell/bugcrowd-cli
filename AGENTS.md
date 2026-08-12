# Using bugcrowd-cli as an agent

Notes for AI coding agents driving this CLI. Humans should read [README.md](README.md).

## Setup check

Run this first. It verifies credentials and tells you which program codes exist, which you
need for almost every filter:

```bash
bugcrowd auth status --json
```

Exit code `77` means credentials are missing or rejected. Do not retry, and do not ask the
user to export a variable into your shell — that would not persist to any run you start
later. Ask them to store credentials once instead:

```bash
bugcrowd auth login              # saves to the config file, mode 600
bugcrowd auth login --keychain   # macOS keychain; nothing plaintext on disk
```

After that, credentials resolve automatically in every process, so you can spawn your own
runs with no environment setup. You never need to read, echo, or pass the token yourself —
if you find yourself about to put a credential in a command line, don't; it would land in
shell history and in this transcript.

Exit `2` is a usage error you made; re-read `--help` and fix the command.

## Always use `--json`

The default text output is a table sized for human terminals. Use `--json` for anything you
intend to parse:

```bash
bugcrowd submissions list --state new --json
```

Relationships are resolved inline, so `.program.code`, `.target.name`, and `.assignee.email`
are directly available — no joining against an `included` array. Relationships that were not
side-loaded appear as `{"type": "...", "id": "..."}` rather than being invented.

Use `--format ndjson` when you want to stream or `grep` line-by-line.

## Discover flags instead of guessing

Every command documents its full flag set, including the valid values for each enumerated
filter:

```bash
bugcrowd submissions list --help
```

Unknown flags and invalid values are hard errors with exit code `2` and a list of what is
valid — they never fall through to a silently different query. If a filter you want isn't
there, use the raw escape hatch rather than inventing a flag:

```bash
bugcrowd api /submissions -q 'filter[some_new_thing]=value'
```

## Cap large queries

`--all` follows pagination until every match is collected, which on a busy program can be
thousands of records and a lot of tokens. Prefer an explicit cap, and narrow with filters
before widening:

```bash
bugcrowd submissions list --program acme --state new --max 100 --json
```

Ask for the fields you need rather than whole records when scanning:

```bash
bugcrowd submissions list --fields title,state,severity,submitted_at --max 200 --json
```

Rate limiting and retries are handled internally, so you don't need to add sleeps between
calls or implement your own backoff.

## Reading a submission

`submissions list` gives you IDs; `submissions get` gives you the full report including the
description, HTTP request, and remediation advice:

```bash
bugcrowd submissions get <id> --json
bugcrowd submissions comments <id> --json     # the discussion thread
bugcrowd submissions activities <id> --json   # state changes, who did what and when
```

Severity is an integer where **1 is the most severe** (Bugcrowd's P1) and 5 the least.
State values in filters use hyphens (`out-of-scope`); the value on the record and in write
operations uses underscores (`out_of_scope`). Both spellings are accepted on input.

## Writes need confirmation

These commands change state on the Bugcrowd platform and are visible to the program and, at
some visibility scopes, to external researchers:

- `bugcrowd submissions update <id> …`
- `bugcrowd submissions comment <id> …`
- any `bugcrowd api` call with `POST`, `PATCH`, or `DELETE`

Confirm with the user before running them, and quote the exact command you intend to run.
Do not batch writes across many submissions without explicit approval for the batch.
`submissions update` sends only the flags you pass, so it will not clobber fields you
didn't mention — but state transitions and comments are still visible actions that are
awkward to walk back.

`--visibility` is mandatory on comments. Think about the audience:
`bugcrowd` is internal-only, `customer` reaches the program, `bugcrowd_and_researcher`
reaches the reporter, and `everyone` reaches all parties.

## Errors

Exit codes are meaningful; branch on them rather than parsing stderr:

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Success | — |
| `1` | API or runtime error | Read the message; it includes the API's own error detail |
| `2` | Usage error | Your command was wrong; check `--help` |
| `70` | Internal error | Re-run with `BUGCROWD_DEBUG=1` and report it |
| `77` | Missing/rejected credentials | Ask the user; don't retry |

A `404` can mean the resource is outside the token's organizations rather than absent.

Add `--verbose` to see requests, retries, and rate-limit pauses on stderr while stdout
stays clean and parseable.

## Suggested workflow

```bash
# 1. Confirm access and learn the program codes
bugcrowd auth status --json

# 2. Find what needs attention
bugcrowd submissions list --program <code> --state new --severity 1,2 --max 50 --json

# 3. Read one in full before forming an opinion
bugcrowd submissions get <id> --json
bugcrowd submissions comments <id> --json

# 4. Propose the write to the user, then run it once approved
bugcrowd submissions update <id> --state triaged --severity 2
```
