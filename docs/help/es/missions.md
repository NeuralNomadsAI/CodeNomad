# Misiones

Las Misiones combinan un plan de proyecto duradero con conversaciones nativas de OpenCode. El coordinador planifica y delega; el árbol de tareas registra dependencias y resultados. Un plan guardado, una entrada admitida y una ejecución observada son hechos distintos.

## Crear y después iniciar explícitamente {#create}

1. Abre **Misiones** en el panel derecho y elige **Crear misión**. El formulario sustituye la lista de misiones y las tareas de la misión seleccionada hasta que crees o canceles.
2. Completa **¿Qué debe hacer la misión?** y comprueba el **Título**, rellenado a partir de la primera frase (hasta 60 caracteres).
3. En **Cuándo**, selecciona **Una vez** o **Cada día a las**. Para trabajo diario, verifica la zona horaria mostrada; **Cambiar** permite indicar una zona IANA.
4. Expande **Opciones** para acceder a **Guion**, **Notas**, **Agentes y modelos**, **Sesiones de tareas**, la **Profundidad de anidamiento de subsesiones** del proyecto, descripciones guardadas y conversaciones seguidas opcionales. Con **Comparar dos modelos**, los selectores **Modelo A** y **Modelo B** aparecen en el formulario principal.
5. Elige **Crear**. Selecciona la entrada nueva y usa su acción ▶ independiente cuando esté lista: **Iniciar misión** para trabajo puntual o **Iniciar programación {id}** para una programación diaria.

**Crear nunca inicia el trabajo.** Una misión puntual queda preparada; una programación diaria queda pausada. Ni la creación ni guardar una descripción activan un temporizador. La creación tiene el ámbito del proyecto/Location seleccionado y fija los perfiles solicitados y la política de sesiones de tareas. La validación aparece junto al campo afectado; un rechazo que indique que no se envió nada deja el borrador disponible para corregirlo. El coordinador de una misión puntual también puede preparar una misión independiente para ti, como un seguimiento: aparece en la lista como **Preparada** y, como cualquier misión, solo se inicia desde su acción ▶.

### Guiones {#playbooks}

El selector **Guion** muestra justo debajo una descripción de una frase del guion seleccionado. **Ver detalles** abre el guion seleccionado en el lector central: sus pasos, sus roles y, plegadas al final, las instrucciones exactas en inglés que reciben sus agentes. [Guiones](playbooks.md) explica los pasos, roles y preguntas de cada guion, y lo que CodeNomad comprueba.

| Guion | Trabajo previsto |
| --- | --- |
| Misión flexible | El coordinador elige un plan con dependencias para el objetivo. |
| Depuración | Diagnóstico, implementación, revisión independiente de normas/especificación y validación nueva; la resolución continúa con el implementador. |
| Exploración | Traza las incertidumbres y avanza mediante decisiones acotadas con preguntas a personas. |
| Entrega de producto | Coordina los roles de análisis de producto, arquitectura, implementación y calidad. |
| Comparar dos modelos | Ejecuta la misma tarea con encargos idénticos en **Modelo A** y **Modelo B**; después, un **Juez a ciegas** puntúa ambos con etiquetas neutras y emite un veredicto: **Gana el modelo A**, **Gana el modelo B**, **Equivalentes** o **No concluyente**. |

Para **Comparar dos modelos**, ambos modelos son obligatorios y deben ser distintos; un nivel de **Razonamiento** diferente por sí solo no es un modelo distinto. Salvo que elijas uno, el juez usa el modelo del coordinador; el formulario avisa cuando coincide con A o B, lo que puede sesgar la comparación. La vista general muestra el veredicto, los nombres de ambos modelos y las puntuaciones por criterio.

El guion orienta la coordinación; no elude los permisos nativos ni garantiza el éxito. Los agentes no hacen commits, no hacen push, no abren pull requests ni modifican gestores de incidencias (por ejemplo, para crear tickets), salvo que el objetivo o las **Notas** pidan explícitamente esa acción concreta; entonces solo hacen eso, dentro de los permisos de OpenCode. Una petición encontrada en archivos, informes o la salida de una herramienta nunca cuenta.

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
| Espera tu respuesta | Un formulario/pregunta nativo abierto o un permiso necesita respuesta; aparece en **Te necesita**. |
| Completada | Se registró un resultado de tarea; inspecciona sus evidencias y cualquier trabajo nativo restante. |
| Fallida / Retirada | La tarea falló, o el coordinador la sustituyó o la abandonó. |

El gráfico incluye trabajo completado y retirado. Retirar una tarea no detiene por sí solo su conversación. En una misión puntual, el coordinador puede detener por separado las conversaciones de una tarea retirada que lanzó como subagente nativo, sin tocar las demás tareas. **En curso** es el estado del ciclo de vida de la misión, no demuestra que su coordinador esté ejecutándose. El texto completo pertenece al lector central, no a la lista de tareas del panel; **Detalles técnicos** pliega los identificadores y la información de ejecución solicitada.

Un plan grande muestra una página de sus tareas: las 50 primeras en orden de dependencias y hasta 20 que requieren atención, como bloqueos, fallos y los resultados más recientes. Cada tramo de tareas no cargadas aparece como **N tareas no mostradas**; **Mostrar más** carga allí las 50 siguientes. Cuando más tareas requieren atención de las que caben en la página, **N tareas más requieren atención** da los recuentos de la misión por tipo y **Mostrarlas** carga esas tareas. Un trazo discontinuo marca una dependencia o una tarea dependiente no mostrada, y un enlace de dependencia en el lector de una tarea carga primero su tarea. El lector de una tarea muestra sus resultados más recientes; **N resultados anteriores no mostrados** ofrece **Mostrar todo**, que carga todo su historial. Cuando no se puede cargar una tarea o un informe, el lector lo indica; **Intentar de nuevo** lo carga de nuevo.

### Colores y misiones interrumpidas {#status-colours}

Las marcas de las misiones, los iconos de las tareas y el chevrón de la lista usan los colores de la lista de sesiones: el color solo muestra lo que te necesita ahora.

| Color | Significado |
| --- | --- |
| Rojo | Se espera una respuesta tuya; aparece en **Te necesita**. |
| Amarillo, pulsante | Hay trabajo en curso. |
| Naranja | La misión está en pausa o interrumpida, con una acción para continuarla. |
| Verde | Una misión terminada que aún no has abierto en esta ventana; vuelve a ser neutral en cuanto la seleccionas. |
| Azul | Una misión preparada, lista para iniciarse como un prompt redactado. |

Todo lo demás es neutral, incluidas las tareas hechas o fallidas: los resultados están en el texto de estado y en los iconos. Con la lista contraída, su chevrón toma el más urgente de rojo, amarillo y verde entre las demás misiones; como en las sesiones contraídas, el naranja y el azul solo se muestran en sus propias filas.

Una misión está **Interrumpida** cuando su coordinador se detuvo sin concluir y no hay nada más en marcha. Una misión mostrada como **Fallida** también puede reanudarse. En ambos casos, el primer botón de la barra de herramientas pasa a ser **Recuperar la misión interrumpida**: pide al coordinador que reevalúe a partir del plan y los resultados guardados y, antes, reabre una misión fallida. Un coordinador no termina una misión puntual como fallida: cuando nada puede avanzar sin ti, te hace una pregunta en **Te necesita**. Solo tú detienes una misión.

### Preguntas y decisiones {#questions}

Solo el coordinador te hace preguntas. Las tareas y los subagentes que lanzan le devuelven sus preguntas abiertas, con las opciones, las evidencias y una recomendación. Antes de preguntar, el coordinador intenta resolver la cuestión por sí mismo: lee el proyecto, investiga, encarga una investigación a una tarea o adopta un valor por defecto fácil de deshacer y lo registra como supuesto. Solo pregunta lo que no puede resolver: tu consentimiento, credenciales, elecciones costosas de deshacer o decisiones de producto que el objetivo deja abiertas. Agrupa las preguntas pendientes en un solo formulario en **Te necesita** y antes pone en marcha el trabajo no relacionado.

En **Exploración**, las tareas de decisión preparan un resumen y el coordinador resuelve cada decisión: decide por sí mismo cuando las evidencias bastan y la elección es fácil de deshacer, deja la pregunta en las **Notas** para más adelante o te la hace. Con **Subagentes nativos**, el resultado de la tarea de decisión indica quién decidió:

| Etiqueta | Significado |
| --- | --- |
| **Decisión del coordinador** | El coordinador decidió sin preguntarte; el resultado muestra su justificación y las indicaciones para revertirla que haya dado. Para cambiarla, escribe al coordinador desde **Abrir conversación**. |
| **Tu respuesta** | Respondiste esta pregunta en el panel de interrupciones de CodeNomad. |

Solo una respuesta que des en el panel de interrupciones cuenta como **Tu respuesta**; un agente no puede responder por ti. Con **Subagentes nativos**, cada pregunta de decisión termina con la etiqueta de la única decisión que resuelve, por ejemplo `[decision choose-seam 3fa9c21b]`. Cuando se preguntan varias decisiones juntas, cada una es una pregunta aparte con su propia etiqueta; una pregunta que nombra dos decisiones no resuelve ninguna. Con **Sesiones independientes**, el coordinador registra en cambio cada resultado en las **Notas**, indicando si decidió él o tú. En **Entrega de producto**, un objetivo que ya describe con precisión el cambio de comportamiento cuenta como especificación aprobada; si no, el coordinador te pide que la apruebes y agrupa las aprobaciones pendientes.

### Informes de situación y solicitudes de actualización {#briefings}

El coordinador recibe instrucciones de publicar un informe de situación del proyecto tras su plan inicial, tras resolver tareas, al esperar a una persona y antes del informe final. Es una evaluación redactada, no un contador de actividad en vivo ni una señal periódica garantizada. Un aviso identifica cuándo el mapa ha cambiado desde ese informe.

Usa **Pedir una actualización** debajo de la barra de herramientas para solicitar una evaluación nueva del coordinador y lee después **Resumen**. **Actualización pedida…** significa que la solicitud está pendiente, no respondida. **Envío sin confirmar** no autoriza el reenvío automático: abre la conversación del coordinador antes de hacer una solicitud nueva independiente. Es una entrada nativa normal, no un entorno aislado de solo lectura; el coordinador conserva sus permisos habituales.

## Cómo circula el contexto en una misión {#context-flow}

El mapa de misión es la memoria compartida y duradera de la misión. Contiene el objetivo y las **Notas**, cada tarea con su **Brief de la tarea**, sus dependencias (**Depende de**) y su estado, los **Informes** registrados del trabajo terminado (resumen, **Pruebas**, **Siguientes pasos recomendados** y, si lo hay, **Informe estructurado**), los informes de situación del coordinador y los **Cambios del plan**. OpenCode lo guarda con el proyecto, así que sobrevive a las conversaciones y a los reinicios; Control de misión lo muestra y la recuperación parte de él. Cada participante recibe una parte definida:

| Participante | Qué recibe |
| --- | --- |
| Coordinador | El objetivo, las notas y las instrucciones del guion en cada turno. Lee el mapa completo siempre que lo necesita; su conversación guardada conserva cada resultado que ha leído, mientras OpenCode puede [compactar](history.md#compact-session) su contexto de modelo. |
| Tarea (**Subagentes nativos**) | Su asignación, que el coordinador pasa en una llamada normal a un subagente de OpenCode: el objetivo, el título y el encargo de la tarea, las instrucciones de su rol y las tareas de las que depende. El coordinador puede añadir contexto, como resultados anteriores. |
| Tarea (**Sesiones independientes**) | La misma asignación, como mensaje en su propia conversación. En cada turno recibe también el objetivo, las notas y sus asignaciones abiertas, y puede leer el mapa completo. |
| Ayudantes lanzados por una tarea | Lo que su padre escribe en la llamada. Los guiones indican a cada padre que pase el alcance, las restricciones y las reglas de seguridad que necesitan sus ayudantes. |

Los resultados vuelven por el mismo camino. Un subagente nativo devuelve su resultado a la conversación que lo lanzó, normalmente el coordinador, que lo registra como informe de la tarea. Una sesión independiente registra su propio informe, y CodeNomad entrega su resumen al coordinador como mensaje.

Una tarea posterior se apoya en el trabajo anterior de dos formas. Las dependencias ordenan el trabajo: el coordinador inicia una tarea cuando las tareas de las que depende están completadas y coloca los resultados pertinentes en el encargo o junto a la asignación; las sesiones independientes también pueden leer esos informes en el mapa. Para continuar la propia conversación de una tarea terminada, el coordinador declara una tarea de seguimiento que la reutiliza: el seguimiento continúa allí con el contexto actual de esa conversación, que OpenCode puede haber [compactado](history.md#compact-session), mientras los detalles anteriores siguen en su historial guardado para la búsqueda. El guion Depuración devuelve así ambas revisiones al implementador. Con **Sesiones independientes**, el coordinador también puede asignar una tarea a una conversación principal existente, que conserva su propio contexto, incluido trabajo anterior no relacionado. En los demás casos, una tarea empieza en una conversación nueva a partir de su asignación, y la transcripción de otra tarea le llega a través del coordinador o de una búsqueda. En **Comparar dos modelos**, la asignación y el contexto del juez omiten el objetivo y las notas; su encargo contiene los resultados anonimizados.

En una programación diaria, cada ejecución empieza con su propio coordinador y su propio mapa. Su primer mensaje contiene las instrucciones de la programación y el texto nuevo de usuario y asistente de sus [conversaciones seguidas](#daily-schedules) desde la última ejecución completada; los resultados de ejecuciones anteriores quedan en el historial de la programación. Las conversaciones lanzadas dentro de una ejecución pueden leer el mapa de esa ejecución. Una misión puntual nueva también empieza con un mapa nuevo: para trasladar resultados, escríbelos en su objetivo o en sus **Notas**, o deja que el coordinador prepare una misión de seguimiento, cuyo objetivo y notas redacta él.

### Buscar en conversaciones anteriores {#context-search}

Mientras CodeNomad está en ejecución, cada conversación de agente del proyecto, incluidos los coordinadores y las tareas de misiones, dispone de la herramienta de búsqueda de sesiones de CodeNomad (`codenomad.session_search`, usada mediante el Code Mode de OpenCode). Busca en las conversaciones guardadas de la carpeta del proyecto de la conversación con la misma clasificación que la [búsqueda](history.md#full-history-search) **Todo el espacio de trabajo**, y devuelve fragmentos breves con el título y el identificador de cada conversación, además de una forma de leer una conversación completa. Se aplican los permisos nativos de las herramientas. Un agente busca cuando lo decide o cuando el objetivo, las notas o tu mensaje se lo piden, por ejemplo para averiguar qué concluyó una misión o tarea anterior. Una ejecución diaria que se ejecuta con CodeNomad cerrado trabaja sin esta herramienta.

## Perfiles, delegación y profundidad {#profiles}

1. Usa el engranaje de Misiones o **Configuración → Misiones** para editar **Valores para nuevas misiones**.
2. En **Aplicar a**, elige **Todas las misiones** o un guion; después establece **Sesiones de tareas** y, en **Agentes y modelos**, una fila por rol (el coordinador y luego los roles del guion). Cada elección se guarda de inmediato; no hay botón Guardar.
3. En el ámbito de un guion, las filas muestran los valores globales marcados como **Global**. Cambiar un campo personaliza ese rol a partir de ellos; su icono de revertir vuelve a usar los valores globales. **Restablecer** (tras confirmar) borra solo los agentes y modelos del ámbito mostrado.
4. Durante la creación, usa **Opciones → Agentes y modelos** para solicitar perfiles específicos; **Usar valores predeterminados guardados** restaura los guardados.
5. Para límites de recursión nativa, edita **Profundidad de anidamiento de subsesiones → Profundidad impuesta para el proyecto**, aquí o en **Opciones** al crear. Pulsar Enter o salir del campo guarda un valor válido modificado; **Heredar** guarda de inmediato; Escape descarta un valor sin guardar.

| Ajuste | Ámbito y efecto |
| --- | --- |
| Valores para nuevas misiones | Valores de toda la configuración solo para misiones **nuevas**; una excepción de guion sustituye el valor general. |
| Agente / Modelo / Razonamiento | Selecciones solicitadas para coordinador/roles registradas al crear; un actor ocupado no se cambia silenciosamente para atender trabajo posterior. Las ejecuciones diarias reutilizan los perfiles solicitados fijados. |
| Subagentes nativos | Las sesiones de tareas usan agentes nativos subagent/all bajo el coordinador. |
| Sesiones independientes | Las sesiones de tareas declaradas usan agentes primary/all y conversaciones independientes; esto no desactiva los ayudantes nativos internos. |
| Profundidad de anidamiento de subsesiones | Configuración del proyecto para **todas** las conversaciones de OpenCode de allí, no solo Misiones. Vacío hereda: **Heredar** elimina la anulación del proyecto y el bloque `experimental` que deje vacío o solo con el valor Global de **Guardar las imágenes una sola vez**. OpenCode lee el bloque `experimental` del proyecto como un todo, así que otros ajustes experimentales que se conserven allí siguen ocultando la profundidad global. Por defecto, el subagente integrado **General** de OpenCode no puede lanzar subagentes, así que sus conversaciones nunca se anidan: guardar cualquier profundidad de proyecto también añade al mismo archivo una regla que permite a los subagentes lanzar sus propios subagentes hasta esa profundidad y prevalece sobre las restricciones de General de otros archivos de configuración (con una profundidad de 1, el límite de profundidad de OpenCode sigue impidiendo el anidamiento), y **Heredar** la quita. Bajo **Profundidad efectiva de OpenCode**, el editor indica si los subagentes General pueden anidarse. Guardar no recarga OpenCode ni cambia las conversaciones en ejecución. |

**Valor nativo predeterminado** y **Global** son distintos: el primero solicita los valores predeterminados propios de OpenCode; el segundo hereda la elección global; elegir los valores nativos en el ámbito de un guion sigue siendo una excepción explícita. Se comprueba la disponibilidad del catálogo; un perfil solicitado no demuestra qué perfil usa actualmente una conversación. Los permisos nativos y la profundidad configurada siguen rigiendo las llamadas a ayudantes internos en ambos modos de tareas.

Cada lista **Modelo** muestra lo mismo que el selector **Modelo** de la conversación, con los mismos nombres y agrupado por proveedor: se omiten los modelos ocultos y, mientras el filtrado de solo favoritos está activo, también los demás modelos (consulta [Visibilidad de modelos, favoritos y Razonamiento](providers.md#models)). También se omiten los modelos sin compatibilidad con herramientas. Un modelo guardado fuera de la lista sigue seleccionado. **No disponible** marca un modelo guardado que el selector no puede ofrecer ahora: falta en el catálogo actual del proyecto, está obsoleto o no admite herramientas.

Una elección rechazada o sin confirmar nunca se reenvía: se vuelven a mostrar los valores guardados, y **Recargar** solo aparece cuando no se pueden leer. Si un cambio de profundidad no está confirmado, tu valor se conserva; usa **Actualizar profundidad del proyecto** antes de otro cambio. No interpretes **Profundidad efectiva de OpenCode desconocida** como cero o desactivada.

## Reutilizar una descripción guardada {#saved-briefs}

1. Durante la creación, expande **Opciones → Empezar desde una descripción** y selecciona la descripción guardada.
2. Revisa el objetivo, las notas, el guion, los perfiles y la delegación copiados antes de **Crear**.
3. Usa **Guardar como descripción** para dar nombre a un borrador reutilizable. Una misión puntual seleccionada, incluso terminada, también ofrece **Guardar como descripción**.

Las descripciones guardan instrucciones y elecciones solicitadas, no planes de tareas, resultados, conversaciones, relojes de programación ni autoridad de ejecución. Cargar una rellena un borrador de creación normal; no inicia ni programa nada. Eliminar una descripción conserva las misiones/conversaciones existentes. **Configuración → Misiones → Descripciones guardadas** gestiona la biblioteca; si la biblioteca deja de poder leerse, **Restablecer la biblioteca guardada** (tras confirmar) elimina las descripciones guardadas, no las ejecuciones. Las programaciones no tienen acción para guardarlas como descripción.

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
| Pestaña de proyecto de CodeNomad | Cierra el proyecto en CodeNomad; las sesiones nativas siguen en OpenCode. Vuelve a abrir el proyecto para encontrarlas. |
| Ventana entera, salir de la aplicación o recargar el renderer | Conserva las conexiones de proyecto para restaurarlas; no detiene el trabajo nativo ni el servicio OpenCode. |
| Backend de CodeNomad | No detiene OpenCode. Una misión puntual en curso continúa: su coordinador, sus tareas como subagentes nativos y las herramientas de misión se ejecutan en OpenCode. Asignar tareas a sesiones independientes y entregar sus informes al coordinador, las misiones que prepara el coordinador, detener las conversaciones de una tarea retirada, la recuperación y el Control de misión esperan al backend, igual que continuar una misión puntual tras un reinicio del servicio OpenCode. |
| Programación diaria en ejecución | Su reloj y la ejecución de sus pasadas se ejecutan en el plugin/servicio OpenCode, incluso con la interfaz y el backend de CodeNomad cerrados. El equipo de ejecución y el servicio OpenCode deben seguir funcionando. |
| Reinicio del servicio OpenCode | Pierde los trabajos de programación locales del proceso. Una programación que debía ejecutarse pasa a **Interrumpido** hasta una **Reanudar** explícita; reabrir CodeNomad no la reactiva. |

Tras un reinicio, inspecciona la ejecución pendiente y elige **Reanudar** cuando estés listo. Reanudar reconcilia la ejecución existente sin enviar dos veces la entrada de su coordinador; no promete continuar un turno nativo interrumpido. Un turno cortado por un reinicio puede resolverse como terminado sin informe, con **Interrumpida por un reinicio**. No uses un reinicio para reintentar efectos secundarios de herramientas.

Las Misiones funcionan con las aplicaciones de escritorio y con un [servidor](server.md) CodeNomad independiente. Cuando el panel muestra **Control de misión no está disponible**, su mensaje indica la causa:

| Causa | Qué hacer |
| --- | --- |
| El espacio de trabajo de OpenCode no está listo | Vuelve a conectar el proyecto y actualiza. |
| OpenCode no ha cargado el plugin de Misiones | Actualiza en un momento; si persiste, usa **Recargar la configuración de OpenCode** en **Configuración → OpenCode**. |
| OpenCode no pudo cargar el plugin de Misiones | Lee su error en la lista de plugins y actualiza cuando esté corregido. |
| El servidor CodeNomad no pudo abrir su conexión local para las Misiones (127.0.0.1) | Revisa el registro del servidor; recargar OpenCode no ayuda. |

## Pausa, detención y resultados inciertos {#controls-recovery}

1. Selecciona la entrada e inspecciona su estado y conversación actuales antes de actuar.
2. Usa el icono de pausa para una suspensión reanudable, o el de detener y su confirmación para una detención terminal. Las etiquetas de misiones puntuales son **Pausar misión** y **Detener misión definitivamente**; las de programaciones nombran la programación.
3. Si el resultado no está confirmado, usa **Comprobar estado** / **Comprobar el estado del control** para leer el resultado existente. No emitas una acción de reemplazo para eludir la incertidumbre.
4. Para acciones puntuales, **Actualizar y reenviar la acción no confirmada** de la cabecera comprueba primero el estado y reenvía únicamente esa acción exacta aún no confirmada desde tu clic explícito.

Pausar una misión puntual deja terminar el trabajo en curso: el coordinador y sus subagentes completan el paso en el que están, no inician nada nuevo y se detienen, mientras el panel muestra **Pausando: los pasos en curso están terminando.** **Interrumpir ahora** los detiene en cambio de inmediato: interrumpe la familia nativa de la misión y suspende la coordinación. Detener también interrumpe, cancela las entradas/entregas familiares en cola y es terminal. Las interrupciones son acotadas: **Es posible que algunos subagentes sigan en ejecución.** significa que una está incompleta. Inspecciona el resultado conservado y usa su reintento explícito en lugar de suponer que se cancelaron todos los efectos de shells/herramientas. Reanudar informa al coordinador de lo que se pausó o interrumpió; este decide cómo continuar el trabajo.

Pausar/Detener una programación diaria cancela la programación y solicita interrumpir los actores raíz registrados, incluidos el coordinador y los especialistas independientes, pero **no demuestra que esas conversaciones ni sus descendientes se hayan detenido**. Inspecciona las familias nativas. Detener es terminal: una programación detenida no puede iniciarse, reanudarse ni ejecutarse ahora. **Comprobar pasada** reconcilia una ejecución pendiente sin volver a enviarla. Los fallos transitorios de comprobación programada muestran su último error y se reintentan automáticamente; perder la respuesta a un control del usuario no causa su reenvío automático.

Para un coordinador puntual inactivo sin informe, la acción principal ▶ puede verificarlo y recuperarlo; las tareas tienen recuperación específica de informes ausentes cuando cumplen las condiciones. La recuperación comprueba primero actividad nativa, descendientes y esperas; una actividad desconocida rechaza la admisión. No repite asignaciones ni reemplaza el plan. Abre las conversaciones para resolver preguntas, permisos, shells o trabajo en segundo plano pendientes.

Si **Crear** queda sin confirmar, la ventana conserva la solicitud enviada y desactiva nuevas creaciones para ese proyecto; la eliminación de worktrees puede permanecer bloqueada. Actualizar solo lee el estado. Cerrar/reabrir el editor no lo repara. Antes de recargar la ventana, inspecciona la lista de misiones: recargar borra el bloqueo local, **no demuestra que la creación fallara**. No crees a ciegas un duplicado tras recargar o reiniciar.

## Editar, eliminar y limpiar conversaciones {#cleanup}

Usa **Editar la misión seleccionada** en una misión puntual editable; ante un conflicto, cierra/reabre el editor para cargar la revisión actual en lugar de sobrescribirla. Si el objetivo o las notas cambian mientras el formulario aún carga, indica que la misión cambió desde que la abriste en lugar de rellenarlos; elige **Volver a abrir** para editar la versión actual. Las programaciones diarias no ofrecen controles de edición/eliminación.

1. Para una misión puntual que ya no necesites, elige **Eliminar la misión seleccionada…** y revisa la confirmación.
2. Opcionalmente, selecciona **Eliminar también las conversaciones de especialistas creadas para esta misión** antes de confirmar.
3. Comprueba **Limpieza de conversaciones** para ver los recuentos de eliminadas/conservadas/pendientes. Reintenta solo la limpieza restante registrada si se ofrece.

Eliminar una misión no equivale a detenerla; usa Detener e inspecciona primero el trabajo restante. Se conservan los coordinadores y las conversaciones reutilizadas. También pueden conservarse especialistas compartidos, movidos, con hijos o cuya propiedad no se pueda verificar. La limpieza parcial no se revierte ni se completa silenciosamente en segundo plano. El lector general conserva las 20 limpiezas completadas más recientes. Eliminar misiones libera su almacenamiento en el proyecto: las misiones eliminadas más antiguas se borran automáticamente.

Consulta [Permisos](permissions.md), [Conversaciones](conversations.md) y [configuración de OpenCode](opencode.md) para el trabajo nativo y los controles del servicio.
