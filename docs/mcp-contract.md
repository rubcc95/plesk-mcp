# MCP contract

Every tool returns JSON:

```json
{ "ok": true, "data": {} }
```

or:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

`isError` is `true` when `ok` is `false`.

Plesk tools accept an optional `server`. If omitted, `defaultServer` is used, or
the first registered server. Tools that operate on a subscription also accept an
optional `domain`: if omitted and the server has a single domain, it is
auto-detected; if the server has several, they return `PLESK_DOMAIN_REQUIRED`.

SQL tools accept **exactly one** of `server` (a Plesk server) or `pc` (a local
database from `localDatabases`). There is no default SQL target: missing both
returns `TARGET_REQUIRED`; providing both returns `TARGET_CONFLICT`.

All tools publish `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). In the default mode
(`PLESK_MCP_ACCESS=confirm`), write tools ask for confirmation through MCP
elicitation and return `CONFIRMATION_UNSUPPORTED` if the client does not support
it. `dry_run: true` does not request confirmation. Details:
[access-control.md](access-control.md).

## Servers and project

- `servers_list()` — lists Plesk servers, local databases, their source
  (`global`/`local`), and the default target.
- `project_info()` — config paths and a summary of servers and local databases,
  without secrets.
- `doctor(server?, domain?)` — checks auth, domain, file access, `exec`, and
  `tar`. When the server has `dbUser`/`dbPass` configured, it also performs a real
  SQL check by calling `listDatabases`.

## Files

- `file_list(server?, domain?, path, recursive?, maxDepth?)`
- `file_stat(server?, domain?, path)`
- `file_read(server?, domain?, path, encoding?, maxBytes?)`
- `file_write(server?, domain?, path, content, encoding?, createDirs?, mode?)`
- `file_upload(server?, domain?, local_paths, remote, overwrite?, chunk_size_mb?, mode?, exclude?, keep_empty_dirs?, dry_run?)`
- `file_download(server?, domain?, remote_paths, local, exclude?, overwrite?, keep_empty_dirs?, dry_run?)`
- `file_mkdir(server?, domain?, path, recursive?)`
- `file_move(server?, domain?, from, to, overwrite?)`
- `file_copy(server?, domain?, from, to, overwrite?)`
- `file_delete(server?, domain?, path, recursive?)` — the server handles the
  confirmation policy
- `file_chmod(server?, domain?, path, mode, recursive?)`

Remote paths are absolute and relative to the subscription root (`/httpdocs/...`,
`/private/...`). The client translates them to real paths because Plesk's `fs` API
resolves relative paths against the document root. Local paths are resolved
against the project root and must stay inside it; local symlinks are skipped.

## Limits

- `file_read`: default 1 MB, maximum 10 MB (`maxBytes`).
- `file_list`: recursive `maxDepth` from 1 to 5, default 2.
- `file_upload`: `chunk_size_mb` default 4, maximum 50.
- SQL `max_rows`: default 1000, maximum 10000.
- SQL `timeout_ms`: default 30000, maximum 300000.
- `list_databases` `limit`: default 100, maximum 500.
- `search_objects` `limit`: default 100, maximum 1000.

### `file_upload` and `file_download`

A single file source path → direct REST transfer, and the destination (`remote`
or `local`) is the exact file path.

A directory or multiple paths → the destination is a directory and two engines
are used:

- `archive`: runs `tar` on the server, transfers the `.tar.gz`, and extracts it.
  Requires `exec` and `tar`.
- `walk`: walks with `fs/list` and transfers file by file in parallel. Works
  without a shell.

`archive` is always attempted first and falls back to `walk` if `exec` is
unavailable.

If the selected domain has no shell, the client looks for another domain on the
server with SSH (`whoami` not empty) and checks `test -e/-r/-w` on the destination
path:

- Same domain or same subscription: normal case.
- Foreign domain: only used if it can read (download) or write (upload) the
  destination. For downloads, the `.tar.gz` is staged in the home directory of the
  domain running the command.
- Responses include `execDomain` and `warnings` when the shell belongs to a
  foreign domain.

Rules:

- Paths are preserved relative to their common ancestor: `/httpdocs/assets` →
  `local/assets/...`. To flatten, enumerate the files.
- `exclude` accepts patterns (`node_modules`, `*.log`, `.git`).
- `overwrite: false` skips files that already exist.
- `mode` only applies to the direct upload of a single file.
- There is no overall limit on file count, depth, bytes, or timeout. Walk
  transfer concurrency is fixed at 4.
- Transient errors are retried indefinitely; auth, DNS, TLS, and data errors are
  returned immediately.
- Remote symlinks are skipped by walk mode but may be preserved by archive mode.
- Remote names that Windows cannot create (invalid characters, reserved names,
  trailing dots/spaces, absolute paths, `..`) are rejected for downloads with
  `WALK_UNSAFE_NAMES` or `ARCHIVE_UNSAFE_ENTRIES`.
- `dry_run` shows the plan without writing anything.
- The local `.tar.gz` and the remote temporary archive are always deleted, even
  if the transfer fails. Remote temp directories are tried in this order:
  `/.plesk-mcp-tmp`, then `<base>/.plesk-mcp-tmp`. Local temporary archives are
  stored under `.plesk/tmp` and then deleted.
- `file_download` is classified as read-only server-side even though it writes to
  the local disk.

## Domains

### `domains_list(server?, includeAliases?)`

Returns every domain and subdomain of the server: `id`, `name`, `asciiName`,
`type` (`domain`/`subdomain`), `baseDomainId`, `hostingType`, `wwwRoot`, and
`aliases`. Not paginated. Domains with `hosting_type` other than `virtual`
(forwarding) are included but cannot run PHP.

## Plesk CLI

### `plesk_cli(server?, id, params?)`

Runs `POST /api/v2/cli/{id}/call`, that is `plesk bin <id> <params>` as root.

- `id` allowlist: `client`, `database`, `dns`, `domain`, `extension`, `ip`,
  `php_handler`, `site`, `subdomain`, `webspace`.
- Read-only when every flag is `--info`, `--list`, `--version`, `--show` or
  `--help`. Otherwise it is a write: confirmation in `confirm` mode, and
  `CLI_WRITE_BLOCKED` in `full`/`client` unless `PLESK_MCP_ALLOW_CLI_WRITE=1`.
- Replaces the former `deps_install` and `node_*` tools, for example
  `id: "extension"`, `params: ["--exec", "nodejs", "--list"]`.

## XML API

### `plesk_xml_call(server?, packet)`

Sends a packet to `https://<panel>:8443/enterprise/control/agent.php` and returns
the parsed `<packet>` response.

- Only `<get>` operators are accepted. `set`/`add`/`del`/`update` are rejected
  with `XML_API_READ_ONLY` before the request is sent.
- Packet size is capped at 64 KB.
- Requires username/password auth (`XML_API_AUTH_UNSUPPORTED` in `apiKey` mode).
- `hosting` datasets expose `php_handler_id`; `php-handler/get` exposes
  `full-version`.

## Databases

SQL tools use the same selector: `server` for a Plesk server or `pc` for a local
database. Exactly one is required; never both.

### `execute_sql(server? | pc?, database, sql, max_rows?, timeout_ms?)`

Runs read SQL. The server classifies the statement and rejects with
`SQL_TOOL_MISMATCH` any verdict other than `read`. Multi-statement SQL is
classified with the most restrictive verdict; a parse error counts as a write, so
it does not go through this tool. `max_rows` defaults to 1000 (max 10000);
`timeout_ms` defaults to 30000 (max 300000).

### `execute_sql_write(server? | pc?, database, sql, timeout_ms?)`

Runs writes, DDL, and administration. Rejects reads with `SQL_TOOL_MISMATCH`.
Because its safety is `write`, in `confirm` mode it goes through the generic
elicitation flow. In `full`/`client` it does not prompt and the client's
permission rule decides (in OpenCode, `plesk_execute_sql_write` with `ask` in
Build and `deny` in Plan).

For Plesk, SQL runs through the `mysql` CLI on any domain with a shell; no SSH
tunnel is required. For `pc`, a direct MySQL connection is used.

### `list_databases(server? | pc?, pattern?, include_system?, limit?, cursor?)`

Lists the databases visible to the MySQL user. By default it hides
`information_schema`, `mysql`, `performance_schema`, and `sys`. Paginates with a
cursor. `limit` defaults to 100 (max 500).

### `search_objects(server? | pc?, database?, object_type, pattern?, table?, detail_level?, limit?)`

Searches objects in `information_schema`. `database` is required unless
`object_type: "schema"`. It keeps the DBHub contract (`object_type`, `pattern`,
`table`, `detail_level`, `limit`) using `database` instead of `schema`. `limit`
defaults to 100 (max 1000).

## Logs

### `logs(server?, domain?, type?, pattern?, lines?)`

`type`: `error`, `access`, or `node`.
