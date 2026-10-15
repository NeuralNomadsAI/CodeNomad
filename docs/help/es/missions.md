# Misiones

Las Misiones combinan un plan de proyecto duradero con conversaciones nativas de OpenCode. El coordinador planifica y delega; el árbol de tareas registra dependencias y resultados. Un plan guardado, una entrada admitida y una ejecución observada son hechos distintos.

## Crear y después iniciar explícitamente {#create}

1. Abre **Misiones** en el panel derecho y elige **Crear misión**.
2. Completa **¿Qué debe hacer la misión?** y comprueba el **Título**, rellenado a partir de la primera frase (hasta 60 caracteres).
3. En **Cuándo**, selecciona **Una vez** o **Cada día a las**. Para trabajo diario, verifica la zona horaria mostrada; **Cambiar** permite indicar una zona IANA.
4. Expande **Opciones** para acceder a **Guion**, **Notas**, **Agentes y modelos**, **Sesiones de tareas**, descripciones guardadas y conversaciones seguidas opcionales.
5. Elige **Crear**. Selecciona la entrada nueva y usa su acción ▶ independiente cuando esté lista: **Iniciar misión** para trabajo puntual o **Iniciar programación {id}** para una programación diaria.

**Crear nunca inicia el trabajo.** Una misión puntual queda preparada; una programación diaria queda pausada. Ni la creación ni guardar una descripción activan un temporizador. La creación tiene el ámbito del proyecto/Location seleccionado y fija los perfiles solicitados y la política de sesiones de tareas. La validación aparece junto al campo afectado; un rechazo que indique que no se envió nada deja el borrador disponible para corregirlo.

### Guiones {#playbooks}

| Guion | Trabajo previsto |
| --- | --- |
| Misión flexible | El coordinador elige un plan con dependencias para el objetivo. |
| Depuración | Diagnóstico, implementación, revisión independiente de normas/especificación y validación nueva; la resolución continúa con el implementador. |
| Exploración | Traza las incertidumbres y avanza mediante decisiones acotadas con preguntas a personas. |
| Entrega de producto | Coordina los roles de análisis de producto, arquitectura, implementación y calidad. |

El guion orienta la coordinación; no elude los permisos nativos ni garantiza el éxito. Responde las preguntas de decisión de Exploración mediante el panel de interrupciones de CodeNomad para que se registre una respuesta explícita de la interfaz, en lugar de pedir a un agente que suplante una aprobación.

## Seguir el árbol y leer resultados {#tracking}

1. Selecciona el título de la misión. El chevrón inicial mantiene abierta su lista; el campo del título abre un selector temporal.
2. Elige **Resumen** (ojo) para la vista central general o selecciona un nodo de tarea para ver su resultado, encargo y evidencias exactos.
3. Sigue los enlaces de dependencias y los **Informes**; usa **Abrir conversación** para el coordinador cuando necesites su transcripción.
4. En **Te necesita**, elige **Responder** para abrir la conversación y el panel de interrupciones del actor solicitante.

| Indicador | Qué demuestra |
| --- | --- |
| Asignada | Se admitió la entrada; no se demuestra que el modelo la haya consumido, trabajado o completado. |
| Activa | Se observó actividad nativa. |
| En espera | Las dependencias declaradas aún no se cumplen. |
| Bloqueada | Se informó de un bloqueo, no necesariamente una pregunta para ti. |
| Te necesita | Un formulario/pregunta nativo abierto o un permiso necesita respuesta. |
| Completada | Se registró un resultado de tarea; inspecciona sus evidencias y cualquier trabajo nativo restante. |

El gráfico incluye trabajo completado y retirado. Retirar una tarea no detiene por sí solo su conversación. **En curso** es el estado del ciclo de vida de la misión, no demuestra que su coordinador esté ejecutándose. El texto completo pertenece al lector central, no a la lista de tareas del panel; **Detalles técnicos** pliega los identificadores y la información de ejecución solicitada.

### Informes de situación y solicitudes de actualización {#briefings}

El coordinador recibe instrucciones de publicar un informe de situación del proyecto tras su plan inicial, tras resolver tareas, al esperar a una persona y antes del informe final. Es una evaluación redactada, no un contador de actividad en vivo ni una señal periódica garantizada. Un aviso identifica cuándo el mapa ha cambiado desde ese informe.

Usa **Pedir una actualización** debajo de la barra de herramientas para solicitar una evaluación nueva del coordinador y lee después **Resumen**. **Actualización pedida…** significa que la solicitud está pendiente, no respondida. **Envío sin confirmar** no autoriza el reenvío automático: abre la conversación del coordinador antes de hacer una solicitud nueva independiente. Es una entrada nativa normal, no un entorno aislado de solo lectura; el coordinador conserva sus permisos habituales.

## Perfiles, delegación y profundidad {#profiles}

1. Usa el engranaje de Misiones o **Configuración → Misiones** para editar **Valores para nuevas misiones**.
2. Elige valores globales y excepciones por guion y pulsa **Guardar**. Durante la creación, usa **Opciones → Agentes y modelos** para solicitar perfiles específicos.
3. Elige **Sesiones de tareas** independientemente de **Guion**.
4. Para límites de recursión nativa, usa por separado **Profundidad de OpenCode → Profundidad máxima → Guardar profundidad de ubicación**.

| Ajuste | Ámbito y efecto |
| --- | --- |
| Valores para nuevas misiones | Valores de toda la configuración solo para misiones **nuevas**; una excepción de guion sustituye el valor general. |
| Agente / Modelo / Razonamiento | Selecciones solicitadas para coordinador/roles registradas al crear; un actor ocupado no se cambia silenciosamente para atender trabajo posterior. Las ejecuciones diarias reutilizan los perfiles solicitados fijados. |
| Subagentes nativos | Las sesiones de tareas usan agentes nativos subagent/all bajo el coordinador. |
| Sesiones independientes | Las sesiones de tareas declaradas usan agentes primary/all y conversaciones independientes; esto no desactiva los ayudantes nativos internos. |
| Profundidad de OpenCode | Configuración de Location/proyecto para **todas** las conversaciones de allí, no solo Misiones. Vacío hereda. Guardar no recarga OpenCode ni cambia las conversaciones en ejecución. |

**Valor nativo predeterminado** y **Heredar valores predeterminados globales** son distintos: el primero solicita valores nativos predeterminados; el segundo usa el perfil global configurado. Se comprueba la disponibilidad del catálogo; un perfil solicitado no demuestra qué perfil usa actualmente una conversación. Los permisos nativos y la profundidad configurada siguen rigiendo las llamadas a ayudantes internos en ambos modos de tareas.

Si el guardado de valores/profundidad no está confirmado, conserva el borrador y usa **Recargar** para los valores o **Actualizar profundidad de ubicación** antes de otro cambio. No interpretes **Profundidad efectiva desconocida** como cero o desactivada.

## Reutilizar una descripción guardada {#saved-briefs}

1. Durante la creación, expande **Opciones → Empezar desde una descripción** y selecciona la descripción guardada.
2. Revisa el objetivo, las notas, el guion, los perfiles y la delegación copiados antes de **Crear**.
3. Usa **Guardar como descripción** para dar nombre a un borrador reutilizable. Una misión puntual seleccionada, incluso terminada, también ofrece **Guardar como descripción**.

Las descripciones guardan instrucciones y elecciones solicitadas, no planes de tareas, resultados, conversaciones, relojes de programación ni autoridad de ejecución. Cargar una rellena un borrador de creación normal; no inicia ni programa nada. Eliminar una descripción conserva las misiones/conversaciones existentes. **Configuración → Misiones → Descripciones guardadas** gestiona la biblioteca; restablecerla explícitamente elimina las descripciones guardadas, no las ejecuciones. Las programaciones no tienen acción para guardarlas como descripción.

## Hora diaria, recuperación de días y conversaciones seguidas {#daily-schedules}

Las programaciones diarias usan la zona horaria IANA y la hora civil guardadas, no un intervalo transcurrido de 24 horas. Las horas se muestran en la zona de la programación, etiquetada cuando difiere de la del lector. Cada ejecución obtiene su propio coordinador y mapa de misión aislado; la programación seleccionada muestra el árbol de tareas actual y el historial de fecha/resultado. Selecciona una ejecución pasada para leerla en el centro. El historial se limita a 30 resultados.

| Situación | Comportamiento de la programación |
| --- | --- |
| Varios días vencidos omitidos | Ejecuta solo el último día vencido posterior al marcador diario resuelto, no una cola por cada día omitido. |
| Salto al adelantar la hora | Avanza hasta el primer minuto válido posterior; un salto al final del día cruza el límite del día. |
| Hora del reloj repetida | Usa la primera aparición; no crea una segunda ejecución diaria. |
| Día civil omitido por completo | No existe ejecución para ese día. |
| El reloj retrocede | No hace que un día ya procesado vuelva a vencer. |
| Una ejecución existente sigue pendiente | No la solapa con una ejecución diaria nueva. |

La fecha de creación también limita el trabajo diario elegible; iniciar una programación nueva no autoriza a procesar fechas anteriores a su existencia. **Ejecutar ahora** inicia una ejecución manual independiente cuando se ofrece; no reemplaza el reloj diario ni elude una ejecución pendiente. La próxima hora mostrada es una proyección, no una garantía de ejecución exacta.

**Conversaciones seguidas (opcional)** añade contexto acotado de conversaciones elegidas. Solo una ejecución completada avanza sus cursores de mensajes procesados; una ejecución fallida/interrumpida no consume silenciosamente ese contexto. Si las instrucciones más el contexto superan la capacidad, acorta las instrucciones o retira conversaciones seguidas en lugar de suponer que se lee un historial ilimitado.

## Duración y reinicios del servicio {#lifetime}

| Componente | Qué significa cerrarlo |
| --- | --- |
| Pestaña de proyecto de CodeNomad | Cierra el proyecto en CodeNomad; el trabajo nativo sigue en OpenCode y vuelve a aparecer al reabrir el proyecto. |
| Ventana de CodeNomad | Desconecta la vista; no detiene el trabajo nativo ni el servicio OpenCode. |
| Backend de CodeNomad | No detiene OpenCode. La coordinación puntual de CodeNomad depende de la presencia del backend; no supongas que se pueden seguir enviando/controlando tareas puntuales mientras está cerrado. |
| Programación diaria en ejecución | Su reloj y la ejecución de sus pasadas se ejecutan en el plugin/servicio OpenCode, incluso con la interfaz y el backend de CodeNomad cerrados. El equipo de ejecución y el servicio OpenCode deben seguir funcionando. |
| Reinicio del servicio OpenCode | Pierde los trabajos de programación locales del proceso. Una programación que debía ejecutarse pasa a **Interrumpido** hasta una **Reanudar** explícita; reabrir CodeNomad no la reactiva. |

Tras un reinicio, inspecciona la ejecución pendiente y elige **Reanudar** cuando estés listo. Reanudar reconcilia la ejecución existente sin enviar dos veces la entrada de su coordinador; no promete continuar un turno nativo interrumpido. Un turno cortado por un reinicio puede resolverse como terminado sin informe, con **Interrumpida por un reinicio**. No uses un reinicio para reintentar efectos secundarios de herramientas.

## Pausa, detención y resultados inciertos {#controls-recovery}

1. Selecciona la entrada e inspecciona su estado y conversación actuales antes de actuar.
2. Usa el icono de pausa para una suspensión reanudable, o el de detener y su confirmación para una detención terminal. Las etiquetas de misiones puntuales son **Pausar misión** y **Detener misión definitivamente**; las de programaciones nombran la programación.
3. Si el resultado no está confirmado, usa **Comprobar estado** / **Comprobar el estado del control** para leer el resultado existente. No emitas una acción de reemplazo para eludir la incertidumbre.
4. Para acciones puntuales, **Actualizar y reenviar la acción no confirmada** de la cabecera comprueba primero el estado y reenvía únicamente esa acción exacta aún no confirmada desde tu clic explícito.

Pausar una misión puntual interrumpe su familia nativa y suspende la coordinación; Detener también cancela las entradas/entregas familiares en cola y es terminal. Son operaciones acotadas: **Es posible que algunos subagentes sigan en ejecución.** significa que la detención es incompleta. Inspecciona el resultado conservado y usa su reintento explícito en lugar de suponer que se cancelaron todos los efectos de shells/herramientas. Reanudar informa al coordinador de los descendientes interrumpidos; este debe decidir cómo continuar el trabajo.

Pausar/Detener una programación diaria cancela la programación y solicita interrumpir los actores raíz registrados, incluidos el coordinador y los especialistas independientes, pero **no demuestra que esas conversaciones ni sus descendientes se hayan detenido**. Inspecciona las familias nativas. Detener es terminal: una programación detenida no puede iniciarse, reanudarse ni ejecutarse ahora. **Comprobar pasada** reconcilia una ejecución pendiente sin volver a enviarla. Los fallos transitorios de comprobación programada muestran su último error y se reintentan automáticamente; perder la respuesta a un control del usuario no causa su reenvío automático.

Para un coordinador puntual inactivo sin informe, la acción principal ▶ puede verificarlo y recuperarlo; las tareas tienen recuperación específica de informes ausentes cuando cumplen las condiciones. La recuperación comprueba primero actividad nativa, descendientes y esperas; una actividad desconocida rechaza la admisión. No repite asignaciones ni reemplaza el plan. Abre las conversaciones para resolver preguntas, permisos, shells o trabajo en segundo plano pendientes.

Si **Crear** queda sin confirmar, la ventana conserva la solicitud enviada y desactiva nuevas creaciones para ese proyecto; la eliminación de worktrees puede permanecer bloqueada. Actualizar solo lee el estado. Cerrar/reabrir el editor no lo repara. Antes de recargar la ventana, inspecciona la lista de misiones: recargar borra el bloqueo local, **no demuestra que la creación fallara**. No crees a ciegas un duplicado tras recargar o reiniciar.

## Editar, eliminar y limpiar conversaciones {#cleanup}

Usa **Editar la misión seleccionada** en una misión puntual editable; ante un conflicto, cierra/reabre el editor para cargar la revisión actual en lugar de sobrescribirla. Las programaciones diarias no ofrecen controles de edición/eliminación.

1. Para una misión puntual que ya no necesites, elige **Eliminar la misión seleccionada…** y revisa la confirmación.
2. Opcionalmente, selecciona **Eliminar también las conversaciones de especialistas creadas para esta misión** antes de confirmar.
3. Comprueba **Limpieza de conversaciones** para ver los recuentos de eliminadas/conservadas/pendientes. Reintenta solo la limpieza restante registrada si se ofrece.

Eliminar una misión no equivale a detenerla; usa Detener e inspecciona primero el trabajo restante. Se conservan los coordinadores y las conversaciones reutilizadas. También pueden conservarse especialistas compartidos, movidos, con hijos o cuya propiedad no se pueda verificar. La limpieza parcial no se revierte ni se completa silenciosamente en segundo plano. El historial de limpieza completada sigue disponible en el lector general.

Consulta [Permisos](permissions.md), [Conversaciones](conversations.md) y [configuración de OpenCode](opencode.md) para el trabajo nativo y los controles del servicio.
