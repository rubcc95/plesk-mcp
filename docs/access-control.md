# Access control and confirmations

The MCP server is a single server and always registers every tool. Protection is
applied at two levels:

1. **MCP server**: write operations ask for human confirmation when the server is
   in `confirm` mode.
2. **Client**: each client can hide or deny tools per agent. OpenCode uses this
   so that Plan cannot write.

## Server modes

Modes are controlled by the `PLESK_MCP_ACCESS` environment variable:

| Value | Behavior |
| --- | --- |
| `confirm` (default) | Write tools request confirmation through MCP elicitation. If the client does not support it, the call fails with `CONFIRMATION_UNSUPPORTED`. |
| `full` | No elicitation: the server does not prompt and relies on the client's own permission layer. |

Aliases and fallbacks:

- `write` is an alias of `confirm`.
- `off` and `none` are aliases of `full`.
- `client` is **not** a separate server mode. In `src/tools/policy.ts` it is an
  alias of `full`: the server behaves exactly the same and does not prompt. The
  name only expresses the intent that the client should show its own permission
  dialog.
- Any other invalid value falls back to `confirm` for safety and logs a warning.

The effective mode is shown in `project_info` and at startup:

```text
[plesk-mcp] access=confirm
```

## How a write is confirmed

Before executing a write tool in `confirm` mode, the server sends an
`elicitation/create` request with a confirmation form. The operation runs only if
the user responds `accept` and checks the `confirm` box.

- `dry_run: true` does not request confirmation, because nothing is modified.
- If the user rejects or cancels, the tool returns `CONFIRM_REJECTED` and nothing
  is changed.
- If the client does not declare elicitation capability, the tool returns
  `CONFIRMATION_UNSUPPORTED`.

Each tool also publishes standard `annotations` (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can classify
them. They are informative: the server enforces the real behavior.

## Classification

Read-only (never prompt):

`servers_list`, `project_info`, `doctor`, `file_list`, `file_stat`,
`file_read`, `file_download`, `logs`, `node_list`, `node_info`,
`node_env_list`, `node_status`, `list_databases`, `search_objects`.

Write (prompt in `confirm` mode):

`file_write`, `file_upload`, `file_mkdir`, `file_move`, `file_copy`,
`file_delete`, `file_chmod`, `node_configure`, `node_update`, `node_env_set`,
`node_env_unset`, `node_install`, `node_run_script`, `node_restart`,
`node_start`, `node_stop`, `deps_install`, `execute_sql_write`.

`file_download` is classified as read-only because it does not modify the
server, even though it writes to the local disk.

`execute_sql` and `execute_sql_write` are static from the client's point of view:
the first accepts only reads and the second accepts only writes, DDL, or
administration (`SQL_TOOL_MISMATCH` otherwise). Because `execute_sql_write` has
safety `write`, in `confirm` mode it **does** go through the generic elicitation
flow. In `full`/`client`/`off`/`none` it does not prompt and relies on the
client's permission layer.

## Databases

There are no SQL-specific policies or environment variables. The classifier only
decides which tool may run the statement; the human gate is provided by the
client:

| Tool | Accepts | Recommended permission (OpenCode) |
| --- | --- | --- |
| `execute_sql` | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | `allow` in Build and Plan |
| `execute_sql_write` | `write`, `ddl`, `admin`, `unknown` | `ask` in Build, `deny` in Plan |

- Multi-statement SQL is classified with the most restrictive verdict.
- SQL that cannot be parsed counts as a write (fail-closed): it can only go
  through `execute_sql_write`.
- In `confirm` mode, `execute_sql_write` follows the same generic confirmation
  flow as any other write tool. In `full`/`client` there is no server prompt.

## OpenCode with the native dialog

OpenCode has its own permission dialog with **Allow once**, **Allow always**, and
**Deny**. To use it, start the MCP in `full` mode (the `client` alias is
equivalent) and mark writes with `effect: "ask"`:

```jsonc
{
  "mcp": {
    "servers": {
      "plesk": {
        "type": "local",
        "command": ["npx", "-y", "@rubcc95/plesk-mcp"],
        "cwd": ".",
        "environment": { "PLESK_MCP_ACCESS": "client" }
      }
    }
  },
  "permissions": [
    { "action": "plesk_file_write",      "resource": "*", "effect": "ask" },
    { "action": "plesk_file_upload",     "resource": "*", "effect": "ask" },
    { "action": "plesk_file_mkdir",      "resource": "*", "effect": "ask" },
    { "action": "plesk_file_move",       "resource": "*", "effect": "ask" },
    { "action": "plesk_file_copy",       "resource": "*", "effect": "ask" },
    { "action": "plesk_file_delete",     "resource": "*", "effect": "ask" },
    { "action": "plesk_file_chmod",      "resource": "*", "effect": "ask" },
    { "action": "plesk_node_configure",  "resource": "*", "effect": "ask" },
    { "action": "plesk_node_update",     "resource": "*", "effect": "ask" },
    { "action": "plesk_node_env_set",    "resource": "*", "effect": "ask" },
    { "action": "plesk_node_env_unset",  "resource": "*", "effect": "ask" },
    { "action": "plesk_node_install",    "resource": "*", "effect": "ask" },
    { "action": "plesk_node_run_script", "resource": "*", "effect": "ask" },
    { "action": "plesk_node_restart",    "resource": "*", "effect": "ask" },
    { "action": "plesk_node_start",      "resource": "*", "effect": "ask" },
    { "action": "plesk_node_stop",       "resource": "*", "effect": "ask" },
    { "action": "plesk_deps_install",    "resource": "*", "effect": "ask" }
  ],
  "agents": {
    "plan": {
      "permissions": [
        { "action": "plesk_file_write",      "resource": "*", "effect": "deny" },
        { "action": "plesk_file_upload",     "resource": "*", "effect": "deny" },
        { "action": "plesk_file_mkdir",      "resource": "*", "effect": "deny" },
        { "action": "plesk_file_move",       "resource": "*", "effect": "deny" },
        { "action": "plesk_file_copy",       "resource": "*", "effect": "deny" },
        { "action": "plesk_file_delete",     "resource": "*", "effect": "deny" },
        { "action": "plesk_file_chmod",      "resource": "*", "effect": "deny" },
        { "action": "plesk_node_configure",  "resource": "*", "effect": "deny" },
        { "action": "plesk_node_update",     "resource": "*", "effect": "deny" },
        { "action": "plesk_node_env_set",    "resource": "*", "effect": "deny" },
        { "action": "plesk_node_env_unset",  "resource": "*", "effect": "deny" },
        { "action": "plesk_node_install",    "resource": "*", "effect": "deny" },
        { "action": "plesk_node_run_script", "resource": "*", "effect": "deny" },
        { "action": "plesk_node_restart",    "resource": "*", "effect": "deny" },
        { "action": "plesk_node_start",      "resource": "*", "effect": "deny" },
        { "action": "plesk_node_stop",       "resource": "*", "effect": "deny" },
        { "action": "plesk_deps_install",    "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

The server starts with `PLESK_MCP_ACCESS=client`, so it does not show its own
form. OpenCode performs the confirmation through its native dialog.

SQL needs no environment configuration: it uses two tools with different
permissions.

```jsonc
{ "action": "plesk_execute_sql",       "resource": "*", "effect": "allow" },
{ "action": "plesk_execute_sql_write", "resource": "*", "effect": "ask" },
```

In the Plan agent, add:

```jsonc
"agents": {
  "plan": {
    "permissions": [
      { "action": "plesk_execute_sql_write", "resource": "*", "effect": "deny" }
    ]
  }
}
```

`plesk_list_databases` and `plesk_search_objects` are read-only and can stay on
`allow`.

- **Plan**: OpenCode blocks the tools before calling the MCP.
- **Build**: OpenCode shows **Allow once / Allow always / Deny** for the tool. If
  you choose **Allow always**, OpenCode stores an `allow` rule for that tool and
  stops asking.
- **General / Explore / subagents**: they inherit the global `ask` rules. If you
  want them read-only, add their own `deny` rules.

### Elicitation or native dialog?

- **OpenCode's native dialog** (`full`/`client` + `ask`): supports **Allow
  always** and does not duplicate prompts. This is the recommended setup when
  OpenCode is the primary client.
- **Server elicitation** (`confirm`): works with any MCP client, but has no
  "Allow always" and shows one form per operation.

Do not enable both at the same time: you would see two confirmations.

## Other clients

- **With elicitation**: no configuration needed; the server asks for
  confirmation on every write.
- **With its own permissions**: start with `PLESK_MCP_ACCESS=full` and let the
  client apply `ask` to write tools.
- **Without elicitation or permissions**: writes fail safely. Only read-only
  tools can be used.

## Limits

- `PLESK_MCP_ACCESS` is a guardrail against AI mistakes, not a security
  boundary: anyone who can launch the process can set it to `full`.
- An agent with unrestricted shell access could try to start another instance of
  the MCP in `full` mode. To prevent this, restrict the agent's shell as well or
  run it without credentials.
