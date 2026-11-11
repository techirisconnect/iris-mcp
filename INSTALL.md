# Instalar IRIS en Claude (guía para el equipo)

Con esto, Claude Desktop puede **consultar** (solo leer, nunca modificar) el CRM, Cliq, WorkDrive y la base de datos de IRIS. Tarda unos 10 minutos.

## Antes de empezar

- **Claude Desktop** instalado y con tu cuenta.
- **Node.js 20 o superior**. Para comprobarlo, abrí una terminal y escribí `node -v`. Si no lo tenés, descargalo de nodejs.org (versión LTS).
- **Git** instalado (`git --version` en una terminal; si no, descargalo de git-scm.com) y una **cuenta de GitHub con acceso al repo** `techirisconnect/iris-mcp`. Si no podés abrirlo, pedile a tecnología que te dé acceso de lectura.
- **El archivo `.env`** con las credenciales (ver paso 2).

## 1. Descargar el código e instalar dependencias

En una terminal, en la carpeta donde quieras guardarlo (por ejemplo `C:\IRIS`). No la muevas después, porque la config de Claude apunta a esa ruta:

```bash
cd C:\IRIS
git clone https://github.com/techirisconnect/iris-mcp.git
cd iris-mcp
npm install
```

La primera vez, Git abre el navegador para que inicies sesión en GitHub. Para actualizar más adelante: `git pull` dentro de la carpeta y luego `npm install`.

Si no podés usar Git, tecnología puede pasarte la carpeta en un zip. En ese caso descomprimila y corré solo `npm install`.

## 2. Recibir el `.env` de forma segura

El `.env` tiene las llaves de acceso a los datos de IRIS. **No se manda por chat, mail ni WhatsApp.**

- Tecnología lo comparte desde el gestor de contraseñas de la empresa (nota segura o archivo adjunto compartido solo contigo).
- Descargalo y copialo dentro de `iris-mcp`, con el nombre exacto `.env` (con el punto, sin `.txt`).
- Si no hay gestor de contraseñas, pedí un enlace de un solo uso que caduque.
- No lo subas a Git, no lo guardes en Drive/WorkDrive compartidos ni lo reenvíes.

## 3. Conectarlo a Claude Desktop

1. En Claude Desktop: **Settings → Developer → Edit Config**. Se abre la carpeta con `claude_desktop_config.json`.
2. Abrí ese archivo con un editor de texto. Si está vacío o es `{}`, pegá esto. Si ya tiene `mcpServers`, agregá solo la parte `"iris"` dentro, separada por coma.

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["C:\\IRIS\\iris-mcp\\src\\index.js"]
    }
  }
}
```

Cambiá la ruta por donde guardaste la carpeta. Las barras van dobles (`\\`).

3. Guardá, **cerrá Claude Desktop por completo** (también desde el ícono de la bandeja del sistema) y volvé a abrirlo.

## 4. Comprobar que funciona

En un chat nuevo debería aparecer el servidor `iris` con sus herramientas. Probá:

- "¿Cuántas propiedades activas hay en Victoria?"
- "Buscá en el CRM leads con el nombre Alex."
- "Mostrame los últimos mensajes del canal #Insurance de Cliq."
- "Buscá en WorkDrive el contrato de Willard Drive."

La primera vez Claude pide permiso para usar cada herramienta. Podés aceptar "siempre permitir".

## Qué puede y qué no puede hacer

- **Puede:** leer registros del CRM, canales y mensajes de Cliq, archivos de WorkDrive (los de texto se leen; PDFs y otros devuelven el enlace) y las tablas permitidas de la base.
- **No puede:** crear, editar ni borrar nada. Tampoco ve contraseñas, tokens ni códigos de acceso de propiedades.
- Lo que Claude lea de IRIS pasa por tu conversación con Claude. Tratá esos datos (inquilinos, leases, contactos) con el mismo cuidado que en cualquier otra herramienta de la empresa.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| No aparece `iris` en Claude | Revisá que el JSON sea válido y la ruta exista. Cerrá Claude del todo y reabrilo. |
| `node` no se reconoce | Instalá Node.js. Si ya lo tenés, poné la ruta completa en `"command"`, por ejemplo `"C:\\Program Files\\nodejs\\node.exe"`. |
| "no configurado" o error de token | El `.env` falta o está mal ubicado. Debe estar dentro de `iris-mcp`, junto a `package.json`. |
| Error de conexión a la base | Avisá a tecnología; puede ser la clave del rol de lectura. |
| Otro error | Abrí `%APPDATA%\Claude\logs\mcp-server-iris.log` y enviá las últimas líneas a tecnología (**sin** pegar el `.env`). |

## Para tecnología: cuando alguien se va o se filtra el `.env`

Las credenciales son compartidas. Si el `.env` llega a alguien que no debe: cambiar la clave del rol (`alter role iris_mcp_ro password '...'`), revocar el refresh token de Zoho del MCP, y redistribuir un `.env` nuevo.
