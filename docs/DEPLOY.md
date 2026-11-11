# Despliegue remoto en Render

Para quien administra el servicio. El equipo solo necesita el paso 7.

## 1. Tablas de login en Supabase

1. En el SQL Editor, abrí `sql/create-auth-tables.sql`, cambiá `CHANGE_ME` por una contraseña nueva (solo letras y números) y ejecutalo. No commitees ese cambio.
2. Armá `AUTH_DATABASE_URL` como las otras: usuario `iris_mcp_auth.<project-ref>`, host del pooler, puerto `6543`.
3. Cargá a las personas que pueden entrar (el correo debe ser el de su cuenta de Zoho):

```sql
insert into public.mcp_users (email) values ('persona@irisproperties.ca');
```

Los correos de `ADMIN_EMAILS` entran siempre y quedan como administradores.

## 2. Crear el servicio en Render

1. En Render: **New → Blueprint**, conectá el repo `techirisconnect/iris-mcp` (es privado: Render pide autorizar el acceso de GitHub).
2. Render lee `render.yaml` y pide las variables marcadas como secretas. Todavía no sabés la URL final: dejá `BASE_URL` y las dos de login en blanco, creá el servicio y anotá la URL que le asigna (por ejemplo `https://iris-mcp.onrender.com`). Después completás esas variables.
3. Región Oregon, plan Starter (el gratuito se duerme y la primera llamada vence por tiempo).

## 3. Cliente de Zoho para el login

Es distinto del Self Client de las APIs, que se queda como está.

1. En https://api-console.zohocloud.ca → **Add Client → Server-based Applications**.
2. Nombre `IRIS MCP login`, **Homepage URL** = tu `BASE_URL`, **Authorized Redirect URIs** = `BASE_URL/zoho/callback`.
3. Copiá el Client ID y el Client Secret.

## 4. Variables en Render

| Variable | Valor |
|---|---|
| `BASE_URL` | URL pública, sin barra final |
| `ZOHO_LOGIN_CLIENT_ID` / `ZOHO_LOGIN_CLIENT_SECRET` | los del paso 3 |
| `ADMIN_EMAILS` | tu correo de Zoho (varios separados por coma) |
| `AUTH_DATABASE_URL` | paso 1 |
| `AUDIT_DATABASE_URL` | la de auditoría, ya creada |
| `Z_CLIENT_ID`, `Z_CLIENT_SECRET`, `Z_REFRESH_TOKEN`, `CLIQ_OAUTH_REFRESH_TOKEN`, `Z_WORKDRIVE_REFRESH_TOKEN`, `PROJECTS_PORTAL_ID`, `DATABASE_URL_READONLY` | los mismos del `.env` local |

Guardá y esperá el redeploy. `BASE_URL/healthz` debe responder `{"ok":true}`.

## 5. Probar el login

Abrí `BASE_URL/.well-known/oauth-authorization-server`: debe mostrar un JSON con `registration_endpoint` y `token_endpoint`. Si responde, el servidor está arriba.

## 6. Conectar Claude

- **Cuenta individual:** Settings → Connectors → **Add custom connector**, URL `BASE_URL/mcp`.
- **Team / Enterprise:** el owner lo agrega en Organization settings → Connectors, y cada persona lo activa y hace login con Zoho.

Al conectar se abre el login de Zoho. Si el correo no está en `mcp_users`, Claude muestra un error de acceso denegado.

## 7. Para el equipo

Settings → Connectors → IRIS → **Connect** → iniciar sesión con Zoho. Nada más.

## Revocar a una persona

```sql
update public.mcp_users set revoked_at = now() where email = 'persona@irisproperties.ca';
```

Pierde el acceso en su próxima llamada, sin tocar a las demás.

## Problemas conocidos

- **Primera llamada lenta:** si el servicio se durmió, tarda unos segundos.
- **Zoho devuelve `invalid_redirect_uri`:** la URI del paso 3 tiene que coincidir letra por letra con `BASE_URL/zoho/callback`.
- **"Tu usuario no tiene acceso":** falta cargarlo en `mcp_users`, o el correo de su Zoho es otro.
- **Residencia de datos:** Render no tiene región en Canadá y Supabase está en us-east-2. Pendiente de la decisión de SCRUM-201.
