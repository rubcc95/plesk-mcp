# Configuración

El MCP lee dos archivos con exactamente el mismo formato:

- Global: `~/.config/plesk-mcp/config.json`
- Local: `<raíz-del-proyecto>/.plesk/config.json`

## Formato

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

También se acepta un array plano, pero solo para servidores Plesk:

```json
[
  {
    "name": "prod-mundopc",
    "url": "https://plesk.mundopc.com:8443",
    "auth": { "mode": "apiKey", "apiKey": "env:PLESK_MUNDOPC_KEY" },
    "dbUser": "db_admin",
    "dbPass": "env:PLESK_MUNDOPC_DB_PASS"
  }
]
```

En ese caso no hay `defaultServer` ni `localDatabases`: el primer servidor es el
defecto. Para usar bases de datos locales hay que usar el formato de objeto.

## Servidores Plesk (`servers`)

Una entrada por **servidor Plesk**, no por dominio. Los dominios ya no se
configuran aquí: se pasan en las tools que los necesitan.

- `name`: identificador único. Es el valor que recibe la tool en `server`.
- `url`: URL base de Plesk, normalmente con `:8443`.
- `auth.mode`: `apiKey` o `basic`.
  - `apiKey`: `auth.apiKey`.
  - `basic`: `auth.username` y `auth.password`.
- `dbUser`: usuario MySQL con acceso a todas las bases de datos del servidor.
- `dbPass`: contraseña del usuario MySQL anterior.
- `verifyTls`: por defecto `true`.
- `timeoutMs`: opcional. Si se omite (o es `null`) no hay timeout; con un entero positivo se limita cada petición a esos milisegundos.

`dbUser` y `dbPass` deben indicarse juntos o no indicarse. Si faltan, las tools
SQL fallan en cerrado con `DB_CREDENTIALS_MISSING`, pero las tools de ficheros y
Node siguen funcionando.

La conexión MySQL no se hace por TCP desde tu equipo: se busca cualquier
dominio del servidor con shell y cliente `mysql`/`mariadb`, y se ejecuta el CLI
allí. No hace falta configurar SSH ni el host de la base de datos.

## Bases de datos locales (`localDatabases`)

Conexiones MySQL directas de la red local, sin depender de un servidor Plesk.
El valor de `name` es el que recibe la tool en `pc`.

- `name`: identificador único (`ballena`, `elefante`...).
- `host`: IP o nombre del equipo.
- `port`: por defecto `3306`.
- `user` y `password`: credenciales MySQL.
- `ssl`: por defecto `false`.

```json
{
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

## Dominio en las tools

Las tools de Plesk que trabajan sobre una suscripción aceptan `domain`
opcional:

- `file_*`, `logs`, `deps_install`, `doctor` y `node_*`.

Regla de resolución:

1. Si la tool recibe `domain`, se usa ese.
2. Si no, y el servidor tiene un solo dominio, se autodetecta.
3. Si hay varios y no se indica, la tool devuelve `PLESK_DOMAIN_REQUIRED` con la
   lista de dominios.

Así no hace falta duplicar una entrada de `servers` por cada dominio del mismo
servidor.

## Unión de global y local

- Se cargan los dos archivos.
- `servers` se unen por `name`; si el mismo nombre está en los dos, gana el local.
- `localDatabases` se unen por `name`; si el mismo nombre está en los dos, gana el local.
- `defaultServer` local gana sobre el global. Si no hay, el primero de la unión
  (global y luego local) es el defecto. Si no hay servidores Plesk, queda vacío.
- Un nombre no puede estar a la vez en `servers` y en `localDatabases`:
  `DUPLICATE_TARGET_NAME`.
- Si no hay ni servidores ni bases locales, el MCP arranca y devuelve
  `CONFIG_EMPTY` desde las tools.

## Referencias `env:`

Cualquier string puede ser `env:NOMBRE`. Se resuelve al usar el servidor o la
base de datos, no al cargar el archivo. Así una credencial ausente no rompe a
los demás.

```json
"apiKey": "env:PLESK_API_KEY",
"dbPass": "env:PLESK_DB_PASS",
"password": "env:MYSQL_BALLENA_PASSWORD"
```

## Crear los archivos

```bash
npx plesk-project init
npx plesk-project init --global
```
