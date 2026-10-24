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

Las solicitudes nuevas no reemplazan la que estás editando ni provocan navegación. La selección permanece en la misma solicitud durante las actualizaciones de la cola; las flechas no vuelven al otro extremo al llegar al final. Tras resolverse, la solicitud de otra conversación no relacionada permanece compacta hasta que la abras.

**Contraer solicitudes** oculta el cuerpo; no deniega, cancela ni responde nada. Un editor expandido reduce temporalmente el editor de mensajes a su altura mínima sin cambiar su tamaño guardado ni el borrador. Su contenido se desplaza de forma independiente de las acciones fijas de respuesta.

## Responder preguntas y formularios {#answer-questions-forms}

1. Expande la solicitud deseada y completa sus campos o selecciona las opciones ofrecidas.
2. Cuando un campo de selección permite respuestas personalizadas, aparece un campo de texto adicional: escribe allí tu propia respuesta en lugar de una opción ofrecida (o añade valores personalizados en un campo de selección múltiple). Responde todas las preguntas obligatorias.
3. Elige **Enviar**; usa **Cancelar** para una pregunta o formulario solo cuando quieras esa cancelación nativa.

Las respuestas parciales y los borradores de rechazo sobreviven a las actualizaciones de la cola y a la navegación entre conversaciones dentro del cliente en ejecución. No son una decisión enviada ni una garantía de recuperación después de borrar los datos del cliente. Una respuesta fallida sigue siendo editable; inspecciona la solicitud pendiente antes de reintentar. CodeNomad no repite automáticamente una respuesta.

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

Si otro cliente resuelve una solicitud, puede desaparecer de aquí. Un tiempo de espera agotado o una respuesta fallida no demuestra si el servicio nativo aceptó la decisión: deja que la reconciliación de solicitudes pendientes actualice el panel antes de tomar otra decisión deliberada. Una respuesta ambigua nunca se muestra como una decisión confirmada inventada.

## Leer los comprobantes de permisos {#permission-receipts}

1. Busca **Decisiones de permisos** junto al contenido asociado de la transcripción, incluso cuando las tarjetas nativas de herramientas estén ocultas.
2. Para decisiones sin mensaje de origen, abre **Decisiones de permisos de la sesión**.
3. Usa **Cargar más decisiones** para continuar o **Reintentar** tras un fallo de lectura.

Los comprobantes registran las solicitudes/recursos conocidos, la decisión confirmada y el motivo/procedencia disponibles. **Decisión en CodeNomad**, **Automático · Yolo** y **Decisión nativa** distinguen los orígenes observados; una resolución nativa no demuestra que alguien hiciera clic en esta ventana.

Los comprobantes son anotaciones de solo lectura de CodeNomad, no mensajes nativos ni editores de reglas de permisos. Se excluyen de la búsqueda nativa en todo el historial, la copia de mensajes y la exportación. No pueden reconstruir decisiones perdidas mientras CodeNomad estaba sin conexión, y un resultado de herramienta correcto no sustituye un comprobante ausente. La eliminación de una sesión borra sus comprobantes.

## Modo Yolo y ámbito familiar {#yolo-mode}

1. Selecciona una conversación y abre **Estado → Modo yolo**.
2. Actívalo solo si es aceptable aprobar permisos automáticamente para toda la familia.
3. Desactívalo antes de continuar con trabajo no fiable; inspecciona las solicitudes pendientes y las herramientas ya en ejecución.

Aunque el control se refiere a una sesión, su ámbito efectivo es la raíz resuelta de la familia y sus descendientes: activarlo/desactivarlo desde un hijo afecta a esa familia. Una bifurcación nativa se trata como una raíz propia. No es una aprobación global para todos los proyectos o conversaciones independientes.

Yolo aprueba **solo permisos**. No responde preguntas ni formularios, no aporta información ausente, no garantiza ejecuciones correctas ni omite las comprobaciones de propiedad del backend. El backend de CodeNomad realiza la aprobación automática: cerrar una ventana no basta para desactivarla mientras el backend siga activo, y un backend detenido no puede seguir aprobando solicitudes. El ajuste familiar se conserva y se restaura cuando se vuelve a cargar el espacio de trabajo.

Desactivar Yolo no revoca una decisión ya aceptada ni revierte efectos sobre archivos/red. Revisa los comprobantes **Automático · Yolo** y detén explícitamente la ejecución si es necesario. Para automatización con puntos de aprobación humana, consulta [Misiones](missions.md).

## Recuperar solicitudes ausentes u obsoletas {#request-recovery}

1. Comprueba el indicador de conexión y reconecta al mismo backend/proyecto.
2. Deja que la recuperación reconcilie las solicitudes nativas pendientes; las solicitudes conocidas y los borradores se conservan si la cobertura es incompleta.
3. Si aparece el aviso **preguntas y permisos no recuperados por completo**, indica el proyecto, la causa, las carpetas y las sesiones afectadas. Resuelve esa causa (por ejemplo, un worktree eliminado o una sesión que trabaja fuera de este proyecto); el siguiente paso de recuperación reintenta automáticamente.

La recuperación no carga todos los worktrees inactivos solo para enumerar solicitudes. Una respuesta incompleta no es una cola vacía autoritativa, y la advertencia no autoriza a repetir un mensaje, una respuesta o una aprobación. Recargar la configuración puede cancelar formularios/permisos nativos; no lo uses como botón habitual para actualizar solicitudes. Consulta [Solución de problemas](troubleshooting.md) y [configuración de OpenCode](opencode.md).
