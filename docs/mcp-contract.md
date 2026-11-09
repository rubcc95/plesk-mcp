# Contrato MCP

Todas las tools devuelven JSON:

```json
{ "ok": true, "data": {} }
```

o:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

`isError` es `true` cuando `ok` es `false`.

Las tools de Plesk aceptan `server` opcional. Si se omite, se usa
`defaultServer` o el primer servidor registrado. Las tools que trabajan sobre una
suscripción aceptan además `domain` opcional: si se omite y el servidor tiene un
solo dominio, se autodetecta; si tiene varios, devuelven `PLESK_DOMAIN_REQUIRED`.

Las tools SQL aceptan **exactamente uno** de `server` (servidor Plesk) o `pc`
(base local de `localDatabases`).

Todas publican `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). En el modo por defecto
(`PLESK_MCP_ACCESS=confirm`), las tools de escritura de Plesk piden confirmación
por MCP elicitation y devuelven `CONFIRMATION_UNSUPPORTED` si el cliente no la
soporta. `dry_run: true` no pide confirmación. Detalle:
[access-control.md](access-control.md).

## Servidores y proyecto

- `servers_list()` — lista servidores Plesk, bases locales, origen (`global`/`local`) y defecto.
- `project_info()` — rutas de config y resumen de servidores y bases locales, sin secretos.
- `doctor(server?, domain?)` — comprueba auth, dominio, `/httpdocs` y `exec`.

## Ficheros

- `file_list(server?, domain?, path, recursive?, maxDepth?)`
- `file_stat(server?, domain?, path)`
- `file_read(server?, domain?, path, encoding?, maxBytes?)`
- `file_write(server?, domain?, path, content, encoding?, createDirs?, mode?)`
- `file_upload(server?, domain?, local_paths, remote, overwrite?, chunk_size_mb?, mode?, exclude?, keep_empty_dirs?, dry_run?)`
- `file_download(server?, domain?, remote_paths, local, exclude?, overwrite?, keep_empty_dirs?, dry_run?)`
- `file_mkdir(server?, domain?, path, recursive?)`
- `file_move(server?, domain?, from, to, overwrite?)`
- `file_copy(server?, domain?, from, to, overwrite?)`
- `file_delete(server?, domain?, path, recursive?)` — la confirmación la gestiona el servidor
- `file_chmod(server?, domain?, path, mode, recursive?)`

Las rutas remotas son absolutas y relativas a la raíz de la suscripción
(`/httpdocs/...`, `/private/...`). El cliente las traduce a rutas reales porque
la API `fs` de Plesk resuelve las relativas contra el document root. Las locales
se resuelven contra la raíz del proyecto.

### `file_upload` y `file_download`

Una única ruta de origen y tipo fichero → transferencia directa por REST y el
destino (`remote` o `local`) es la ruta exacta del fichero.

Un directorio o varias rutas → el destino es un directorio y se usan dos
motores:

- `archive`: ejecuta `tar` en el servidor, transfiere el `.tar.gz` y lo extrae.
  Requiere `exec` y `tar`.
- `walk`: recorre con `fs/list` y transfiere fichero a fichero en paralelo.
  Funciona sin shell.

Siempre se intenta `archive` y cae a `walk` si `exec` no está disponible.

Si el dominio seleccionado no tiene shell, se busca otro dominio del servidor con
SSH (`whoami` no vacío) y se comprueba `test -e/-r/-w` sobre la ruta destino:

- Mismo dominio o misma suscripción: caso normal.
- Dominio ajeno: solo se usa si puede leer (descarga) o escribir (subida) en el
  destino. En descargas el `.tar.gz` se aloja en el home del dominio que ejecuta.
- Las respuestas incluyen `execDomain` y `warnings` cuando el shell es ajeno.

Reglas:

- Las rutas se conservan relativas al ancestro común: `/httpdocs/assets` →
  `local/assets/...`. Para aplanar, se enumeran los ficheros.
- `exclude` acepta patrones (`node_modules`, `*.log`, `.git`).
- `overwrite: false` salta los ficheros que ya existen.
- `mode` solo aplica a la subida directa de un único fichero.
- No hay límites de ficheros, profundidad, bytes ni timeout.
- Los errores transitorios se reintentan indefinidamente; auth, DNS, TLS y
  errores de datos se devuelven de inmediato.
- La concurrencia del modo walk es fija (4).
- `dry_run` muestra el plan sin escribir nada.
- El `.tar.gz` local y el temporal remoto se borran siempre, incluso si falla
  la transferencia.

## Node.js

- `node_list(server?)`
- `node_info(server?, domain?)`
- `node_configure(server?, domain?, appRoot?, startupFile?, nodeVersion?, appMode?, packageManager?, documentRoot?)`
- `node_update(...)`
- `node_env_list(server?, domain?)` — solo nombres.
- `node_env_set(server?, domain?, file)` — importa un `.env` local (`KEY=value`). Las variables se guardan siempre como secretas en Plesk. La tool no devuelve nombres ni valores; la AI solo ve la ruta del archivo. Si alguna línea no es válida, no se escribe ninguna variable.
- `node_env_unset(server?, domain?, key)`
- `node_install(server?, domain?)`
- `node_run_script(server?, domain?, script)`
- `node_restart(server?, domain?)`
- `node_start(server?, domain?)`
- `node_stop(server?, domain?)`
- `node_status(server?, domain?)`

Si el servidor tiene varios dominios, hay que pasar `domain` o la tool devuelve
`PLESK_DOMAIN_REQUIRED`.

## Bases de datos

Las tools SQL usan el mismo selector: `server` para un servidor Plesk o `pc`
para una base local. Nunca los dos.

### `execute_sql(server? | pc?, database, sql, max_rows?, timeout_ms?)`

Ejecuta SQL de lectura. El servidor clasifica la sentencia y rechaza con
`SQL_TOOL_MISMATCH` cualquier veredicto que no sea `read`. Multi-statement se
clasifica con el veredicto más restrictivo; un error de parseo cuenta como
escritura, así que no entra por aquí.

### `execute_sql_write(server? | pc?, database, sql, timeout_ms?)`

Ejecuta escrituras, DDL y administración. Rechaza las lecturas con
`SQL_TOOL_MISMATCH`. El servidor no pregunta nada por SQL: el permiso del cliente
decide si se permite, se pregunta o se bloquea (en OpenCode,
`plesk_execute_sql_write` con `ask` en Build y `deny` en Plan).

Para Plesk, el SQL se ejecuta con el CLI `mysql` en cualquier dominio con shell;
no hace falta túnel SSH. Para `pc`, se usa una conexión MySQL directa.

### `list_databases(server? | pc?, pattern?, include_system?, limit?, cursor?)`

Lista las bases de datos visibles por el usuario MySQL. Por defecto oculta
`information_schema`, `mysql`, `performance_schema` y `sys`. Pagina con
`cursor`.

### `search_objects(server? | pc?, database?, object_type, pattern?, table?, detail_level?, limit?)`

Busca objetos en `information_schema`. `database` es obligatoria salvo
`object_type: "schema"`. Mantiene el contrato de DBHub (`object_type`,
`pattern`, `table`, `detail_level`, `limit`) usando `database` en lugar de
`schema`.

## Dependencias

### `deps_install(server?, domain?, command, cwd?)`

Ejecuta un instalador permitido: `npm`, `pnpm`, `yarn`, `composer`, `bundle`,
`pip`, `pip3`. No es un shell libre.

## Logs

### `logs(server?, domain?, type?, pattern?, lines?)`

`type`: `error`, `access` o `node`.
