# bugcrowd-cli

An **unofficial** command-line client for the [Bugcrowd REST API](https://docs.bugcrowd.com/api/1.1.0/).
Not affiliated with, endorsed by, or supported by Bugcrowd. "Bugcrowd" is their trademark;
this project just talks to their public API.

Bugcrowd's API is [JSON:API](https://jsonapi.org/), which means a single submission
arrives split across `data.attributes`, `data.relationships`, and a top-level `included`
array that you have to join by hand. This CLI flattens that into plain objects, wraps the
filters in real flags, and handles pagination, retries, and rate limiting — so both people
and coding agents can read and triage submissions without writing a client first.

```console
$ bugcrowd submissions list --state new --sort severity-asc
ID                                    SEV  STATE  SUBMITTED         PROGRAM  TARGET         TITLE
5f2c…  P1   new    2026-08-02 11:14  acme     api.acme.com   Stored XSS in comment renderer
7a91…  P2   new    2026-08-01 09:52  acme     acme.com       IDOR on /v1/invoices/{id}
```

## Install

```bash
npm install -g bugcrowd-cli
```

Or run it without installing:

```bash
npx bugcrowd-cli submissions list
```

Requires Node.js 20 or newer. No runtime dependencies.

## Authenticate

Bugcrowd API credentials are a **username/password pair**, created under your Bugcrowd
account settings. Store them once:

```bash
bugcrowd auth login          # prompts (input is not echoed), verifies, then saves
bugcrowd auth status         # confirms it works and lists reachable orgs and programs
```

`auth login` writes to `~/.config/bugcrowd/config.json` with mode `600`. Every later
invocation reads it — including runs started by a script, a cron job, or an agent — so
there is no environment to export and nothing to re-enter.

`auth status` is a good first call: it prints the organizations and programs the token can
reach, which is how you discover the program codes you'll filter by.

### Storage options

| Where | How |
| --- | --- |
| Config file, mode 600 | `bugcrowd auth login` |
| macOS keychain | `bugcrowd auth login --keychain` |
| 1Password, `pass`, Vault, … | set `token_command` (below) |
| Per-command | `BUGCROWD_API_TOKEN`, or `--token` |

`--keychain` stores the secret in the login keychain and leaves only a lookup command in
the config file, so no plaintext credential is written to disk. Reads are
non-interactive — no unlock prompt on each run.

For any other secret manager, set `token_command` to something that prints the pair on
stdout:

```json
{ "token_command": "op read op://Private/Bugcrowd/credential" }
{ "token_command": "pass show bugcrowd/api" }
{ "token_command": "vault kv get -field=token secret/bugcrowd" }
```

Re-running `auth login` rotates the stored credential. It says what is already stored
before prompting, and warns if you are about to move a secret out of the keychain into a
plaintext file. Switching backends moves the credential rather than copying it, so no
orphaned entry is left behind. `bugcrowd auth logout` removes whatever was stored.

### Resolution order

First match wins:

1. `--token 'user:secret'`
2. `BUGCROWD_API_TOKEN`, then `BUGCROWD_TOKEN`
3. `BUGCROWD_TOKEN_COMMAND`
4. config file → `token_command`
5. config file → `token`

`token_command` deliberately outranks a literal `token` in the same file, so switching to a
secret manager can't be silently undone by a leftover plaintext value. If a config file
holding a literal token is readable by anyone but you, the CLI warns and tells you to
`chmod 600` it.

Tokens carry the permissions of the user that created them, and are pinned to an API
version. This CLI sends `Bugcrowd-Version: V1.1.0` by default; override with
`--api-version` or `BUGCROWD_API_VERSION`.

## Commands

| Command | Purpose |
| --- | --- |
| `auth login` | Store credentials locally so later runs need no setup |
| `auth logout` | Remove stored credentials |
| `auth status` | Verify the token, list reachable orgs and programs |
| `submissions list` | List and filter submissions |
| `submissions get <id>` | One submission in full, relationships resolved |
| `submissions comments <id>` | The comment thread |
| `submissions activities <id>` | The activity/audit feed |
| `submissions search` | Same filters as `list`, sent as POST for very long filter sets |
| `submissions update <id>` | Change state, severity, assignee, VRT, … |
| `submissions comment <id>` | Post a comment |
| `programs list` / `get` | Programs; `get` accepts a code or a UUID |
| `engagements list` / `get` | Engagements, including brief and scope |
| `targets list` | Targets in scope |
| `organizations list` / `get` | Organizations |
| `rewards get <id>` | A monetary reward |
| `disclosures list` | Disclosure requests |
| `api <METHOD> <PATH>` | Call any endpoint directly |

`bugcrowd --help` lists everything; `bugcrowd <command> --help` documents every flag,
including the valid values for each enumerated filter.

Groups accept short aliases (`sub`, `subs`, `prog`, `org`, `eng`), and
`bugcrowd submissions <uuid>` is shorthand for `submissions get <uuid>`.

## Output formats

| Flag | Output |
| --- | --- |
| *(default)* | Aligned text table, or a field block for a single record |
| `--json` / `-j` | Normalized JSON: attributes hoisted, relationships resolved inline |
| `--format ndjson` | One normalized JSON object per line |
| `--raw` | The untouched JSON:API response |

Text tables truncate long values **only when attached to a terminal**. Piped or redirected
output keeps every character, so nothing is silently lost in a script. Row counts and
other hints go to stderr, so stdout stays purely tabular even in text mode.

Relationships are expanded exactly as far as `include=` asked for, and no further: a
relationship that was not side-loaded stays a `{type, id}` identifier rather than pulling
in the rest of the response.

`--json` is the format to reach for when something else consumes the output. Compare:

```console
$ bugcrowd submissions get <id> --raw | jq '.data.relationships.program.data.id' # then look it up in .included
$ bugcrowd submissions get <id> --json | jq '.program.code'
"acme"
```

## Filtering

Filters combine with AND. Repeating one filter is an OR over its values, so these are
equivalent:

```bash
bugcrowd submissions list --severity 1 --severity 2
bugcrowd submissions list --severity 1,2
```

Dates accept a single day or a range:

```bash
bugcrowd submissions list --submitted 2026-08-01
bugcrowd submissions list --submitted from.2026-01-01,to.2026-02-01
bugcrowd submissions list --updated from.2026-08-01T00:00:00Z
```

Common queries:

```bash
# Untriaged criticals across every program
bugcrowd submissions list --state new --severity 1,2 --sort severity-asc

# Your queue
bugcrowd submissions list --assignee me --state triaged

# Everything in one program, following pagination
bugcrowd submissions list --program acme --all

# Full-text search, capped
bugcrowd submissions list --search 'ssrf' --max 200 --json

# Anything blocked on the customer
bugcrowd submissions list --blocked-by customer
```

## Pagination

List commands report the matching total when the API provides one, so `Showing 25 of 340`
makes clear that a page is not the whole set.

`--limit` sets the page size (max 100, the server's ceiling). `--all` follows the API's
`next` links until every match is collected; `--max N` stops after N records and implies
`--all`. Requests are self-paced under Bugcrowd's 60-per-minute limit, and `429`/`5xx`
responses are retried with backoff honouring `Retry-After`, so a long `--all` walk over
thousands of submissions is safe to leave running.

## Writing

`submissions update` sends only the flags you pass; unspecified fields are untouched.

```bash
bugcrowd submissions update <id> --state triaged --severity 2
bugcrowd submissions update <id> --assignee alice@example.com
bugcrowd submissions update <id> --assignee none          # unassign
bugcrowd submissions update <id> --duplicate-of <other-id>
```

Comments require an explicit `--visibility`, so the audience is always a deliberate
choice rather than a default:

```bash
bugcrowd submissions comment <id> \
  --body 'Reproduced on staging, escalating.' \
  --visibility bugcrowd_and_researcher
```

Valid scopes are `everyone`, `bugcrowd_and_researcher`, `bugcrowd_and_customer`,
`customer`, and `bugcrowd`. Pass `--body -` to read the body from stdin.

**These commands write to the Bugcrowd platform and are visible to the program.**

## Escape hatch

Any endpoint the CLI doesn't wrap is still reachable, with auth, versioning, retries, and
pagination applied:

```bash
bugcrowd api /teams
bugcrowd api /submissions -q 'filter[state]=new' -q 'page[limit]=5'
bugcrowd api /credential_buckets --paginate --normalize
bugcrowd api PATCH /submissions/<id> -b '{"data":{"type":"submission","attributes":{"severity":3}}}'
bugcrowd api POST /submissions/search -b @query.json
```

`--normalize` flattens the response the same way `--json` does. `-b` takes inline JSON,
`@file`, or `-` for stdin.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | API or runtime error |
| `2` | Usage error — unknown command, bad flag, invalid value |
| `70` | Unexpected internal error (set `BUGCROWD_DEBUG=1` for a stack trace) |
| `77` | Missing or rejected credentials |

Errors print the API's own messages, so a rejected write tells you which field was wrong.
`--verbose` logs every request, retry, and rate-limit pause to stderr; stdout stays clean
for piping.

## Environment variables

| Variable | Effect |
| --- | --- |
| `BUGCROWD_API_TOKEN` | Credentials as `user:secret` |
| `BUGCROWD_TOKEN` | Fallback if the above is unset |
| `BUGCROWD_TOKEN_COMMAND` | Command whose stdout is the credential pair |
| `BUGCROWD_API_VERSION` | Value for the `Bugcrowd-Version` header |
| `BUGCROWD_BASE_URL` | Override the API base URL |
| `BUGCROWD_CONFIG` | Path to the config file |
| `BUGCROWD_KEYCHAIN_SERVICE` | Keychain service name; override to isolate from real credentials |
| `BUGCROWD_DEBUG` | Print stack traces on unexpected errors |
| `NO_COLOR` / `FORCE_COLOR` | Disable / force ANSI color |

## Using this with AI coding agents

See [AGENTS.md](AGENTS.md), which most coding agents read automatically. It covers the
conventions worth knowing up front: prefer `--json`, discover flags with `--help` rather
than guessing, cap large queries with `--max`, and treat `update`/`comment` as writes that
need confirmation.

For Claude Code specifically, [`skills/bugcrowd/`](skills/bugcrowd/SKILL.md) is an
installable skill — copy it in and Claude will load it whenever a task touches Bugcrowd:

```bash
# from a clone
mkdir -p ~/.claude/skills && cp -r skills/bugcrowd ~/.claude/skills/

# or from the installed package
mkdir -p ~/.claude/skills && cp -r "$(npm root -g)/bugcrowd-cli/skills/bugcrowd" ~/.claude/skills/
```

## Development

```bash
npm install
npm run build      # compile to dist/
npm test           # typecheck + run the test suite
npm run verify     # build dist/ and run the suite, so dist/ is never stale
npm run typecheck
```

Zero runtime dependencies; TypeScript and `@types/node` are the only devDependencies.
Tests use the built-in `node:test` runner and a stubbed `fetch`, so they never touch the
network.

## License

MIT
