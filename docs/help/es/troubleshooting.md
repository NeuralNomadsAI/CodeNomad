# Solución de problemas

Para recuperarte, comprueba primero quién controla la operación fallida: navegador, backend de CodeNomad, servicio OpenCode o proveedor. Una respuesta perdida no demuestra que una modificación fallara; vuelve a leer el estado actual antes de repetirla.

## Problemas al iniciar el escritorio {#desktop-launch}

### Cuarentena de macOS {#macos-quarantine}

Para una versión que hayas descargado del repositorio oficial y verificado, macOS puede indicar que la aplicación está dañada debido a comprobaciones de cuarentena/notarización.

1. Comprueba el origen de la descarga y la ruta de la aplicación instalada.
2. Si la aplicación está instalada en la siguiente ruta, retira su atributo de cuarentena:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Vuelve a iniciar; en Mac Intel comprueba también **System Settings → Privacy & Security** para la decisión del primer inicio.

Esto cambia el atributo de cuarentena de macOS en esa aplicación. No repara una descarga corrupta ni convierte un binario desconocido en fiable.

### Gráficos de Linux y FUSE {#linux-graphics}

Una AppImage Tauri que se cierra inmediatamente en Wayland/NVIDIA puede estar afectada por el renderer DMA-BUF/GBM de WebKitGTK. Ejecuta la AppImage descargada con este ajuste específico de entorno:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron usa Chromium y es una alternativa en el mismo equipo. Si la AppImage no puede montarse porque FUSE no está disponible, usa `--appimage-extract-and-run`; consulta [Instalación en Linux](install.md#linux-install). Estas soluciones no requieren desactivar el aislamiento de Electron.

## Disponibilidad de Git y del espacio de trabajo {#git-and-workspaces}

1. Comprueba Git en el `PATH` de la cuenta del backend, no solo dentro del shell del agente.
2. Instala Git en ese equipo/cuenta si falta y reinicia después el backend de CodeNomad para que herede el entorno actualizado.
3. Reabre/actualiza el espacio de trabajo y comprueba el estado del repositorio.

Las conversaciones limitadas al directorio siguen disponibles sin Git; los controles de worktree y Git no. En Windows, Git instalado solo dentro de WSL no basta para el backend Windows. Una carpeta conocida sin repositorio puede mostrar **Inicializar Git**; que falte el ejecutable de Git es una condición distinta que debe resolverse primero. Consulta [requisitos](install.md#requirements) y [Archivos](files.md).

Si no puede verificarse un worktree propio o la ubicación de una conversación, abre explícitamente su carpeta física en lugar de probar rutas arbitrarias o editar almacenamiento nativo. Actualiza tras un movimiento/eliminación incierto para ver qué ubicación existe realmente. Forzar la eliminación de un worktree puede destruir archivos sin confirmar; no lo uses para reparar una conexión.

## Entorno de ejecución OpenCode y WSL {#opencode-runtime}

1. Abre **Preferencias → OpenCode** y comprueba el ejecutable seleccionado, la versión instalada y el estado del servicio en ejecución.
2. Usa la acción compatible de instalación/actualización si falta el entorno requerido. Mínimo actual: **2.0.27**; recomendado/verificado: **2.0.32**.
3. Si la CLI instalada difiere del servicio en ejecución, decide explícitamente si reiniciar el servicio compartido.

**Reiniciar servicio OpenCode** está disponible en **Solución de problemas** y requiere confirmación. Interrumpe el trabajo activo de todos los clientes conectados, pero conserva el historial de sesiones. Recargar la configuración es una acción separada: mantiene el proceso, pero reconstruye las Locations cargadas y cancela preguntas/permisos pendientes. Ninguna es una actualización inofensiva.

Para un ejecutable WSL, confirma la distribución prevista y el reenvío de localhost de Windows. El ciclo de vida del servicio se ejecuta dentro de Linux; CodeNomad aún debe alcanzar su endpoint loopback desde Windows. Nunca edites el registro/base de datos del servicio ni envíes señales desde Windows a identificadores de proceso Linux adivinados.

Una versión personalizada/más nueva puede no estar verificada sin ser incompatible. Lee el error real del contrato antes de cambiar versiones. Si falla la sincronización del entorno de sesión, repara el entorno/conexión del equipo de ejecución: CodeNomad no enviará un mensaje sin esa sincronización. Consulta [OpenCode](opencode.md).

## Inicio de sesión, TLS y conectividad directa {#login-and-tls}

| Síntoma | Comprobación y recuperación seguras |
| --- | --- |
| **Volver a iniciar sesión en CodeNomad** | Mantén abierta la página, introduce usuario/contraseña del servidor y selecciona **Iniciar sesión**. La recuperación reconecta en el mismo lugar para conservar borradores; no repite la acción fallida. |
| Servidor inaccesible | Verifica que el backend esté en ejecución y usa su dirección indicada/puerto real. Una comprobación de inaccesibilidad por sí sola no demuestra que tu sesión haya caducado. |
| El proveedor rechaza la autenticación | Repara el inicio de sesión del proveedor mediante su propietario; no cambies la contraseña del servidor CodeNomad para reparar OAuth del proveedor. |
| Error de nombre/confianza del certificado | Compara el nombre de host/IP real con los SAN del certificado e instala la confianza de CA prevista o un certificado de servidor válido. No desactives la verificación TLS. |
| Conexión directa rechazada | Comprueba las direcciones efectivas de escucha HTTP/HTTPS, el cortafuegos y el enrutamiento. HTTP en escritorio o modo de dos listeners permanece en loopback; el modo independiente solo HTTP escucha de forma distinta. |

Después de recuperar la autenticación, inspecciona el estado antes de reintentar manualmente una modificación cuya respuesta fuera incierta. Las contraseñas de ejecución deben proporcionarse en cada inicio del backend; una contraseña guardada en configuración persiste. Consulta [seguridad](security.md), [reglas TLS/de escucha](remote-access.md) y [referencia del servidor](server.md).

## Emparejamiento de Control remoto {#pairing}

1. En el anfitrión, abre **Configuración → Acceso remoto** y comprueba que Control remoto esté en ejecución.
2. Crea un enlace de emparejamiento nuevo y ábrelo en el dispositivo previsto antes de que caduque.
3. Si el cliente muestra **Vincular de nuevo este dispositivo**, empareja desde el anfitrión y selecciona después **Comprobar conexión** en el cliente.

Los enlaces de emparejamiento son de un solo uso y corta duración; la contraseña de acceso directo no los sustituye. Las credenciales de dispositivo revocadas o caducadas por inactividad requieren emparejar de nuevo. Cerrar la última ventana de escritorio detiene su backend y, por tanto, Control remoto; un servicio activado se reanuda en el siguiente inicio de la aplicación. Consulta [Control remoto](remote-control.md) para las superficies exclusivas del anfitrión no disponibles y la revocación.

## Estado de proveedores, plugins y extensiones {#providers-and-addons}

| Problema | Recuperación |
| --- | --- |
| Cuenta/cuota de proveedor incorrecta | Comprueba la cuenta nativa seleccionada y **Uso**. Una cuota mostrada no es un total de tokens/coste. Actualiza tras un cambio de cuenta incierto; la selección puede afectar a otros clientes de ese servicio. |
| OAuth externo caducado | Vuelve a iniciar sesión mediante OpenCode, Claude Code o el propietario correspondiente de la credencial. CodeNomad no intercambia sus tokens de actualización. |
| La rotación automática no cambia de cuenta | Comprueba la elegibilidad de la opción y si la cuenta actual tiene realmente agotada su cuota. Es una política previa a la admisión, no conmutación durante la solicitud ni repetición de mensajes. |
| El estado del plugin parece obsoleto | Usa **Actualizar controles de plugins** e inspecciona el ámbito/destino en su ayuda emergente; la activación en ejecución puede esperar una actualización nativa. No alternes repetidamente una escritura incierta. |
| Falta una extensión instalada | Comprueba su única casilla de activación en personalización del panel. La instalación/reemplazo la deja desactivada hasta que la actives explícitamente y apruebes el consentimiento requerido. |
| Recursos de extensión denegados | Confirma el consentimiento de lectura de recursos de API 2 para la sesión montada actual. Instalar una extensión no da permiso para leer archivos/historial arbitrarios. |

Consulta [Proveedores](providers.md), [Integraciones](integrations.md) y [Extensiones](extensions.md).

## Historial, solicitudes pendientes y limpieza {#history-and-requests}

La búsqueda en todo el historial no se limita a las filas de transcripción cargadas actualmente. Un filtro de visualización oculta contenido sin eliminarlo; usa [Historial](history.md) para distinguir búsqueda, compactación, limpieza técnica y eliminación.

Si la recuperación de solicitudes pendientes es incompleta, CodeNomad conserva las colas conocidas y los borradores de respuestas en lugar de tratar la cobertura ausente como una cola vacía. Tras dos recuperaciones incompletas consecutivas avisa mediante notificaciones normales; los fallos transitorios se reintentan con la comprobación de actividad. Un aplazamiento relacionado con la compactación no significa que la solicitud se cancelara. Deja intacto el borrador, verifica la conexión al servicio y usa el estado actual de la solicitud antes de volver a responder.

Para limpieza cancelada o parcial, lee su progreso/comprobantes antes de iniciar otra eliminación. Cancelar no deshace un lote ya enviado. No repares el historial editando la base de datos nativa. Ante incertidumbre de Misiones, usa su recuperación **Comprobar estado**/actualización en lugar de crear otra ejecución o repetir automáticamente trabajo; [Misiones](missions.md) explica los límites de reinicio y duración.

## Registros y diagnósticos seguros {#diagnostics}

1. Abre **Info de la instancia** para inspeccionar su estado; **Mostrar registros del servidor** expone la salida disponible.
2. En **Preferencias → OpenCode**, elige la **Verbosidad de logs** prevista solo cuando necesites más detalle. Para registros de CodeNomad independiente, usa las [opciones de registro de la CLI del servidor](server.md).
3. Abre **Configuración → Info → Diagnósticos** y usa **Informar de un error**, **Copiar al portapapeles** o **Descargar .txt**.

El detalle de los registros puede exponer rutas, salida y datos de la aplicación. Oculta credenciales, enlaces de emparejamiento, direcciones de red, rutas privadas y contenido de conversaciones antes de compartir registros/capturas. El informe diagnóstico completo incluye rutas/direcciones; el formulario de error rellenado las excluye deliberadamente. Consulta [Soporte](support.md#report-a-bug).
