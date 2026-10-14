# Conversaciones

CodeNomad presenta las sesiones nativas de OpenCode como conversaciones, con una jerarquía para el trabajo delegado y controles independientes para lo que envías a continuación.

Los mensajes muestran Markdown, código, diferencias e imágenes compatibles de resultados de herramientas. La copia de texto, la búsqueda en todo el historial y la voz usan proyecciones de texto, no los bytes de las imágenes incrustadas. **Contenido de los mensajes** cambia la visibilidad sin eliminar las partes almacenadas; [Historial](history.md#operation-reference) distingue los controles de visualización de la limpieza.

## Buscar y recorrer conversaciones {#navigate-conversations}

1. Selecciona una fila en **Sesiones** o usa **Nueva sesión** para iniciar una conversación padre.
2. Expande el chevrón de una conversación padre para ver sus subsesiones. Un chevrón contraído puede indicar descendientes trabajando o que necesitan entrada.
3. Usa **Buscar sesiones…**, **Sesiones principales** / **Subsesiones**, el filtro de worktree y la ordenación por **Actividad**, **Nombre** o **Worktree** para acotar la lista.
4. Usa **Atrás** y **Adelante** en la barra lateral para volver a conversaciones que hayas mostrado.

La exploración normal es jerárquica; los resultados de búsqueda/filtro son entradas planas con la identidad y el worktree propios de cada conversación. Una subsesión que empiece a trabajar solo se revela automáticamente dentro de la familia de la conversación activa. Contraer esa rama descarta esa apertura automática para los descendientes actualmente en ejecución.

Atrás/Adelante es un historial de visitas por pestaña de proyecto y ventana, no el orden de la lista. Se conserva en memoria, omite conversaciones no disponibles/eliminadas y no se restaura tras reiniciar. Seleccionar una conversación nueva después de retroceder reemplaza la ruta hacia delante. En cambio, **Sesión anterior** / **Siguiente sesión** en la paleta recorren cíclicamente la lista visible.

## Elegir Agente, Modelo y Razonamiento {#agent-model-thinking}

1. Usa los selectores de agente y modelo del pie del editor de mensajes antes de enviar.
2. Si el modelo ofrece variantes, selecciona su esfuerzo de **Razonamiento**; **Por defecto** mantiene el valor nativo predeterminado.
3. Envía el siguiente mensaje y comprueba los metadatos de agente/modelo de la respuesta al diagnosticar un resultado.

Son elecciones de ejecución para los envíos posteriores, no modificaciones de respuestas anteriores. Leer un pasaje antiguo de la línea de tiempo no reemplaza las elecciones actuales del editor con metadatos históricos. La visibilidad de modelos, los favoritos y las conexiones de proveedores se gestionan en [Proveedores](providers.md).

## Borradores y adjuntos {#drafts-attachments}

1. Escribe en la conversación seleccionada. Cambiar de conversación conserva su borrador en lugar de enviarlo.
2. Elige **Adjuntar archivo…** para archivos de este dispositivo, o escribe `@` para seleccionar archivos del proyecto, agentes o habilidades.
3. Revisa las etiquetas de adjuntos y quita lo que no quieras incluir en el próximo envío.

| Entrada | Origen y efecto |
| --- | --- |
| Adjunto del dispositivo | El selector, el arrastre o el portapapeles leen bytes del dispositivo que ejecuta la interfaz; no es una ruta del servidor |
| Referencia `@` del proyecto | Se resuelve en el proyecto/Location de la conversación en el backend, incluido su worktree |
| Mención de agente | Adjunta la referencia del agente seleccionado en lugar de cambiar mensajes anteriores |
| Habilidad | Busca las habilidades de la Location por nombre/descripción y adjunta una selección de habilidad que se puede quitar |

Los archivos del dispositivo deben poder leerse y ajustarse al límite de adjuntos: como máximo 5 MiB cada uno, 10 archivos y 20 MiB en total. Un archivo rechazado no se adjunta; revisa el aviso en lugar de suponer que toda la selección se adjuntó correctamente.

Elegir una habilidad retira el token `@query` y añade una etiqueta. Enviar borra esa selección del editor, no las instrucciones ya almacenadas por OpenCode con el mensaje enviado. Los mensajes históricos conservan las etiquetas de habilidades. Quitar una habilidad al editar un mensaje en cola la mantiene fuera del envío que lo reemplaza.

Los borradores son estado de trabajo del cliente, no mensajes nativos compartidos. La restauración al iniciar puede conservar el estado compatible del editor, pero no trates un borrador o adjunto sin enviar como una copia de seguridad ni supongas que aparece en otro dispositivo. Guarda el texto importante antes de borrar los datos de inicio o cerrar un cliente cuya política de restauración esté desactivada; consulta [Escritorio](desktop.md).

## Comandos y modo shell {#commands-shell}

1. Escribe `/` y selecciona un comando personalizado descubierto; después, proporciona sus argumentos.
2. Para un comando de shell directo, escribe `!` al principio de un editor vacío para entrar en **Modo shell**.
3. Envía el comando. Para salir del modo shell sin ejecutarlo, usa Escape o Retroceso con el campo vacío.

Solo los nombres conocidos de comandos con barra usan la ruta de comandos personalizados; un `/text` desconocido es un mensaje normal. Los comandos personalizados usan su definición nativa. Los adjuntos de archivo/imagen no se envían por esa ruta de comandos y quedan disponibles para un mensaje posterior; el texto pegado usado en los argumentos se resuelve dentro de ellos.

El modo shell ejecuta una solicitud shell nativa de la sesión, no una petición para que el modelo sugiera un comando. Puede modificar archivos e iniciar procesos en el equipo de ejecución. Los ajustes de entorno del perfil se aplican antes del siguiente mensaje, comando personalizado o solicitud shell; no reinician un servicio existente. Consulta [Integraciones](integrations.md) y [configuración de OpenCode](opencode.md).

## Dirigir, poner en cola y editar seguimientos {#follow-ups}

1. En **Configuración → General → Comportamiento de seguimiento**, elige **Dirigir** o **Poner en cola**.
2. Mientras la sesión esté ocupada, envía un seguimiento con ese comportamiento. El atajo de envío alternativo usa el otro comportamiento; consulta su asignación actual en [Atajos](shortcuts.md).
3. En la cola de mensajes, usa **Intervenir ahora**, **Mover a la cola**, **Editar prompt en cola** o **Eliminar prompt en cola** mientras la entrada siga pendiente.

| Entrega | Efecto |
| --- | --- |
| Dirigir | Entrada nativa de orientación para la ejecución en curso |
| Poner en cola | Seguimiento nativo en cola, retenido para procesarlo posteriormente |

En reposo, un envío normal usa la ruta inmediata habitual independientemente de la preferencia para sesiones ocupadas. Editar restaura un mensaje pendiente y sus adjuntos removibles en el editor; **Cancelar edición** sale del proceso de edición. Un mensaje ya consumido por OpenCode deja de ser una entrada pendiente editable. Eliminar una entrada no deshace el trabajo ya realizado.

Si falla una actualización de la cola, inspecciona la cola actual antes de reintentar. La admisión no demuestra que el modelo haya consumido un seguimiento, y reconectar no autoriza a enviarlo de nuevo.

## Hacer una pregunta aparte con /btw {#side-question}

1. Envía `/btw your question` en una conversación existente, o `/btw` para abrir la ventana de pregunta aparte.
2. Lee la respuesta, usa **Copiar respuesta** o elige **Cancelar pregunta** mientras esté pendiente.
3. Cierra la ventana cuando termines.

Es una solicitud de modelo independiente que usa el contexto de la sesión. No ejecuta un bucle de herramientas, no realiza acciones ni añade su pregunta/respuesta a la conversación. Los adjuntos de archivo/imagen permanecen en el editor; el texto pegado usado en la pregunta se incluye como texto. No es una conversación duradera nueva ni una forma alternativa de asignar trabajo.

Cerrar cancela la solicitud aparte pendiente sin interrumpir la sesión principal. Salir de la conversación activa borra esta ventana efímera; copia primero lo que necesites. Las respuestas vacías/con error aparecen aquí en lugar de convertirse en mensajes de la transcripción.

## Bifurcar, deshacer y recuperar una ejecución fallida {#fork-errors}

1. En un mensaje, elige **Bifurcar después de este mensaje** para crear una conversación después de ese punto sin reemplazar la original.
2. Para deshacer, revisa cuidadosamente **Deshacer cambios hasta aqui (elimina mensajes)**. La paleta ofrece **Deshacer último mensaje** y **Rehacer último mensaje** para la operación de deshacer preparada.
3. Si la ejecución falla, inspecciona **Error de sesión**, el error de la respuesta y los detalles de **Error al enviar** antes de volver a enviar.

La bifurcación copia el contexto de la conversación hasta el punto seleccionado; no crea un worktree de Git ni aísla los archivos. Revertir no es simplemente navegar. Revisa los efectos sobre los archivos y el límite de lo que se deshace antes de continuar; usa una bifurcación cuando quieras una discusión alternativa sin reescribir el recorrido original.

Un envío fallido restaura el borrador y los adjuntos intentados cuando no sobrescribe texto más reciente. Una ejecución fallida puede haber ejecutado ya herramientas: inspecciona [Archivos](files.md), las [solicitudes](permissions.md) pendientes y la actividad nativa antes de reintentar. **Recargar mensajes** o **Recargar sesión** lee el estado; ninguna indica que se repita una modificación. **Detener sesión** interrumpe la ejecución, no revierte los cambios en archivos o servicios externos.
