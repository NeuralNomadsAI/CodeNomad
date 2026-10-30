# Extensiones de panel

## Explorar extensiones instaladas y en línea {#browse}

1. Abre **Personalizar panel derecho** en la barra de pestañas del panel derecho.
2. Expande **Extensiones** debajo del separador.
3. Usa **Buscar extensiones** para buscar en la lista única de complementos instalados y del catálogo oficial en línea. Pasa el puntero o enfoca una entrada para ver sus metadatos.

La sección empieza contraída cada vez que se abre el popup de personalización. Las entradas instaladas y en línea se combinan por ID de extensión; no hay ventana de gestión separada ni modos instalado/en línea. Explorar metadatos del catálogo no descarga ni ejecuta el código del panel del autor. El catálogo se mantiene en [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions); la inclusión y los nombres de autor declarados no son firmas ni pruebas de confianza.

Si el catálogo no está disponible, las extensiones instaladas y **Instalar desde ZIP…** siguen disponibles. Actualiza para reintentar el descubrimiento. Contraer o cerrar el popup abandona su interfaz de revisión/confirmación pendiente; no instala nada silenciosamente.

## Revisar e instalar desactivada {#install}

1. Elige **Instalar…** en una entrada del catálogo o **Instalar desde ZIP…** para un paquete obtenido por separado.
2. Revisa el ID del paquete, autor, repositorio, versión, API/permisos y resumen SHA-256. Expande los detalles técnicos cuando lo necesites.
3. Verifica al editor y, cuando sea posible, compara el resumen por un canal de confianza.
4. Solo si confías en el código, selecciona **Confío en este paquete y en su autor** y después **Instalar desactivada**.

La inspección descarga/revalida el paquete seleccionado; no ejecuta el código del autor. Un resumen identifica bytes exactos, no la identidad del autor. Los paquetes del catálogo proceden del recurso exacto declarado de una versión de GitHub, no de una URL arbitraria. Los paquetes manuales son ZIP que contienen solo `manifest.json` y un `panel.html` autónomo; los paquetes inválidos o no compatibles se rechazan.

La instalación no necesita reiniciar OpenCode y nunca concede activación automáticamente. Un fallo de validación, conflicto u operación de almacenamiento no autoriza a reintentar con bytes distintos. Vuelve a inspeccionar el paquete antes de un nuevo intento de instalación.

## Activar y comprender el ámbito {#activate-scope}

1. Vuelve a la fila del complemento sobre la sección **Extensiones** en **Personalizar panel derecho**. Los complementos instalados desactivados permanecen en esa lista.
2. Marca su casilla para activarlo. Desmarca esa misma casilla para desactivarlo.

Esa casilla es el único control de activación: no hay un interruptor adicional en un gestor ni una barrera de visibilidad por ventana. La activación abarca todos los proyectos de la configuración, no una carpeta. En una conexión remota afecta al almacén de extensiones instaladas del servidor, no solo al dispositivo desde el que miras.

El almacén de extensiones es `panel-extensions/` junto a la configuración de CodeNomad seleccionada. Los perfiles de datos de escritorio separados **no** aíslan las extensiones cuando usan el mismo directorio de configuración. A la inversa, abrir otra configuración no concede permiso para ejecutar un complemento instalado en otro lugar. Consulta [Ventanas y datos de escritorio](desktop.md) para la distinción.

Un panel activado puede montarse al seleccionarlo; ocultarlo puede descartar su estado temporal de interfaz. Desactivarlo revoca su activación. **Restablecer** en personalización solo restaura la disposición integrada y no activa, desactiva ni desinstala extensiones.

## Reemplazar o eliminar {#replace-remove}

1. Usa **Cambiar versión…** o inspecciona otro ZIP con el mismo ID para reemplazar un paquete instalado.
2. Revisa el resumen y los permisos nuevos, confirma la confianza e instálalo desactivado.
3. Reactívalo mediante la casilla normal solo después de decidir confiar en el reemplazo.
4. Para desinstalar, usa **Eliminar…** y **Confirmar eliminación** tras revisar el objetivo.

Cada reemplazo revoca la activación en todos los proyectos, incluso si la lista de permisos no cambia, y borra los ajustes guardados propios del panel. Un fallo de validación/conflicto/almacenamiento conserva el paquete instalado. No hay actualizaciones silenciosas de extensiones. Eliminar borra el paquete, sus ajustes de activación y sus ajustes de panel guardados, no sesiones de OpenCode ni archivos del proyecto. Para recuperarte de código no deseado, desactívalo primero; reinstala solo un paquete verificado de confianza.

## Contexto, consentimiento de recursos y límites del aislamiento {#permissions-sandbox}

| Contrato | Qué permite la activación |
| --- | --- |
| API 1 / `session.context` | Identificador de sesión actual (o ninguno), idioma y apariencia de la interfaz. Sin texto de transcripción ni acceso al sistema de archivos. |
| API 2 / `session.assets.read` más contexto | Permiso revisado explícitamente para enumerar metadatos acotados de imágenes/adjuntos de resultados de herramientas de la sesión actual y leer bytes incrustados compatibles. No es acceso general a transcripciones, archivos o URL. |
| API 3 / `repository.workItems.read` más contexto | Permiso revisado explícitamente para listar páginas limitadas de issues y pull requests del repositorio del proyecto en GitHub, GitLab o Gitea/Forgejo, y abrir uno en el navegador. No es acceso a archivos, credenciales ni a la red en general. |
| API 4 / contexto más uno o varios de los permisos siguientes | La revisión muestra una frase por permiso declarado; la activación los concede todos juntos y un reemplazo los revoca todos. |
| `session.images.read` | Leer las imágenes devueltas por la herramienta read en la conversación mostrada, con el estado de generación y el linaje cuando puedan verificarse. |
| `session.images.prompts` (requiere `session.images.read`) | Leer el prompt y el modelo de cada imagen generada en la conversación Imágenes del proyecto. |
| `composer.prefill` | Añadir texto al editor de mensajes de la conversación mostrada. Nunca envía un mensaje. |
| `images.conversation` | Abrir o iniciar la conversación Imágenes de este proyecto. |
| `opencode.designAgent` | Añade el agente Design de CodeNomad y sus habilidades de imagen a OpenCode mientras esta extensión esté activada. |
| `panel.preferences` | Recordar los ajustes propios de este panel. |

El acceso a recursos sigue al anfitrión/sesión montado actualmente, no a una sesión elegida por el autor. Las referencias locales/remotas pueden enumerarse como no disponibles; la API de recursos no obtiene URL remotas arbitrarias ni abre archivos locales. Cambiar de sesión, desconectar o revocar el consentimiento invalida el acceso anterior.

Con la API 4, la lectura de imágenes sigue de la misma forma a la conversación mostrada y solo muestra las imágenes que el agente volvió a leer en ella. Una extensión con `session.images.prompts` puede leer los prompts escritos por ti o por el agente para imágenes en una conversación Imágenes, y podría transmitirlos pese al aislamiento, así que concédelo solo a autores a quienes se los confiarías. El texto añadido por `composer.prefill` permanece en el editor de mensajes hasta que lo edites o selecciones **Enviar mensaje**; nunca empieza con un comando, nunca termina con una mención `@` abierta y cita las rutas de imágenes como texto sin formato. Deshacer con Ctrl+Z (Cmd+Z en macOS) en el editor de mensajes no lo elimina. Los ajustes de panel guardados pertenecen a este perfil de CodeNomad, como máximo 4 KiB por extensión; desactivar una extensión los conserva.

Los elementos provienen del remoto `upstream` de la carpeta del proyecto o, si no existe, de `origin`. CodeNomad los lee con la CLI de GitHub, GitLab o Gitea en la que ya iniciaste sesión (`gh`, `glab`, `tea`), o de forma anónima en repositorios públicos, y no guarda ningún token; la extensión solo ve el nombre del repositorio y los elementos. La lectura anónima cubre github.com, gitlab.com, codeberg.org y gitea.com; una forja autoalojada solo se lee mediante su CLI con sesión iniciada en ella. Abrir un elemento pide a CodeNomad que abra su página en la misma forja en tu navegador, como máximo una vez por segundo; la extensión no puede abrir otras direcciones.

El código del autor se ejecuta en un iframe restringido, no en el renderer de confianza de la aplicación. No recibe puente nativo/OpenCode, acceso a credenciales, RPC general, formularios, popups ni descargas; las API de red y los recursos externos están restringidos. Las extensiones son complementos de interfaz, no [plugins de OpenCode](integrations.md).

El aislamiento no es aislamiento de proceso/CPU ni una promesa de que el código aprobado sea inocuo. Una extensión hostil puede perturbar su renderer. Instala solo autores de confianza, no proporciones secretos y desactiva/elimina un complemento si se comporta inesperadamente.

## Crear imágenes con la extensión Design {#design}

La extensión **Design** es una mesa de luz para las imágenes que creas con el agente Design de CodeNomad en la **conversación de imágenes** de un proyecto. Muestra las imágenes, prepara solicitudes en el cuadro de mensaje y deja cada generación a los mensajes que tú envías.

1. Activa la generación de imágenes en **Configuración → Proveedores → Imágenes** y conecta un proveedor que ofrezca un modelo de imagen ([Generación y almacenamiento de imágenes](providers.md#images)).
2. En **Personalizar panel derecho → Extensiones**, instala **Design** desde el catálogo ([Revisar e instalar desactivada](#install)) después de revisar sus permisos ([Contexto, consentimiento de recursos y límites del aislamiento](#permissions-sandbox)) y marca su casilla ([Activar y comprender el ámbito](#activate-scope)).
3. Abre el panel **Design** y elige **Abrir la conversación de imágenes**.

Mientras la extensión está activada, CodeNomad añade a OpenCode su agente Design y sus habilidades de imagen. Tu propio agente `design` y tus propias habilidades `design-*` siempre tienen prioridad; cuando aportas tu propio agente `design`, el panel muestra **Se usa tu propio agente Design.** El panel también indica cuándo faltan la generación de imágenes, un modelo de imagen o el agente Design.

### Conversación de imágenes {#design-conversation}

Cada carpeta de proyecto o worktree tiene su propia conversación de imágenes, titulada **Imágenes**. **Abrir la conversación de imágenes** la encuentra, o la crea con el agente Design y el modelo que CodeNomad elige para una conversación nueva con ese agente, y la muestra con el foco en el cuadro de mensaje; abrirla no envía nada. Una conversación de imágenes existente conserva su propio modelo. **Nueva conversación de imágenes** empieza otra con la mesa de luz vacía, y el panel la sugiere cuando una conversación tiene muchas imágenes; **Abrir** muestra después la más reciente. Las conversaciones de imágenes archivadas o eliminadas se omiten.

Describe lo que necesitas y envíalo: el agente hace unas preguntas de encuadre, dice cuántas imágenes va a generar, las genera, vuelve a leer cada una y la critica. Las imágenes se guardan en `.codenomad/design/` de la carpeta del proyecto. CodeNomad añade esa carpeta a las exclusiones locales de Git del repositorio (`.git/info/exclude`) y deja intacto `.gitignore`; si no puede, el panel muestra **Las imágenes de esta ubicación pueden aparecer en Git.** Deshacer un turno quita sus imágenes de la mesa de luz pero conserva sus archivos, y una imagen que el agente sobrescribió no se puede recuperar. El agente pide imágenes de unos 1K píxeles, pero los proveedores pueden devolverlas más grandes, y varias imágenes grandes a la vez pueden ocupar mucha memoria en el servicio OpenCode compartido.

Si falta el agente Design en una conversación de imágenes que lo usa, el cuadro de mensaje muestra **El agente Design no está disponible** y bloquea el envío: elige **Usar el agente predeterminado** o vuelve a activar la extensión Design. Si el modelo de chat de la conversación no recibe imágenes, el panel avisa de que el agente no puede criticarlas visualmente; las imágenes que vuelve a leer siguen apareciendo en la mesa de luz.

### Mesa de luz {#design-light-table}

La **Mesa de luz** muestra las imágenes que el agente volvió a leer en la conversación mostrada, de la más reciente a la más antigua, agrupadas por respuesta. Al seleccionar una imagen se ve más grande, con vistas previas en **Tamaños pequeños** de 16, 32 y 64 px; **Comparar** pone dos imágenes lado a lado, y **Ver a tamaño completo** abre un visor. En un panel estrecho, ensánchalo para comparar. El linaje (**Creada a partir de**, **Usada para**) y, en la conversación de imágenes, el prompt y el modelo solo aparecen cuando CodeNomad puede verificar qué generación produjo la imagen; si no, la imagen conserva sus píxeles e indica **origen no verificable**. **Generaciones** enumera cada generación de imagen con su estado; sigue su progreso en la conversación. En otra conversación, el panel muestra las imágenes que se volvieron a leer en ella, sin prompts ni solicitudes, y ofrece abrir la conversación de imágenes.

En la conversación de imágenes, **Empezar desde** (una receta como un icono de app o un logotipo), **Refinar**, **Variantes**, **Aplicar dirección**, **Guardar en el proyecto…**, **Pedir al agente que la muestre** y **Reintentar** solo añaden texto editable al cuadro de mensaje: el panel nunca envía un mensaje ni genera una imagen. Las acciones sobre una imagen elegida citan su ruta relativa al proyecto, y solo se pueden citar imágenes del proyecto con un origen verificable. Edita la solicitud y envíala tú. **Guardar en el proyecto…** pide al agente que copie la imagen al destino que escribas después de la solicitud. **Imágenes por turno** (de 1 a 4, 3 por defecto) se incluye en las solicitudes que generan imágenes nuevas y se guarda en los ajustes del panel. En un teléfono, el panel flota y se cierra al añadir una solicitud.

### Usar el agente Design sin CodeNomad {#design-without-codenomad}

El agente Design y sus habilidades son archivos normales de OpenCode. Para usarlos en la TUI de OpenCode u otro cliente sin CodeNomad, copia el contenido de la [carpeta de contenido de Design](../../../packages/server/src/opencode/design/opencode/) en la carpeta `.opencode/` de un proyecto o en tu carpeta de configuración global de OpenCode (`~/.config/opencode/`), junto con `NOTICE.md` y la licencia. Después selecciona el agente **design**; carga sus habilidades por su nombre, y los demás agentes solo las usan cuando las nombras.

El agente Design y sus habilidades adaptan material de [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) y de [taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT); `NOTICE.md` enumera cada archivo adaptado. La extensión Design reutiliza código de la extensión MCP Assets (MIT).
