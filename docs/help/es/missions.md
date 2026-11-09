# Misiones

La ejecución actual de una programación diaria o nativa usa el mismo árbol de tareas paginado y los mismos lectores de contenido exacto. Cargue explícitamente más tareas o actividad; las solicitudes no observadas siguen siendo desconocidas. Los lectores de resumen, tareas, informes, partes de situación y cambios del plan permanecen vinculados a la ejecución seleccionada. Los resultados guardados conservan sus identidades originales de ejecución e informe cuando comienza otra ejecución.

Para un campo guardado demasiado grande, elija **Leer páginas de JSON sin procesar**. **Página anterior** y **Página siguiente** leen partes exactas y acotadas; si cambia la colección, **Intentar de nuevo** vuelve a la primera página.

La lista carga automáticamente más misiones y programaciones al acercarse al final y conserva las páginas anteriores. Los estados de las misiones cargadas también se actualizan automáticamente. La búsqueda filtra solo las misiones cargadas. Solo las misiones seleccionadas o abiertas en el lector cargan sus detalles. El historial de limpieza y los detalles de actores conservan sus propias continuaciones; los actores y solicitudes sin leer siguen siendo desconocidos. **Leer campos guardados** permite consultar páginas exactas de actores, informes, historial, recibos y metadatos. Una ventana fallida conserva la última vista; **Intentar de nuevo** la relee, y una colección cambiada vuelve a la primera ventana. Leer no inicia trabajo. Las finalizaciones históricas se reconocen una sola vez mediante el contador duradero; las nuevas permanecen sin ver hasta mostrarse.

Las Misiones combinan un plan de proyecto duradero con conversaciones nativas de OpenCode. El coordinador planifica y delega; el árbol de tareas registra dependencias y resultados. Un plan guardado, una entrada admitida y una ejecución observada son hechos distintos.

## Crear y después iniciar explícitamente {#create}

1. Abre **Misiones** en el panel derecho y elige **Crear misión**. El formulario sustituye el árbol de misiones hasta que crees o canceles.
2. Si quieres, elige arriba **Empezar desde una configuración**; revisa **¿Qué debe hacer la misión?**, **Notas** y **Título** (hasta 60 caracteres). La carga sustituye objetivo, notas y título; este se deriva del nombre de la configuración y puedes editarlo después.
3. El formulario compacto muestra directamente **Guion**, **Notas**, **Agentes y modelos**, **Sesiones de tareas**, **Profundidad de subagentes**, conversaciones seguidas y **Programación**. Con **Comparar dos modelos**, revisa también **Modelo A** y **Modelo B**.
4. **Lanzar cuando** empieza con **Una vez, ahora**. **Añadir un criterio** combina horarios y eventos; su orden determina **o**, **si** y **si no**.
5. Deja **Iniciar al crear** desactivado para guardar una misión en pausa e iniciarla después con ▶ **Iniciar**. Actívalo para solicitar el mismo inicio protegido tras confirmar la creación y elige **Crear**.

**Iniciar al crear está desactivado por defecto.** Primero se guarda una Misión en pausa en el proyecto/Location seleccionado, con los perfiles y la política de sesiones solicitados. El inicio posterior usa las comprobaciones normales de Play y la confirmación de ajustes nativos cuando corresponda. Si se pierde la confirmación de creación, leer su recibo deja el inicio manual. La validación aparece junto al campo; un rechazo sin envío conserva el borrador. Un seguimiento del coordinador aparece como **Preparada** y se inicia desde su propia acción ▶.
Si aún se está identificando el proyecto, la programación creada queda en pausa; usa ▶ **Iniciar** en la barra de herramientas cuando el proyecto esté listo.

Las misiones puntuales guardadas conservan sus controles de ejecución, árbol de tareas, conversaciones e informes finales. Las programaciones diarias existentes siguen en la lista con sus controles diarios y sus [reglas horarias diarias](#existing-daily-schedules). Selecciona la entrada y usa los controles disponibles para ese objeto.

### Guiones {#playbooks}

El **ⓘ** junto a **Guion** abre la guía en tu idioma en la sección del guion seleccionado. [Guiones](playbooks.md) explica sus pasos, roles y preguntas, y lo que CodeNomad comprueba.

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

1. Como en la lista de sesiones, el chevrón de una fila muestra u oculta sus tareas, y un clic selecciona una fila: una misión o una de sus tareas. Las acciones de la selección están en la segunda línea del encabezado. Una misión sin tareas no tiene chevrón. **Filtrar misiones** acota las demás filas.
2. Pulsa **Resumen** (ojo) para leer la selección en el lector central: la vista general de una misión, o el resultado, encargo y evidencias exactos de una tarea. Mientras está pulsado, el lector sigue lo que seleccionas; púlsalo de nuevo para volver a la conversación. Con una tarea seleccionada, las acciones del encabezado se aplican a esa tarea, con **Abrir la conversación de la tarea** y, si falta su informe, **Verificar y recuperar el informe faltante**.
3. **Más acciones** (⋯) agrupa **Pedir una actualización**, **Interrumpir ahora**, **Guardar configuración** y **Editar la misión seleccionada**; las acciones que no corresponden quedan desactivadas.
4. Sigue los enlaces de dependencias y los **Informes**; usa **Abrir conversación** para el coordinador cuando necesites su transcripción.
5. Cuando una misión o una de sus tareas se pone en rojo, selecciónala: se abre la conversación que pregunta, con su pregunta en el panel de interrupciones.

| Indicador | Qué demuestra |
| --- | --- |
| Asignada | Se admitió la entrada; no se demuestra que el modelo la haya consumido, trabajado o completado. |
| Activa | Se observó actividad nativa. |
| En espera | Las dependencias declaradas aún no se cumplen. |
| Bloqueada | Se informó de un bloqueo, no necesariamente una pregunta para ti. |
| Espera tu respuesta | Un formulario/pregunta nativo abierto o un permiso necesita respuesta; selecciona la tarea para abrirlo. |
| Completada | Se registró un resultado de tarea; inspecciona sus evidencias y cualquier trabajo nativo restante. |
| Fallida / Retirada | La tarea falló, o el coordinador la sustituyó o la abandonó. |

El gráfico incluye trabajo completado y retirado. Retirar una tarea no detiene por sí solo su conversación. En una misión puntual, el coordinador puede detener por separado las conversaciones de una tarea retirada que lanzó como subagente nativo, sin tocar las demás tareas. **En curso** es el estado del ciclo de vida de la misión, no demuestra que su coordinador esté ejecutándose. El texto completo pertenece al lector central, no a la lista de tareas del panel; **Detalles técnicos** pliega los identificadores y la información de ejecución solicitada.

Un plan grande carga más tareas automáticamente al desplazarse. Las páginas anteriores se conservan en caché; Virtua solo renderiza filas cercanas a la vista y mantiene montadas la tarea enfocada y la seleccionada. Volver a una parte cargada no vuelve a descargarla. El icono **Tareas** da los recuentos de atención de toda la misión cuando corresponde. Las lecturas de fondo animan **Actualizar** arriba a la derecha sin mover la posición de lectura. Un trazo discontinuo marca una dependencia o tarea dependiente sin cargar; los enlaces del lector cargan su destino directamente. El lector ofrece **Mostrar todo** para los resultados anteriores e **Intentar de nuevo** tras un fallo de lectura.

Las páginas de tareas aparecen solo cuando se han recibido por completo. Si falla o cambia una lectura, se conservan las últimas tareas mostradas. Si la lista cambia durante la lectura, usa **Actualizar** y después **Intentar de nuevo**; la página se lee de nuevo desde el principio. Una parte que falta nunca demuestra que una tarea o solicitud esté ausente, y reintentar una lectura no inicia trabajo. Si el plugin de Misiones no puede proporcionar la página, vuelve a intentarlo tras reconectar o recargar el plugin.

### Colores y misiones interrumpidas {#status-colours}

Las banderas de las misiones y los iconos de las tareas usan los colores de la lista de sesiones: el color solo muestra lo que te necesita ahora. Una misión recurrente muestra un icono de repetición en lugar de la bandera.

| Color | Significado |
| --- | --- |
| Rojo | Se espera una respuesta tuya. La bandera de una misión se pone en rojo por una pregunta de su coordinador, una tarea por la suya propia, y el chevrón de la misión indica que una de sus tareas pregunta. Selecciona la misión o la tarea en rojo para abrir la pregunta. |
| Amarillo, pulsante | Hay trabajo en curso. |
| Naranja | La misión está en pausa o interrumpida, con una acción para continuarla. |
| Verde | Una misión terminada o una tarea finalizada que aún no has visto en esta ventana, y el chevrón de una misión con una tarea así. Vuelve a ser neutral en cuanto la seleccionas; haz clic en un icono de tarea verde, o arrastra sobre varios, para marcarlos como vistos. Haz clic derecho en el chevrón de una misión y elige **Marcar como leído** para marcar como vistas la misión y todas sus tareas a la vez. |
| Azul | Una misión preparada, lista para iniciarse como un prompt redactado, o una tarea que aún no ha empezado. |

Todo lo demás es neutral, incluidas las tareas hechas o fallidas: los resultados están en el texto de estado y en los iconos.

Una misión está **Interrumpida** cuando su coordinador se detuvo sin concluir y no hay nada más en marcha. Una misión mostrada como **Fallida** también puede reanudarse. En ambos casos, el primer botón de la barra de herramientas pasa a ser **Recuperar la misión interrumpida**: pide al coordinador que reevalúe a partir del plan y los resultados guardados y, antes, reabre una misión fallida. Un coordinador no termina una misión puntual como fallida: cuando nada puede avanzar sin ti, te hace una pregunta y su fila se pone en rojo. Solo tú detienes una misión.

### Preguntas y decisiones {#questions}

Solo el coordinador te hace preguntas. Las tareas y los subagentes que lanzan le devuelven sus preguntas abiertas, con las opciones, las evidencias y una recomendación. Antes de preguntar, el coordinador intenta resolver la cuestión por sí mismo: lee el proyecto, investiga, encarga una investigación a una tarea o adopta un valor por defecto fácil de deshacer y lo registra como supuesto. Solo pregunta lo que no puede resolver: tu consentimiento, credenciales, elecciones costosas de deshacer o decisiones de producto que el objetivo deja abiertas. Agrupa las preguntas pendientes en un solo formulario, que se abre desde la fila roja de la misión, y antes pone en marcha el trabajo no relacionado.

En **Exploración**, las tareas de decisión preparan un resumen y el coordinador resuelve cada decisión: decide por sí mismo cuando las evidencias bastan y la elección es fácil de deshacer, deja la pregunta en las **Notas** para más adelante o te la hace. Con **Subagentes nativos**, el resultado de la tarea de decisión indica quién decidió:

| Etiqueta | Significado |
| --- | --- |
| **Decisión del coordinador** | El coordinador decidió sin preguntarte; el resultado muestra su justificación y las indicaciones para revertirla que haya dado. Para cambiarla, escribe al coordinador desde **Abrir conversación**. |
| **Tu respuesta** | Respondiste esta pregunta en el panel de interrupciones de CodeNomad. |

Solo una respuesta que des en el panel de interrupciones cuenta como **Tu respuesta**; un agente no puede responder por ti. Con **Subagentes nativos**, cada pregunta de decisión termina con la etiqueta de la única decisión que resuelve, por ejemplo `[decision choose-seam 3fa9c21b]`. Cuando se preguntan varias decisiones juntas, cada una es una pregunta aparte con su propia etiqueta; una pregunta que nombra dos decisiones no resuelve ninguna. Con **Sesiones independientes**, el coordinador registra en cambio cada resultado en las **Notas**, indicando si decidió él o tú. En **Entrega de producto**, un objetivo que ya describe con precisión el cambio de comportamiento cuenta como especificación aprobada; si no, el coordinador te pide que la apruebes y agrupa las aprobaciones pendientes.

### Informes de situación y solicitudes de actualización {#briefings}

El coordinador recibe instrucciones de publicar un informe de situación del proyecto tras su plan inicial, tras resolver tareas, al esperar a una persona y antes del informe final. Es una evaluación redactada, no un contador de actividad en vivo ni una señal periódica garantizada. Un aviso identifica cuándo el mapa ha cambiado desde ese informe.

Usa **Pedir una actualización** en **Más acciones** (⋯) para solicitar una evaluación nueva del coordinador y lee después **Resumen**. **Actualización pedida…** significa que la solicitud está pendiente, no respondida. **Envío sin confirmar** no autoriza el reenvío automático: abre la conversación del coordinador antes de hacer una solicitud nueva independiente. Es una entrada nativa normal, no un entorno aislado de solo lectura; el coordinador conserva sus permisos habituales.

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

Cada pasada programada empieza con su propio coordinador y mapa de misión, usando sus instrucciones guardadas y entradas fijadas. Las conversaciones seguidas aportan una cantidad acotada de texto nuevo de usuario y asistente; sus cursores de consumo avanzan tras una pasada exitosa. Las pasadas anteriores permanecen en el historial de la programación. Las conversaciones lanzadas dentro de una pasada pueden leer su mapa. Una misión puntual nueva tiene un mapa independiente: pon los resultados que quieras trasladar en su objetivo o sus **Notas**, o pide al coordinador que prepare un seguimiento con ese contexto.

### Buscar en conversaciones anteriores {#context-search}

Mientras CodeNomad está en ejecución, cada conversación de agente del proyecto, incluidos los coordinadores y las tareas de misiones, dispone de la herramienta de búsqueda de sesiones de CodeNomad (`codenomad.session_search`, usada mediante el Code Mode de OpenCode). Busca en las conversaciones guardadas de la carpeta del proyecto de la conversación con la misma clasificación que la [búsqueda](history.md#full-history-search) **Todo el espacio de trabajo**, y devuelve fragmentos breves con el título y el identificador de cada conversación, además de una forma de leer una conversación completa. Se aplican los permisos nativos de las herramientas. Un agente busca cuando lo decide o cuando el objetivo, las notas o tu mensaje se lo piden, por ejemplo para averiguar qué concluyó una misión o tarea anterior. Una pasada programada que se ejecuta con CodeNomad cerrado trabaja sin esta herramienta.

## Perfiles, delegación y profundidad {#profiles}

Guardar una profundidad conserva las programaciones nativas activadas en la configuración del proyecto. Un `schedules:false` explícito del proyecto sigue desactivado; eliminar la profundidad conserva el ajuste de programación. Los archivos JSON y JSONC en conflicto deben resolverse antes de guardar los ajustes nativos.

1. Usa el engranaje de Misiones o **Configuración → Misiones** para editar **Valores para nuevas misiones**.
2. En **Aplicar a**, elige **Todas las misiones** o un guion; después establece **Sesiones de tareas** y, en **Agentes y modelos**, una fila por rol (el coordinador y luego los roles del guion). Cada elección se guarda de inmediato; no hay botón Guardar.
3. En el ámbito de un guion, las filas muestran los valores globales marcados como **Global**. Cambiar un campo personaliza ese rol a partir de ellos; su icono de revertir vuelve a usar los valores globales. **Restablecer** (tras confirmar) borra solo los agentes y modelos del ámbito mostrado.
4. Durante la creación, usa **Agentes y modelos** para solicitar perfiles específicos; **Usar valores predeterminados guardados** restaura los guardados.
5. Elige una **Profundidad de subagentes**, aquí o en los controles de delegación del formulario: **Heredar** (con la profundidad heredada cuando se conoce) o de 1 a 10. Se guarda de inmediato. El icono de información indica la profundidad efectiva, el anidamiento y los archivos de configuración.

| Ajuste | Ámbito y efecto |
| --- | --- |
| Valores para nuevas misiones | Valores de toda la configuración solo para misiones **nuevas**; una excepción de guion sustituye el valor general. |
| Agente / Modelo / Razonamiento | Selecciones solicitadas para coordinador/roles registradas al crear; un actor ocupado no se cambia silenciosamente para atender trabajo posterior. Las pasadas programadas usan sus perfiles solicitados guardados; los cambios se aplican a futuras pasadas. |
| Subagentes nativos | Las sesiones de tareas usan agentes nativos subagent/all bajo el coordinador. |
| Sesiones independientes | Las sesiones de tareas declaradas usan agentes primary/all y conversaciones independientes; esto no desactiva los ayudantes nativos internos. |
| Profundidad de subagentes | Configuración del proyecto para **todas** las conversaciones de OpenCode de allí, no solo Misiones. **Heredar** elimina la anulación del proyecto y el bloque `experimental` que deje vacío o solo con el valor Global de **Guardar las imágenes una sola vez**. Mientras un bloque `experimental` vacío del proyecto oculte la profundidad heredada, el menú muestra **Predeterminado de OpenCode** hasta que elijas **Heredar**. OpenCode lee el bloque `experimental` del proyecto como un todo, así que otros ajustes experimentales que se conserven allí siguen ocultando la profundidad global. Por defecto, el subagente integrado **General** de OpenCode no puede lanzar subagentes, así que sus conversaciones nunca se anidan: guardar cualquier profundidad de proyecto también añade al mismo archivo una regla que permite a los subagentes lanzar sus propios subagentes hasta esa profundidad y prevalece sobre las restricciones de General de otros archivos de configuración (con una profundidad de 1, el límite de profundidad de OpenCode sigue impidiendo el anidamiento), y **Heredar** la quita. El icono de información indica si los subagentes General pueden anidarse. Si el proyecto define General en el formato heredado con un único valor `permission`, o con `task` y `subagent` ya definidos, solo se guarda la profundidad y una advertencia bajo el menú lo indica: permite tú mismo los subagentes para General en ese archivo. Guardar no recarga OpenCode ni cambia las conversaciones en ejecución. |

**Valor nativo predeterminado** y **Global** son distintos: el primero solicita los valores predeterminados propios de OpenCode; el segundo hereda la elección global; elegir los valores nativos en el ámbito de un guion sigue siendo una excepción explícita. Se comprueba la disponibilidad del catálogo; un perfil solicitado no demuestra qué perfil usa actualmente una conversación. Los permisos nativos y la profundidad configurada siguen rigiendo las llamadas a ayudantes internos en ambos modos de tareas.

Las misiones iniciadas por agentes usan **Valores para nuevas misiones** para lo que el agente omita cuando el proyecto está abierto en CodeNomad. Si CodeNomad está cerrado o el proyecto no está abierto en él, usan los valores propios de OpenCode para esas opciones. Las elecciones explícitas del agente tienen prioridad y los reintentos conservan las originales aunque cambies los valores predeterminados. Si CodeNomad puede leer tus valores pero no son válidos, se rechaza la creación hasta que los corrijas.

Cada lista **Modelo** muestra lo mismo que el selector **Modelo** de la conversación, con los mismos nombres y agrupado por proveedor: se omiten los modelos ocultos y, mientras el filtrado de solo favoritos está activo, también los demás modelos (consulta [Visibilidad de modelos, favoritos y Razonamiento](providers.md#models)). También se omiten los modelos sin compatibilidad con herramientas. Un modelo guardado fuera de la lista sigue seleccionado. **No disponible** marca un modelo guardado que el selector no puede ofrecer ahora: falta en el catálogo actual del proyecto, está obsoleto o no admite herramientas.

Una elección rechazada o sin confirmar nunca se reenvía: se vuelven a mostrar los valores guardados, y **Recargar** solo aparece cuando no se pueden leer. Si un cambio de profundidad no está confirmado, tu valor se conserva; usa **Actualizar profundidad del proyecto** antes de otro cambio. No interpretes **Profundidad efectiva de OpenCode desconocida** como cero o desactivada.

## Reutilizar una configuración guardada {#saved-briefs}

1. Elige arriba **Empezar desde una configuración**. Sustituye objetivo, notas y título; el título se deriva del nombre de la configuración. Puedes editar los campos después.
2. Revisa el objetivo, las notas, el guion, los perfiles y la delegación copiados antes de **Crear**.
3. Usa **Guardar configuración** para dar nombre a un borrador reutilizable. Una misión puntual seleccionada, incluso terminada, también ofrece **Guardar configuración** en **Más acciones** (⋯).

Las configuraciones guardan instrucciones, guion y elecciones de perfiles y delegación. Los planes, resultados, conversaciones, horarios y permisos de ejecución permanecen en sus misiones. Cargar rellena un borrador; revisa aparte la programación e **Iniciar al crear**. Eliminar conserva las misiones y conversaciones. **Configuración → Misiones → Configuraciones guardadas** gestiona la biblioteca; **Restablecer la biblioteca de configuraciones** elimina las configuraciones tras confirmar y conserva las ejecuciones. Las programaciones no ofrecen guardar configuración.

## Programación, recuperación y conversaciones seguidas {#daily-schedules}

### Programación nativa {#native-scheduling}

El **ⓘ** junto a **Lanzar cuando** muestra una ayuda al pasar el puntero o enfocarlo con el teclado. Haz clic, tócalo o pulsa Intro para abrir [Programación nativa](missions.md#native-scheduling) en el navegador, en el idioma de tu interfaz.

**Programación** está visible al crear y editar. **Lanzar cuando** empieza con **Una vez, ahora**, la primera opción de horario. Es una fuente de horario normal: combínala con otros horarios (**o**), con un evento posterior como condición (**si**) o después de eventos como alternativa (**si no**). **Añadir un criterio** añade y × elimina. Las misiones se ejecutan mientras OpenCode funciona. Los horarios civiles usan la zona del sistema; **Zona horaria guardada (IANA)** aparece si difiere.

**Una vez, ahora** ofrece una sola oportunidad, anclada cuando Play activa el horario, en vez de al abrir el formulario o guardarlo. Evento antes de ahora es una alternativa; ahora antes de evento es condicional. Una condición bloqueante puede consumir esa única oportunidad sin iniciar nada. Usa recurrencia o un evento desencadenante para tener oportunidades posteriores.

| Horario | Momento |
| --- | --- |
| Cada N horas | Cada 1, 2, 3, 4, 6, 8 o 12 horas, en punto, en la zona guardada. |
| Todos los días | Una hora civil en la zona guardada. |
| Días de la semana elegidos | Una hora en los días marcados. |
| Un día de cada mes | El día 1–31 a la hora elegida; se omiten los meses sin ese día. |
| Avanzado (cron) | Una expresión cron nativa, como máximo una vez por minuto. |

Añade varios horarios para varias horas, como 09:15 y 17:45. Los atajos civiles usan cron; las expresiones reconocidas se reabren como su atajo. Los [eventos](#scheduling-conditions) son los demás criterios: los eventos que lanzan la misión se comprueban cada 15 minutos, sin frecuencia que ajustar; las condiciones se leen en los momentos que las necesitan.

Entre dos tarjetas, un pequeño conector muestra cómo se combinan: **o** entre dos horarios o dos eventos, **si** de un horario a un evento, **si no** de un evento a un horario. Los eventos al principio lanzan la misión cada vez que ocurren; los horarios al principio la lanzan a sus horas. Los eventos tras horarios son sus condiciones: en cada una de esas horas, la misión solo se lanza si alguno de ellos ocurrió desde la última pasada exitosa; si no, esa hora se omite. Los horarios tras eventos son un respaldo para todo lo que está encima: en cada una de sus horas, un horario de respaldo solo lanza si las tarjetas de encima no lanzaron ninguna pasada desde su hora anterior (o desde que se configuró); **Ejecutar ahora** también cuenta, y también una pasada fallida. Los eventos tras él condicionan solo ese respaldo. Por ejemplo, nuevos commits, luego 18:00, luego nuevos mensajes, luego 20:00 lanza con cada commit; si no, a las 18:00 si hubo mensajes nuevos; si no, a las 20:00. Arrastra una tarjeta por su asa para cambiar el orden, o enfoca el asa y pulsa Alt+Flecha arriba o Alt+Flecha abajo; los conectores se actualizan.

Una pasada en curso nunca se duplica. Los horarios o eventos que ocurren mientras se ejecuta se agrupan en una sola pasada, lanzada al terminar, si habrían lanzado la misión a su propia hora: sus condiciones y respaldos se deciden entonces.

Los horarios civiles siguen la zona guardada y las reglas de horario de verano de OpenCode. Se rechaza un calendario sin ningún horario futuro.

Tras una interrupción, la programación nativa entrega como máximo una pasada de recuperación antes de volver a los horarios futuros. Usa el horario nativo vencido registrado, que puede preceder a otros horarios perdidos. Todos los horarios comparten esta recuperación y la misma protección contra solapamientos. Una pasada sin resolver se reconcilia con sus identidades de conversación y mensaje originales antes de que pueda empezar otra. Reanudar una programación pausada explícitamente usa su próximo horario futuro.

### Eventos y fuentes {#scheduling-conditions}

Un criterio de evento indica su fuente en este proyecto: **Otra programación tiene éxito**, **Nuevos commits en una rama local**, **Una Misión única termina con éxito**, **Nuevo mensaje en una conversación seguida** o **Cambios en archivos explícitos**. Se pueden listar varios eventos, incluidas dos ramas; basta con uno. Cada nuevo cambio que cumpla puede volver a lanzarla.

El primer inicio establece la referencia inicial. Reanudar la conserva, incluidos los cambios observados tras una pausa. Las fuentes de éxito exigen un resultado exitoso verificado y una familia nativa resuelta. Las comprobaciones de ramas usan commits locales y su ascendencia sin obtener datos remotos. Las comprobaciones de conversaciones esperan mensajes nuevos completos y estables, y excluyen las activaciones técnicas y las propias conversaciones de la pasada. Los archivos usan hasta 128 rutas explícitas relativas al proyecto, una por línea; se rechazan los patrones recursivos y las rutas enlazadas. Una fuente ausente, movida, ambigua o que supere la capacidad bloquea la admisión con una explicación. Los cambios entre comprobaciones necesitan dejar una huella duradera en la fuente para detectarse.

Los cambios observados juntos se agrupan. Una pasada fija las evidencias observadas de las fuentes; la resolución exitosa consume esa instantánea y deja los cambios posteriores para una comprobación futura. Una pasada fallida conserva su punto de control de la fuente y exige intervención. **Conversaciones seguidas (opcional)** aporta contexto independientemente de elegir un evento de mensaje de conversación.

### Recuentos y programaciones guardadas {#scheduling-limits}

Las programaciones no tienen fecha de fin. Una programación guardada con fecha de fin la sigue respetando hasta que la edites; guardar una edición quita la fecha de fin. Un horario registrado antes de ese final puede llegar tarde tras una larga interrupción. Una pasada ya admitida sigue siendo observable a través de su resultado.

**Pasadas iniciadas** cuenta cada pasada una vez cuando se admite la primera entrada de su coordinador, incluidas **Ejecutar ahora** y una pasada que luego falla. Las comprobaciones, los eventos sin cambios y las activaciones rechazadas no cuentan. Los recuentos se conservan tras ediciones y reinicios.

Una programación guardada con una frecuencia y una condición opcional se abre como criterios: la frecuencia se convierte en horarios colocados primero, una condición tras una frecuencia se coloca después de ellos y se convierte en su condición (**si**), y una condición sola se convierte en el evento que lanza la misión; reabrirla y guardarla sin cambios conserva exactamente la programación guardada, incluido un único lanzamiento con ese evento; guardar una edición quita ese límite de un solo lanzamiento, de modo que el evento lanza la misión cada vez que ocurre. Un intervalo, un retraso, una fecha única, un número máximo de pasadas o un final tras un número de horas sigue funcionando tal como se guardó y se muestra en **Política de programación guardada** hasta que la reemplaces.

La programación nativa seleccionada muestra **Estado deseado**, **Calendario nativo**, **Próxima activación** o **Próxima comprobación**, **Comprobaciones** con **Seguimiento desde…**, **Pasadas iniciadas**, **Pasadas exitosas**, su final y **Ejecuciones anteriores**. Lee una pasada anterior mediante **Abrir conversación**. **Programación terminada** describe el final de la programación; inspecciona por separado el resultado de la pasada. Se conservan los últimos 30 resultados; los recuentos acumulados persisten más allá de esa ventana. **Cargar más Missions** carga la siguiente página de objetos guardados.

La lista resume cada criterio en orden, precedido a partir del segundo por su conector (**o**, **si** o **si no**); el detalle muestra una fecha de fin guardada solo si está definida, y **Comprobaciones** solo con eventos.

### Programaciones diarias existentes {#existing-daily-schedules}

Las programaciones diarias existentes usan la zona IANA y la hora civil guardadas. Cada ejecución tiene su propio coordinador y mapa de misión; selecciona su árbol de tareas actual o una fecha/resultado anterior para leerlo en el centro. Su historial conservado contiene 30 resultados. Las siguientes reglas diarias se aplican a estas entradas:

| Situación | Comportamiento de la programación |
| --- | --- |
| Varios días vencidos omitidos | Ejecuta solo el último día vencido posterior al marcador diario resuelto, no una cola por cada día omitido. |
| Salto al adelantar la hora | Avanza hasta el primer minuto válido posterior; un salto al final del día cruza el límite del día. |
| Hora del reloj repetida | Usa la primera aparición; no crea una segunda ejecución diaria. |
| Día civil omitido por completo | No existe ejecución para ese día. |
| El reloj retrocede | No hace que un día ya procesado vuelva a vencer. |
| Una ejecución existente sigue pendiente | No la solapa con una ejecución diaria nueva. |

La fecha de creación también acota el trabajo diario admisible. **Ejecutar ahora**, cuando se ofrece en una entrada diaria existente, inicia una ejecución manual independiente bajo la protección de ejecuciones pendientes y conserva su reloj diario. La próxima hora mostrada es una proyección sujeta a la disponibilidad del servicio y del equipo de ejecución.

**Conversaciones seguidas (opcional)** añade contexto acotado de conversaciones elegidas. Solo una ejecución completada avanza sus cursores de mensajes procesados; una ejecución fallida/interrumpida no consume silenciosamente ese contexto. Si las instrucciones más el contexto superan la capacidad, acorta las instrucciones o retira conversaciones seguidas en lugar de suponer que se lee un historial ilimitado.

## Duración y reinicios del servicio {#lifetime}

El **i** junto a **Detalles técnicos** explica la actividad técnica y los costes.

En una programación nativa, despliega **Detalles técnicos** para identificar su **Portador principal** y su **Portador de reconciliación**, sus calendarios nativos y cualquier **Limpieza pendiente de reconciliación**. Estas conversaciones técnicas no ofrecen una acción de composición y quedan fuera de los selectores habituales de conversaciones y fuentes. Las activaciones técnicas, los títulos y la compactación usan el modelo local sin solicitudes HTTP a los proveedores; los eventos y estadísticas nativos aún pueden incluirlos, mientras que las pasadas reales mantienen sus costes de modelo habituales. La compactación limita el contexto procesado y conserva la identidad de la conversación y del calendario. Los mensajes y eventos nativos almacenados pueden acumularse hasta la limpieza explícita de una programación terminada; los 30 resultados de Mission conservados son independientes. El icono de información de **Profundidad de subagentes** muestra la ruta bajo **Archivo de configuración de OpenCode:** cuando está disponible y nombra por separado el **Destino de escritura del proyecto**.

| Componente | Qué significa cerrarlo |
| --- | --- |
| Pestaña de proyecto de CodeNomad | Cierra el proyecto en CodeNomad; las sesiones nativas siguen en OpenCode. Vuelve a abrir el proyecto para encontrarlas. |
| Ventana entera, salir de la aplicación o recargar el renderer | Conserva las conexiones de proyecto para restaurarlas; no detiene el trabajo nativo ni el servicio OpenCode. |
| Backend de CodeNomad | No detiene OpenCode. Una misión puntual en curso continúa: su coordinador, sus tareas como subagentes nativos y las herramientas de misión se ejecutan en OpenCode. Asignar tareas a sesiones independientes y entregar sus informes al coordinador, las misiones que prepara el coordinador, detener las conversaciones de una tarea retirada, la recuperación y el Control de misión esperan al backend, igual que continuar una misión puntual tras un reinicio del servicio OpenCode. |
| Programación nativa activada | Los calendarios persistentes de OpenCode activan su proyecto y ejecutan pasadas con la interfaz y el backend de CodeNomad cerrados, mientras el equipo de ejecución y el servicio estén disponibles. |
| Reinicio del servicio OpenCode — programación nativa saludable | Una programación saludable cuyo estado deseado es en marcha reanuda su calendario automáticamente. El trabajo pendiente se reconcilia con sus identidades originales antes de nuevas admisiones. |
| Programación diaria existente | Su reloj del plugin funciona con CodeNomad cerrado mientras el servicio siga activo. Un reinicio del servicio la deja **Interrumpido**; **Reanudar** explícitamente reconcilia su ejecución pendiente y reactiva su reloj diario. |

En las programaciones nativas, pausar o detener explícitamente, el trabajo fallido y los resultados inciertos conservan sus barreras de admisión tras reiniciar. Inspecciona la pasada conservada y la solicitud original; usa **Comprobar pasada** o **Actualizar la solicitud guardada** cuando se ofrezcan, y después **Reanudar** solo cuando el estado lo permita. Una continuación nativa se observa con su identidad existente. Un fallo demostrado o un final sin informe requiere recuperación humana; las pruebas incompletas mantienen la pasada incierta. Nunca uses un reinicio para repetir efectos de herramientas ya iniciados.

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

En una programación nativa, **Pausar** cierra futuras admisiones y solicita interrumpir una pasada admitida; **Reanudar** reconcilia el trabajo existente antes de reactivarla. **Detener…** es terminal. **Ejecutar ahora** usa la misma protección de pasadas pendientes y conserva los horarios previstos. **Comprobar pasada** reconcilia la pasada original. Conserva una acción sin confirmar y usa **Actualizar la solicitud guardada**; la actualización pasiva y la reconexión conservan esa solicitud. Los efectos de herramientas iniciados pueden continuar tras la interrupción.

Tras confirmar una acción, las demás acciones y **Editar la misión seleccionada** permanecen desactivadas hasta que una vista actualizada y validada incluya ese cambio o una revisión posterior. Cerrar y volver a abrir el panel conserva esta espera. **Actualizar la solicitud guardada** solo actualiza entonces la vista. Si falla la lectura, la acción sigue confirmada; usa el mismo botón para volver a leer.

Las entradas diarias existentes mantienen sus controles diarios Pausar/Detener/Reanudar/Ejecutar ahora/Comprobar pasada. Pausar/Detener cancelan su reloj y solicitan interrumpir las raíces registradas, incluidos los especialistas independientes. Inspecciona sus familias nativas y cualquier resultado de interrupción parcial. Los fallos transitorios de comprobación diaria se reintentan con su advertencia visible; una respuesta perdida a un control del usuario sigue vinculada a su solicitud original. Una entrada detenida permanece en estado terminal.

Para un coordinador puntual inactivo sin informe, la acción principal ▶ puede verificarlo y recuperarlo; las tareas tienen recuperación específica de informes ausentes cuando cumplen las condiciones. La recuperación comprueba primero actividad nativa, descendientes y esperas; una actividad desconocida rechaza la admisión. No repite asignaciones ni reemplaza el plan. Abre las conversaciones para resolver preguntas, permisos, shells o trabajo en segundo plano pendientes.

Si **Crear** queda sin confirmar, la ventana conserva la solicitud enviada y desactiva nuevas creaciones para ese proyecto; la eliminación de worktrees puede permanecer bloqueada. Actualizar solo lee el estado. Cerrar/reabrir el editor no lo repara. Antes de recargar la ventana, inspecciona la lista de misiones: recargar borra el bloqueo local, **no demuestra que la creación fallara**. No crees a ciegas un duplicado tras recargar o reiniciar.

## Editar, eliminar y limpiar conversaciones {#cleanup}

Si el objetivo o las notas cambian mientras el formulario aún carga, indica que la misión cambió desde que la abriste en lugar de rellenarlos; elige **Volver a abrir** para editar la versión actual.

Entre pasadas, una programación nativa pausada o en marcha permite editar título, instrucciones, notas, perfiles solicitados, modo de sesiones de tareas y criterios de lanzamiento cuando ninguna pasada ni control sin resolver retiene el objeto. Una programación pausada permanece pausada; una activada reconcilia su calendario antes de continuar. Guardar conserva resultados anteriores, fuentes consumidas, recuento de inicios y el origen en el primer inicio; los horarios sin cambios conservan sus calendarios nativos.

Durante una pasada admitida, solo las instrucciones y notas siguen el contrato de edición de textos activos: los cambios se registran en su historial y se guardan para futuras pasadas. Las tareas, encargos, perfiles e identidades de ejecución existentes conservan sus valores admitidos. Los campos estructurales permanecen bloqueados hasta resolver la pasada, incluso tras pausar. Un guion queda bloqueado en cuanto se haya creado alguna tarea, incluidas las completadas o retiradas. Una admisión/control incierto o evidencias de integridad incompletas mantienen la edición estructural en solo lectura. Crear y Editar comparten la validación del calendario.

La fuente de ramas locales incluye ramas sin worktree y lee solo referencias locales. El selector admite hasta 200 ramas locales; un inventario mayor muestra la fuente como no disponible. **Iniciar** y **Reanudar** solicitan consentimiento con las rutas exactas cuando la activación está disponible. **Ejecutar ahora** permanece desactivado con una explicación mientras la programación nativa esté inactiva; activa `experimental.schedules` en la configuración de OpenCode y actualiza. Si se pierde la respuesta de activación, se conserva la solicitud original para consultar su recibo.

Una confirmación directa de la activación puede continuar la acción que acabas de solicitar. Si la activación se confirma más tarde mediante **Actualizar la solicitud guardada**, espera a la vista actualizada y elige **Iniciar** o **Reanudar** por tu cuenta. La recuperación conserva la solicitud original y deja el inicio del trabajo para tu próxima acción explícita.

Antes del primer Play puede elegir **Una vez, ahora** conservando las conversaciones seguidas. Play lee y fija su prefijo de mensajes completos y estables (hasta 32 mensajes por fuente, dentro de una entrada de 16 384 caracteres). Una fuente ausente, movida o demasiado grande bloquea el inicio con una explicación. Un reintento conserva el contexto fijado y la identidad del inicio original.

Cuando la lectura del recibo confirma una preparación parcial, aparece **Intentar de nuevo**. El clic vuelve a comprobar ese mismo recibo y reanuda únicamente el cambio guardado original, manteniendo la misión en pausa.

Antes del primer inicio de una nueva misión preparada, puede editar título, instrucciones, notas, playbook, agentes/modelos/razonamiento solicitados, modo de sesiones de tareas y **Programación**. Puede añadir o quitar criterios de lanzamiento conservando la misma Misión. Guardar la mantiene en pausa y prepara un coordinador nuevo y vacío; se conserva la conversación inicial. Solo Play inicia el trabajo o activa una programación. Tras el inicio, instrucciones y notas siguen las reglas de edición de la misión activa. Si guardar queda sin confirmar, **Actualizar la solicitud guardada** lee el resultado original; conserve esa solicitud mientras una preparación parcial bloquea el inicio, la edición de textos y la eliminación.

Usa **Editar la misión seleccionada** desde **Más acciones** (⋯) en una misión puntual o programación nativa editable. Lee las explicaciones junto a los campos bloqueados. Ante un conflicto de revisión, elige **Recargar la configuración actual** y abre **Borrador anterior para comparar** para revisar el borrador conservado antes de volver a guardar. Las programaciones diarias existentes mantienen los controles de su propia barra de herramientas.

En una programación nativa, **Eliminar la misión seleccionada…** desactiva futuras pasadas antes de retirar la entrada. Se conservan las conversaciones y resultados; la limpieza pendiente de reconciliación sigue visible en **Detalles técnicos**. Conserva una eliminación sin confirmar y actualiza su solicitud original.

1. Para eliminar también las conversaciones de tareas creadas para las misiones que elimines, marca **Eliminar una misión también elimina las conversaciones de sus tareas** en **Configuración → Misiones**.
2. Para una misión puntual que ya no necesites, elige **Eliminar la misión seleccionada…**: se elimina de inmediato. Solo aparece un formulario si la eliminación falla o queda sin confirmar, con **Intentar de nuevo**.
3. Comprueba **Limpieza de conversaciones** para ver los recuentos de eliminadas/conservadas/pendientes. Reintenta solo la limpieza restante registrada si se ofrece.

Eliminar una misión no equivale a detenerla; usa Detener e inspecciona primero el trabajo restante. Se conservan los coordinadores y las conversaciones reutilizadas. También pueden conservarse especialistas compartidos, movidos, con hijos o cuya propiedad no se pueda verificar. La limpieza parcial no se revierte ni se completa silenciosamente en segundo plano. La tarjeta de la misión puede desaparecer mientras la confirmación de la eliminación sigue pendiente, incluso cuando la limpieza de conversaciones muestra 0 pendientes. Sigue usando la acción original **Intentar de nuevo** hasta que se confirme la eliminación; conserva la misma solicitud de eliminación y las mismas opciones. El lector general conserva las 20 limpiezas completadas más recientes. Eliminar misiones libera su almacenamiento en el proyecto: las misiones eliminadas más antiguas se borran automáticamente.

Consulta [Permisos](permissions.md), [Conversaciones](conversations.md) y [configuración de OpenCode](opencode.md) para el trabajo nativo y los controles del servicio.
