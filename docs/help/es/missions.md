# Misiones

Una Misión reúne un objetivo, una conversación del coordinador, tareas y resultados. Abre **Misiones** en el panel derecho.

## Crear una Misión {#create}

Las conexiones remotas usan el mismo formulario y los mismos controles. Usa preferentemente HTTPS para proteger el tráfico de red.

**Crear misión** sustituye el árbol por el formulario hasta crear o cancelar. Los grupos siguen este orden.

### Configuración {#saved-briefs}

**Configuración** carga opcionalmente objetivo, notas, guion, perfiles y sesiones guardados. Su nombre proporciona el título editable. Revisa los campos.

**Guardar configuración**, abajo junto a Cancelar y Crear, conserva una configuración reutilizable sin crear ni iniciar una Misión. Programación e inicio automático se eligen aparte. El engranaje abre Preferencias y la biblioteca; eliminar una configuración conserva las misiones y conversaciones.

### Objetivo, Título y Notas {#mission-instructions}

**Objetivo** describe el resultado y cómo comprobarlo. **Título** nombra la entrada; inicialmente sigue la primera frase del objetivo, hasta 60 caracteres, y es editable. **Notas** aporta contexto, restricciones o instrucciones adicionales opcionales para los agentes.

### Opciones y guion {#playbooks}

**Guion** elige el método del coordinador; [Guiones](playbooks.md) explica roles y pasos. Los permisos nativos siguen vigentes. Commits, pushes, pull requests y cambios en el seguimiento de incidencias requieren pedir expresamente esa acción en el objetivo o las Notas.

### Delegación y profundidad {#profiles}

**Sesiones de tareas** elige subagentes nativos del coordinador o sesiones independientes. Ambos respetan permisos y límites de anidamiento de OpenCode.

**Profundidad de subagentes** afecta a todas las conversaciones OpenCode del proyecto. **Heredar** o 1–10 se guarda inmediatamente. El **ⓘ** muestra profundidad efectiva observada, permisos y archivos de configuración. Un guardado fallido o no confirmado conserva su aviso y ofrece actualización explícita.

Guardar una profundidad de proyecto también permite que los subagentes deleguen dentro de ese límite, prevaleciendo sobre restricciones compatibles de General en otros archivos. Una regla de proyecto incompatible conserva su aviso. **Heredar** quita la regla añadida. Guardar no recarga OpenCode ni cambia conversaciones en curso.

### Agentes y modelos {#agents-models}

Despliega **Agentes y modelos** para editar Agente / Modelo / Razonamiento por rol. El resumen conserva las selecciones al plegar. Se parte de los valores de Preferencias; los cambios aquí son para esta Misión.

El engranaje abre los valores de todas las misiones o de un guion. Preferencias guarda cada cambio inmediatamente. Las listas siguen visibilidad y favoritos del selector de conversación; un modelo guardado fuera de la lista sigue seleccionado.

**Comparar dos modelos** requiere A y B distintos; cambiar solo Razonamiento no basta. El juez usa el modelo del coordinador salvo otra selección. Usar A o B como juez puede sesgar la comparación.

La programación basada en calendario requiere agente y modelo explícitos para el coordinador y cada rol del guion.

### Iniciar automáticamente {#automatic-start}

**Iniciar automáticamente** está fuera de Programación y desactivado por defecto. Desactivado crea una Misión en pausa para iniciarla después desde ▶. Activado solicita el inicio tras confirmar la creación, con las comprobaciones habituales y la preparación automática de la programación.

Si se pierde la confirmación, leer el recibo deja el inicio manual. Conserva la solicitud original no confirmada y comprueba lista y conversación antes de crear otra vez.

## Programación {#daily-schedules}

### Criterios {#native-scheduling}

La información de profundidad de subagentes identifica su origen efectivo en **Archivo de configuración de OpenCode:**.

El primer criterio es **Una vez, ahora**. **Añadir un criterio** agrega otro. Elige su tipo, elimina con × o reordena por el asa; Alt+Arriba/Abajo mueve el asa enfocada.

Hay una vez ahora, cada N horas, diario, días de semana, día del mes y cron. Se usa la zona guardada; su campo aparece si difiere de la del sistema. Los meses sin el día elegido se omiten. Una vez ahora fija su instante al iniciar y ofrece una sola oportunidad, que una condición puede consumir sin lanzar. Se necesitan OpenCode y el equipo de ejecución disponibles.

Al iniciar o reanudar, la programación se prepara automáticamente en la configuración OpenCode del proyecto. Se conserva un OFF explícito: **Abrir los ajustes de programación**, cuando esté disponible, abre el archivo responsable; **i** muestra el origen o los detalles del entorno. El botón pulsado indica carga solo durante la solicitud. Un resultado sin confirmar permite verificarlo; recuperar la activación deja el inicio como acción explícita.

### Eventos y combinaciones {#scheduling-conditions}

Elige **Actividad del repositorio → Evento** y los filtros opcionales en la misma tarjeta. Los commits de Git comparten este menú con los eventos del repositorio GitHub, GitLab o Gitea detectado automáticamente, como en Contribute (`upstream`, luego `origin`). Los tres admiten nuevas PR/MR, PR/MR fusionadas y nuevas issues, con **Autor (opcional)**, incluido `dependabot[bot]`. Elegir un evento fija su repositorio; los criterios guardados conservan su destino.

Las comprobaciones usan `gh`, `glab` o `tea` en el host OpenCode, incluso con CodeNomad cerrado; los repositorios públicos permiten acceso anónimo. Las forjas autohospedadas requieren una CLI conectada a ese host. **github.com** ofrece además notificaciones y alertas Dependabot mediante `gh` conectado, con acceso a [notificaciones](https://docs.github.com/en/rest/activity/notifications) o [lectura de alertas](https://docs.github.com/en/rest/dependabot/alerts). Las notificaciones conservan su estado de lectura; las alertas incluyen las corregidas o descartadas. Las notificaciones guardadas con **Repositorio de GitHub** vacío cubren la cuenta. El primer inicio fija la referencia. Cada comprobación lee hasta cuatro páginas de 50 elementos en diez segundos; permisos insuficientes, límites de API o ventanas incompletas dejan la fuente no disponible. Los resúmenes entran en el pase y se consumen tras el éxito.

Los eventos siguen el éxito de otra programación o Misión, commits locales, mensajes nuevos o archivos explícitos del proyecto. Elige la fuente dentro del criterio. Sin búsqueda, el selector carga más fuentes al desplazarte; si la lectura falla, ofrece **Intentar de nuevo** allí. La búsqueda ignora mayúsculas y minúsculas, también en letras acentuadas. Durante una búsqueda, usa **Cargar más fuentes** en el selector para continuar, aunque la página ya tenga coincidencias. La conversación elegida para mensajes nuevos también aporta contexto a la ejecución. Cambiar el tipo de criterio borra su fuente. La edición conserva el contexto de conversación guardado.

**o** une horarios vecinos o eventos vecinos. **si** convierte eventos después de horarios en condiciones: alguno debe haber cambiado desde la última pasada exitosa. **si no** convierte horarios posteriores a eventos en respaldo: nada de arriba debe haber lanzado una pasada desde su horario anterior o su activación. Los eventos posteriores condicionan ese respaldo.

Los eventos iniciales se comprueban cada 15 minutos. El primer inicio fija la referencia; el éxito la avanza y el fallo la conserva. Fuentes ilegibles bloquean con explicación. Las pasadas no se solapan.

### Contadores e historial {#scheduling-limits}

**Sesión del coordinador** usa por defecto una **Nueva sesión** por pase. Con un horario o evento, **Sesión existente** permite elegir una conversación raíz del proyecto y de la misma Location de ejecución. Cada pase continúa allí con el agente y modelo configurados, conservando historial, título y permisos. Los controles de la misión también afectan al trabajo existente allí. Cada pase mantiene su propio resultado y diario en el historial; una conversación elegida que desaparezca requiere tu intervención.

La programación seleccionada muestra estado, próximo despertar o comprobación, pasadas lanzadas/exitosas e historial. Se conservan 30 resultados y los contadores acumulados. **Ejecutar ahora** cuenta al admitirse. Una política guardada no representable se conserva hasta sustituirla explícitamente; revisa finales y límites antes de editar.

### Programaciones diarias existentes {#existing-daily-schedules}

Conservan controles y zona. Tras reiniciar el servicio requieren **Reanudar** desde el estado interrumpido. Recuperan el último día válido, no todos los perdidos. La entrada seleccionada permite leer resultados.

## Árbol y resultados {#tracking}

El chevrón despliega tareas; hacer clic selecciona Misión o tarea. Sus acciones quedan en la cabecera. Sin tareas no hay chevrón. El filtro busca en las entradas cargadas.

El ojo alterna el resumen central y sigue la selección. **Abrir conversación** lleva al coordinador o tarea. El menú ⋯ contiene las acciones disponibles de actualización, interrupción, configuración y edición.

La selección, las secciones expandidas y el lector pertenecen a cada pestaña de proyecto y se restauran con ella. Las pestañas duplicadas pueden leer informes distintos o mantener un informe en una y la conversación, un archivo o una vista previa web en otra. Abrir o cerrar un lector cambia solo esa pestaña; el trabajo de las Misiones y las confirmaciones de lectura de resultados terminados siguen compartidos dentro de la ventana.

Más entradas y tareas se cargan automáticamente al acercarse al final. Las páginas quedan en caché independientemente de las filas mostradas. Un error conserva la vista y ofrece **Intentar de nuevo**. Leer no inicia trabajo; la cabecera indica las lecturas de fondo.

### Colores y estados {#status-colours}

La bandera muestra la Misión y el chevrón la atención de sus tareas; las recurrentes usan repetición. Rojo pide respuesta y amarillo pulsante indica trabajo observado. Un símbolo de pausa naranja indica pausa; un triángulo de advertencia naranja, interrupción. Verde indica una Misión, tarea o ejecución correcta pendiente de revisión.

Un icono de acento con una pequeña línea neutra estática debajo significa **Esperando ejecución programada**: la próxima activación está confirmada. El acento sigue la paleta. El icono de acento solo indica preparación o una tarea sin iniciar. Los resultados revisados, las programaciones detenidas y **Estado sin confirmar** son neutros; consulta el texto de estado.

Seleccionar o pulsar/barrer iconos verdes confirma resultados; el menú del chevrón ofrece **Marcar como leído**. Para **Ejecución correcta por revisar**, selecciona explícitamente la fila recurrente en la ventana activa o usa **Marcar como leído** para confirmar esa ejecución. El icono vuelve a espera si la programación sigue activa; en caso contrario, a neutro. La selección restaurada y los resultados que llegan a una fila ya seleccionada mantienen el nuevo resultado sin leer. Los éxitos históricos presentes en la primera carga comienzan como leídos. Las tareas retiradas conservan historial.

### Preguntas y decisiones {#questions}

El coordinador debe resolver lo posible y preguntar solo decisiones, consentimiento o credenciales pendientes. Contesta en el panel de interrupciones. Exploración distingue decisiones del coordinador de tus respuestas; sesiones independientes guardan decisiones en Notas. Véase [Guiones](playbooks.md).

### Informes de progreso {#briefings}

Los informes en hitos son valoraciones del coordinador. Pide una actualización desde ⋯ y léela en el resumen. Si la entrega no se confirma, comprueba la conversación primero.

## Contexto y resultados {#context-flow}

El plan duradero guarda objetivo, Notas, encargos, dependencias y resultados. El coordinador recibe objetivo, Notas y guion; las tareas nativas reciben el encargo del padre, las independientes también sus asignaciones abiertas. Los ayudantes reciben el contexto transmitido. El juez ciego recibe material anonimizado.

Misiones y pasadas nuevas tienen planes propios. Lleva resultados útiles a Objetivo o Notas. OpenCode puede compactar el contexto del modelo conservando el historial almacenado.

### Buscar conversaciones anteriores {#context-search}

Con CodeNomad funcionando, los agentes pueden buscar conversaciones guardadas del proyecto. Pídelo cuando importen conclusiones previas; no se hereda automáticamente el contexto completo.

## Cierre y reinicios {#lifetime}

Cerrar CodeNomad no detiene trabajo nativo. Las programaciones nativas activadas funcionan con servicio/equipo disponibles; calendarios sanos se reanudan tras reiniciar el servicio. Pausas, paradas e incertidumbres conservan sus bloqueos. Las entradas diarias existentes requieren Reanudar.

Algunas acciones de coordinación y recuperación necesitan el servidor CodeNomad. Sigue los errores de conexión/plugin del panel.

## Pausa, parada y acciones no confirmadas {#controls-recovery}

Pausa puntual deja acabar los pasos actuales sin empezar otros; interrumpir solicita interrupción inmediata. Parar es terminal y requiere confirmación. La pausa de programación cierra futuros inicios y pide interrumpir la pasada actual. Los efectos de herramientas pueden continuar.

Conserva la solicitud original no confirmada. Usa la consulta de estado, actualización de recibo o reintento ofrecido, no una acción sustitutiva. La actualización pasiva no reenvía. Tras confirmar, los controles pueden esperar una vista actualizada. La recuperación comprueba antes actividad nativa y solicitudes pendientes.

## Editar, eliminar y limpiar conversaciones {#cleanup}

La limpieza de conversaciones de tareas es una opción de Misiones puntuales. Eliminar programaciones nativas conserva sus conversaciones.

La edición en ⋯ abre el mismo formulario. Antes del primer inicio se editan campos desbloqueados; después, instrucciones y Notas cuando esté permitido. Los campos bloqueados explican el motivo. Ante conflicto, recarga la configuración y compara el borrador anterior.

Detén el trabajo antes de eliminarlo. La Misión puntual se elimina directamente; una eliminación no confirmada conserva su reintento original. Eliminar programación cierra primero futuros inicios. La preferencia de eliminar conversaciones de tareas afecta solo a las elegibles; coordinadores, conversaciones reutilizadas/compartidas o sin propiedad comprobable se conservan. La limpieza muestra pendientes y reintentos explícitos.
