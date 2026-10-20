# Configuración y disposición

## Abrir la configuración e identificar el ámbito {#open-settings}

1. Abre **Configuración** desde la página de inicio o la paleta de comandos.
2. Selecciona una sección. Las ventanas locales de Electron y Tauri abren o enfocan una única ventana nativa de Preferencias; las vistas de navegador y remotas usan la pantalla de configuración integrada.
3. Comprueba el ámbito del ajuste y cualquier acción de **Guardar** antes de salir.

La mayoría de los interruptores se aplican inmediatamente. Los editores de voz, paletas y preferencias de Misiones tienen controles de guardado explícitos. Un guardado fallido no confirma que el cambio se haya aplicado; reabre o actualiza la sección correspondiente antes de reintentar.

| Estado | Qué controla |
| --- | --- |
| Configuración de CodeNomad | Preferencias de interfaz, voz, SideCars y ajustes de servidor para los clientes que usan esa configuración. Una etiqueta «Dispositivo» en la interfaz no promete aislamiento de otro cliente que comparta la configuración. |
| Disposición de ventana/pestaña de proyecto | Paneles abiertos, pestañas seleccionadas, estado del lector y borradores/disposición restaurables. No son configuración de OpenCode. |
| Ajustes Global/Proyecto de OpenCode | Cambios nativos de plugins/configuración en el ámbito mostrado. Los controles de Proyecto requieren un proyecto/Location activo. |
| Perfil de datos de escritorio | Ventanas nativas, estado de restauración y almacenamiento del navegador, independientemente del archivo de configuración y del servicio compartido de OpenCode. Consulta [Ventanas y datos de escritorio](desktop.md). |

Cambiar preferencias de visualización no reinicia OpenCode ni repite un mensaje. La configuración nativa, el mantenimiento del servicio y las credenciales tienen efectos independientes: consulta [configuración de OpenCode](opencode.md), [Proveedores](providers.md) e [Integraciones](integrations.md).

## Idioma y apariencia {#language-appearance}

1. En **General**, selecciona **Idioma**: inglés, español, francés, ruso, japonés, chino simplificado, hebreo, alemán, nepalí o turco.
2. Elige **Modo de apariencia**: **Auto**, **Claro** u **Oscuro**. Auto sigue al sistema operativo.
3. Elige una paleta para la apariencia mostrada. Las selecciones clara y oscura se guardan por separado; Auto usa la correspondiente.
4. Para colores personalizados, usa las muestras y **Guardar**; **Restablecer** restaura los colores de esa paleta. Usa **Nuevo** para dar nombre a otra paleta.

La interfaz se actualiza sin reiniciar una conversación. El hebreo usa disposición de derecha a izquierda; el código y los valores técnicos siguen legibles en su propia dirección. La selección de idioma cambia el texto de la interfaz, no el idioma de los mensajes existentes ni las instrucciones del agente. Los menús nativos del sistema operativo pueden seguir en inglés.

Si los colores se vuelven difíciles de leer, selecciona una paleta integrada o restablece la editada. Cambiar de paleta puede pedir que descartes ediciones de color sin guardar; no descarta un borrador de conversación.

## Paneles y secciones de Estado {#panels-status}

1. Usa **Panel izquierdo** y **Panel derecho** en las esquinas de la cabecera exterior, o sus opciones del menú **View**, para mostrar u ocultar cada panel.
2. Abre **Personalizar panel derecho** en el panel derecho. Usa las casillas para elegir pestañas integradas y secciones de Estado; al menos una sección de Estado permanece visible.
3. Arrastra las pestañas del panel derecho para reordenarlas. Usa **Restablecer** para restaurar las elecciones de disposición integradas.

Estado incluye información de tokens, modo Yolo, Uso del proveedor, procesos en segundo plano, MCP y Plugins. Ocultar una sección no desactiva su servicio ni revoca permisos. Las disposiciones estrechas hacen flotar los paneles sobre la conversación en lugar de estrecharla; abrir un panel flotante cierra el otro.

La disposición integrada es disposición de ventana, no una modificación del proyecto. Las casillas de extensiones son distintas: activan código en todos los proyectos que usan la configuración. **Restablecer** no cambia el consentimiento de extensiones. Consulta [Extensiones de panel](extensions.md).

## Detalle de la transcripción y tamaño del editor {#transcript-composer}

1. Abre **Chat** para elegir los valores de detalle de la transcripción. Los preajustes son **Nada**, **Mínimo**, **Equilibrado** y **Todo**; los cambios individuales producen **Personalizado**.
2. Ajusta razonamiento, entradas/salidas de herramientas, diagnósticos y detalles de tokens, o usa el popup **Contenido de los mensajes** de la conversación para los controles compartidos de visibilidad.
3. En **General**, ajusta **Línea de tiempo de mensajes**, **Vista de diferencias** y **Comportamiento de seguimiento** según necesites.
4. Cambia el tamaño del editor con su control; los borradores largos se desplazan dentro del campo.

Los ajustes de visibilidad y expansión solo cambian la presentación. No eliminan herramientas/razonamientos almacenados ni compactan el contexto del modelo. Consulta [Historial y limpieza](history.md) para operaciones destructivas.

La altura del editor sigue la conversación visible, incluido el teclado en pantalla: mínimo del 8% con un suelo de 44 px, máximo del 60%. La altura manual se recuerda proporcionalmente; la anchura estrecha y el texto largo no elevan esos límites. Un permiso/pregunta expandido minimiza temporalmente el editor sin cambiar su altura guardada ni su borrador. Contrae o resuelve la solicitud para volver a cambiar su tamaño.

## Notificaciones e indicadores {#notifications}

1. Abre **Notificaciones** y elige **Solicitar** si aún no se ha concedido permiso.
2. Activa **Activar notificaciones**.
3. Elige **La sesión necesita entrada**, **La sesión queda inactiva** y si quieres **Notificar cuando la app tenga el foco**.

El permiso del navegador/sistema operativo pertenece al dispositivo y al origen de la aplicación; una preferencia guardada no puede anular una denegación. Si está bloqueado, activa las notificaciones en los ajustes del navegador o sistema operativo y vuelve aquí. Los entornos no compatibles mantienen el control desactivado.

El recuento de no leídos de la campana/historial controla el punto del favicon del navegador y el indicador nativo de la aplicación. Los indicadores nativos agregan las ventanas principales activas; no son un recuento de sesiones en ejecución ni prueban que se haya entregado una notificación del sistema operativo. Esta función no proporciona indicadores en el icono de inicio de la PWA.

## Opciones avanzadas {#advanced}

1. Abre **Avanzado**.
2. Cambia solo el comportamiento que necesites; los interruptores guardan mediante las preferencias de CodeNomad. Edita **Variables de entorno** por separado al cambiar el entorno de ejecución de las sesiones.
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
