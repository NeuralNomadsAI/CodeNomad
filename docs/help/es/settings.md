# Configuración y disposición

Preferencias usa el servidor del proyecto seleccionado para sus ajustes, proveedores, estadísticas y memoria, incluida la limpieza. Si el servidor no está disponible, los controles del proyecto permanecen inactivos. Los ajustes del dispositivo y los SideCars siguen siendo locales. Los ajustes de Imágenes y Búsqueda web corresponden al servidor del proyecto, incluidos sus valores globales.

## Abrir la configuración e identificar el ámbito {#open-settings}

1. Abre **Configuración** con el engranaje **Abrir configuración** de la barra de pestañas. Accesos directos como **Gestionar proveedores** en el selector de modelos, el engranaje del panel Misiones o el engranaje **Configuración** del historial de notificaciones abren directamente la sección correspondiente.
2. Selecciona una sección. Las ventanas locales de Electron y Tauri abren o enfocan una única ventana nativa de Preferencias; las vistas de navegador y remotas usan la pantalla de configuración integrada.
3. Comprueba el ámbito del ajuste y cualquier acción de **Guardar** antes de salir.

La mayoría de las elecciones se aplican inmediatamente, incluidas las preferencias de Misiones, que guardan cada cambio en cuanto lo haces. Los ajustes de las API de voz, los colores de paletas personalizadas y Archivos de configuración requieren pulsar **Guardar**. Pasa el puntero o enfoca la **i** junto al título de un ajuste para ver una explicación breve. Cuando enlaza a la ayuda, haz clic, pulsa Intro o tócala para abrir la sección correspondiente en el idioma de la interfaz, en el navegador del sistema o en otra pestaña. Los iconos que solo tienen una descripción la muestran al tocarlos. **Configuración → Info** también incluye la tarjeta **Apoyar a CodeNomad**: **Patrocinar o contribuir** abre la página [Apoyar a CodeNomad](sponsor.md).

| Estado | Qué controla |
| --- | --- |
| Configuración de CodeNomad | Preferencias de interfaz compartidas y opciones marcadas como **Configuración del servidor**, como la API de voz, SideCars, Control remoto y Variables de entorno. |
| Motores de voz | El [motor de dictado de escritorio](voice.md#desktop-dictation) se aplica a todos los proyectos del dispositivo. El [motor de conversación](voice.md#conversation) se elige para el perfil de escritorio o para el perfil del navegador y el servidor conectado. |
| Disposición de ventana/pestaña de proyecto | Paneles abiertos, pestañas seleccionadas, estado del lector y borradores/disposición restaurables. No son configuración de OpenCode. |
| Ajustes Global/Proyecto de OpenCode | Cambios nativos de plugins/configuración en el ámbito mostrado. Los controles de Proyecto requieren un proyecto/Location activo. |
| Perfil de datos de escritorio | Ventanas nativas, estado de restauración y almacenamiento del navegador, independientemente del archivo de configuración y del servicio compartido de OpenCode. Consulta [Ventanas y datos de escritorio](desktop.md). |

La pestaña seleccionada del panel derecho y el modo de Archivos se guardan por separado para cada pestaña de proyecto. Tus últimas elecciones explícitas proporcionan los valores predeterminados para las pestañas nuevas; los tamaños de los paneles, el orden de las pestañas, la personalización y la apariencia siguen siendo opciones de disposición y preferencias compartidas.

**Estadísticas** abarca todo el servicio OpenCode conectado (todos los proyectos, clones independientes y subsesiones), no solo la carpeta abierta, durante los últimos 7, 30, 90 o 365 días. Necesita un proyecto abierto y muestra los tokens y el coste registrados por OpenCode, no facturas del proveedor ni cuotas de suscripción; los totales guardados anteriormente pueden aparecer mientras se actualiza. Las cuotas del plan pertenecen a la sección **Uso** de Estado.

## Idioma y apariencia {#language-appearance}

1. En **General**, selecciona **Idioma**: inglés, español, francés, ruso, japonés, chino simplificado, hebreo, alemán, nepalí o turco.
2. En **Esquema de color**, elige **Modo**: **Auto**, **Oscuro** o **Claro**. Auto sigue al sistema operativo.
3. Junto a **Modo**, elige **Contraste**: **Auto** (predeterminado) sigue la preferencia de contraste del sistema; **Activado** aumenta el contraste de cualquier paleta; **Desactivado** usa el contraste normal.
4. Elige una paleta para la apariencia mostrada. Las selecciones clara y oscura se guardan por separado; Auto usa la correspondiente.
5. Para colores personalizados, usa las muestras y **Guardar**; **Restablecer** restaura los colores de una paleta integrada. Usa **Nuevo** para dar nombre a otra paleta y **Eliminar** para quitar una que hayas creado.

El contraste se aplica y guarda inmediatamente, independientemente de **Guardar** los colores. Adapta la visualización y conserva la paleta seleccionada, los colores editables y el borrador de conversación. La **i** muestra el estado actual del contraste en Auto.

La interfaz se actualiza sin reiniciar una conversación. El hebreo usa disposición de derecha a izquierda; el código y los valores técnicos siguen legibles en su propia dirección. La selección de idioma cambia el texto de la interfaz, no el idioma de los mensajes existentes ni las instrucciones del agente. Los menús nativos de escritorio pasan al idioma de la interfaz en cuanto se ha cargado una ventana de CodeNomad.

Si los colores se vuelven difíciles de leer, elige **Contraste → Activado**. También puedes seleccionar una paleta integrada o restablecer la editada. Cambiar de paleta puede pedir que descartes ediciones de color sin guardar; el borrador de conversación se conserva.

## Mantener el ordenador activo {#keep-computer-awake}

En **Configuración → General**, **Mantener el ordenador activo mientras CodeNomad esté en ejecución** está desactivado por defecto. Actívalo para impedir la suspensión del sistema mientras haya una ventana local de CodeNomad abierta (aunque esté minimizada), incluso si ninguna sesión está trabajando; la pantalla puede seguir apagándose. Si se desactiva, CodeNomad mantiene el ordenador activo solo mientras una sesión está trabajando. La opción aparece solo en las ventanas locales de la aplicación de escritorio y en Preferencias; está oculta en las vistas de navegador y remotas.

## Permisos de las conversaciones nuevas {#new-conversation-permissions}

En **Configuración → General → Permisos de las conversaciones nuevas**, elige **Autónomo** (el valor predeterminado) o **Supervisado** para las conversaciones principales que crees en CodeNomad. Las conversaciones existentes no cambian. Para cambiar el modo de una de ellas, abre [Estado → Permisos](permissions.md#conversation-mode) en esa conversación.

## Memoria persistente del agente {#agent-memory}

Los usuarios autenticados mediante Control remoto, HTTPS verificado, LAN o una PWA instalada pueden revisar y editar la memoria del proyecto local o remoto seleccionado y usar **Ordenar**.

CodeNomad intenta retirar las instrucciones de memoria obsoletas de la sesión; si esa limpieza también falla, las anteriores pueden permanecer hasta una actualización correcta.

Abre **Preferencias → General → Memoria** (o **Configuración → General** en el navegador). La memoria está desactivada por defecto. Actívala para que el agente conserve hechos y preferencias útiles entre conversaciones. El interruptor se aplica a la configuración CodeNomad conectada; desactivarlo conserva las entradas y su historial. Mientras está desactivada, los agentes no reciben ninguna herramienta de memoria; el cambio se aplica a las conversaciones en curso en pocos segundos, sin reiniciar.

- **Acerca de ti**: hasta 60 entradas compartidas entre los proyectos de esta configuración.
- **Proyecto**: hasta 200 entradas. Esta interfaz usa el proyecto seleccionado en Preferencias, o el proyecto activo de la ventana principal en los ajustes integrados. El servidor identifica el repositorio por su dirección remota Git normalizada, con la ruta local del repositorio como alternativa; los worktrees comparten esta memoria. Abre un proyecto para seleccionar este ámbito.

1. Selecciona un ámbito, despliega su número de entradas (por ejemplo **7/200**) y selecciona una entrada. **Nuevo** y **Modificado** señalan cambios desde la última vez que se mostraron las entradas de ese ámbito en esta vista del navegador o escritorio; la línea del contador plegada también los muestra, y siguen visibles durante la visita actual.
2. Edita **Título**, **Tipo** (**Hecho**, **Preferencia** o **Referencia**) y **Texto**, y pulsa **Guardar**. El título admite 60 caracteres y el texto 2000. **Cancelar** restaura el contenido guardado. Si alguien modificó la entrada, usa **Recargar** y revísala antes de guardar de nuevo.
3. Para quitar una entrada, abre su menú de acciones y confirma **Olvidar**. Sale de la memoria activa; Git conserva su historial local, incluido el texto anterior. Olvidar retira la entrada del uso del agente, sin borrarla de forma segura.
4. Si la memoria está llena, combina u olvida entradas antes de reintentar. Los títulos coincidentes o textos muy similares reemplazan una entrada existente; Git conserva su texto anterior.

**Requiere revisión** marca instrucciones sospechosas de eludir protecciones o revelar credenciales. Estas entradas siguen siendo editables aquí, cuentan para el límite y se excluyen de los títulos y lecturas del agente. Se comprueban en cada lectura; corrige y guarda el contenido o usa **Olvidar**.

**Ordenar** pide confirmación y abre una conversación nueva en el proyecto mostrado en Preferencias para verificar y combinar el ámbito seleccionado. Conserva las entradas no verificables y las referencias externas e informa de los cambios. Requiere un proyecto abierto y memoria activada, legible y escribible con al menos una entrada sin marcar.

La memoria la mantiene el agente. Si ya mantiene otra, como `.claude/…/MEMORY.md`, guarda una **Referencia** a ese archivo; los archivos externos conservan su propia gestión. El almacenamiento es solo local, sin sincronización remota. Consulta [Ventanas y datos de escritorio](desktop.md) para los límites de configuración y perfiles.

## Paneles y secciones de Estado {#panels-status}

**Estado** aparece primero por defecto; el orden de pestañas guardado tiene prioridad. Sigue disponible. En **Personalizar panel derecho**, su flecha contrae o expande la lista de casillas de sus secciones sin ocultar las propias secciones.

Arrastra el borde interior de un panel acoplado para cambiar su tamaño.

1. Usa **Panel izquierdo** y **Panel derecho** en las esquinas de la cabecera exterior, o sus opciones del menú **Ver**, para mostrar u ocultar cada panel.
2. Abre **Personalizar panel derecho** en el panel derecho. Usa las casillas para elegir pestañas integradas y secciones de Estado; al menos una sección de Estado permanece visible. Arrastra sobre estas casillas para ajustar varias a la vez.
3. Arrastra las pestañas del panel derecho para reordenarlas. Usa **Restablecer** para restaurar las elecciones de disposición integradas.

Reordena cualquier sección de Estado arrastrando por su asa o con las teclas Arriba/Abajo. La visibilidad y el orden persisten al recargar.

Estado incluye información de tokens, Permisos, Uso del proveedor, shells en segundo plano, MCP y Plugins. Mientras la conversación tiene un [objetivo](conversations.md#goal), una línea de objetivo encima de estas secciones lo muestra; esa línea no es una sección y no se puede ocultar ni mover. Ocultar una sección no desactiva su servicio ni revoca permisos. Las disposiciones estrechas cierran los paneles que ya no caben en lugar de estrechar la conversación; un panel abierto en ellas flota sobre la conversación, y abrir un panel flotante cierra el otro.

La disposición integrada pertenece a la ventana. La [casilla Misiones](missions.md#activation) también cambia la activación global del plugin y se omite al arrastrar sobre varias casillas. Las casillas de extensiones activan código en todos los proyectos que usan la configuración. **Restablecer** no cambia el consentimiento de extensiones. Consulta [Extensiones de panel](extensions.md).

## Detalle de la transcripción y tamaño del editor {#transcript-composer}

1. Abre **Chat** para elegir los valores de detalle de la transcripción. Los preajustes son **Nada**, **Mínimo**, **Equilibrado** y **Todo**; los cambios individuales producen **Personalizado**.
2. Establece el **Estado predeterminado** de cada fila (**Oculto**, **Colapsado** o **Expandido**) o usa el popup **Contenido de los mensajes** de la conversación, que comparte estas opciones. En **Grupos de herramientas**, **Desactivado** muestra una tarjeta por llamada; **Colapsado** y **Expandido** determinan el estado inicial de los grupos.
3. En **General**, marca **Mostrar la cronología de mensajes**, **Colocar las flechas de primer/último mensaje bajo la cronología**, **Dividir los diffs de las llamadas a herramientas** y **Poner en cola los prompts enviados** (pone en cola los prompts enviados mientras una sesión trabaja en lugar de dirigirla) según necesites.
4. Cambia el tamaño del editor con su control; los borradores largos se desplazan dentro del campo.

La línea de tiempo tiene un marcador por cada respuesta, razonamiento, herramienta, compactación y contexto del sistema que muestra la conversación, en el mismo orden. Sus marcadores siguen **Contenido de los mensajes**: ocultar allí un tipo de herramienta, el razonamiento o los mensajes del sistema también oculta sus marcadores, salvo el de una herramienta con un permiso pendiente, y **Nada** oculta todos los marcadores de herramientas. Los ajustes de visibilidad y expansión solo cambian la presentación. No eliminan herramientas/razonamientos almacenados ni compactan el contexto del modelo. Consulta [Historial y limpieza](history.md) para operaciones destructivas.

El ajuste manual del editor toma como referencia la altura de la conversación sin el teclado en pantalla: mínimo del 8 % con un límite inferior de 44 px, máximo del 60 %. Una pantalla estrecha o un texto largo no elevan esos límites. Al abrirse el teclado, el campo puede reducirse temporalmente para dejar espacio a los controles y mensajes, sin cambiar la proporción de altura guardada. Un permiso/pregunta expandido minimiza temporalmente el editor sin cambiar su altura guardada ni su borrador. Contrae o resuelve la solicitud para volver a cambiar su tamaño.

## Notificaciones e indicadores {#notifications}

Para una pestaña de proyecto en otro servidor CodeNomad, las notificaciones incluyen el nombre del servidor. **Ver conversación** abre ese proyecto y esa conversación exactos; desconectar el servidor elimina sus avisos.

La compactación de las sesiones técnicas de las misiones no genera avisos.

1. Abre **Notificaciones**. Para cada tipo de notificación, marca dónde aparece: **En pantalla** (una burbuja temporal), **Historial** (se conserva en el historial de notificaciones de la campana de la barra de pestañas) y **Sistema** (una notificación del sistema operativo). Arrastra sobre una fila o columna de casillas para ajustar varias a la vez.
2. Marcar una casilla **Sistema** pide permiso si hace falta. En **Notificaciones del sistema**, **Solicitar permiso** vuelve a pedirlo mientras falte el permiso.
3. Activa **Notificar cuando la app tenga el foco** para conservar las notificaciones del sistema mientras esta ventana tiene el foco. Si no, aparecen en cuanto no lo tiene, aunque siga abierta en pantalla.

Por defecto, **Una sesión espera tu respuesta** y **Una sesión ha terminado** van solo a Sistema, para que los estados pasajeros de las sesiones no se acumulen en Historial; se refieren a las sesiones principales, no a los subagentes, y una sesión que detienes tú no se anuncia. Los errores siempre aparecen en pantalla y en Historial, diga lo que diga la tabla, y los mensajes breves de progreso solo se quedan en pantalla.

El permiso del navegador/sistema operativo pertenece al dispositivo y al origen de la aplicación; una preferencia guardada no puede anular una denegación. Si está bloqueado, activa las notificaciones en los ajustes del navegador o sistema operativo y vuelve aquí. Los entornos no compatibles mantienen desactivada la columna Sistema.

El recuento de no leídos de la campana/historial, que solo cuenta las notificaciones dirigidas a Historial, controla el punto del favicon del navegador y el indicador nativo de la aplicación.

Si el sistema admite acciones de notificación, al hacer clic en una notificación se muestra la conversación si sigue abierta. Que la ventana pase al primer plano depende del entorno de escritorio.

## Opciones avanzadas {#advanced}

En Rune, enfoca la **i** junto a un interruptor desactivado para saber por qué no está disponible. El editor de configuración indica la línea de los errores de sintaxis JSON/JSONC y permite guardar.

1. Abre **Avanzado**.
2. Marca o desmarca solo las opciones que necesites; cada cambio se guarda mediante las preferencias de CodeNomad. Para cambiar el entorno de ejecución de las sesiones, expande el grupo plegado **Variables de entorno** al final.

| Opción | Efecto y precaución |
| --- | --- |
| Limpieza automática de sesiones en blanco | Limpia sesiones vacías al crear otras nuevas; déjala desactivada si quieres conservarlas. |
| Conservar marcadores de inactividad de subagentes | Conserva los marcadores de inactividad no vistos hasta que se visualizan en lugar de ocultarlos tras cinco segundos. |
| Enfocar la ventana existente en el segundo inicio | Solo escritorio nativo; cambia el comportamiento de la ventana en el segundo inicio, no la creación de pestañas. |
| Saldo de créditos del proveedor | Muestra saldos complementarios en Uso; no compra créditos ni cambia de cuenta. |
| Ocultar cambios solo de espacios | Omite archivos sin preparar con cambios solo de espacios/finales de línea de Cambios y sus acciones masivas; los archivos preparados siguen visibles. Consulta [Archivos](files.md). |
| Retener respuestas largas del asistente | Detiene el seguimiento automático cuando una respuesta en streaming supera el área visible. |
| Variables de entorno | Se aplican en el servidor antes de cada mensaje o comando de sesión; las lecturas no actualizan ejecuciones ya iniciadas. Consulta [configuración de OpenCode](opencode.md). |

Para configurar el teclado, consulta [Atajos de teclado](shortcuts.md). **Voz** reúne [Dictado, Reproducción y Conversación](voice.md). La restauración al iniciar y los perfiles de datos se explican en [Ventanas y datos de escritorio](desktop.md).
