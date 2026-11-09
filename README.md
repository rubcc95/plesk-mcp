# plesk-mcp

MCP local para acceder a uno o varios servidores Plesk:

- Subir y gestionar ficheros.
- Configurar aplicaciones Node.js.
- Instalar dependencias.
- Consultar logs.
- Ejecutar SQL en las bases de datos de los servidores Plesk y en las bases
  locales de la red (`ballena`, `elefante`).

Sustituye al MCP `mysql` (DBHub): todo el acceso a bases de datos se hace desde
este servidor.

## Requisitos

- Node.js 22 o superior.
- Plesk Linux 18.0.82 o superior.
- API key de Plesk o usuario/contraseña con acceso a la API REST.
- Para SQL en Plesk: algún dominio con shell y el cliente `mysql` o `mariadb`
  instalado en el servidor. Las credenciales MySQL (`dbUser`/`dbPass`) se
  configuran por servidor.

## Instalación

```bash
npm install
npm run build
```

## Configuración

El MCP se define una sola vez en `opencode.jsonc`:

```jsonc
"plesk": {
  "type": "local",
  "command": ["node", "C:\\Users\\Usuario\\projects\\plesk-mcp\\dist\\index.js"],
  "cwd": "."
}
```

Sin `environment`. El MCP lee dos archivos con el mismo formato:

- Global: `C:\Users\Usuario\.config\plesk-mcp\config.json`
- Local: `<proyecto>\.plesk\config.json`

Ambos son iguales:

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
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_MUNDOPC_DB_PASS"
    },
    {
      "name": "cliente-x",
      "url": "https://plesk.cliente-x.com:8443",
      "auth": {
        "mode": "basic",
        "username": "admin",
        "password": "env:PLESK_CLIENTE_PASSWORD"
      },
      "dbUser": "db_admin",
      "dbPass": "env:PLESK_CLIENTE_DB_PASS"
    }
  ],
  "localDatabases": [
    {
      "name": "ballena",
      "host": "192.168.1.50",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_BALLENA_PASSWORD"
    },
    {
      "name": "elefante",
      "host": "192.168.1.51",
      "port": 3306,
      "user": "root",
      "password": "env:MYSQL_ELEFANTE_PASSWORD"
    }
  ]
}
```

Reglas:

- Se cargan los dos archivos y se unen por `name`.
- Si el mismo nombre está en los dos, gana el local.
- `defaultServer` es opcional.
- Si no hay `defaultServer`, el primero de la unión (global y luego local) es el defecto.
- Una entrada de `servers` es un servidor Plesk, no un dominio. El `domain` se
  pasa en las tools que lo necesitan; si el servidor tiene uno solo, se
  autodetecta.
- `dbUser`/`dbPass` son las credenciales MySQL del servidor Plesk. Se usan para
  todas sus bases de datos.
- `localDatabases` contiene las conexiones MySQL directas de la red local.
- Los valores `env:VAR` se leen del entorno heredado.

Crear los archivos:

```bash
npx plesk-project init            # local
npx plesk-project init --global   # global
```

## Permisos y confirmaciones

El servidor es único y siempre expone todas las tools. Por defecto, cualquier
tool que modifique el servidor pide confirmación humana mediante MCP
elicitation:

```bash
PLESK_MCP_ACCESS=confirm   # defecto: elicitation del servidor
PLESK_MCP_ACCESS=client    # deja la confirmación al cliente (OpenCode: ask)
PLESK_MCP_ACCESS=full      # sin confirmación; solo tests
```

- `confirm`: antes de escribir, el servidor muestra un formulario de
  confirmación. Si el cliente no soporta elicitation, la tool falla con
  `CONFIRMATION_UNSUPPORTED`.
- `client`: el servidor no muestra formulario; el cliente aplica su propio
  diálogo de permisos. Es el modo recomendado para OpenCode.
- `full`: no pide confirmación (alias: `off`, `none`).
- `dry_run` no pide confirmación porque no modifica nada.
- Cada tool publica annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).

En OpenCode, Plan deniega las tools de escritura y Build las marca con
`effect: "ask"`. Así aparece el diálogo nativo con **Allow once / Allow always /
Deny**. Ejemplo completo: [docs/access-control.md](docs/access-control.md).

El SQL está partido en dos tools para que el cliente pueda darles permisos
distintos:

- `execute_sql`: solo lectura (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`).
- `execute_sql_write`: escrituras, DDL y administración.

No hay políticas SQL propias ni variables de entorno. El servidor solo comprueba
que cada tool recibe el tipo de sentencia correcto (`SQL_TOOL_MISMATCH` en caso
contrario). El control real está en los permisos del cliente. En OpenCode:

```jsonc
{ "action": "plesk_execute_sql", "resource": "*", "effect": "allow" },
{ "action": "plesk_execute_sql_write", "resource": "*", "effect": "ask" },
```

Y en Plan:

```jsonc
"agents": {
  "plan": {
    "permissions": [
      { "action": "plesk_execute_sql_write", "resource": "*", "effect": "deny" }
    ]
  }
}
```

## Uso

Con un solo servidor, no hace falta pasar `server`:

```json
{ "path": "/httpdocs/index.php" }
```

Con varios, se puede omitir y se usa el defecto:

```json
{ "path": "/httpdocs/index.php" }
```

O elegir uno:

```json
{
  "server": "cliente-x",
  "path": "/httpdocs/index.php"
}
```

Si el servidor tiene varios dominios, hay que indicar `domain` en las tools de
ficheros, Node, logs o `deps_install`:

```json
{
  "server": "cliente-x",
  "domain": "cliente-x.com",
  "path": "/httpdocs/index.php"
}
```

`servers_list` muestra los servidores, las bases locales, su origen y cuál es el
defecto.

## Subida y descarga

`file_upload` y `file_download` aceptan una o varias rutas. El destino se
interpreta por contexto:

- Un único fichero: `remote` / `local` es la ruta exacta del fichero.
- Un directorio o varias rutas: `remote` / `local` es el directorio destino.

Cuando hay un único fichero se transfiere directamente por REST, por trozos.
Cuando hay varios ficheros o algún directorio se usan dos motores:

- `archive`: empaqueta en el servidor un `.tar.gz`, lo transfiere y lo extrae.
  Es el más rápido, pero necesita `exec` y `tar`.
- `walk`: recorre el árbol con `fs/list` y transfiere fichero a fichero en
  paralelo. Funciona en cualquier suscripción, incluso con `/bin/false`, pero
  hace una petición por fichero.

Siempre se intenta `archive` y, si el servidor no permite ejecutar comandos,
se cae a `walk` automáticamente.

Si el dominio seleccionado no tiene shell, el MCP busca en el listado de
dominios otro con acceso SSH y lo usa para `tar`/`exec`:

- Prioriza dominios de la misma suscripción (addon domains y subdominios), que
  comparten usuario de sistema.
- Comprueba con `test -e/-r/-w` que ese usuario puede acceder a la ruta destino.
- En descargas, si el shell es de otro dominio, el `.tar.gz` se genera y se
  descarga desde el home de ese dominio.
- En subidas solo se usa un dominio ajeno si puede escribir en el destino; los
  ficheros extraídos quedan con su propietario y se devuelve un warning.
- Si ningún dominio sirve, se mantiene el fallback a `walk`.

`doctor` incluye el check `execPaths`: si hay shell pero no puede acceder a la
ruta del dominio (permisos entre suscripciones), lo indica y confirma que se
usará `walk`.

El dominio de ejecución se elige con el input `domain` de la tool. Si no se
indica y el servidor tiene un solo dominio, se autodetecta.

```json
{
  "remote_paths": ["/httpdocs/assets", "/httpdocs/index.php"],
  "local": "backup/httpdocs",
  "exclude": ["node_modules", ".git", "*.log"]
}
```

Reglas:

- Las rutas se conservan relativas al ancestro común: `/httpdocs/assets`
  genera `local/assets/...`. Para aplanar, enumera los ficheros en lugar del
  directorio.
- `overwrite: false` salta los ficheros que ya existen.
- El `.tar.gz` es siempre temporal: se borra al terminar, igual que el
  temporal remoto (`/.plesk-mcp-tmp`).
- No hay límites de número de ficheros, profundidad, bytes ni timeout. La
  transferencia continúa hasta completar o fallar.
- Los errores transitorios (red, 5xx, 429) se reintentan indefinidamente. Los
  permanentes (auth, DNS, TLS, 4xx de datos) se devuelven de inmediato.
- La concurrencia del modo walk es fija (4).
- `dry_run` muestra el plan (archivo o lista de ficheros) sin escribir nada.

## Herramientas

- `servers_list`, `project_info`, `doctor`
- `file_list`, `file_stat`, `file_read`, `file_write`, `file_upload`, `file_download`, `file_mkdir`, `file_move`, `file_copy`, `file_delete`, `file_chmod`
- `node_list`, `node_info`, `node_configure`, `node_update`, `node_env_list`, `node_env_set`, `node_env_unset`, `node_install`, `node_run_script`, `node_restart`, `node_start`, `node_stop`, `node_status`
- `deps_install`
- `logs`
- `execute_sql`, `execute_sql_write`, `list_databases`, `search_objects`

Las tools de Plesk aceptan `server` opcional. Las SQL aceptan `server` o `pc`.
Contrato detallado: [docs/mcp-contract.md](docs/mcp-contract.md).

## Seguridad

- `.plesk/config.json` está en `.gitignore`.
- El config global está fuera del repo.
- OpenCode deniega la lectura del config local y global.
- Toda tool de escritura pide confirmación humana: por MCP elicitation en
  `confirm`, o por el diálogo nativo del cliente en `client`/`full` + `ask`.
- `deps_install` solo acepta instaladores conocidos (`npm`, `pnpm`, `yarn`, `composer`, `bundle`, `pip`).
- `file_upload` y `file_download` solo ejecutan `tar` con rutas y patrones validados.
- Si el dominio no tiene shell, se puede usar el shell de otro dominio, pero
  siempre como su usuario de sistema (nunca root) y comprobando antes el acceso
  real a la ruta con `test -e/-r/-w`. Solo se ejecutan `whoami`, `test`, `tar` y
  los instaladores permitidos por `deps_install`.
- Los enlaces simbólicos locales se omiten siempre.
- `node_env_set` no acepta claves ni valores: importa un `.env` local, los guarda
  siempre como secretos en Plesk y nunca devuelve su contenido a la AI.
- No hay shell libre.
- Las credenciales MySQL de Plesk no se usan por TCP desde tu equipo: se ejecuta
  el CLI `mysql` en un dominio con shell, con un fichero temporal `umask 077`
  que se borra al terminar.
- `execute_sql` solo ejecuta lecturas y `execute_sql_write` solo escrituras/DDL
  (`SQL_TOOL_MISMATCH` si no coinciden). El gate humano lo pone el cliente:
  `execute_sql_write` con `ask` en Build y `deny` en Plan.
- El usuario MySQL de Plesk tiene acceso a todas las bases del servidor, así que
  el clasificador y los permisos del cliente son el control de escritura.

## Estado

Validado en Plesk Obsidian 18.0.81 (Linux):

- La API `fs` resuelve las rutas relativas contra el document root y solo
  acepta rutas absolutas dentro del webspace. El cliente traduce las rutas
  virtuales del MCP (`/httpdocs/...`) al home real de la suscripción.
- `fs/mkdir` usa `path` como query parameter (sin cuerpo).
- `file_download` probado de extremo a extremo:
  - modo `archive` con `exec`/`tar` (dominio con shell).
  - modo `auto` en un dominio con `/bin/false`, cayendo a `walk` y
    descargando en paralelo por REST.
  - `overwrite=false` salta ficheros existentes en ambos modos.
  - transferencia directa de un único fichero sin pasar por tar.

Pendiente de validar:

- Flags de `plesk ext nodejs` vía `/cli/extension/call`.
- Límites de subida por trozos.
- Validación de `execute_sql_write` en producción con permiso `ask` en Build y
  `deny` en Plan.
