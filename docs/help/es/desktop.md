# Ventanas y datos de escritorio

## Ventanas, pestañas y servicio compartido {#windows-tabs}

1. Usa **Nueva instancia** para abrir otra pestaña de proyecto/inicio en la ventana actual.
2. Usa **Ventana → Nueva ventana** nativo (`Ctrl+Shift+N` o `Cmd+Shift+N`) para una ventana de aplicación separada.
3. En **Configuración → Avanzado**, activa **Enfocar la ventana existente en el segundo inicio** si otro inicio debe enfocar la ventana usada más recientemente en lugar de abrir una nueva.

Las pestañas de proyectos, conversaciones seleccionadas y disposición pertenecen a una ventana. Las sesiones/mensajes OpenCode pertenecen al servicio nativo compartido de OpenCode: otra ventana puede ver la misma conversación. Cerrar una pestaña de proyecto cierra ese proyecto en CodeNomad, no sus sesiones OpenCode; vuelve a abrirlo para encontrarlas. Otra ventana que muestre la misma conexión de proyecto también cierra su pestaña y muestra una notificación; las pestañas de la misma carpeta abiertas por separado no se ven afectadas. Cerrar una ventana entera, salir o recargar conserva las conexiones de proyecto para restaurarlas; consulta [Proyectos](projects.md). No uses el cierre de ventanas como prueba de que se ha detenido un agente o una Misión programada.

Los menús nativos de la aplicación usan el idioma de la interfaz de CodeNomad en cuanto se ha cargado una ventana; hasta entonces se muestran en inglés. **Ayuda → Acerca de CodeNomad** (también en el menú de la aplicación en macOS) abre **Configuración → Info** con la versión, las actualizaciones y los diagnósticos.

## Preferencias y restauración al iniciar {#preferences-startup}

1. Abre Configuración desde la ventana que quieras configurar. Los puntos de entrada locales de escritorio enfocan la única ventana nativa de Preferencias con el proyecto/Location de esa ventana de origen.
2. En **General**, activa o desactiva **Restaurar el estado anterior**.
3. Para olvidar la disposición guardada de esa ventana, usa **Borrar el estado de inicio guardado**. Se aplica de inmediato, sin confirmación.

La restauración puede reabrir pestañas de espacios de trabajo/SideCar y sesiones activas, texto sin enviar, posiciones de desplazamiento, paneles, posición de ventanas y zoom. Es estado del cliente por ventana, no una copia de la base de datos nativa de conversaciones. Borrarlo elimina pestañas guardadas, borradores y disposición; no elimina la configuración de CodeNomad ni conversaciones OpenCode. Guarda primero cualquier borrador importante sin enviar en otro lugar.

La ventana de Preferencias no tiene un estado de restauración independiente: estos controles apuntan a la ventana que la abrió. Si esa ventana se cerró, o es desconocida porque Preferencias se reabrió al iniciar, siguen la ventana usada más recientemente; un cambio preparado para otra ventana nunca se aplica, y los controles muestran primero el valor de la nueva ventana. Para configurar una ventana concreta, abre Preferencias desde ella. Los ajustes con ámbito de proyecto usan igualmente la Location de origen; sin ella no están disponibles. Cuando Preferencias se reabre al iniciar, se vuelven a conectar en cuanto ese proyecto termina de abrirse; mientras la carpeta sigue iniciándose, o está abierta en varias pestañas, permanecen no disponibles hasta que abras Preferencias desde la ventana deseada.

La configuración del navegador y remota está integrada en lugar de tener un segundo propietario nativo de Preferencias. Se informa de un error al abrir Preferencias nativas; no es motivo para suponer que se abrió una pantalla integrada oculta en su lugar.

## Perfiles de datos de escritorio {#data-profiles}

1. En **Configuración → General** nativo, bajo **Restaurar el estado anterior**, despliega **Perfil de datos**. Muestra todos los perfiles de este equipo con su tamaño, fecha de creación y último uso, con el abierto primero.
2. Selecciona el perfil que abrirá el siguiente inicio, o elige **Nuevo perfil** e introduce un nombre de 1–64 letras minúsculas, dígitos, puntos, guiones o guiones bajos, que empiece por una letra o un dígito.
3. Elige **Reiniciar en** para cambiar ahora; si no, el perfil elegido se abre en el siguiente inicio. Volver a seleccionar el perfil abierto cancela el cambio.

Los perfiles de otra configuración aparecen en la lista, pero no se pueden elegir aquí. Sin una elección recordada, un inicio empaquetado busca trabajo restaurable en los perfiles predeterminado, `dev` y `dev-v2` y abre el usado más recientemente, o el predeterminado si ninguno lo tiene. Elegir un perfil no mueve, combina ni elimina datos de perfiles.

`CODENOMAD_PROFILE` establecido antes de iniciar el ejecutable prevalece sobre la elección; **Perfil de datos** muestra entonces los perfiles sin permitir elegir uno. `default` o `stable` selecciona el perfil predeterminado, y un nombre inválido impide el inicio en lugar de seleccionar otro perfil. Por ejemplo, en PowerShell, antes de iniciar el ejecutable de escritorio deseado:

```powershell
$env:CODENOMAD_PROFILE = "review"
```

Para una configuración de servidor independiente, establece también `CLI_CONFIG` en un archivo de configuración separado antes de iniciar. El predeterminado es `~/.config/codenomad/config.yaml`. Un nombre de perfil por sí solo no cambia ese archivo ni el servicio compartido de OpenCode.

| Aislado por un perfil de datos de escritorio | No aislado automáticamente |
| --- | --- |
| Estado de restauración de ventanas/pestañas, borradores sin enviar y ámbito de singleton/backend de escritorio | Sesiones OpenCode, mensajes, credenciales de proveedores y ejecución |
| Almacenamiento nativo Chromium/WebView asociado a ese perfil, sujeto a límites de plataforma | Configuración/preferencias de CodeNomad, claves de voz, SideCars y activación de extensiones cuando la configuración es compartida |
| Almacenamiento de vistas previas nativas dentro de su anfitrión/perfil | Archivos de proyectos abiertos; datos de servidores remotos |

En Tauri para macOS, los perfiles separados comparten almacenamiento WebKit del sistema, inicios de sesión y caché; no uses nombres de perfiles como aislamiento de seguridad de cuentas. Electron almacena los datos web en su perfil. La versión instalada y **Canal de actualizaciones** nunca seleccionan otro perfil de datos. Los inicios de desarrollo sin empaquetar usan el perfil `dev` salvo selección explícita.

## Eliminar un perfil guardado {#delete-profiles}

1. Despliega **Perfil de datos** como se indica arriba y actualiza la lista si es necesario.
2. Elige el botón de eliminar del perfil que quieras quitar. El perfil abierto no lo tiene.
3. Confirma solo después de conservar los borradores/inicios de sesión que necesites. Inspecciona cualquier informe de eliminación incompleta antes de reintentar.

La eliminación borra las pestañas, borradores, disposición y almacenamiento web/caché/inicios de sesión propios de ese perfil, incluido un perfil enumerado de otra configuración. Conserva el perfil abierto, las conversaciones OpenCode y los archivos del proyecto. Un perfil abierto o en estado desconocido no se puede eliminar; cierra las ventanas de CodeNomad relevantes, actualiza la lista y reintenta. El contenido no reconocido se conserva y se notifica en lugar de eliminarse indiscriminadamente.

El almacén WebKit compartido de Tauri en macOS se conserva porque borrarlo afectaría a otros perfiles. Esta limpieza no se puede deshacer: que sobreviva una conversación nativa no restaura un borrador sin enviar eliminado. **Borrar el estado de inicio guardado** es la acción más limitada cuando solo quieres restablecer la ventana actual.

## Zoom y geometría de paneles {#zoom-panels}

1. Usa **Ver → Acercar**, **Alejar** o **Tamaño real** nativos; la entrada de teclado/rueda también depende del anfitrión.
2. Usa **Panel izquierdo** y **Panel derecho** en las esquinas fijas de la cabecera exterior para alternar paneles. Fija/desfija los cajones cuando la disposición lo permita.
3. Si los controles ya no caben, reduce el zoom o ensancha la ventana; las disposiciones estrechas trasladan controles a menús y paneles a superposiciones.

Las ventanas principales de escritorio locales y remotas reservan al menos 390 × 600 píxeles CSS, escalados por el zoom de la aplicación y limitados por el área de trabajo del monitor. Acercar puede ampliar una ventana demasiado pequeña; alejar no reduce una que ya sea mayor. Preferencias y las ventanas hijas de vista previa de navegador tienen reglas de tamaño separadas.

Los paneles dejan una anchura mínima de conversación antes de flotar. Por debajo de 420 píxeles CSS de anchura de conversación, la línea de tiempo se oculta y las acciones de cabecera usan su menú de desbordamiento; se conserva la preferencia guardada de la línea de tiempo. Estos cambios geométricos no alteran el borrador ni la sesión nativa. Consulta [Configuración y disposición](settings.md) y [Vistas previas de navegador y SideCars](browser-sidecars.md).
