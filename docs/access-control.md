# Control de acceso y confirmaciones

El servidor MCP es único y siempre registra todas las tools. La protección se
aplica en dos niveles:

1. **Servidor MCP**: toda operación de escritura pide confirmación humana.
2. **Cliente**: cada cliente puede ocultar o denegar tools por agente. OpenCode
   lo usa para que Plan no pueda escribir.

## Modos del servidor

Se controlan con la variable de entorno `PLESK_MCP_ACCESS`:

| Valor | Comportamiento |
| --- | --- |
| `confirm` (defecto) | Las tools de escritura piden confirmación por MCP elicitation. Si el cliente no la soporta, la llamada falla con `CONFIRMATION_UNSUPPORTED`. |
| `client` | No usa elicitation: deja la confirmación al sistema de permisos del cliente. Es el modo recomendado para OpenCode. |
| `full` | No pide confirmación. Solo para tests o clientes que ya aplican su propia confirmación. |

Se aceptan los alias `write` para `confirm`, y `off` / `none` para `full`.
`client` y `full` se comportan igual en el servidor; `client` expresa la
intención de que el cliente muestre el diálogo de permisos.

El modo se muestra en `project_info` y en el arranque:

```text
[plesk-mcp] access=confirm
```

## Cómo se confirma una escritura

Antes de ejecutar una tool de escritura, el servidor envía un
`elicitation/create` con un formulario de confirmación. La operación solo se
ejecuta si el usuario responde `accept` y marca la casilla `confirm`.

- `dry_run: true` no pide confirmación, porque no modifica nada.
- Si el usuario rechaza o cancela, la tool devuelve `CONFIRM_REJECTED` y no se
  cambia nada.
- Si el cliente no declara capacidad de elicitation, la tool devuelve
  `CONFIRMATION_UNSUPPORTED`.

Cada tool publica además `annotations` estándar (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) para que los clientes
puedan clasificarlas. Son informativas: la seguridad real la aplica el servidor.

## Clasificación

Lectura (nunca piden confirmación):

`servers_list`, `project_info`, `doctor`, `file_list`, `file_stat`,
`file_read`, `file_download`, `logs`, `node_list`, `node_info`,
`node_env_list`, `node_status`, `list_databases`, `search_objects`.

Escritura (piden confirmación en modo `confirm`):

`file_write`, `file_upload`, `file_mkdir`, `file_move`, `file_copy`,
`file_delete`, `file_chmod`, `node_configure`, `node_update`, `node_env_set`,
`node_env_unset`, `node_install`, `node_run_script`, `node_restart`,
`node_start`, `node_stop`, `deps_install`.

`file_download` está clasificada como lectura porque no modifica el servidor,
aunque escribe en el disco local.

`execute_sql` y `execute_sql_write` son estáticas desde el punto de vista del
cliente: la primera solo acepta lecturas y la segunda solo escrituras, DDL o
administración (`SQL_TOOL_MISMATCH` si no coincide). Así cada una puede tener su
propio permiso.

## Bases de datos

No hay políticas SQL propias ni variables de entorno. El clasificador solo
decide qué tool debe ejecutar la sentencia, y el gate humano lo pone el cliente:

| Tool | Acepta | Permiso recomendado (OpenCode) |
| --- | --- | --- |
| `execute_sql` | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | `allow` en Build y Plan |
| `execute_sql_write` | `write`, `ddl`, `admin`, `unknown` | `ask` en Build, `deny` en Plan |

- Multi-statement se clasifica con el veredicto más restrictivo.
- Un SQL que no se puede parsear cuenta como escritura (fail-closed): solo entra
  por `execute_sql_write`.
- El servidor no pregunta nada para SQL; con `PLESK_MCP_ACCESS=confirm` la tool
  de escritura sigue el flujo genérico de confirmación, pero lo normal en
  OpenCode es `PLESK_MCP_ACCESS=client` y dejar el diálogo a OpenCode.

## OpenCode con el diálogo nativo

OpenCode tiene su propio diálogo de permisos con **Allow once**, **Allow
always** y **Deny**. Para usarlo se arranca el MCP en modo `client` y se marcan
las escrituras con `effect: "ask"`:

```jsonc
{
  "mcp": {
    "servers": {
      "plesk": {
        "type": "local",
        "command": ["node", "C:\\Users\\Usuario\\projects\\plesk-mcp\\dist\\index.js"],
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

El servidor arranca con `PLESK_MCP_ACCESS=client`, así que no muestra su propio
formulario para las tools Plesk. La confirmación la hace OpenCode con su diálogo
nativo.

Para SQL no hace falta configurar nada en el entorno: se usan dos tools con
permisos distintos.

```jsonc
{ "action": "plesk_execute_sql",       "resource": "*", "effect": "allow" },
{ "action": "plesk_execute_sql_write", "resource": "*", "effect": "ask" },
```

Y en el agente Plan se añade:

```jsonc
"agents": {
  "plan": {
    "permissions": [
      { "action": "plesk_execute_sql_write", "resource": "*", "effect": "deny" }
    ]
  }
}
```

`plesk_list_databases` y `plesk_search_objects` son de lectura y se dejan en
`allow`.

- **Plan**: OpenCode bloquea las tools antes de llamar al MCP.
- **Build**: OpenCode muestra **Allow once / Allow always / Deny** para la tool.
  Si eliges **Allow always**, OpenCode guarda una regla `allow` para esa tool y
  deja de preguntar.
- **General / Explore / subagentes**: heredan los `ask` globales. Si se quieren
  read-only, hay que añadir sus propias reglas `deny`.

### ¿Elicitation o diálogo nativo?

- **Diálogo nativo de OpenCode** (`client` + `ask`): permite **Allow always** y
  no duplica prompts. Es el modo recomendado si OpenCode es el cliente
  principal.
- **Elicitation del servidor** (`confirm`): funciona en cualquier cliente MCP,
  pero no tiene “Allow always” y muestra un formulario por operación.

No conviene activar ambos a la vez: se verían dos confirmaciones.

## Otros clientes

- **Con elicitation**: no hace falta configurar nada; el servidor pide
  confirmación en cada escritura.
- **Con permisos propios**: se puede arrancar con `PLESK_MCP_ACCESS=full` y
  dejar que el cliente aplique `ask` sobre las tools de escritura.
- **Sin elicitation ni permisos**: las escrituras fallan de forma segura. Solo
  se pueden usar las tools de lectura.

## Límites

- `PLESK_MCP_ACCESS` es un guardrail contra errores de la IA, no una frontera
  de seguridad: quien puede lanzar el proceso puede poner `full`.
- Un agente con shell libre podría intentar arrancar otra instancia del MCP en
  modo `full`. Para evitarlo, hay que restringir también el shell del agente o
  ejecutarlo sin credenciales.
