# Configuration

The MCP reads two files with exactly the same format:

- Global: `~/.config/plesk-mcp/config.json`. Override this path with the
  `PLESK_GLOBAL_CONFIG` environment variable.
- Local: `<project-root>/.plesk/config.json`.

## Format

```json
{
  "defaultServer": "prod-example",
  "servers": [
    {
      "name": "prod-example",
      "url": "https://plesk.example.com:8443",
      "auth": {
        "mode": "apiKey",
        "apiKey": "env:PLESK_PROD_KEY"
      },
      "verifyTls": true,
      "timeoutMs": null,
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_PROD_DB_PASS"
    }
  ],
  "localDatabases": [
    {
      "name": "local-mysql-1",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_LOCAL_1_PASSWORD",
      "ssl": false
    }
  ]
}
```

A flat array is also accepted, but only for Plesk servers:

```json
[
  {
    "name": "prod-example",
    "url": "https://plesk.example.com:8443",
    "auth": { "mode": "apiKey", "apiKey": "env:PLESK_PROD_KEY" },
    "verifyTls": true,
    "timeoutMs": null,
    "dbUser": "db_admin",
    "dbPass": "env:PLESK_PROD_DB_PASS"
  }
]
```

In that case there is no `defaultServer` and no `localDatabases`: the first
server is the default. To use local databases you must use the object format.

## Plesk servers (`servers`)

One entry per **Plesk server**, not per domain. Domains are no longer configured
here: they are passed to the tools that need them.

- `name`: unique identifier. This is the value the tool receives in `server`.
- `url`: Plesk base URL, normally including `:8443`.
- `auth.mode`: `apiKey` or `basic`.
  - `apiKey`: `auth.apiKey`.
  - `basic`: `auth.username` and `auth.password`.
- `dbUser`: MySQL user with access to all databases on the server.
- `dbPass`: password for that MySQL user.
- `verifyTls`: TLS certificate verification, default `true`.
- `timeoutMs`: optional per-request timeout in milliseconds. If omitted (or
  `null`) there is no timeout; a positive integer limits each request to that
  many milliseconds.

`dbUser` and `dbPass` must be provided together or not at all. If they are
missing, SQL tools fail closed with `DB_CREDENTIALS_MISSING`, but file and
Node.js tools keep working.

The MySQL connection is not made over TCP from your machine: the client finds any
domain on the server with a shell and the `mysql`/`mariadb` client, and runs the
CLI there. You do not need to configure SSH or the database host.

## Local databases (`localDatabases`)

Direct MySQL connections on the local network, independent of a Plesk server.
The `name` value is what the tool receives in `pc`.

- `name`: unique identifier (for example `local-mysql-1`).
- `host`: IP address or hostname.
- `port`: default `3306`.
- `user` and `password`: MySQL credentials.
- `ssl`: enable TLS for the connection, default `false`.

```json
{
  "localDatabases": [
    {
      "name": "local-mysql-1",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_LOCAL_1_PASSWORD",
      "ssl": false
    },
    {
      "name": "local-mysql-2",
      "host": "127.0.0.1",
      "port": 3307,
      "user": "root",
      "password": "env:MYSQL_LOCAL_2_PASSWORD",
      "ssl": false
    }
  ]
}
```

## Domain in tools

Plesk tools that operate on a subscription accept an optional `domain`:

- `file_*`, `logs`, `domains_list`, `plesk_xml_call`, `doctor`, and `plesk_cli`.

Resolution rule:

1. If the tool receives `domain`, that domain is used.
2. Otherwise, if the server has a single domain, it is auto-detected.
3. If there are several and none is provided, the tool returns
   `PLESK_DOMAIN_REQUIRED` with the list of domains.

This avoids duplicating a `servers` entry for each domain on the same server.

## Merging global and local

- Both files are loaded.
- `servers` are merged by `name`; if the same name exists in both, the local one
  wins.
- `localDatabases` are merged by `name`; if the same name exists in both, the
  local one wins.
- A local `defaultServer` wins over the global one. If neither is set, the first
  server in the union (global first, then local) is the default. If there are no
  Plesk servers, it stays empty.
- A name cannot exist in both `servers` and `localDatabases`:
  `DUPLICATE_TARGET_NAME`.
- If there are neither servers nor local databases, the MCP starts and tools
  return `CONFIG_EMPTY`.

## `env:` references

Any string can be `env:NAME`. It is resolved when the server or database is used,
not when the file is loaded. This way a missing credential does not break the
others.

```json
"apiKey": "env:PLESK_API_KEY",
"dbPass": "env:PLESK_DB_PASS",
"password": "env:MYSQL_LOCAL_1_PASSWORD"
```

## Creating the files

```bash
npx -y @rubcc95/plesk-mcp init
npx -y @rubcc95/plesk-mcp init --global
```

If the package is installed globally, use `plesk-mcp init` directly.

## Project root

The local config path is resolved as follows:

1. `PLESK_PROJECT_ROOT`, if set.
2. The process working directory (`cwd`).

With `npx`, the `cwd` is decided by the MCP client, so if the client cannot set
it (Claude Desktop, for example), use `PLESK_PROJECT_ROOT` or the global config.
