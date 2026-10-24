# Archivos y Git

La pestaña **Archivos** del panel derecho combina exploración de copias de trabajo, cambios locales e historial de commits. Seleccionar una fila es distinto de abrir su lector central.

## Explorar una copia de trabajo {#browse-workspace}

1. Abre **Archivos** y elige **Espacio de trabajo**.
2. Selecciona **Worktree para consultar** cuando quieras otra copia de trabajo; expande las carpetas según necesites.
3. Haz clic en la fila de un archivo para seleccionarlo. Usa su acción del ojo para abrir o cerrar la vista previa central.
4. Usa **Actualizar** si necesitas volver a comprobar la instantánea visible.

| Modo | Qué lee | Efecto sobre la conversación |
| --- | --- | --- |
| Espacio de trabajo | Archivos de la copia de trabajo explorada | No mueve sesiones ni cambia de rama |
| Cambios | Cambios del índice y del árbol de trabajo | Las modificaciones de Git solo ocurren mediante acciones explícitas |
| Commits | Historial paginado de commits y contenido de revisiones | Historial de solo lectura; no cambia la copia de trabajo |

Las carpetas expandidas sobreviven a los cambios de modo. Las listas/el estado/el historial usan instantáneas en caché y se revalidan tras cambios relevantes del sistema de archivos, al activarse o con una actualización explícita; enfocar el panel no garantiza una lectura nueva. Las carpetas visibles de Espacio de trabajo detectan por sí solas los archivos creados, editados, renombrados o eliminados en el equipo del backend, como máximo una vez cada cinco segundos durante una actividad continua; las carpetas contraídas y los demás worktrees solo se vuelven a leer cuando los muestras.

Las acciones de fila incluyen **Copiar ruta** y, cuando el cliente permite abrir rutas del backend, acciones de administrador de archivos/editor/terminal como **Abrir con la aplicación predeterminada**, **Mostrar en la carpeta**, **Abrir en el explorador de archivos** y **Abrir terminal aquí**. Las acciones pueden trasladarse a **Más acciones para {name}** cuando el espacio es limitado; el nombre del archivo o carpeta reemplaza `{name}`. Un navegador remoto no puede suponer que una ruta del servidor es local al dispositivo; consulta [Control remoto](remote-control.md).

## Editar código fuente y guardar con seguridad {#edit-save}

1. Abre un archivo de texto de Espacio de trabajo con su acción del ojo.
2. Para Markdown, elige **Mostrar fuente** para editar o **Vista previa Markdown** para leer su representación.
3. Edita y elige **Guardar**, o pulsa **Ctrl/Cmd+S** mientras el editor tenga el foco.
4. Si el archivo cambió externamente, revisa la confirmación de sobrescritura; elige **Cancelar** para conservar tu borrador sin sobrescribir ese cambio.

Guardar escribe el archivo real en la copia de trabajo explorada, incluido un worktree vinculado; no envía un mensaje ni prepara/confirma la edición. Al guardar se vuelve a leer primero el archivo autoritativo. El diálogo de conflicto dice **El archivo fue modificado por el agente. ¿Sobrescribir los cambios del agente?**; trata con el mismo cuidado los cambios de cualquier otro escritor externo.

Los borradores de código fuente modificados se conservan en la memoria del renderer por instancia de proyecto, directorio y ruta cuando se cierran o cambian los lectores. Las actualizaciones del sistema de archivos no los reemplazan silenciosamente. No es almacenamiento duradero de archivos: guarda o copia las ediciones importantes antes de reiniciar/recargar el cliente. Los fallos de lectura/escritura conservan el borrador. **Actualizar** explícitamente advierte antes de descartar ediciones sin guardar.

Cerrar el lector con su botón de cierre final devuelve a la conversación; el editor de mensajes permanece disponible debajo del lector. Cambiar de sesión/worktree borra el lector seleccionado, lo que no implica que se guarde su borrador. Abrir una vista previa de navegador reemplaza el lector; abrir un archivo devuelve esa vista al modo de chat.

## Vistas previas de solo lectura y acotadas {#preview-limits}

1. Abre una imagen, un archivo binario o un cambio histórico con la acción del ojo.
2. Para una diferencia, usa **Cambiar a vista dividida** / **Cambiar a vista unificada**, ajuste de línea y controles de regiones sin cambios según necesites.
3. Cierra el lector para volver al chat.

| Contenido | Comportamiento disponible |
| --- | --- |
| Texto del espacio de trabajo, incluido el código fuente Markdown | Editable con Guardar explícito |
| Imagen del espacio de trabajo | Vista previa de imagen de solo lectura |
| Otro contenido binario | Alternativa de vista previa no disponible, de solo lectura |
| Diferencia de texto de Cambios/Commits | Comparación de solo lectura, no un editor para ninguno de los lados |
| Diferencia de imagen de Git | Imágenes Antes/Después de las revisiones exactas comparadas |

Las lecturas de vista previa están acotadas; el contenido grande/no compatible puede no estar disponible en lugar de cargarse sin límite. Las imágenes históricas nunca se sustituyen por el archivo actual del worktree. Un fallo de vista previa no significa que el archivo subyacente no exista. Abre el archivo con una aplicación externa adecuada cuando esté disponible, sin cambiar su revisión solo para obtener una vista previa.

## Preparar, retirar de preparación y confirmar {#stage-commit}

1. Elige **Cambios** e inspecciona **Cambios preparados** y **Cambios**.
2. Usa **Preparar archivo** / **Quitar del área preparada**, selecciona varias filas para la acción correspondiente sobre archivos seleccionados o arrastra filas entre las secciones.
3. Introduce un mensaje en la parte superior de **Cambios preparados** y elige **Commit**.

Las cabeceras de secciones contraídas siguen aceptando archivos arrastrados. Contraer secciones o cambiar de modo conserva su estado y el borrador del mensaje de commit. Una sección larga muestra sus primeros 200 archivos y después una línea como **480 archivos no mostrados** con **Mostrar 200 más** para revelar los siguientes en su lugar; los recuentos de sección siguen siendo los totales completos, y los archivos actual, en vista previa y seleccionados permanecen visibles. Los rangos con Mayús+clic solo cubren las filas mostradas, de modo que una acción masiva nunca incluye un archivo que no puedes ver. Preparar/retirar de preparación cambia el índice en el worktree explorado; confirmar registra solo el contenido preparado. Retirar del área preparada no descarta la edición del worktree.

Revisa los archivos preparados antes de confirmar, sobre todo cuando agentes u otro cliente también escriban allí. Un commit fallido no se repite automáticamente. Actualiza el estado/historial e inspecciona el error antes de reintentar, porque una respuesta perdida no demuestra que no se haya creado un commit.

## Leer el historial de commits {#commit-history}

1. Elige **Commits** y selecciona uno para leer su mensaje y los archivos cambiados.
2. Usa **Filtrar commits cargados…** para filtrar el conjunto cargado o **Cargar commits anteriores** para obtener otra página.
3. Abre un archivo cambiado con su acción del ojo.

El historial de texto compara el commit con su primer padre (o una base vacía para un commit raíz). No cambia HEAD ni mueve sesiones. Filtrar commits cargados no es una búsqueda del registro Git de todo el servidor. Actualiza para partir del historial actual después de nuevos commits; la paginación existente conserva la instantánea inicial del historial.

## Espacios en blanco y finales de línea {#whitespace-line-endings}

1. Abre **Configuración → Avanzado → Ocultar cambios solo de espacios**.
2. Desactívalo si necesitas inspeccionar ediciones sin preparar que solo cambian espacios en blanco y se omiten en Cambios.
3. Revisa la diferencia real y el contenido preparado antes de confirmar.

El ajuste está activado por defecto. Su efecto principal es ocultar de la lista Cambios, los recuentos, la selección, la preparación masiva y las acciones de arrastre las modificaciones de texto con seguimiento, sin preparar, que solo cambian espacios en blanco y cumplen los criterios. Los archivos ocultos permanecen sin preparar. Los archivos preparados siguen visibles, al igual que los archivos sin seguimiento, añadidos/eliminados/renombrados y binarios. Una detección fallida/no compatible mantiene los archivos visibles en lugar de adivinar.

La detección de listas de Git puede ignorar espacios interiores, cambios solo de CRLF y saltos de línea finales añadidos/eliminados. La comparación de espacios en blanco del lector de diferencias es más limitada: sangría y espacios/tabulaciones finales, no todos los espacios interiores. Preparar y Commit siempre actúan sobre el contenido exacto, independientemente de la preferencia de visualización.

Las diferencias de final de línea y marca de orden de bytes pueden producir una nota informativa en lugar de líneas resaltadas. Desactivar el ajuste no hace que el editor dibuje todos los cambios de final de línea/BOM ni todos los intercambios de espacios finales de igual longitud. Una diferencia visualmente vacía no demuestra que los bytes sean idénticos.

## Inicializar Git {#initialize-git}

1. Abre **Cambios** o **Commits** en una carpeta que no sea un repositorio.
2. Elige **Inicializar Git**; se ejecuta inmediatamente sin confirmación.
3. Espera a que se actualicen proyecto/sesión y después prepara y confirma explícitamente cuando esté listo.

La inicialización crea `.git` en la carpeta abierta explícitamente; no inicializa un directorio padre ni crea un primer commit. Si falta Git en el backend, siguen siendo posibles las conversaciones limitadas al directorio y la exploración de Espacio de trabajo, pero la inicialización y las operaciones Git no están disponibles. Ante un fallo incierto, actualiza antes de reintentar; ninguna solicitud de inicialización se repite automáticamente. Consulta [Proyectos](projects.md).
