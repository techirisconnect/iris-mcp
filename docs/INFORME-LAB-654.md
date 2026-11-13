# LAB-654 · IRIS MCP: informe de estado

Para: Jhony · Noviembre 2026 · Estado: implementado y probado; falta cerrar tres puntos antes de abrirlo a todo el equipo.

## 1. Resumen

Con el conector **IRIS**, el personal puede pedirle a Claude que consulte y agregue información en los datos de la empresa, sin salir de la conversación. Funciona en Claude para toda persona dada de alta, con su propio inicio de sesión de Zoho. Lee las **6 fuentes** pedidas (base de datos, WorkDrive, Cliq, Sign, CRM y Projects), escribe un conjunto acotado de cosas y **no puede borrar nada**: el borrado está bloqueado por los permisos de Zoho, no solo por el código. Cada acción queda registrada y se puede consultar.

Servidor: `https://iris-mcp-5h54.onrender.com` (Render, Oregon). Código: repositorio privado `techirisconnect/iris-mcp`.

## 2. Qué puede hacer

| Tipo | Acciones |
|---|---|
| **Leer** | Registros del CRM, canales y mensajes de Cliq, archivos de WorkDrive (los de texto se leen), estado de documentos de Sign, proyectos y tareas de Projects, tablas permitidas de la base de datos |
| **Agregar** (Nivel A) | Nota o tarea en el CRM; tarea o comentario en Projects; mensaje en un canal de Cliq habilitado; archivo de texto nuevo en WorkDrive (nunca pisa uno existente) |
| **Modificar con confirmación** (Nivel B) | Algunos campos de notas de un lead o contacto; crear lead o contacto (solo si no existe el email o teléfono); estado y responsable de una tarea de Projects |
| **No puede** | Borrar nada; reemplazar lo ya publicado; enviar o modificar documentos en Sign; leer contraseñas o tokens |

En el Nivel B, Claude primero muestra el cambio exacto ("valor actual → valor nuevo") y solo lo aplica con la aprobación de la persona. Si el registro cambió entre la propuesta y la aplicación, el cambio se cancela. Todo texto escrito termina con la firma "enviado desde Claude (IRIS MCP) a pedido de <persona>".

## 3. Cómo se controla

- **Acceso:** solo entran las personas dadas de alta (lista explícita) con su cuenta de Zoho de IRIS. Se puede quitar a alguien con una instrucción y corta su acceso en la siguiente consulta. Las sesiones duran 1 hora y se renuevan hasta 30 días.
- **Sin borrado, por permisos:** las escrituras usan dos tokens de Zoho separados, con permisos solo de crear y de actualizar. Se probó con esos tokens un intento de borrar en cada sistema y **falló en los cuatro**:

| Sistema | Resultado del intento de borrar |
|---|---|
| CRM | Rechazado por permisos (`OAUTH_SCOPE_MISMATCH`) |
| Projects | Rechazado por permisos (`Invalid OAuth scope`) |
| WorkDrive | Rechazado por permisos, tanto borrar como enviar a la papelera |
| Cliq | Rechazado por permisos (`oauthtoken_scope_invalid`) |

- **Auditoría:** cada llamada guarda quién, cuándo, qué herramienta, parámetros, resultado y duración, en una tabla de la base que solo admite insertar y consultar (nadie puede modificar ni borrar entradas con el rol del MCP). No se guardan los datos leídos. Las escrituras guardan lo escrito y, en el Nivel B, el valor anterior y el nuevo, **antes** de actuar: si el registro no se puede guardar, la escritura no corre. La consulta del log es solo para administradores.
- **Claves:** todas en variables de entorno de Render; nada en el repositorio. La base se consulta con un rol de solo lectura, sin acceso a columnas de contraseñas, tokens o claves.
- **Interruptores:** la escritura se apaga con `WRITES_ENABLED=false` (Nivel A) o `WRITES_B_ENABLED=false` (Nivel B) y un redeploy.

## 4. Qué se probó

- Lectura en vivo de las 6 fuentes.
- Inicio de sesión real con la cuenta de IRIS, y rechazo de usuarios no dados de alta.
- Todas las herramientas de escritura contra Zoho real, usando registros de prueba (después eliminados).
- Registro de auditoría en la base, incluyendo valor anterior y nuevo en el Nivel B.
- Intento de borrado en cada sistema (ver tabla).
- 43 pruebas automáticas, entre ellas: sin token no se aplica un cambio de Nivel B; el token de otra persona no sirve; si falla la auditoría la escritura no se ejecuta; en el código no existe `DELETE` ni `PATCH`, y `PUT` solo para el Nivel B.

## 5. Criterios de aceptación

| Criterio | Estado |
|---|---|
| Conectado a las 6 fuentes | Cumplido |
| Lee y escribe; todo intento de borrar falla | Cumplido (probado en los 4 sistemas con escritura) |
| Logs consultables de todas las acciones | Cumplido |
| Guía corta de instalación y conexión | Cumplido (`INSTALL.md`) |
| Desplegado y conectable por el equipo | **Parcial:** desplegado y probado con una cuenta; falta la aprobación a nivel organización y la prueba con otra persona |

## 6. Pendientes

1. **Plan de Claude y administración del conector.** Hay que confirmar que el plan de la empresa permite un conector personalizado para toda la organización y quién lo agrega. Lo agrega el owner de Claude en *Organization settings → Connectors*, con la URL `https://iris-mcp-5h54.onrender.com/mcp`. Después cada persona lo conecta con su cuenta de Zoho de IRIS.
2. **Prueba con una segunda persona.** Dar de alta a un compañero con cuenta de Zoho del data center de Canadá, comprobar que lee, escribe y que el log de auditoría le niega el acceso, y luego revocarlo para ver que lo corta.
3. **Rotación de la clave del rol administrador de la base** (pedida a quien tiene los permisos). El MCP no usa ese rol, pero la especificación pide rotarlo antes de abrir el acceso al equipo.

## 7. Decisiones y riesgos

- **Residencia de datos.** El servidor corre en Oregon (Render) y la base está en us-east-2 (Supabase); el MCP hace pasar más datos de IRIS por servicios fuera de Canadá. Decisión provisional: seguir con los datos en Oregon. Queda la decisión formal de Jhony junto con SCRUM-201.
- **Lo que Claude lee pasa por la conversación.** Los datos de inquilinos, contratos y contactos que Claude lea quedan en la conversación de esa persona. La guía de instalación pide tratarlos con el mismo cuidado que en cualquier herramienta de la empresa.
- **Lo escrito no se deshace desde Claude.** Como no puede borrar, un error de escritura se corrige a mano en Zoho. Por eso el Nivel B pide confirmación y la guía recomienda aprobar caso por caso las herramientas de escritura.
- **Campos del CRM.** Los leads y contactos no tienen un campo de estado ni de fecha de seguimiento estándar; el Nivel B permite por ahora campos de notas y fechas (configurable). Si se quiere otra lista, se cambia con una variable de entorno.

## 8. Cómo dar de alta o revocar a una persona

Ver `INSTALL.md`, sección "Para tecnología". Alta: `insert into public.mcp_users (email) values (...)`. Revocar: `update public.mcp_users set revoked_at = now() where email = ...`. Consultar qué hizo alguien: un administrador pide a Claude "consultá el log de auditoría con audit_query".

## 9. Cómo restringir o habilitar datos

Todo se configura con variables de entorno en Render (Environment) y un redeploy. No hace falta tocar el código.

| Qué | Variable | Valor por defecto |
|---|---|---|
| Tablas de la base que Claude puede leer | `DB_ALLOWED_TABLES` (lista separada por comas) | Seis tablas: propiedades, administradores, contratos, inquilinos, mantenimiento y lista de espera |
| Columnas visibles de cada tabla | `DB_EXPOSED_COLUMNS` (JSON por tabla) | Sin lista, se ocultan datos sensibles, identificadores de otros sistemas, referencias entre tablas y claves foráneas |
| Filas máximas por consulta y por persona al día | `DB_MAX_ROWS`, `DB_DAILY_ROW_LIMIT` | 25 por consulta (tope 100) y 1000 por persona cada 24 h |
| Quién tiene herramientas de base de datos | `db_enabled` en `mcp_users` | Nadie hasta activarlo; los administradores siempre |
| Canales de Cliq donde puede publicar | `CLIQ_WRITE_CHANNELS` (nombres únicos de canal, separados por comas) | Ninguno: hoy solo `test` |
| Campos del CRM que puede cambiar (Nivel B) | `CRM_UPDATE_FIELDS_LEADS` y `CRM_UPDATE_FIELDS_CONTACTS` | Solo campos de notas y fechas |
| Apagar todas las escrituras agregar | `WRITES_ENABLED=false` | Encendido |
| Apagar las modificaciones con confirmación | `WRITES_B_ENABLED=false` | Encendido |
| Quién consulta el log | `ADMIN_EMAILS` o `is_admin` en `mcp_users` | Administradores definidos |
| Quién entra | Tabla `mcp_users` (alta y revocación, ver sección 8) | Personas dadas de alta |

**Protección de la estructura de la base de datos.** Para que Claude no pueda deducir el diagrama de la base (tablas, relaciones, sistemas conectados):
- No devuelve columnas que son referencias entre tablas ni identificadores de Zoho, Buildium o proveedores, y no deja filtrar ni ordenar por ellas.
- Una columna oculta, una inexistente y una sensible reciben la misma respuesta, y los errores de la base no llegan a Claude, así que no se pueden descubrir nombres por prueba y error.
- El servidor le indica a Claude que no describa ni deduzca la estructura de los sistemas de IRIS. Es una instrucción, no una barrera: los controles anteriores son los que cuentan.
- Límite que queda: las columnas que se muestran revelan su nombre, y la persona ve las filas. La solución de fondo, si hace falta, es un esquema aparte de vistas con nombres de negocio.

Límites que no se cambian con variables:
- **Base de datos:** aunque se agregue una tabla a la lista, el rol de la base tiene que tener permiso de lectura sobre ella (`grant select` en Supabase), y las columnas con `password`, `token`, `secret`, `hash` o `api_key` en el nombre nunca se leen.
- **Lectura de Cliq, CRM, WorkDrive, Sign y Projects:** Claude ve lo que ven los tokens de lectura de Zoho. Para limitarlo hay que reducir los permisos del token o regenerarlo, no hay una lista dentro del MCP.
- **Subida a WorkDrive:** solo archivos de texto nuevos, en una carpeta existente que elija la persona. Hoy no hay lista de carpetas permitidas.
- **Qué se puede escribir:** agregar una acción nueva requiere cambiar el código y un permiso nuevo en el token de Zoho. Borrar no se puede habilitar por configuración.
