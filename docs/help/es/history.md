# Historial, búsqueda y limpieza

El historial almacenado, lo que muestra actualmente la transcripción y el contexto compactado del modelo son cosas distintas. Elige navegar o filtrar antes de eliminar nada.

## Buscar en todo el historial {#full-history-search}

1. Abre **Buscar en el historial del chat** en la cabecera de la conversación o usa su atajo configurado (por defecto **Ctrl/Cmd+F**).
2. Selecciona **Toda la sesión** o **Todo el espacio de trabajo** e introduce un término de búsqueda.
3. Activa **Incluir herramientas y razonamiento** si necesitas contenido técnico además del texto legible.
4. Selecciona un fragmento. En **Toda la sesión**, usa **Siguientes resultados** para recorrer las páginas cronológicas.

**Toda la sesión** busca una frase literal sin distinguir mayúsculas en el historial guardado. **Todo el espacio de trabajo** clasifica los resultados del árbol y los worktrees autorizados del proyecto abierto con hasta seis términos y muestra los 40 mejores en una lista. Primero aparece el mejor resultado de cada conversación, con títulos y etiquetas del worktree actual en orden de relevancia. Los términos se resaltan en los fragmentos y en la transcripción de destino tras **Abrir en la sesión**. Se busca texto legible y, opcionalmente, herramientas y razonamiento.

Las páginas de conversación muestran **Esta página: … resultados · … mensajes examinados** al llegar los lotes. El proyecto muestra **Mejores resultados: …** y avisos compactos de búsqueda parcial o directorios excluidos. Si la búsqueda clasificada no está disponible en el entorno, usa **Toda la sesión**. Se indican los mensajes omitidos; inicia otra búsqueda para incluir mensajes nuevos.

Abrir una búsqueda vacía no analiza el historial. Cambiar la consulta/el ámbito, cerrar la ventana o salir de la sesión cancela el trabajo de búsqueda obsoleto. Si falla una lectura, usa **Reintentar**; no envía un mensaje ni modifica el historial.

La búsqueda empieza por hasta 16 384 mensajes guardados más recientes por ubicación. **Buscar más atrás** sustituye la lista por los mejores resultados de la siguiente ventana anterior. La nota indica el intervalo examinado, del más nuevo al más antiguo por ubicación del proyecto. La clasificación corresponde solo a esa ventana. Cambiar consulta, ámbito o contenido técnico, cerrar la búsqueda o salir de la sesión reinicia la ventana. Una búsqueda nueva incluye los mensajes nuevos.

Si una ventana de búsqueda caduca o su historial cambia, **Iniciar búsqueda nueva** vuelve a los mensajes más recientes con la misma consulta y opciones. Un aviso explica la recuperación. Ante errores de lectura normales, **Reintentar** vuelve a leer la ventana actual.

## Abrir resultados y usar la línea de tiempo {#timeline-navigation}

1. Elige un resultado de búsqueda de la sesión actual para saltar al pasaje que lo rodea.
2. Elige un resultado de otra sesión para abrir una vista previa independiente de ese mensaje; usa **Abrir en la sesión** para ir a esa conversación en el resultado.
3. En **Línea de tiempo de mensajes**, pasa el puntero o enfoca un marcador para ver un fragmento y selecciónalo para navegar: su bloque pasa arriba y el marcador sigue resaltado hasta que te desplaces; después, el resaltado sigue al bloque de la parte superior de la conversación. Usa los controles de primer/último mensaje para volver a los extremos del historial almacenado.

La línea de tiempo representa la estructura completa de la sesión aunque la transcripción solo contenga un pasaje acotado. Los saltos cargan el destino en lugar de obtener todos los mensajes intermedios. Las vistas previas de resultados de otras sesiones no cargan toda su transcripción ni las seleccionan; solo **Abrir en la sesión** cambia de conversación.

Los marcadores de herramientas siguen **Contenido de los mensajes**: un tipo de herramienta oculto allí no tiene marcador (ninguno con **Nada**), salvo una herramienta que espera un permiso. Un paso que solo ejecutó herramientas muestra únicamente sus marcadores de herramientas, sin un marcador de agente vacío.

Mientras se carga un salto, el pasaje anterior permanece visible. Un salto más reciente o una interacción manual con la transcripción sustituye la navegación obsoleta; un salto fallido deja intacto el pasaje visible. Reintenta el destino en lugar de recargar todo el proyecto repetidamente. Leer el historial no cambia la selección de agente/modelo del editor de mensajes.

La línea de tiempo se oculta cuando la conversación es demasiado estrecha (menos de 420 píxeles CSS); usa allí la búsqueda y los controles de la transcripción. Ese cambio adaptable no borra su preferencia de visibilidad guardada.

## Elegir la operación de historial adecuada {#operation-reference}

| Operación | Dónde | Ámbito y consecuencia |
| --- | --- | --- |
| Filtrado de visualización | **Contenido de los mensajes**, o **Configuración → Chat** | Preferencias compartidas de visualización de la transcripción; oculta/contrae contenido sin eliminarlo |
| Compactación | **Compactar sesión** en la paleta | Resumen/compactación de contexto nativo para la sesión seleccionada, no eliminación de salida técnica |
| Limpieza de una respuesta | **Más acciones → Eliminar herramientas y razonamientos de esta respuesta** en el mensaje | Elimina permanentemente las partes técnicas completadas aptas; conserva el texto final |
| Limpieza técnica de la sesión | **Eliminar herramientas y razonamientos de la sesión** en la paleta | Planifica sobre todo el historial almacenado de la sesión, incluidos los mensajes anteriores a la compactación; conserva el texto final y los metadatos de mensajes/sesión |
| Eliminar sesión | **Eliminar sesión** en la fila de la sesión, o eliminación de sesiones seleccionadas | Elimina recursivamente la conversación nativa y sus subsesiones/historial descendientes tras confirmar; no se puede deshacer |
| Depurar sesiones | Paleta de comandos | Eliminación más amplia de sesiones, no un ajuste de visualización ni de tamaño del contexto |

**Contenido de los mensajes** se aplica a todas las conversaciones. Elige un preajuste (**Nada**, **Mínimo**, **Equilibrado** o **Todo**) en su parte superior o en **Configuración → Chat** y después ajusta filas individuales; el menú de preajustes de **Contenido de los mensajes** muestra entonces **Personalizado**. Ocultar herramientas no las desactiva, no cambia permisos ni elimina la salida almacenada. Para mantener la fluidez de representación, los mensajes muy grandes muestran **Mostrar … más** en un hueco omitido, y los textos o salidas de herramientas muy largos se detienen en una línea **… caracteres más ocultos** con **Mostrar todo**, o **Mostrar … más** cuando queda mucho, lo que puede requerir varios pasos. Revelar cualquiera de ellos solo afecta a la visualización y no recupera contenido eliminado. Arrastra sobre sus botones de ojo o de flecha para ajustar varias filas a la vez: el primer botón del que sales cambia, y cada botón que cruzas en la misma columna toma su nuevo estado. La conversación se actualiza al soltar el botón.

## Compactar una sesión {#compact-session}

1. Selecciona la conversación deseada.
2. Ejecuta **Compactar sesión** desde la paleta de comandos.
3. Espera el resultado nativo de compactación o inspecciona **La compactación falló** antes de decidir si reintentar.

La compactación cambia el contexto que OpenCode usa para continuar la sesión. No promete borrar los mensajes anteriores almacenados: la búsqueda en todo el historial y la limpieza técnica siguen pudiendo alcanzar el contenido anterior a la compactación. No compactes como sustituto de eliminar historial sensible almacenado.

## Eliminar herramientas y razonamiento {#technical-cleanup}

1. Elige la acción de una respuesta o ejecuta **Eliminar herramientas y razonamientos de la sesión** para la sesión seleccionada.
2. Revisa los recuentos previstos de herramientas/razonamientos y cualquier advertencia de contenido omitido.
3. Confirma **Eliminar**. Para el trabajo sobre toda la sesión, sigue el progreso sobre la transcripción y usa su control de cancelación si es necesario.

Solo se eliminan herramientas y razonamientos completados aptos. No se depura contenido activo/incompleto, ni un mensaje de más de 16 MB tal como lo lee OpenCode (archivos adjuntos incluidos), que cuenta como contenido omitido; el contenido cambiado se rechaza en lugar de ampliar silenciosamente lo que confirmaste. El texto final y los metadatos de mensajes/sesión permanecen, pero la salida técnica eliminada no se puede recuperar. Conserva lo que necesites antes de confirmar.

La limpieza de una sesión no es atómica para toda ella. Las eliminaciones anteriores correctas permanecen si un mensaje posterior entra en conflicto o falla. **La cancelación detiene los lotes futuros; no revierte un lote ya enviado**, que aún puede confirmarse.

Ante un error de almacenamiento ocupado, espera a que terminen la ejecución y el trabajo de almacenamiento actuales. Ante un error de mensaje cambiado, recarga y selecciona de nuevo. Si un plugin no está disponible, reconecta/vuelve a abrir CodeNomad e inspecciona el error antes de reintentar. Tras una respuesta incierta, actualiza y evalúa el contenido restante; no supongas que no ocurrió nada ni que se limpió toda la sesión.

## Eliminar y depurar sesiones {#delete-scrub}

Eliminar una sesión padre también elimina sus subsesiones descendientes y su historial. Inspecciona la familia de conversaciones antes de confirmar. La limpieza de especialistas de Misiones es distinta: conserva las sesiones que tienen hijos.

1. Prefiere **Eliminar sesión** en una fila específica cuando sepas exactamente qué conversación debe desaparecer.
2. Para un mantenimiento más amplio, ejecuta **Depurar sesiones** y lee la confirmación **Limpieza profunda de sesiones**.
3. Confirma solo si se pueden eliminar las sesiones vacías, las sesiones de subagentes completadas y las bifurcaciones sin usar.

La depuración actúa sobre las sesiones candidatas conocidas del proyecto actual y puede eliminar más que sesiones principales vacías. No es una operación de archivado y no se puede deshacer. No la uses solo para ocultar una barra lateral ocupada. La preferencia independiente **Limpieza automática de sesiones en blanco** es más limitada: comprueba que una sesión esté realmente vacía en lugar de considerar vacía una transcripción no cargada.

La eliminación borra conversaciones, no commits de Git, y no revierte efectos sobre el sistema de archivos o sistemas externos. Si la limpieza solo tiene éxito parcial, las sesiones ya eliminadas siguen eliminadas. Revisa la lista restante y los errores antes de reintentar. Consulta [Conversaciones](conversations.md) para bifurcaciones/deshacer y [Proyectos](projects.md) para eliminar carpetas temporales o worktrees.
