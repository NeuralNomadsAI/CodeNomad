# Configuración y disposición

## Abrir la configuración e identificar el ámbito {#open-settings}

1. Abre **Configuración** con el engranaje **Abrir configuración** de la barra de pestañas (la barra de título en la aplicación de escritorio de macOS) o de la página de inicio. Accesos directos como **Gestionar proveedores** en el selector de modelos, el engranaje del panel Misiones o el engranaje **Configuración** del historial de notificaciones abren directamente la sección correspondiente.
2. Selecciona una sección. Las ventanas locales de Electron y Tauri abren o enfocan una única ventana nativa de Preferencias; las vistas de navegador y remotas usan la pantalla de configuración integrada.
3. Comprueba el ámbito del ajuste y cualquier acción de **Guardar** antes de salir.

La mayoría de las elecciones se aplican inmediatamente, incluidas las preferencias de Misiones, que guardan cada cambio en cuanto lo haces. Voz, los colores de paletas personalizadas y Archivos de configuración conservan un **Guardar** explícito. Un guardado fallido no confirma que el cambio se haya aplicado; reabre o actualiza la sección correspondiente antes de reintentar. Las explicaciones están detrás de la **i** junto al título de un ajuste: pasa el puntero o enfócala, o tócala en una pantalla táctil.

| Estado | Qué controla |
| --- | --- |
| Configuración de CodeNomad | Preferencias de interfaz, voz, SideCars y ajustes de servidor para los clientes que usan esa configuración. Las preferencias sin etiqueta tampoco se guardan por dispositivo; **Configuración del servidor** marca la configuración del lado del servidor, como Voz, SideCars, Control remoto y Variables de entorno. |
| Disposición de ventana/pestaña de proyecto | Paneles abiertos, pestañas seleccionadas, estado del lector y borradores/disposición restaurables. No son configuración de OpenCode. |
| Ajustes Global/Proyecto de OpenCode | Cambios nativos de plugins/configuración en el ámbito mostrado. Los controles de Proyecto requieren un proyecto/Location activo. |
| Perfil de datos de escritorio | Ventanas nativas, estado de restauración y almacenamiento del navegador, independientemente del archivo de configuración y del servicio compartido de OpenCode. Consulta [Ventanas y datos de escritorio](desktop.md). |

**Estadísticas** abarca todo el servicio OpenCode conectado (todos los proyectos, clones independientes y subsesiones), no solo la carpeta abierta, durante los últimos 7, 30, 90 o 365 días. Necesita un proyecto abierto y muestra los tokens y el coste registrados por OpenCode, no facturas del proveedor ni cuotas de suscripción; los totales guardados anteriormente pueden aparecer mientras se actualiza. Las cuotas del plan pertenecen a la sección **Uso** de Estado.

Cambiar preferencias de visualización no reinicia OpenCode ni repite un mensaje. La configuración nativa, el mantenimiento del servicio y las credenciales tienen efectos independientes: consulta [configuración de OpenCode](opencode.md), [Proveedores](providers.md) e [Integraciones](integrations.md).

## Idioma y apariencia {#language-appearance}

1. En **General**, selecciona **Idioma**: inglés, español, francés, ruso, japonés, chino simplificado, hebreo, alemán, nepalí o turco.
2. En **Esquema de color**, elige **Modo**: **Auto**, **Oscuro** o **Claro**. Auto sigue al sistema operativo.
3. Elige una paleta para la apariencia mostrada. Las selecciones clara y oscura se guardan por separado; Auto usa la correspondiente.
4. Para colores personalizados, usa las muestras y **Guardar**; **Restablecer** restaura los colores de una paleta integrada. Usa **Nuevo** para dar nombre a otra paleta y **Eliminar** para quitar una que hayas creado.

La interfaz se actualiza sin reiniciar una conversación. El hebreo usa disposición de derecha a izquierda; el código y los valores técnicos siguen legibles en su propia dirección. La selección de idioma cambia el texto de la interfaz, no el idioma de los mensajes existentes ni las instrucciones del agente. Los menús nativos de escritorio pasan al idioma de la interfaz en cuanto se ha cargado una ventana de CodeNomad.

Si los colores se vuelven difíciles de leer, selecciona una paleta integrada o restablece la editada. Cambiar de paleta puede pedir que descartes ediciones de color sin guardar; no descarta un borrador de conversación.

## Paneles y secciones de Estado {#panels-status}

1. Usa **Panel izquierdo** y **Panel derecho** en las esquinas de la cabecera exterior, o sus opciones del menú **Ver**, para mostrar u ocultar cada panel.
2. Abre **Personalizar panel derecho** en el panel derecho. Usa las casillas para elegir pestañas integradas y secciones de Estado; al menos una sección de Estado permanece visible.
3. Arrastra las pestañas del panel derecho para reordenarlas. Usa **Restablecer** para restaurar las elecciones de disposición integradas.

Estado incluye información de tokens, modo Yolo, Uso del proveedor, shells en segundo plano, MCP y Plugins. Ocultar una sección no desactiva su servicio ni revoca permisos. Las disposiciones estrechas hacen flotar los paneles sobre la conversación en lugar de estrecharla; abrir un panel flotante cierra el otro.

La disposición integrada es disposición de ventana, no una modificación del proyecto. Las casillas de extensiones son distintas: activan código en todos los proyectos que usan la configuración. **Restablecer** no cambia el consentimiento de extensiones. Consulta [Extensiones de panel](extensions.md).

## Detalle de la transcripción y tamaño del editor {#transcript-composer}

1. Abre **Chat** para elegir los valores de detalle de la transcripción. Los preajustes son **Nada**, **Mínimo**, **Equilibrado** y **Todo**; los cambios individuales producen **Personalizado**.
2. Establece el **Estado predeterminado** de cada fila (**Oculto**, **Colapsado** o **Expandido**) para el razonamiento, los diagnósticos, las entradas de herramientas, los tokens, los mensajes del sistema y cada tipo de herramienta, o usa el popup **Contenido de los mensajes** de la conversación, que comparte estas elecciones.
3. En **General**, marca **Mostrar la cronología de mensajes**, **Dividir los diffs de las llamadas a herramientas** y **Poner en cola los prompts enviados** (pone en cola los prompts enviados mientras una sesión trabaja en lugar de dirigirla) según necesites.
4. Cambia el tamaño del editor con su control; los borradores largos se desplazan dentro del campo.

La línea de tiempo tiene un marcador por cada respuesta, razonamiento, herramienta, compactación y contexto del sistema que muestra la conversación, en el mismo orden. Sus marcadores siguen **Contenido de los mensajes**: ocultar allí un tipo de herramienta, el razonamiento o los mensajes del sistema también oculta sus marcadores, salvo el de una herramienta con un permiso pendiente, y **Nada** oculta todos los marcadores de herramientas. Los ajustes de visibilidad y expansión solo cambian la presentación. No eliminan herramientas/razonamientos almacenados ni compactan el contexto del modelo. Consulta [Historial y limpieza](history.md) para operaciones destructivas.

La altura del editor sigue la conversación visible, incluido el teclado en pantalla: mínimo del 8% con un suelo de 44 px, máximo del 60%. La altura manual se recuerda proporcionalmente; la anchura estrecha y el texto largo no elevan esos límites. Un permiso/pregunta expandido minimiza temporalmente el editor sin cambiar su altura guardada ni su borrador. Contrae o resuelve la solicitud para volver a cambiar su tamaño.

## Notificaciones e indicadores {#notifications}

1. Abre **Notificaciones**. Para cada tipo de notificación, marca dónde aparece: **En pantalla** (una burbuja temporal), **Historial** (se conserva en el historial de notificaciones de la campana de la barra de pestañas, o de la barra de título en la aplicación de escritorio de macOS) y **Sistema** (una notificación del sistema operativo).
2. Marcar una casilla **Sistema** pide permiso si hace falta. En **Notificaciones del sistema**, **Solicitar** vuelve a pedirlo mientras falte el permiso.
3. Activa **Notificar cuando la app tenga el foco** para conservar las notificaciones del sistema mientras esta ventana está visible.

Por defecto, **Una sesión espera tu respuesta** y **Una sesión ha terminado** van solo a Sistema, para que los estados pasajeros de las sesiones no se acumulen en Historial; se refieren a las sesiones principales, no a los subagentes, y una sesión que detienes tú no se anuncia. Los errores siempre aparecen en pantalla y en Historial, diga lo que diga la tabla, y los mensajes breves de progreso solo se quedan en pantalla.

El permiso del navegador/sistema operativo pertenece al dispositivo y al origen de la aplicación; una preferencia guardada no puede anular una denegación. Si está bloqueado, activa las notificaciones en los ajustes del navegador o sistema operativo y vuelve aquí. Los entornos no compatibles mantienen desactivada la columna Sistema.

El recuento de no leídos de la campana/historial, que solo cuenta las notificaciones dirigidas a Historial, controla el punto del favicon del navegador y el indicador nativo de la aplicación. Los indicadores nativos agregan las ventanas principales activas; no son un recuento de sesiones en ejecución ni prueban que se haya entregado una notificación del sistema operativo. Esta función no proporciona indicadores en el icono de inicio de la PWA.

## Opciones avanzadas {#advanced}

1. Abre **Avanzado**.
2. Marca o desmarca solo las opciones que necesites; cada cambio se guarda mediante las preferencias de CodeNomad. Para cambiar el entorno de ejecución de las sesiones, expande el grupo plegado **Variables de entorno** al final.
3. Comprueba la vista resultante o el próximo envío en lugar de reiniciar especulativamente el servicio compartido.

| Opción | Efecto y precaución |
| --- | --- |
| Limpieza automática de sesiones en blanco | Limpia sesiones vacías al crear otras nuevas; déjala desactivada si quieres conservarlas. |
| Conservar marcadores de inactividad de subagentes | Conserva los marcadores de inactividad no vistos hasta que se visualizan en lugar de ocultarlos tras cinco segundos. |
| Enfocar la ventana existente en el segundo inicio | Solo escritorio nativo; cambia el comportamiento de la ventana en el segundo inicio, no la creación de pestañas. |
| Saldo de créditos del proveedor | Muestra saldos complementarios en Uso; no compra créditos ni cambia de cuenta. |
| Ocultar cambios solo de espacios | Omite archivos sin preparar con cambios solo de espacios/finales de línea de Cambios y sus acciones masivas; los archivos preparados siguen visibles. Consulta [Archivos](files.md). |
| Retener respuestas largas del asistente | Detiene el seguimiento automático cuando una respuesta en streaming supera el área visible. |
| Variables de entorno | Se aplican en el servidor antes de cada mensaje o comando de sesión; las lecturas no actualizan ejecuciones ya iniciadas. Consulta [configuración de OpenCode](opencode.md). |

Para configurar el teclado usa [Atajos de teclado](shortcuts.md); para controles de voz usa [Entrada y reproducción de voz](voice.md). La restauración al iniciar y la eliminación de perfiles de escritorio guardados se cubren en [Ventanas y datos de escritorio](desktop.md).
