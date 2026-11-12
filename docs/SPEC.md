# LAB-654 — MCP de IRIS: especificación

Estado: acordada el 2026-11-11 (lista de escritura confirmada por Joaquín). Estado al 2026-11-12: implementada (servidor remoto, auditoría, 6 fuentes, escritura Nivel A y B sin borrado); ver §9 para lo que falta cerrar. Este documento define la versión completa.

## 1. Objetivo

Que cualquier persona del equipo que use Claude pueda consultar y actuar sobre los datos reales de IRIS desde un solo lugar, con permisos mínimos y todo registrado.

## 2. Fuentes

| Fuente | Lectura | Escritura | Estado |
|---|---|---|---|
| Base de datos (Supabase/Postgres) | Sí | Solo tabla de auditoría | Lectura hecha (v0.1) |
| Zoho CRM | Sí | Sí (ver §4) | Lectura hecha |
| Zoho Cliq | Sí | Sí (ver §4) | Lectura hecha |
| Zoho WorkDrive | Sí | Sí (ver §4) | Lectura hecha |
| Zoho Projects | Sí | Sí (ver §4) | Falta |
| Zoho Sign | Sí | **No** (solo estado/lectura) | Falta |

## 3. Reglas transversales

- **Borrar: prohibido en todos los sistemas**, bloqueado por permisos y no solo por código (ver §5).
- **Autenticación:** solo usuarios de IRIS, con inicio de sesión de Zoho, acceso revocable por persona.
- **Despliegue:** servidor remoto (Render, Oregon EE. UU. como los backends), conectable desde Claude por el equipo.
- **Secretos:** solo variables de entorno, nunca en el repositorio.
- **Logs:** ver §6.

## 4. Acciones de escritura

### Nivel A — se habilitan primero (solo agregan, no pisan datos)

| Acción | Sistema | Restricción |
|---|---|---|
| Agregar nota a lead, contacto, deal o cuenta | CRM | — |
| Crear tarea | CRM, Projects | — |
| Comentar una tarea | Projects | — |
| Publicar mensaje | Cliq | Solo canales de una lista permitida configurable |
| Subir archivo **nuevo** | WorkDrive | Carpeta existente; sin sobrescribir |

### Nivel B — actualizan datos: confirmación explícita y registro de antes y después

| Acción | Sistema | Restricción |
|---|---|---|
| Actualizar campos de lead o contacto | CRM | Solo campos de una lista permitida (estado, notas, fecha de seguimiento) |
| Cambiar estado o responsable de una tarea | Projects | — |
| Crear lead o contacto | CRM | Buscar duplicados antes de crear |

La confirmación significa que la tool muestra el cambio exacto (valor actual y nuevo) y no lo aplica hasta que la persona lo apruebe en Claude.

### Nivel C — fuera de esta versión

- **Zoho Sign:** enviar a firmar o modificar documentos. Solo lectura.
- **Tablas centrales de la base** (`tenants`, `leases`, `properties`, etc.): los backends ejecutan correos, sincronización con Zoho y reglas de nombres; escribir directo se las salta.
- **WorkDrive:** mover, renombrar, sobrescribir, compartir o cambiar permisos.
- **Cliq:** mensajes directos a personas o a canales fuera de la lista.
- **CRM:** cambiar propietario, convertir leads o acciones que disparen workflows y correos.
- Operaciones masivas, gestión de usuarios y permisos.

Cualquier acción nueva se agrega a esta lista y se clasifica antes de implementarse.

## 5. Prohibición de borrar

- **Zoho (CRM, Cliq, WorkDrive, Projects, Sign):** los refresh tokens se generan solo con scopes `READ`, `CREATE` y `UPDATE` de lo necesario. Nunca `ALL` ni `DELETE`.
- **Base de datos:** rol de Postgres sin `DELETE` ni `TRUNCATE`; `INSERT` solo en la tabla de auditoría.
- **Código:** ninguna tool de borrado. No reemplaza a los permisos, los complementa.
- **Actualizar también destruye datos** si pisa un campo: por eso el Nivel B guarda el valor anterior en el log.

**Prueba obligatoria antes de cerrar:** en cada sistema, intentar borrar un registro de prueba y comprobar que falla. En WorkDrive hay que verificar específicamente si enviar a la papelera queda bloqueado solo con los scopes; si no, esa acción se restringe por código y se documenta.

## 6. Logs de auditoría

Cada llamada a una tool registra:

- **Quién** (usuario autenticado), **cuándo**, **qué herramienta**, **sistema** y **tipo** (lectura o escritura).
- **Resultado:** éxito o error, con el motivo.
- **Lecturas:** parámetros y cantidad de resultados; sin guardar los datos leídos.
- **Escrituras (obligatorio):** el cambio realizado y, en el Nivel B, el valor anterior y el nuevo. Datos personales recortados a lo necesario.

Los logs se guardan en una tabla de la base y se pueden consultar con una tool de solo lectura restringida a administradores. Nota de residencia: esa tabla vive en Supabase (us-east-2); por eso no se guardan datos leídos.

## 7. Autenticación

- Login de Zoho, limitado a usuarios de la organización de IRIS.
- Zoho no soporta el registro dinámico de clientes OAuth que usan los conectores de Claude, así que el servidor actúa como servidor de autorización propio y delega el login a Zoho.
- Revocar a una persona: bloquearla en el servidor sin tocar a las demás.
- Credenciales de Zoho hacia las APIs: tokens de servicio con los scopes de §5.

## 8. Fases

1. Servidor remoto con login de Zoho en Render, con las 14 tools de lectura actuales.
2. Auditoría: tabla de logs y registro de todas las llamadas.
3. Zoho Sign y Projects en lectura.
4. Escritura sin borrado: Nivel A, luego Nivel B, con las pruebas de §5.
5. Guía de instalación para el equipo y revisión de seguridad.

## 9. Criterios de aceptación

- [x] Conectado a las 6 fuentes (probado en vivo, 2026-11-11).
- [x] Lee y escribe según §4 (Nivel A y B probados contra Zoho real, 2026-11-12). Prueba de borrado hecha en cada sistema con los tokens de escritura: CRM (`OAUTH_SCOPE_MISMATCH`), Projects (`Invalid OAuth scope`), WorkDrive (borrar y papelera: `Invalid OAuth scope`), Cliq (`oauthtoken_scope_invalid`). Falla en todos.
- [ ] Desplegado y conectable desde Claude por el equipo (desplegado y probado con `tech@`; falta que lo pruebe otra persona del equipo y la aprobación del conector a nivel organización).
- [x] Logs consultables de todas las acciones (`audit_query`, tabla `mcp_audit_log`; las escrituras guardan el contenido y, en el Nivel B, el valor anterior y el nuevo).
- [x] Guía corta de instalación y conexión (`INSTALL.md`).

## 10. Decisiones abiertas

- **Plan de Claude:** confirmar que permite conectores remotos personalizados para todo el equipo y quién es administrador (consultado en Jira).
- **Residencia de datos:** Render en Oregon y Supabase en us-east-2 están fuera de Canadá; el MCP hace pasar más datos por ahí. Decisión provisional (2026-11-12): seguir con los datos en Oregon; queda pendiente la decisión formal de Jhony junto con SCRUM-201.
- **Clave de `postgres` de Supabase:** rotarla antes de dar acceso al equipo (pedido a quien tiene los permisos). El MCP no la usa; usa roles propios con permisos mínimos.
