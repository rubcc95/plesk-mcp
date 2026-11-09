# SQL query manager

Database access is unified inside `plesk-mcp`, which also replaces the `mysql`
MCP server (DBHub). There is no separate SQL entrypoint or server.

## 1. Decisions

1. **Single MCP**: SQL tools live in `plesk-mcp`; there is no `sql-index.js`
   entrypoint or separate `mysql` server.
2. **Four tools**: `execute_sql`, `execute_sql_write`, `list_databases`, and
   `search_objects`.
3. **Two execution tools**: `execute_sql` accepts only reads and
   `execute_sql_write` accepts only writes/DDL/administration. This lets the
   client give them different permissions (for example, Plan denies the write
   one).
4. **Two target types**:
   - `server`: a Plesk server from the `servers` array.
   - `pc`: a local database from the `localDatabases` array (for example
     `local-mysql-1`).
5. **Plesk**: there is no direct TCP access or configured SSH tunnel. The client
   finds any domain on the server with a shell and `mysql`/`mariadb`, and runs the
   `mysql` CLI there with `dbUser`/`dbPass`. The subscription does not matter.
6. **Local**: direct `mysql2` over TCP with `host`, `port`, `user`, `password`,
   and optional `ssl`.
7. **Permission per tool, not per SQL statement**: the classifier only decides
   which tool may run the statement (`SQL_TOOL_MISMATCH` otherwise). The human
   gate is applied by the client through its permissions (`ask` in Build, `deny`
   in Plan). In server `confirm` mode, `execute_sql_write` also goes through the
   generic elicitation flow.
8. **Single instance**: Plan and Build share the same server; different behavior
   comes from the client's per-agent permissions.

## 2. Configuration

Plesk servers are no longer configured per domain. One entry per server, with no
`domain`, `domainId`, `execDomain`, or `execDomainId`.

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

- `dbUser`/`dbPass` are the Plesk server's MySQL credentials and give access to
  all its databases.
- `verifyTls` defaults to `true`; `timeoutMs` defaults to `null` (no timeout).
- `localDatabases` is independent of `servers`. `ssl` defaults to `false`.
- `env:VAR` is resolved when the target is used.
- A name cannot exist in both `servers` and `localDatabases`
  (`DUPLICATE_TARGET_NAME`).
- The Plesk tool `domain` is passed as input (`file_*`, `logs`, `deps_install`,
  `doctor`, `node_*`). If the server has a single domain, it is auto-detected.

## 3. Tools

### `execute_sql`

```ts
{
  server?: string,   // Plesk server
  pc?: string,       // local database
  database: string,
  sql: string,       // read only
  max_rows?: number, // default 1000, max 10000
  timeout_ms?: number // default 30000, max 300000
}
```

Exactly one of `server`/`pc`. Missing both returns `TARGET_REQUIRED`; providing
both returns `TARGET_CONFLICT`. `database` is required. If the verdict is not
`read`, it returns `SQL_TOOL_MISMATCH`.

### `execute_sql_write`

```ts
{
  server?: string,
  pc?: string,
  database: string,
  sql: string,       // write, DDL, or administration
  timeout_ms?: number // default 30000, max 300000
}
```

If the verdict is `read`, it returns `SQL_TOOL_MISMATCH`. Its safety is `write`,
so in `confirm` mode it goes through the generic elicitation flow; in
`full`/`client` the client's permission decides whether it is allowed, asked, or
blocked.

### `list_databases`

```ts
{
  server?: string,
  pc?: string,
  pattern?: string,       // LIKE
  include_system?: boolean,
  limit?: number,         // default 100, max 500
  cursor?: string
}
```

Lists the databases visible to the MySQL user. By default it hides
`information_schema`, `mysql`, `performance_schema`, and `sys`.

### `search_objects`

```ts
{
  server?: string,
  pc?: string,
  database?: string,      // required unless object_type="schema"
  object_type: "schema" | "table" | "view" | "column" | "procedure" | "function" | "index",
  pattern?: string,       // LIKE
  table?: string,         // required for column and index
  detail_level?: "names" | "summary" | "full",
  limit?: number          // default 100, max 1000
}
```

## 4. Classifier and policy

Verdicts: `read`, `write`, `ddl`, `admin`, `unknown`.

- `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` without execution → `read`.
- `INSERT`, `UPDATE`, `DELETE`, `REPLACE` → `write`.
- `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME` → `ddl`.
- `GRANT`, `REVOKE`, `SET`, `CALL`, `USE`, `LOCK`, `FLUSH`, `KILL`,
  transactions, `LOAD` → `admin`.
- Parse error or unrecognized SQL → `unknown`.
- `SELECT ... INTO OUTFILE`, `FOR UPDATE`, `LOCK IN SHARE MODE`, `LOAD_FILE`,
  `LOAD DATA` → at least `write`.
- Multi-statement SQL: the most restrictive verdict applies.

Policy:

- There are no SQL environment variables. The server's only rule is that the
  statement matches the tool: `read` → `execute_sql`; `write`, `ddl`, `admin`,
  and `unknown` → `execute_sql_write`. Otherwise, `SQL_TOOL_MISMATCH`.
- The human gate lives in the client:
  `plesk_execute_sql` → `allow`; `plesk_execute_sql_write` → `ask` in Build and
  `deny` in Plan.
- In server `confirm` mode, `execute_sql_write` also uses the generic MCP
  elicitation confirmation. In `full`/`client` there is no server prompt.
- Fail-closed: a parse error counts as a write, so it can only enter through
  `execute_sql_write`.

## 5. Execution on Plesk

1. `findShellDomain(client, { require })` walks domains and picks the first one
   with a shell and `mysql`/`mariadb`.
2. That domain is cached per server.
3. A bash script runs with `umask 077`, a temporary `--defaults-extra-file`, and
   a `trap` to delete it:

```bash
mysql --defaults-extra-file="$f" -D "$database" --batch \
  --default-character-set=utf8mb4 -e "$sql"
```

4. The `--batch` output is parsed as TSV (with special characters escaped). For
   writes or multi-statement SQL, the result returns `stdout`/`stderr`/`exitCode`.
5. `dbHost` and `dbPort` are not used: the CLI runs on the server and connects to
   `localhost`.

## 6. Local execution

- `mysql2/promise` with a pool per `(pc, database)`.
- `multipleStatements: true`, `charset: utf8mb4`.
- Simple LRU with idle eviction.
- Typed results; rows are truncated to `max_rows`.
- `ssl` enables TLS for the connection (default `false`).

## 7. Security

- The classifier is a guardrail against AI mistakes, not a security boundary.
- The Plesk MySQL user has access to all databases; write control is the tool
  split plus client permissions.
- Credentials and SQL containing secrets are not returned in responses.
- The temporary credentials file is created with `umask 077` and deleted when the
  command finishes.

## 8. Implementation

- `src/sql/classifier.ts`: parser and verdicts.
- `src/sql/format.ts`: TSV, LIKE, cursor, and pagination.
- `src/sql/objects-query.ts`: `information_schema` queries.
- `src/sql/plesk-target.ts`: `mysql` CLI through `exec`.
- `src/sql/local-target.ts`: `mysql2`.
- `src/sql/tools.ts`: registration of the four tools.
- `src/tools/policy.ts`: access modes and generic confirmation.
- `src/index.ts`: registers `registerSqlTools`.

## 9. Validation checklist

- Exercise `execute_sql` against a Plesk server with a MySQL user that can see all
  databases.
- Exercise `list_databases` and `search_objects` on Plesk and on a local database.
- Verify write confirmation in Plan and Build under `confirm` and `full`/`client`
  modes.
