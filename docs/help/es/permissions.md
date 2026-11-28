# Preguntas y permisos

Las preguntas nativas, los formularios y las solicitudes de permiso se responden en el panel de interrupciones justo encima del editor de mensajes, no dentro de las tarjetas de herramientas pendientes de la transcripción.

## Buscar la solicitud y comprobar su origen {#request-dock}

1. Selecciona una conversación con **Requiere entrada** / **Requiere permiso** o haz clic en el indicador de solicitudes del proyecto para abrir el panel sin navegar.
2. Lee el tipo de solicitud, el título de la conversación y su procedencia antes de expandirla o responder.
3. Cuando haya varias solicitudes pendientes, usa **Solicitud anterior** / **Solicitud siguiente**. Usa **Ver conversación** solo si quieres navegar a su origen.

| Procedencia | Significado y comportamiento |
| --- | --- |
| Conversación abierta | Su solicitud puede expandirse normalmente |
| Subagente, con padre **De …** | Un descendiente recursivo de la conversación abierta es contexto local; la procedencia del padre permanece visible |
| Otra conversación | Empieza como una vista previa compacta; expándela explícitamente para responder sin salir de la conversación actual |
| Solicitud del proyecto / Solicitud del servicio | Un formulario puede no tener una conversación propietaria; no se muestra un enlace de conversación inventado |

**Contraer solicitudes** oculta el cuerpo; no deniega, cancela ni responde nada. Un editor expandido reduce temporalmente el editor de mensajes a su altura mínima sin cambiar su tamaño guardado ni el borrador. Su contenido se desplaza de forma independiente de las acciones fijas de respuesta.

## Responder preguntas y formularios {#answer-questions-forms}

1. Expande la solicitud deseada y completa sus campos o selecciona las opciones ofrecidas.
2. Cuando un campo de selección permite respuestas personalizadas, aparece un campo de texto adicional: escribe allí tu propia respuesta en lugar de una opción ofrecida (o añade valores personalizados en un campo de selección múltiple). Responde todas las preguntas obligatorias.
3. Elige **Enviar**; usa **Cancelar** para una pregunta o formulario solo cuando quieras esa cancelación nativa.

Las respuestas parciales y los borradores de rechazo sobreviven a las actualizaciones de la cola y a la navegación entre conversaciones dentro del cliente en ejecución. No son una decisión enviada ni una garantía de recuperación después de borrar los datos del cliente.

Algunos formularios ofrecen **Abrir formulario externo** para un flujo en el navegador. Sigue las instrucciones de la solicitud y vuelve a su estado en lugar de considerar una página abierta como una respuesta correcta. Los formularios arbitrarios de proveedor/autenticación no son necesariamente artefactos de una conversación.

Las herramientas nativas de preguntas completadas muestran en el historial la pregunta, la respuesta seleccionada, las descripciones de las opciones y el texto personalizado literal. **Otras opciones** mantiene disponibles las alternativas no seleccionadas. Estos resultados completados son distintos del panel activo.

## Aprobar o denegar un permiso {#permission-decisions}

1. Lee la operación solicitada, los recursos y cualquier **Diff solicitado**. Comprueba qué conversación recibirá la decisión.
2. Opcionalmente, introduce comentarios explicando una denegación o una alternativa más segura.
3. Elige **Permitir una vez**, **Permitir siempre** o **Denegar**.

| Opción | Efecto nativo | Límite de seguridad |
| --- | --- | --- |
| Permitir una vez | Aprueba esta solicitud de permiso | No es una aprobación general de futuras operaciones no relacionadas |
| Permitir siempre | Envía la opción nativa de aprobación persistente para solicitudes coincidentes en su contexto de sesión aplicable | No es un interruptor de confianza de todo CodeNomad ni del sistema operativo; revisa el recurso/patrón autorizado |
| Denegar | Rechaza la solicitud, con comentarios opcionales | No deshace el trabajo realizado antes de esta solicitud |

La aprobación de permisos puede liberar la ejecución de herramientas inmediatamente. No es una simulación. Los límites de diferencias/lectura y las comprobaciones de identidad de origen pueden impedir la aprobación cuando no se puede validar el contenido solicitado; actualiza y revisa la solicitud real en lugar de aprobar por suposición una operación distinta.

Si otro cliente resuelve una solicitud, puede desaparecer de aquí. Un tiempo de espera agotado o una respuesta fallida no demuestra si el servicio nativo aceptó la decisión: deja que la reconciliación de solicitudes pendientes actualice el panel antes de tomar otra decisión deliberada.

## Leer los comprobantes de permisos {#permission-receipts}

1. Busca **Decisiones de permisos** junto al contenido asociado de la transcripción, incluso cuando las tarjetas nativas de herramientas estén ocultas.
2. Para decisiones sin mensaje de origen, abre **Decisiones de permisos de la sesión**.
3. Usa **Cargar más decisiones** para continuar o **Reintentar** tras un fallo de lectura.

Los comprobantes registran las solicitudes/recursos conocidos, la decisión confirmada y el motivo/procedencia disponibles. **Decisión en CodeNomad**, **Decisión automática** y **Decisión nativa** distinguen los orígenes observados; una resolución nativa no demuestra que alguien hiciera clic en esta ventana.

Los comprobantes son anotaciones de solo lectura de CodeNomad, no mensajes nativos ni editores de reglas de permisos. Se excluyen de la búsqueda nativa en todo el historial, la copia de mensajes y la exportación. No pueden reconstruir decisiones perdidas mientras CodeNomad estaba sin conexión, y un resultado de herramienta correcto no sustituye un comprobante ausente. La eliminación de una sesión borra sus comprobantes.

## Modo de permisos de la conversación {#conversation-mode}

Selecciona una conversación, abre **Estado → Permisos** y haz clic en un modo. La sección plegada muestra el último modo conocido.

- **Autónomo** — Aplica las reglas de permisos de OpenCode.
- **Supervisado** — Pide confirmación antes de que el agente modifique archivos o ejecute comandos de shell. Para esas acciones, las prohibiciones globales, del proyecto y de la conversación siguen vigentes, y las reglas que las permiten pasan a requerir confirmación. Las aprobaciones de **Permitir siempre** guardadas por OpenCode siguen vigentes para las solicitudes que coincidan.

Ambos modos usan las reglas de sesión de OpenCode, también en su interfaz de terminal si abres la misma conversación en el mismo servicio. Volver a **Autónomo** solo quita las reglas añadidas para la supervisión. Los archivos de configuración de OpenCode no cambian. CodeNomad no aprueba solicitudes automáticamente en ninguno de los dos modos.

El modo Supervisado no es un entorno aislado. Las lecturas, el acceso fuera del proyecto y las herramientas MCP conservan sus propias reglas. Las solicitudes abiertas conservan sus reglas originales.

En un subagente, **Permisos** muestra y cambia el modo de la conversación raíz. Los subagentes existentes conservan sus reglas al cambiar el modo. Si un subagente inicia otro, el nuevo copia las reglas de su padre inmediato.

Una bifurcación copia las reglas de su conversación de origen y tiene su propio modo. Si CodeNomad no puede verificar qué reglas quitar, la bifurcación las conserva y puedes seguir enviando mensajes.

Si el modo está sin confirmar, selecciona **Volver a cargar los permisos**. Para elegir el modo inicial, consulta [Permisos de las conversaciones nuevas](settings.md#new-conversation-permissions).

## Recuperar solicitudes ausentes u obsoletas {#request-recovery}

1. Comprueba el indicador de conexión y reconecta al mismo backend/proyecto.
2. Deja que la recuperación reconcilie las solicitudes nativas pendientes; las solicitudes conocidas y los borradores se conservan si la cobertura es incompleta.

Los fallos temporales de recuperación se reintentan en segundo plano sin crear notificaciones. Si el plugin integrado de OpenCode no puede listar las solicitudes en espera, aparece un único aviso por backend en la pestaña del navegador hasta que la recuperación se complete.

Una respuesta incompleta no es una cola vacía autoritativa, y un aviso de plugin no disponible no autoriza a repetir un mensaje, una respuesta o una aprobación. Recargar la configuración puede cancelar formularios/permisos nativos; no lo uses como botón habitual para actualizar solicitudes. Consulta [Solución de problemas](troubleshooting.md) y [configuración de OpenCode](opencode.md).
