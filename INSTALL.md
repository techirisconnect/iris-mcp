# Conectar IRIS a Claude (guía para el equipo)

Con esto, Claude puede **consultar** el CRM, Cliq, WorkDrive, Sign, Projects y la base de datos de IRIS, y **agregar** notas, tareas, comentarios, mensajes y archivos de texto. Nunca puede borrar ni modificar lo que ya existe. Tarda unos 2 minutos y no instalás nada.

## Antes de empezar

- Una cuenta de Claude de la empresa.
- Tu **usuario de Zoho de IRIS** (el que termina en `@irisproperties.ca`). El login usa esa cuenta.
- Que tecnología te haya dado de alta. Si no estás en la lista, el login termina con "acceso denegado".

## 1. Conectar

1. En Claude: **Settings → Connectors**.
2. Buscá el conector **IRIS** y apretá **Connect**. Si no aparece, tecnología tiene que agregarlo primero (ver "Para tecnología").
3. Se abre el login de Zoho: entrá con tu cuenta de IRIS.
4. Volvé a Claude. El conector queda activo.

## 2. Comprobar que funciona

En un chat nuevo, con el conector IRIS activado, probá:

- "¿Cuántas propiedades hay en la base?"
- "Buscá en el CRM leads con el nombre Alex."
- "Mostrame los contratos de Sign que están pendientes de firma."
- "Mostrame las tareas abiertas de Tenant Operations en Projects."

La primera vez Claude pide permiso para usar cada herramienta. En las de lectura podés aceptar "siempre permitir"; en las de escritura, mejor aprobar caso por caso.

## Qué puede y qué no puede hacer

- **Puede:** leer registros del CRM, canales y mensajes de Cliq, archivos de WorkDrive (los de texto se leen; PDFs y otros devuelven el enlace), el estado de los documentos de Sign, proyectos y tareas de Projects, y las tablas permitidas de la base.
- **Puede agregar** (siempre algo nuevo):
  - una nota o una tarea en el CRM (en un lead, contacto, deal o cuenta);
  - una tarea o un comentario en Projects;
  - un mensaje en el canal de Cliq habilitado para pruebas;
  - un archivo de texto nuevo (`.txt .md .csv .json .html .log`) en una carpeta de WorkDrive. Si ya existe uno con ese nombre, no lo pisa.
- **No puede:** borrar nada, ni editar o reemplazar lo que ya existe, ni enviar documentos a firmar en Sign. Tampoco ve contraseñas, tokens ni códigos de acceso de propiedades. El borrado está bloqueado por los permisos de Zoho, no solo por el código.
- **Firma:** todo texto que Claude escribe termina con "enviado desde Claude (IRIS MCP) a pedido de <tu correo>", para que se sepa de dónde salió.
- **Cuidado:** lo que Claude agrega queda en el sistema real y solo se corrige a mano. Revisá lo que va a escribir antes de aceptar cada herramienta de escritura (no uses "siempre permitir" con ellas).
- **Queda registro:** cada acción se guarda con tu nombre, la hora y qué herramienta usaste. De las lecturas se guarda qué pediste, no los datos leídos. De las escrituras se guarda también lo que se escribió.
- Lo que Claude lea de IRIS pasa por tu conversación con Claude. Tratá esos datos (inquilinos, leases, contactos) con el mismo cuidado que en cualquier otra herramienta de la empresa.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| "Acceso denegado" al iniciar sesión | Tu usuario no está dado de alta, o entraste con una cuenta que no es la de IRIS. Pedile a tecnología que te agregue. |
| Zoho dice "Invalid Client" | Tu cuenta de Zoho está en otro data center. Usá tu cuenta de IRIS. |
| La primera consulta tarda unos segundos | Es normal si el servicio estaba dormido. Reintentá. |
| Dejó de funcionar de repente | Puede que te hayan quitado el acceso, o que haya vencido la sesión: desconectá y volvé a conectar el conector. |
| Otro error | Copiá el mensaje y enviáselo a tecnología. |

## Para tecnología

**Agregar el conector a la organización:** el owner de Claude lo agrega en Organization settings → Connectors, con la URL del servidor (`BASE_URL/mcp`, ver `docs/DEPLOY.md`). Después cada persona lo conecta desde su cuenta.

**Dar de alta a una persona** (el correo debe ser el de su cuenta de Zoho):

```sql
insert into public.mcp_users (email) values ('persona@irisproperties.ca');
```

**Quitar el acceso** (corta la sesión en su próxima consulta, sin afectar a nadie más):

```sql
update public.mcp_users set revoked_at = now() where email = 'persona@irisproperties.ca';
```

**Ver qué hizo alguien:** un administrador le pide a Claude *"consultá el log de auditoría con audit_query"* (filtra por usuario, herramienta, resultado y fecha). Los administradores son los de `ADMIN_EMAILS`.

**Escritura:** se activa con `WRITES_ENABLED=true` y el token `Z_WRITE_REFRESH_TOKEN` (solo permisos de crear). Cliq solo publica en los canales de `CLIQ_WRITE_CHANNELS`. Para apagarla, poné `WRITES_ENABLED=false` y redeployá.

Detalles de despliegue en `docs/DEPLOY.md`.

## Apéndice: modo local (solo desarrollo)

Para probar cambios, el servidor también corre en la máquina de quien lo desarrolla, con las credenciales en un `.env` (ver `README.md`). Ese modo comparte las credenciales de servicio y no distingue personas, por eso **no se usa para el equipo**. Si se filtra un `.env`, hay que cambiar la clave del rol de la base (`alter role iris_mcp_ro password '...'`) y regenerar el refresh token de Zoho.
