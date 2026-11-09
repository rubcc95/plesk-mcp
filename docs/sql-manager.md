# Administrador de queries SQL

> **Estado: diseño cerrado, implementación en curso.**
> Este documento sustituye al primer diseño basado en un segundo entrypoint y un
> catálogo de conexiones. El acceso a bases de datos queda unificado dentro de
> `plesk-mcp`, que también sustituye al MCP `mysql` (DBHub).

## 1. Decisiones

1. **Un solo MCP**: las tools SQL viven en `plesk-mcp`; no hay un entrypoint
   `sql-index.js` ni un servidor `mysql` aparte.
2. **Cuatro tools**: `execute_sql`, `execute_sql_write`, `list_databases` y
   `search_objects`.
3. **Dos tools de ejecución**: `execute_sql` solo acepta lecturas y
   `execute_sql_write` solo escrituras/DDL. Así el cliente puede darles permisos
   distintos (por ejemplo, Plan deniega la de escritura).
4. **Dos tipos de destino**:
   - `server`: un servidor Plesk del array `servers`.
   - `pc`: una base local del array `localDatabases` (`ballena`, `elefante`...).
5. **Plesk**: no hay acceso TCP directo ni túnel SSH configurado. Se busca
   cualquier dominio del servidor con shell y `mysql`/`mariadb`, y se ejecuta el
   CLI `mysql` allí con `dbUser`/`dbPass`. No importa la suscripción.
6. **Local**: `mysql2` directo por TCP con `host`, `port`, `user`, `password`.
7. **Permiso por tool, no por SQL**: el clasificador solo decide qué tool puede
   ejecutar la sentencia (`SQL_TOOL_MISMATCH` si no coincide). El gate humano lo
   pone el cliente con sus permisos (`ask` en Build, `deny` en Plan).
8. **Una sola instancia**: Plan y Build comparten el servidor; el comportamiento
   distinto sale de los permisos por agente del cliente.

## 2. Configuración

Los servidores Plesk ya no se configuran por dominio. Una entrada por servidor,
sin `domain`, `domainId`, `execDomain` ni `execDomainId`.

```json
{
  "defaultServer": "prod-mundopc",
  "servers": [
    {
      "name": "prod-mundopc",
      "url": "https://plesk.mundopc.com:8443",
      "auth": {
        "mode": "apiKey",
        "apiKey": "env:PLESK_MUNDOPC_KEY"
      },
      "verifyTls": true,
      "timeoutMs": null,
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_MUNDOPC_DB_PASS"
    }
  ],
  "localDatabases": [
    {
      "name": "ballena",
      "host": "192.168.1.50",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_BALLENA_PASSWORD"
    }
  ]
}
```

- `dbUser`/`dbPass` son las credenciales MySQL del servidor Plesk y dan acceso a
  todas sus bases de datos.
- `localDatabases` es independiente de `servers`.
- `env:VAR` se resuelve al usar el destino.
- Un nombre no puede estar a la vez en `servers` y `localDatabases`.
- El `domain` de las tools Plesk se pasa como input (`file_*`, `logs`,
  `deps_install`, `doctor`, `node_*`). Si el servidor tiene un solo dominio, se
  autodetecta.

## 3. Tools

### `execute_sql`

```ts
{
  server?: string,   // servidor Plesk
  pc?: string,       // base local
  database: string,
  sql: string,       // solo lectura
  max_rows?: number, // 1000 por defecto, 10.000 máximo
  timeout_ms?: number
}
```

Exactamente uno de `server`/`pc`. `database` es obligatoria. Si el veredicto no
es `read`, devuelve `SQL_TOOL_MISMATCH`.

### `execute_sql_write`

```ts
{
  server?: string,
  pc?: string,
  database: string,
  sql: string,       // escritura, DDL o administración
  timeout_ms?: number
}
```

Si el veredicto es `read`, devuelve `SQL_TOOL_MISMATCH`. Su permiso en el cliente
decide si se pregunta, se permite o se bloquea.

### `list_databases`

```ts
{
  server?: string,
  pc?: string,
  pattern?: string,       // LIKE
  include_system?: boolean,
  limit?: number,         // 100 por defecto, 500 máximo
  cursor?: string
}
```

Lista las bases visibles por el usuario MySQL. Por defecto oculta
`information_schema`, `mysql`, `performance_schema` y `sys`.

### `search_objects`

```ts
{
  server?: string,
  pc?: string,
  database?: string,      // obligatoria salvo object_type="schema"
  object_type: "schema" | "table" | "view" | "column" | "procedure" | "function" | "index",
  pattern?: string,       // LIKE
  table?: string,         // obligatoria para column e index
  detail_level?: "names" | "summary" | "full",
  limit?: number          // 100 por defecto, 1000 máximo
}
```

## 4. Clasificador y política

Veredictos: `read`, `write`, `ddl`, `admin`, `unknown`.

- `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` sin ejecutar → `read`.
- `INSERT`, `UPDATE`, `DELETE`, `REPLACE` → `write`.
- `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME` → `ddl`.
- `GRANT`, `REVOKE`, `SET`, `CALL`, `USE`, `LOCK`, `FLUSH`, `KILL`,
  transacciones, `LOAD` → `admin`.
- Parse error o SQL no reconocido → `unknown`.
- `SELECT ... INTO OUTFILE`, `FOR UPDATE`, `LOCK IN SHARE MODE`, `LOAD_FILE`,
  `LOAD DATA` → como mínimo `write`.
- Multi-statement: se aplica el veredicto más restrictivo.

Política:

- No hay variables de entorno SQL. La única regla del servidor es que la
  sentencia encaje con la tool: `read` → `execute_sql`; `write`, `ddl`, `admin`
  y `unknown` → `execute_sql_write`. Si no coincide, `SQL_TOOL_MISMATCH`.
- El gate humano vive en el cliente:
  `plesk_execute_sql` → `allow`; `plesk_execute_sql_write` → `ask` en Build y
  `deny` en Plan.
- Fail-closed: error de parseo cuenta como escritura, así que solo entra por
  `execute_sql_write`.

## 5. Ejecución en Plesk

1. `findShellDomain(client, { require })` recorre dominios y elige el primero con
   shell y `mysql`/`mariadb`.
2. Se cachea ese dominio por servidor.
3. Se ejecuta un script bash con `umask 077`, un `--defaults-extra-file` temporal
   y `trap` para borrarlo:

```bash
mysql --defaults-extra-file="$f" -D "$database" --batch \
  --default-character-set=utf8mb4 -e "$sql"
```

4. La salida `--batch` se parsea como TSV (con los caracteres especiales
   escapados). Para escrituras o
   multi-statement se devuelve `stdout`/`stderr`/`exitCode`.
5. No se usa `dbHost` ni `dbPort`: el CLI corre en el servidor y conecta a
   `localhost`.

## 6. Ejecución local

- `mysql2/promise` con pool por `(pc, database)`.
- `multipleStatements: true`, `charset: utf8mb4`.
- LRU simple con evicción por inactividad.
- Resultados tipados; se truncan a `max_rows`.

## 7. Seguridad

- El clasificador es un guardrail contra errores de la IA, no una frontera de
  seguridad.
- El usuario MySQL de Plesk tiene acceso a todas las bases; el control de
  escritura es el split de tools + los permisos del cliente.
- No se devuelven credenciales ni el SQL con secretos en las respuestas.
- El fichero temporal de credenciales se crea con `umask 077` y se borra al
  terminar.

## 8. Implementación

- `src/sql/classifier.ts`: parser y veredictos.
- `src/sql/format.ts`: TSV, LIKE, cursor y paginación.
- `src/sql/objects-query.ts`: consultas a `information_schema`.
- `src/sql/plesk-target.ts`: CLI `mysql` vía `exec`.
- `src/sql/local-target.ts`: `mysql2`.
- `src/sql/tools.ts`: registro de las cuatro tools.
- `src/index.ts`: registra `registerSqlTools`.

## 9. Validación pendiente

- Probar `execute_sql` contra un servidor Plesk real con un usuario MySQL que
  tenga acceso a todas las bases.
- Probar `list_databases` y `search_objects` en Plesk y en `ballena`/`elefante`.
- Validar la confirmación de escritura en Plan y Build.
- Arrancar producción con `SQL_WRITE_POLICY=deny` y subir a `ask` cuando la
  lectura esté validada.
