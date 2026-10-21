# Historial, búsqueda y limpieza

El historial almacenado, lo que muestra actualmente la transcripción y el contexto compactado del modelo son cosas distintas. Elige navegar o filtrar antes de eliminar nada.

## Buscar en todo el historial {#full-history-search}

1. Abre **Buscar en el historial del chat** en la cabecera de la conversación o usa su atajo configurado (por defecto **Ctrl/Cmd+F**).
2. Selecciona **Toda la sesión** o **Todo el espacio de trabajo** e introduce un término de búsqueda.
3. Activa **Incluir herramientas y razonamiento** si necesitas contenido técnico además del texto legible.
4. Selecciona un fragmento o usa **Siguientes resultados** para continuar más allá de la página actual.

La búsqueda es literal y no distingue mayúsculas de minúsculas; recorre el historial almacenado, no solo las filas montadas de la transcripción. El ámbito del espacio de trabajo sigue el árbol de directorios y los worktrees autorizados del proyecto abierto, no todos los proyectos del servicio OpenCode; sus resultados se agrupan por conversación, cada una identificada por su título y el worktree que la contiene actualmente. Los bytes de archivos/imágenes adjuntos y el estado opaco del proveedor no son texto buscable.

La línea de progreso **Esta página: … resultados · … mensajes examinados** describe esta página de resultados, no los totales del espacio de trabajo. Los resultados llegan por lotes. Se informa de los mensajes demasiado grandes o no compatibles omitidos; la ausencia de un resultado no demuestra que esos mensajes no contengan coincidencias. Los mensajes nuevos que llegan durante un análisis necesitan una búsqueda nueva para incluirse de forma coherente.

Abrir una búsqueda vacía no analiza el historial. Cambiar la consulta/el ámbito, cerrar la ventana o salir de la sesión cancela el trabajo de búsqueda obsoleto. Si falla una lectura, usa **Reintentar**; no envía un mensaje ni modifica el historial.

## Abrir resultados y usar la línea de tiempo {#timeline-navigation}

1. Elige un resultado de búsqueda de la sesión actual para saltar al pasaje que lo rodea.
2. Elige un resultado de otra sesión para abrir una vista previa independiente de ese mensaje; usa **Abrir en la sesión** para ir a esa conversación en el resultado.
3. En **Línea de tiempo de mensajes**, pasa el puntero o enfoca un marcador para ver un fragmento y selecciónalo para navegar. Usa los controles de primer/último mensaje para volver a los extremos del historial almacenado.

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

**Contenido de los mensajes** se aplica a todas las conversaciones. Elige un preajuste (**Nada**, **Mínimo**, **Equilibrado** o **Todo**) en su parte superior o en **Configuración → Chat** y después ajusta filas individuales; el menú de preajustes de **Contenido de los mensajes** muestra entonces **Personalizado**. Ocultar herramientas no las desactiva, no cambia permisos ni elimina la salida almacenada. Para mantener la fluidez de representación, los mensajes muy grandes muestran **Mostrar … más** en un hueco omitido, y los textos o salidas de herramientas muy largos se detienen en una línea **… caracteres más ocultos** con **Mostrar todo**. Revelar cualquiera de ellos solo afecta a la visualización y no recupera contenido eliminado.

## Compactar una sesión {#compact-session}

1. Selecciona la conversación deseada.
2. Ejecuta **Compactar sesión** desde la paleta de comandos.
3. Espera el resultado nativo de compactación o inspecciona **La compactación falló** antes de decidir si reintentar.

La compactación cambia el contexto que OpenCode usa para continuar la sesión. No promete borrar los mensajes anteriores almacenados: la búsqueda en todo el historial y la limpieza técnica siguen pudiendo alcanzar el contenido anterior a la compactación. No compactes como sustituto de eliminar historial sensible almacenado.

## Eliminar herramientas y razonamiento {#technical-cleanup}

1. Elige la acción de una respuesta o ejecuta **Eliminar herramientas y razonamientos de la sesión** para la sesión seleccionada.
2. Revisa los recuentos previstos de herramientas/razonamientos y cualquier advertencia de contenido omitido.
3. Confirma **Eliminar**. Para el trabajo sobre toda la sesión, sigue el progreso sobre la transcripción y usa su control de cancelación si es necesario.

Solo se eliminan herramientas y razonamientos completados aptos. No se depura contenido activo/incompleto; el contenido cambiado se rechaza en lugar de ampliar silenciosamente lo que confirmaste. El texto final y los metadatos de mensajes/sesión permanecen, pero la salida técnica eliminada no se puede recuperar. Conserva lo que necesites antes de confirmar.

La limpieza de una sesión no es atómica para toda ella. Las eliminaciones anteriores correctas permanecen si un mensaje posterior entra en conflicto o falla. **La cancelación detiene los lotes futuros; no revierte un lote ya enviado**, que aún puede confirmarse.

Ante un error de almacenamiento ocupado, espera a que terminen la ejecución y el trabajo de almacenamiento actuales. Ante un error de mensaje cambiado, recarga y selecciona de nuevo. Si un plugin no está disponible, reconecta/vuelve a abrir CodeNomad e inspecciona el error antes de reintentar. Tras una respuesta incierta, actualiza y evalúa el contenido restante; no supongas que no ocurrió nada ni que se limpió toda la sesión.

## Eliminar y depurar sesiones {#delete-scrub}

Eliminar una sesión padre también elimina sus subsesiones descendientes y su historial. Inspecciona la familia de conversaciones antes de confirmar. La limpieza de especialistas de Misiones es distinta: conserva las sesiones que tienen hijos.

1. Prefiere **Eliminar sesión** en una fila específica cuando sepas exactamente qué conversación debe desaparecer.
2. Para un mantenimiento más amplio, ejecuta **Depurar sesiones** y lee la confirmación **Limpieza profunda de sesiones**.
3. Confirma solo si se pueden eliminar las sesiones vacías, las sesiones de subagentes completadas y las bifurcaciones sin usar.

La depuración actúa sobre las sesiones candidatas conocidas del proyecto actual y puede eliminar más que sesiones principales vacías. No es una operación de archivado y no se puede deshacer. No la uses solo para ocultar una barra lateral ocupada. La preferencia independiente **Limpieza automática de sesiones en blanco** es más limitada: comprueba que una sesión esté realmente vacía en lugar de considerar vacía una transcripción no cargada.

La eliminación borra conversaciones, no commits de Git, y no revierte efectos sobre el sistema de archivos o sistemas externos. Si la limpieza solo tiene éxito parcial, las sesiones ya eliminadas siguen eliminadas. Revisa la lista restante y los errores antes de reintentar. Consulta [Conversaciones](conversations.md) para bifurcaciones/deshacer y [Proyectos](projects.md) para eliminar carpetas temporales o worktrees.
