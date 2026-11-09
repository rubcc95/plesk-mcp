# plesk-mcp

Local MCP server for managing one or more Plesk servers:

- Upload, download, and manage files.
- Configure Node.js applications.
- Install dependencies.
- Read domain logs.
- Run SQL against Plesk databases and local MySQL databases.

It replaces the `mysql` MCP server (DBHub): all database access goes through
this server.

## Requirements

- Node.js 22 or newer.
- Plesk Obsidian 18.0.81 or newer on Linux (validated on 18.0.81).
- A Plesk API key, or a username/password with REST API access.
- For SQL on Plesk: at least one domain with shell access and the `mysql` or
  `mariadb` client installed. MySQL credentials (`dbUser`/`dbPass`) are
  configured per Plesk server.
- For archive-based transfers: command execution enabled in the Plesk REST
  extension and `tar` available. If command execution is unavailable, the
  server falls back to REST-only transfers.

## Installation

Install the package globally:

```bash
npm install -g @rubcc95/plesk-mcp
```

Or run it directly with `npx`:

```bash
npx -y @rubcc95/plesk-mcp
```

Install from a clone:

```bash
npm install
npm run build
npm test
npm link
```

The package exposes a single binary, `plesk-mcp`:

- Without arguments it starts the MCP server over stdio.
- With a subcommand (`init`, `doctor`, `servers`, `project-info`) it runs the
  configuration CLI.
- `--help` and `--version` show CLI help and the package version.

## MCP client setup

Add the server once to your MCP client. Example for OpenCode:

```jsonc
{
  "mcp": {
    "servers": {
      "plesk": {
        "type": "local",
        "command": ["npx", "-y", "@rubcc95/plesk-mcp"],
        "environment": {
          "PLESK_MCP_ACCESS": "client"
        }
      }
    }
  }
}
```

`PLESK_MCP_ACCESS=client` means the server does not show its own confirmation
forms; your client's permission dialog is responsible for write operations. If
you omit `environment`, the server runs in `confirm` mode and asks for
confirmation through MCP elicitation. See [Access control](#access-control).

The local configuration file is resolved from the MCP process working
directory. If your client supports `cwd`, point it at the project that contains
`.plesk/config.json`. If it does not, set `PLESK_PROJECT_ROOT` to that project:

```jsonc
"environment": {
  "PLESK_PROJECT_ROOT": "C:\\Users\\you\\projects\\my-project"
}
```

Otherwise, use the global config file, which is always found.

### Claude Code

Claude Code runs the server as a local stdio process. Add it to the project's
`.mcp.json`:

```json
{
  "mcpServers": {
    "plesk": {
      "command": "npx",
      "args": ["-y", "@rubcc95/plesk-mcp"],
      "env": {
        "PLESK_MCP_ACCESS": "client",
        "PLESK_PROJECT_ROOT": "${CLAUDE_PROJECT_DIR:-.}"
      }
    }
  }
}
```

Claude Code sets `CLAUDE_PROJECT_DIR` for stdio servers, so
`PLESK_PROJECT_ROOT` resolves to the project root. Approve the project server
from `/mcp` the first time.

Or register it from the command line:

```bash
claude mcp add --scope project --transport stdio plesk \
  --env PLESK_MCP_ACCESS=client \
  -- npx -y @rubcc95/plesk-mcp
```

If the local config is not found, pass an absolute path:

```bash
claude mcp add --scope project --transport stdio plesk \
  --env PLESK_MCP_ACCESS=client \
  --env PLESK_PROJECT_ROOT=/absolute/path/to/project \
  -- npx -y @rubcc95/plesk-mcp
```

Check the connection:

```bash
claude mcp list
claude mcp get plesk
```

Claude Code permission rules use `mcp__<server>__<tool>`. Minimal example for
`.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plesk__execute_sql",
      "mcp__plesk__list_databases",
      "mcp__plesk__search_objects"
    ],
    "ask": [
      "mcp__plesk__execute_sql_write"
    ]
  }
}
```

Add the other write tools (`mcp__plesk__file_write`,
`mcp__plesk__file_upload`, `mcp__plesk__file_delete`,
`mcp__plesk__deps_install`, and so on) to `ask` as needed. The full list is in
[docs/access-control.md](docs/access-control.md).

## Configuration

The server reads two files with the same format:

- Global: `~/.config/plesk-mcp/config.json`
- Local: `<project>/.plesk/config.json`

Set `PLESK_GLOBAL_CONFIG` to use a different global file.

Example:

```json
{
  "defaultServer": "prod-example",
  "servers": [
    {
      "name": "prod-example",
      "url": "https://plesk.example.com:8443",
      "auth": {
        "mode": "apiKey",
        "apiKey": "env:PLESK_API_KEY"
      },
      "verifyTls": true,
      "timeoutMs": null,
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_DB_PASSWORD"
    },
    {
      "name": "client-a",
      "url": "https://plesk.client-a.example:8443",
      "auth": {
        "mode": "basic",
        "username": "admin",
        "password": "env:PLESK_CLIENT_A_PASSWORD"
      },
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_CLIENT_A_DB_PASSWORD"
    }
  ],
  "localDatabases": [
    {
      "name": "local-mysql-1",
      "host": "192.168.1.50",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_LOCAL_1_PASSWORD",
      "ssl": false
    }
  ]
}
```

### Rules

- Both files are loaded and merged by `name`.
- If the same name exists in both files, the local entry wins.
- The local `defaultServer` wins over the global one.
- If no `defaultServer` is set, the first merged server is the default.
- A `servers` entry is a Plesk server, not a domain. Pass `domain` to tools that
  need it; if the server has only one domain, it is detected automatically.
- `dbUser`/`dbPass` are MySQL credentials for that Plesk server and are used for
  all of its databases. They must be provided together.
- `localDatabases` contains direct MySQL connections reachable from your
  machine (`name` is passed as `pc` in SQL tools).
- The same name cannot exist in both `servers` and `localDatabases`
  (`DUPLICATE_TARGET_NAME`).
- Any string value can be `env:VARIABLE`. References are resolved lazily when
  the target is used, so a missing variable only breaks that target.
- If neither file exists or both are empty, the MCP server still starts and
  exposes three configuration-error tools instead of failing to boot.

A flat array is also accepted, but only for Plesk servers:

```json
[
  {
    "name": "prod-example",
    "url": "https://plesk.example.com:8443",
    "auth": { "mode": "apiKey", "apiKey": "env:PLESK_API_KEY" },
    "dbUser": "db_admin",
    "dbPass": "env:PLESK_DB_PASSWORD"
  }
]
```

In that format there is no `defaultServer` and no `localDatabases`; the first
server is the default.

### Server fields

- `name`: unique identifier used by the `server` input.
- `url`: Plesk base URL, usually with `:8443`.
- `auth.mode`: `apiKey` or `basic`.
  - `apiKey`: requires `auth.apiKey`.
  - `basic`: requires `auth.username` and `auth.password`.
- `verifyTls`: verify the Plesk TLS certificate. Defaults to `true`.
- `timeoutMs`: per-request timeout in milliseconds. `null` or omitted means no
  timeout.
- `dbUser` / `dbPass`: MySQL credentials with access to the server databases.

### Local database fields

- `name`: unique identifier used by the `pc` input.
- `host`, `port`: MySQL endpoint. Port defaults to `3306`.
- `user`, `password`: MySQL credentials.
- `ssl`: use TLS for the MySQL connection. Defaults to `false`.

### Create the files

```bash
npx -y @rubcc95/plesk-mcp init            # local project config
npx -y @rubcc95/plesk-mcp init --global   # global config
```

If the package is installed globally, drop the `npx -y @rubcc95/plesk-mcp`
prefix and use `plesk-mcp` directly.

`init` creates an empty registry and adds `.plesk/config.json` to the project
`.gitignore`.

### CLI commands

```bash
npx -y @rubcc95/plesk-mcp init [--global] [--force]
npx -y @rubcc95/plesk-mcp servers
npx -y @rubcc95/plesk-mcp project-info
npx -y @rubcc95/plesk-mcp doctor [--server <name>] [--domain <domain>]
```

The CLI `doctor` checks configuration, authentication, domain resolution,
filesystem access, command execution, `tar`, and path access. It exits with a
non-zero status if any check fails. The MCP `doctor` tool additionally validates
SQL connectivity when `dbUser`/`dbPass` are configured.

## Access control

The server is a single process and always registers every tool. Write
protection is applied at two levels: the MCP server and the client.

### Server modes

`PLESK_MCP_ACCESS` controls server-side confirmation:

| Value | Behavior |
| --- | --- |
| `confirm` (default) | Write tools ask for confirmation through MCP elicitation. If the client does not support elicitation, the call fails with `CONFIRMATION_UNSUPPORTED`. |
| `full` | No server-side confirmation. Intended for clients that apply their own permission dialog, or for tests. |
| `client` | Alias for `full`, used to express that the client handles confirmation. |
| `off`, `none` | Aliases for `full`. |
| `write` | Alias for `confirm`. |

Invalid values fall back to `confirm` and log a warning.

Additional rules:

- `dry_run: true` never asks for confirmation because it does not modify
  anything.
- `file_download` is classified as read-only on the server even though it writes
  to your local disk. It does not ask for confirmation.
- Every tool publishes standard annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- `project_info` reports the active access mode.

### SQL tools

SQL is split into two tools so the client can give them different permissions:

- `execute_sql`: read-only (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`).
- `execute_sql_write`: writes, DDL, administration, and unclassified SQL.

The server rejects a statement sent to the wrong tool with
`SQL_TOOL_MISMATCH`. In `confirm` mode, `execute_sql_write` also goes through the
generic write confirmation. In `full`/`client` mode it does not; the client's
permission layer is the only gate.

### OpenCode example

```jsonc
{
  "permissions": [
    { "action": "plesk_execute_sql", "resource": "*", "effect": "allow" },
    { "action": "plesk_execute_sql_write", "resource": "*", "effect": "ask" },
    { "action": "plesk_file_write", "resource": "*", "effect": "ask" },
    { "action": "plesk_file_delete", "resource": "*", "effect": "ask" }
  ],
  "agents": {
    "plan": {
      "permissions": [
        { "action": "plesk_execute_sql_write", "resource": "*", "effect": "deny" },
        { "action": "plesk_file_write", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

The complete list of write tools and a full OpenCode configuration are in
[docs/access-control.md](docs/access-control.md).

## Tools

All Plesk tools accept an optional `server`. If omitted, the default server is
used. Tools that operate on a subscription accept an optional `domain`; if it is
omitted and the server has only one domain, it is detected automatically. If
there are several domains, the tool returns `PLESK_DOMAIN_REQUIRED`.

### Project and diagnostics

| Tool | Inputs | Description |
| --- | --- | --- |
| `servers_list` | - | Lists Plesk servers, local databases, their source, and the default. |
| `project_info` | - | Returns config paths, default server, access mode, servers, and local databases. No secrets. |
| `doctor` | `server?`, `domain?` | Checks auth, domain, filesystem, SQL, command execution, `tar`, and path access. |

### Files

| Tool | Inputs | Description |
| --- | --- | --- |
| `file_list` | `server?`, `domain?`, `path`, `recursive?`, `maxDepth?` | Lists a remote directory. `maxDepth` is 1-5 (default 2). |
| `file_stat` | `server?`, `domain?`, `path` | Returns size, type, permissions, and modification time. |
| `file_read` | `server?`, `domain?`, `path`, `encoding?`, `maxBytes?` | Reads a file as UTF-8 or base64. Default limit 1 MB, maximum 10 MB. |
| `file_write` | `server?`, `domain?`, `path`, `content`, `encoding?`, `createDirs?`, `mode?` | Writes a file. Creates parent directories by default. |
| `file_upload` | `server?`, `domain?`, `local_paths`, `remote`, `overwrite?`, `chunk_size_mb?`, `mode?`, `exclude?`, `keep_empty_dirs?`, `dry_run?` | Uploads files or directories. |
| `file_download` | `server?`, `domain?`, `remote_paths`, `local`, `exclude?`, `overwrite?`, `keep_empty_dirs?`, `dry_run?` | Downloads files or directories. |
| `file_mkdir` | `server?`, `domain?`, `path`, `recursive?` | Creates a directory. |
| `file_move` | `server?`, `domain?`, `from`, `to`, `overwrite?` | Moves or renames a path. `overwrite` defaults to `false`. |
| `file_copy` | `server?`, `domain?`, `from`, `to`, `overwrite?` | Copies a path. `overwrite` defaults to `false`. |
| `file_delete` | `server?`, `domain?`, `path`, `recursive?` | Deletes a path. |
| `file_chmod` | `server?`, `domain?`, `path`, `mode`, `recursive?` | Changes permissions. |

Remote paths are absolute and virtual to the subscription root
(`/httpdocs/...`, `/private/...`). The client translates them to the real
subscription home because the Plesk API resolves relative paths against the
document root.

Local paths must stay inside the project root. Symlinks that escape the project
are rejected, and local symlinks are skipped during recursive uploads.

### Node.js

| Tool | Inputs | Description |
| --- | --- | --- |
| `node_list` | `server?` | Lists Node.js applications managed by Plesk. |
| `node_info` | `server?`, `domain?` | Returns the application configuration. |
| `node_configure` | `server?`, `domain?`, `appRoot?`, `startupFile?`, `nodeVersion?`, `appMode?`, `packageManager?`, `documentRoot?` | Auto-configures the application when no options are passed; otherwise updates the given settings. |
| `node_update` | same as `node_configure` | Updates the given settings. |
| `node_env_list` | `server?`, `domain?` | Lists environment variable names only. Never returns values. |
| `node_env_set` | `server?`, `domain?`, `file` | Imports a local `.env` file. Variables are always stored as secrets in Plesk. The tool never returns names or values. |
| `node_env_unset` | `server?`, `domain?`, `key` | Removes an environment variable. |
| `node_install` | `server?`, `domain?` | Installs dependencies with the configured package manager. |
| `node_run_script` | `server?`, `domain?`, `script` | Runs a `package.json` script. |
| `node_restart` | `server?`, `domain?` | Restarts the application. |
| `node_start` | `server?`, `domain?` | Starts the application. |
| `node_stop` | `server?`, `domain?` | Stops the application. |
| `node_status` | `server?`, `domain?` | Returns the application status. |

`node_env_set` writes entries sequentially. If Plesk rejects an entry, the
operation stops and variables already written remain. Restart the application
after changing environment variables.

### Dependencies

| Tool | Inputs | Description |
| --- | --- | --- |
| `deps_install` | `server?`, `domain?`, `command`, `cwd?` | Runs an allowlisted installer: `npm`, `pnpm`, `yarn`, `composer`, `bundle`, `pip`, or `pip3`. This is not a free-form shell. |

### Logs

| Tool | Inputs | Description |
| --- | --- | --- |
| `logs` | `server?`, `domain?`, `type?`, `pattern?`, `lines?` | Searches domain logs. `type` is `error`, `access`, or `node`. `lines` is limited to 2000. |

### SQL

SQL tools require exactly one target: `server` for a Plesk server or `pc` for a
local database. There is no default target for SQL.

| Tool | Inputs | Description |
| --- | --- | --- |
| `execute_sql` | `server?` or `pc?`, `database`, `sql`, `max_rows?`, `timeout_ms?` | Runs read-only SQL. `max_rows` defaults to 1000 (max 10000); timeout defaults to 30 s (max 300 s). |
| `execute_sql_write` | `server?` or `pc?`, `database`, `sql`, `timeout_ms?` | Runs writes, DDL, administration, and unclassified SQL. |
| `list_databases` | `server?` or `pc?`, `pattern?`, `include_system?`, `limit?`, `cursor?` | Lists databases. Default limit 100 (max 500). Uses cursor pagination. |
| `search_objects` | `server?` or `pc?`, `database?`, `object_type`, `pattern?`, `table?`, `detail_level?`, `limit?` | Searches `information_schema`. `object_type` is `schema`, `table`, `view`, `column`, `index`, `procedure`, or `function`. |

`database` is required except for `object_type=schema`; `table` is required for
columns and indexes. `detail_level` is `names`, `summary` (default), or `full`.

The SQL classifier assigns one of `read`, `write`, `ddl`, `admin`, or `unknown`:

- `SELECT`, `SHOW`, `DESCRIBE`, and `EXPLAIN` are reads.
- `INSERT`, `UPDATE`, `DELETE`, and `REPLACE` are writes.
- `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, and `RENAME` are DDL.
- `GRANT`, `REVOKE`, `SET`, `CALL`, `USE`, locks, transactions, `FLUSH`,
  `KILL`, and table maintenance are administrative.
- Unparseable or unrecognized SQL is `unknown` and therefore only accepted by
  `execute_sql_write` (fail closed).

Multi-statement SQL is classified with the most restrictive verdict. On Plesk,
multi-statement output is returned as raw text. On local databases, each
statement result is returned separately.

### Plesk SQL execution

Plesk SQL does not use a direct TCP connection from your machine. The server
finds a domain with shell and the `mysql`/`mariadb` client, then runs a bash
script with a temporary `--defaults-extra-file` created under `umask 077` and
removed by a `trap` on exit.

### Local SQL execution

Local databases use `mysql2` over TCP with `multipleStatements: true` and
`utf8mb4`. Connection pools are reused and evicted after 10 minutes of
inactivity.

## File transfers

`file_upload` and `file_download` accept one or more paths. The destination is
interpreted by context:

- A single file: `remote` / `local` is the exact file path.
- A directory or multiple paths: `remote` / `local` is the destination
  directory.

### Direct transfer

A single file is transferred directly through REST in chunks. Uploads first
write to a temporary remote file and then move it into place; failures clean up
the temporary file. `chunk_size_mb` defaults to 4 MB and accepts up to 50 MB.
`mode` applies only to this direct single-file upload.

### Archive and walk modes

For multiple files or directories, two engines are available:

- `archive`: creates a `.tar.gz` on the server, transfers it, and extracts it.
  It is the fastest option but requires `exec` and `tar`.
- `walk`: walks the tree with `fs/list` and transfers files over REST in
  parallel. It works on subscriptions without shell, including `/bin/false`,
  but makes one request per file.

The server always tries `archive` first and automatically falls back to `walk`
when command execution is unavailable.

### Shell discovery

If the selected domain has no shell, the server looks for another domain with
SSH access:

- Domains in the same subscription (addon domains and subdomains) are preferred
  because they share the system user.
- It verifies access with `test -e/-r/-w` before using a foreign shell.
- For downloads, if the shell belongs to another domain, the `.tar.gz` is
  created and downloaded from that domain's home.
- For uploads, a foreign shell is used only if it can write to the destination.
  Extracted files keep that user's ownership and the response includes a
  warning.
- If no domain works, the transfer falls back to `walk`.

`doctor` includes the `execPaths` check: if a shell exists but cannot access the
domain path, it reports the problem and confirms that `walk` will be used.

### Transfer rules

- Paths are preserved relative to the common ancestor. `/httpdocs/assets`
  produces `local/assets/...`. To flatten a tree, list individual files instead
  of the directory.
- `exclude` accepts glob patterns such as `node_modules`, `.git`, or `*.log`.
- `overwrite: false` skips files that already exist.
- There are no file count, depth, byte, or timeout limits. Transfers run until
  they complete or fail. Upload chunks are capped at 50 MB.
- Transient errors (network, timeouts, 5xx, 429) are retried indefinitely with
  exponential backoff. Permanent errors (auth, DNS, TLS, invalid data) are
  returned immediately.
- Walk mode uses a fixed concurrency of 4.
- `dry_run` returns the transfer plan without writing anything.
- The local `.tar.gz` (`.plesk/tmp`) and remote temporary archive are always
  deleted, even when the transfer fails.
- Remote temp directories are tried in this order: `/.plesk-mcp-tmp`, then
  `<base>/.plesk-mcp-tmp`.
- Local extraction rejects unsafe archive entries and names that Windows cannot
  create.
- Remote symlinks are skipped by `walk` mode. `archive` mode may preserve them,
  subject to the same safety checks on local extraction.
- Local symlinks are always skipped.

## Security

- `.plesk/config.json` is in `.gitignore`. Keep the global config outside the
  repository.
- Prefer `env:` references for API keys and database passwords instead of
  storing secrets in the JSON file.
- Configure your MCP client to deny reading the local and global config files.
- Write tools require human confirmation in `confirm` mode, or the client's
  permission dialog in `full`/`client` mode.
- `deps_install` accepts only known installers (`npm`, `pnpm`, `yarn`,
  `composer`, `bundle`, `pip`, `pip3`).
- `file_upload` and `file_download` execute `tar` only with validated paths and
  exclusion patterns.
- If the selected domain has no shell, another domain's shell can be used, but
  always as that domain's system user (never root) and only after verifying real
  access with `test -e/-r/-w`.
- The only internal commands executed by the server are `whoami`, `test`,
  `pwd`, `printenv`, `tar`, `mysql`/`mariadb`, the `plesk ext nodejs` CLI, and
  the installers allowed by `deps_install`. There is no generic shell tool.
- `node_run_script` can run any script defined in the application's
  `package.json`. Package installers may also run lifecycle scripts. Treat both
  as code execution on the server and restrict them with client permissions.
- Local symlinks are always skipped.
- `node_env_set` does not accept keys or values directly: it imports a local
  `.env` file, stores every entry as a secret in Plesk, and never returns the
  contents to the AI.
- Plesk MySQL credentials are not used over TCP from your machine. The `mysql`
  CLI runs on a domain with shell, with a temporary `umask 077` credentials file
  that is deleted on exit.
- `execute_sql` only runs reads and `execute_sql_write` only runs
  writes/DDL/administration (`SQL_TOOL_MISMATCH` otherwise). The human gate is
  provided by the client: `execute_sql_write` with `ask` in Build and `deny` in
  Plan.
- The Plesk MySQL user can access all databases on the server, so the SQL
  classifier and the client permissions are the write control.
- The server itself is a guardrail against AI mistakes, not a security boundary:
  anyone who can start the process can set `PLESK_MCP_ACCESS=full`.

## Validation status

Validated on Plesk Obsidian 18.0.81 (Linux):

- The `fs` API resolves relative paths against the document root and accepts
  absolute paths inside the webspace. The client translates the MCP virtual
  paths (`/httpdocs/...`) to the real subscription home.
- `fs/mkdir` uses `path` as a query parameter with no request body.
- `file_download` end to end:
  - `archive` mode with `exec`/`tar` on a domain with shell.
  - `auto` mode on a domain with `/bin/false`, falling back to `walk` and
    downloading in parallel over REST.
  - `overwrite=false` skips existing files in both modes.
  - direct single-file transfer without `tar`.
- Configuration loading and precedence, SQL classification, and the file
  transfer engines are covered by unit tests.

Pending validation against real servers:

- `plesk ext nodejs` flags through `/cli/extension/call`.
- Plesk upload chunk-size limits.
- `execute_sql_write` in production with `ask` in Build and `deny` in Plan.

## Documentation

- [MCP contract](docs/mcp-contract.md)
- [Access control](docs/access-control.md)
- [Project configuration](docs/project-config.md)
- [SQL manager](docs/sql-manager.md)

## License

MIT
