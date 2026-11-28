# Misiones

Una Misión reúne un objetivo, una conversación del coordinador, tareas y resultados. Abre **Misiones** en el panel derecho.

Si Misiones no está disponible, **Ajustes de OpenCode** abre la recuperación del servicio para un plugin ausente o con errores. **Diagnóstico del servidor** abre el informe de diagnóstico en Configuración → Info cuando el puente local de Misiones del servidor no está disponible.

## Mostrar u ocultar Misiones {#activation}

En **Personalizar panel derecho**, marca **Misiones** para mostrar la pestaña o desmárcala y confirma para ocultarla. El gesto también escribe `codenomad.missions` o `-codenomad.missions` en la configuración global del servidor OpenCode conectado. Las reglas del proyecto pueden prevalecer. Desactivar no elimina ni pausa nada, pero pueden omitirse ejecuciones programadas. Si falla la escritura, la pestaña conserva la visibilidad elegida. **Restablecer** solo cambia la disposición. **Estado → Plugins** omite el aviso para esa regla global exacta; las demás desactivaciones siguen ofreciendo **Reactivar**.

## Crear una Misión {#create}

Las conexiones remotas usan el mismo formulario y los mismos controles. Usa preferentemente HTTPS para proteger el tráfico de red.

**Crear misión** sustituye el árbol por el formulario hasta crear o cancelar. Una creación confirmada selecciona la misión; una creación rechazada deja el formulario editable.

Pide a un agente en cualquier conversación del proyecto, incluido un subagente o una ejecución programada, que prepare una Misión separada, puntual o programada. Su conversación permanece igual; por defecto se crea una nueva conversación del coordinador. Mantén disponible el backend de CodeNomad responsable. **Iniciar automáticamente** autoriza el primer inicio de esa nueva Misión; la recuperación lee el resultado original. Los agentes también pueden listar, inspeccionar, iniciar, pausar, detener, reanudar, ejecutar ahora, comprobar, editar y eliminar cualquier programación del proyecto, incluidas las creadas en el editor. Se aplican las mismas comprobaciones de revisión y admisión; se conserva la desactivación explícita de la programación. Una acción no confirmada conserva su solicitud original para consultar el estado en modo de solo lectura.

### Configuración {#saved-briefs}

Los agentes pueden consultar todas las Misiones del proyecto, incluidas las tuyas, desde cualquier conversación propia. Las vistas de solo lectura incluyen tareas, resultados, limpieza, ejecuciones programadas y selección de fuentes; consultar nunca inicia ni reintenta trabajo.

También pueden diagnosticar la programación, preparar sus ajustes conservando un OFF explícito y reanudar una edición parcial confirmada con la solicitud original.

**Configuración** carga opcionalmente objetivo, notas, guion, perfiles y sesiones guardados. Su nombre proporciona el título editable. Revisa los campos.

Los agentes pueden leer, guardar, reemplazar o renombrar, eliminar y reparar configuraciones, incluidas las instrucciones de una Misión existente. También pueden cambiar los perfiles y las sesiones predeterminados globalmente o por guion, restaurar la herencia, restablecer preferencias inválidas y cambiar la preferencia de eliminación de conversaciones de tareas. La biblioteca y estas preferencias se aplican a todos los proyectos del perfil de CodeNomad. La profundidad de subagentes del proyecto admite 1–10 o **Heredar**, incluida la reparación de un bloque de configuración vacío. Cada cambio comprueba el último valor leído y conserva las modificaciones humanas posteriores.

**Guardar configuración**, abajo junto a Cancelar y Crear, conserva una configuración reutilizable sin crear ni iniciar una Misión. Programación e inicio automático se eligen aparte. El engranaje abre Preferencias y la biblioteca; eliminar una configuración conserva las misiones y conversaciones.

Para sustituir una configuración guardada, usa su nombre y elige **Reemplazar**. Si varias tienen ese nombre, carga primero la que quieras sustituir. Un nombre nuevo guarda una copia mientras haya espacio en la biblioteca.

### Objetivo, Título y Notas {#mission-instructions}

En las Missions puntuales, los agentes pueden iniciar, reanudar, pausar suavemente, interrumpir de inmediato, detener, editar, eliminar, recuperar la coordinación tras un fallo y pedir un informe pendiente o una actualización. Esto incluye las Missions que usted creó, con las mismas comprobaciones de admisión y revisión del panel. La eliminación sigue su preferencia para las sesiones administradas salvo indicación expresa. Las acciones y limpiezas sin confirmar conservan su identidad original; los agentes leen el estado guardado antes de continuar explícitamente una acción parcial confirmada.

**Objetivo** describe el resultado y cómo comprobarlo. **Título** nombra la entrada; inicialmente sigue la primera frase del objetivo, hasta 60 caracteres, y es editable. **Notas** aporta contexto, restricciones o instrucciones adicionales opcionales para los agentes.

### Opciones y guion {#playbooks}

**Guion** elige el método del coordinador; [Guiones](playbooks.md) explica roles y pasos. Los permisos nativos siguen vigentes. Commits, pushes, pull requests y cambios en el seguimiento de incidencias requieren pedir expresamente esa acción en el objetivo o las Notas.

### Delegación y profundidad {#profiles}

**Sesiones de tareas** elige subagentes nativos del coordinador o sesiones independientes. Ambos respetan permisos y límites de anidamiento de OpenCode.

**Profundidad de subagentes** afecta a todas las conversaciones OpenCode del proyecto. **Heredar** o 1–10 se guarda inmediatamente. El **ⓘ** muestra profundidad efectiva observada, permisos y archivos de configuración.

La información de profundidad de subagentes identifica su origen efectivo en **Archivo de configuración de OpenCode:**.

Guardar una profundidad de proyecto también permite que los subagentes deleguen dentro de ese límite, prevaleciendo sobre restricciones compatibles de General en otros archivos. **Heredar** quita la regla añadida. Guardar no recarga OpenCode ni cambia conversaciones en curso.

### Agentes y modelos {#agents-models}

Despliega **Agentes y modelos** para editar Agente / Modelo / Razonamiento por rol. El resumen conserva las selecciones al plegar. Se parte de los valores de Preferencias; los cambios aquí son para esta Misión.

El engranaje abre los valores de todas las misiones o de un guion. Preferencias guarda cada cambio inmediatamente. Las listas siguen visibilidad y favoritos del selector de conversación; un modelo guardado fuera de la lista sigue seleccionado.

**Comparar dos modelos** requiere A y B distintos; cambiar solo Razonamiento no basta. El juez usa el modelo del coordinador salvo otra selección. Usar A o B como juez puede sesgar la comparación.

La programación basada en calendario requiere agente y modelo explícitos para el coordinador y cada rol del guion.

### Iniciar automáticamente {#automatic-start}

**Iniciar automáticamente** está fuera de Programación y desactivado por defecto. Desactivado crea una Misión en pausa para iniciarla después desde ▶. Activado solicita el inicio tras confirmar la creación, con las comprobaciones habituales y la preparación automática de la programación.

### Mantener activo al coordinador con /goal {#coordinator-goal}

**Mantener activo al coordinador con /goal** está disponible para Misiones puntuales y desactivado por defecto. Activado, al iniciar la Misión se activa `/goal` de OpenCode en el coordinador; pausar y reanudar la Misión pausan y reanudan ese objetivo, y finalizar o detener lo elimina. Si OpenCode se reinicia durante la ejecución, Misiones reanuda automáticamente el objetivo pausado por el reinicio (incluso con CodeNomad cerrado si las automatizaciones de OpenCode están activas), manteniendo intactas las pausas manuales, por bloqueo o por límite de rondas. El estado en vivo y los controles aparecen en el resumen de la Misión.

## Programación {#daily-schedules}

Una Misión con un horario repetido o un evento sigue siendo una sola fila de la lista: cada lanzamiento sustituye al anterior en la misma conversación de coordinación y espera mientras el anterior siga activo. Su detalle muestra **Lanzar cuando**, **Estado deseado**, la próxima activación o comprobación, **Pasadas iniciadas** y **Ejecuciones anteriores** (los últimos 20 lanzamientos). Con **Iniciar automáticamente** desactivado, se crea en pausa. **Editar la misión seleccionada** vuelve a abrir el formulario de creación, y el siguiente lanzamiento usa lo que guarde. **Eliminar la misión seleccionada…** quita primero su programación. ⏸ de la barra de herramientas la pausa por completo, el lanzamiento en curso y su programación, y ▶ reanuda ambos. ■ detiene el lanzamiento en curso; cuando ya no se ejecuta nada, detiene definitivamente la programación y deja la Misión en la lista.

### Criterios {#native-scheduling}

El botón **i** abre la [ayuda de programación](missions.md#native-scheduling).

El primer criterio es **Una vez, ahora**. **Añadir un criterio** agrega otro. Elige su tipo, elimina con × o reordena por el asa; Alt+Arriba/Abajo mueve el asa enfocada.

Hay una vez ahora, cada N horas, diario, días de semana, día del mes y cron. Se usa la zona guardada; su campo aparece si difiere de la del sistema. Los meses sin el día elegido se omiten. Una vez ahora fija su instante al iniciar y ofrece una sola oportunidad, que una condición puede consumir sin lanzar. Se necesitan OpenCode y el equipo de ejecución disponibles.

Al iniciar o reanudar, la programación se prepara automáticamente en la configuración OpenCode del proyecto. Se conserva un OFF explícito: **Abrir los ajustes de programación**, cuando esté disponible, abre el archivo responsable; **i** muestra el origen o los detalles del entorno.

### Eventos y combinaciones {#scheduling-conditions}

Elige **Actividad del repositorio → Evento** y los filtros opcionales en la misma tarjeta. Los commits de Git comparten este menú con los eventos del repositorio GitHub, GitLab o Gitea detectado automáticamente, como en Contribute (`upstream`, luego `origin`). Los tres admiten nuevas PR/MR, PR/MR fusionadas y nuevas issues, con **Autor (opcional)**, incluido `dependabot[bot]`. Elegir un evento fija su repositorio; los criterios guardados conservan su destino.

Las comprobaciones usan `gh`, `glab` o `tea` en el host OpenCode, incluso con CodeNomad cerrado; los repositorios públicos permiten acceso anónimo. Las forjas autohospedadas requieren una CLI conectada a ese host. **github.com** ofrece además notificaciones y alertas Dependabot mediante `gh` conectado, con acceso a [notificaciones](https://docs.github.com/en/rest/activity/notifications) o [lectura de alertas](https://docs.github.com/en/rest/dependabot/alerts). Las notificaciones conservan su estado de lectura; las alertas incluyen las corregidas o descartadas. Las notificaciones guardadas con **Repositorio de GitHub** vacío cubren la cuenta. El primer inicio fija la referencia.

Los eventos siguen el éxito de otra programación o Misión, commits locales, mensajes nuevos o archivos explícitos del proyecto. Elige la fuente dentro del criterio. La búsqueda ignora mayúsculas y minúsculas, también en letras acentuadas. Durante una búsqueda, usa **Cargar más fuentes** en el selector para continuar, aunque la página ya tenga coincidencias. La conversación elegida para mensajes nuevos también aporta contexto a la ejecución. Cambiar el tipo de criterio borra su fuente. La edición conserva el contexto de conversación guardado.

**o** une horarios vecinos o eventos vecinos. **si** convierte eventos después de horarios en condiciones: alguno debe haber cambiado desde la última pasada exitosa. **si no** convierte horarios posteriores a eventos en respaldo: nada de arriba debe haber lanzado una pasada desde su horario anterior o su activación. Los eventos posteriores condicionan ese respaldo.

Los eventos iniciales se comprueban cada 15 minutos. El primer inicio fija la referencia; el éxito la avanza y el fallo la conserva. Las pasadas no se solapan.

### Contadores e historial {#scheduling-limits}

**Sesión del coordinador** usa por defecto una **Nueva sesión** por pase. Con un horario o evento, **Sesión existente** permite elegir una conversación raíz del proyecto y de la misma Location de ejecución. Cada pase continúa allí con el agente y modelo configurados, conservando historial, título y permisos. Los controles de la misión también afectan al trabajo existente allí. Cada pase mantiene su propio resultado y diario en el historial. La conversación debe usar el agente, el modelo y el razonamiento del coordinador: de lo contrario, no se guarda, y un lanzamiento que los encuentre cambiados usa otra sesión.

Puedes pedir a un agente que prepare la programación con su conversación raíz actual. Los pases esperan a que la conversación esté inactiva.

La programación seleccionada muestra estado, próximo despertar o comprobación, pasadas lanzadas/exitosas e historial. Se conservan 30 resultados y los contadores acumulados. **Ejecutar ahora** cuenta al admitirse. Una política guardada no representable se conserva hasta sustituirla explícitamente; revisa finales y límites antes de editar.

En **Conversaciones seguidas**, usa **Añadir conversación** y elige una conversación, también para una Misión inmediata. Antes de iniciar, cambia una selección o quítala con ×.

Elige **Nuevos commits en una rama local** para seguir una referencia Git local o **Nuevos commits en una rama remota** e introduce el nombre de la rama (por ejemplo, `dev`). La comprobación consulta directamente el repositorio detectado, sin un fetch local. Varios commits entre comprobaciones generan un solo pase.

## Árbol y resultados {#tracking}

El chevrón despliega tareas; hacer clic selecciona Misión o tarea. Sus acciones quedan en la cabecera. Sin tareas no hay chevrón. El filtro busca en las entradas cargadas. Las Misiones únicas y recurrentes comparten una lista, con la actividad más reciente primero; una ejecución programada en curso va arriba.

El ojo alterna el resumen central y sigue la selección. **Abrir conversación** lleva al coordinador o tarea. El menú ⋯ contiene las acciones disponibles de actualización, interrupción, configuración y edición.

La selección, las secciones expandidas y el lector pertenecen a cada pestaña de proyecto y se restauran con ella. Las pestañas duplicadas pueden leer informes distintos o mantener un informe en una y la conversación, un archivo o una vista previa web en otra. Abrir o cerrar un lector cambia solo esa pestaña; el trabajo de las Misiones y las confirmaciones de lectura de resultados terminados siguen compartidos dentro de la ventana.

Más entradas y tareas se cargan automáticamente al acercarse al final. Si falla la carga de tareas, usa **Intentar de nuevo** para continuar.

### Colores y estados {#status-colours}

La bandera muestra la Misión y el chevrón la atención de sus tareas; las recurrentes usan repetición. Rojo pide respuesta y amarillo indica trabajo observado. Un símbolo de pausa naranja indica pausa: nada continúa ni se lanza hasta que la reanude; un triángulo de advertencia naranja, interrupción. Verde indica una Misión, tarea o ejecución correcta pendiente de revisión.

Un símbolo de pausa en el color de acento con una pequeña línea neutra estática debajo significa **Esperando ejecución programada**: la próxima activación está confirmada. El acento sigue la paleta. El icono de acento solo indica preparación o una tarea sin iniciar. Los resultados revisados, las programaciones detenidas y **Estado sin confirmar** son neutros; consulta el texto de estado.

Seleccionar o pulsar/barrer iconos verdes confirma resultados; el menú del chevrón ofrece **Marcar como leído**. Para **Ejecución correcta por revisar**, selecciona explícitamente la fila recurrente en la ventana activa o usa **Marcar como leído**. El icono vuelve a espera si la programación sigue activa; en caso contrario, a neutro. Los resultados nuevos que llegan a una fila ya seleccionada permanecen sin leer. Las tareas retiradas conservan historial.

### Preguntas y decisiones {#questions}

El coordinador debe resolver lo posible y preguntar solo decisiones, consentimiento o credenciales pendientes. Contesta en el panel de interrupciones. Exploración distingue decisiones del coordinador de tus respuestas; sesiones independientes guardan decisiones en Notas. Véase [Guiones](playbooks.md).

### Informes de progreso {#briefings}

Los informes en hitos son valoraciones del coordinador. Pide una actualización desde ⋯ y léela en el resumen.

## Contexto y resultados {#context-flow}

Misiones y pasadas nuevas tienen planes propios. Lleva resultados útiles a Objetivo o Notas.

### Buscar conversaciones anteriores {#context-search}

Con CodeNomad funcionando, los agentes pueden buscar conversaciones guardadas del proyecto. Pídelo cuando importen conclusiones previas; no se hereda automáticamente el contexto completo.

## Cierre y reinicios {#lifetime}

Cerrar CodeNomad no detiene trabajo nativo. Las programaciones nativas activadas funcionan con servicio/equipo disponibles; calendarios sanos se reanudan tras reiniciar el servicio. Pausas, paradas e incertidumbres conservan sus bloqueos.

Algunas acciones de coordinación y recuperación necesitan el servidor CodeNomad.

Una Misión puntual en curso sigue asignando sus tareas y entregando sus informes aunque ninguna ventana de CodeNomad tenga el proyecto abierto. Las variables de entorno y los ajustes de permisos cambiados en CodeNomad vuelven a aplicarse a esas conversaciones cuando el proyecto está abierto.

## Pausa, parada y acciones no confirmadas {#controls-recovery}

Pausa puntual deja acabar los pasos actuales sin empezar otros; interrumpir solicita interrupción inmediata. Parar es terminal y requiere confirmación. La pausa de programación cierra futuros inicios y pide interrumpir la pasada actual. Los efectos de herramientas pueden continuar.

Conserva la solicitud original no confirmada: mientras la vista de una programación nativa o el editor estén abiertos, CodeNomad la vuelve a leer automáticamente hasta resolverla y reintenta por sí solo únicamente una preparación parcial exactamente registrada. Usa **Comprobar estado** para controles de Misiones puntuales, y **Actualizar mapa de misión** para una creación puntual ordinaria cuando se ofrezcan; no crees una acción sustitutiva. Una programación nativa ofrece **Comprobar estado** en su menú **Más acciones**.

## Editar, eliminar y limpiar conversaciones {#cleanup}

La limpieza de conversaciones de tareas es una opción de Misiones puntuales. Eliminar programaciones nativas conserva sus conversaciones.

La edición en ⋯ abre el mismo formulario. Antes del primer inicio se editan campos desbloqueados; después, instrucciones y Notas cuando esté permitido. Los campos bloqueados explican el motivo.

Detén el trabajo antes de eliminarlo. La Misión puntual se elimina directamente. Eliminar programación cierra primero futuros inicios. La preferencia de eliminar conversaciones de tareas afecta solo a las elegibles; coordinadores, conversaciones reutilizadas/compartidas o sin propiedad comprobable se conservan. La limpieza muestra pendientes y reintentos explícitos.
