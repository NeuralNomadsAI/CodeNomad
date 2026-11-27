# Solución de problemas

## Problemas al iniciar el escritorio {#desktop-launch}

### Cuarentena de macOS {#macos-quarantine}

Las versiones de CodeNomad para macOS no están notarizadas por Apple, así que macOS puede bloquear el primer inicio de una copia descargada, incluso una que hayas verificado desde el repositorio oficial: puede mostrar **"CodeNomad" Not Opened** (Apple no pudo verificar que esté libre de malware) o indicar que la aplicación está dañada.

1. Comprueba el origen de la descarga y la ruta de la aplicación instalada.
2. Si la aplicación está instalada en la siguiente ruta, retira su atributo de cuarentena:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Vuelve a iniciar. Con el mensaje **Not Opened** también puedes, tras el inicio bloqueado, elegir **Open Anyway** para CodeNomad en **System Settings → Privacy & Security** y confirmar con tu contraseña de administrador.

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

Si no puede verificarse un worktree propio o la ubicación de una conversación, abre explícitamente su carpeta física en lugar de probar rutas arbitrarias o editar almacenamiento nativo. Forzar la eliminación de un worktree puede destruir archivos sin confirmar; no lo uses para reparar una conexión.

## Entorno de ejecución OpenCode y WSL {#opencode-runtime}

En el diálogo de error de inicio, elige **Abrir Configuración de OpenCode** para comprobar el ejecutable y la versión; para los valores de entorno personalizados, ve a **Avanzado → Variables de entorno**.

1. Abre **Preferencias → OpenCode** y comprueba la tarjeta **Versión de OpenCode** (versión instalada y estado del servicio en ejecución) y después el ejecutable seleccionado en **Binario de OpenCode**.
2. Usa la acción compatible de instalación/actualización si falta el entorno requerido. Mínimo actual: **2.4.0**; versión recomendada/verificada: **2.4.1**.
3. Si la CLI instalada difiere del servicio en ejecución, decide explícitamente si reiniciar el servicio compartido.

**Reiniciar servicio OpenCode** está disponible en **Solución de problemas** y requiere confirmación. Interrumpe el trabajo activo de todos los clientes conectados, pero conserva el historial de sesiones. Recargar la configuración es una acción separada: mantiene el proceso, pero reconstruye las Locations cargadas y cancela preguntas/permisos pendientes. Ninguna es una actualización inofensiva.

Para un ejecutable WSL, confirma la distribución prevista y el reenvío de localhost de Windows. El ciclo de vida del servicio se ejecuta dentro de Linux; CodeNomad aún debe alcanzar su endpoint loopback desde Windows. Nunca edites el registro/base de datos del servicio ni envíes señales desde Windows a identificadores de proceso Linux adivinados.

## Inicio de sesión, TLS y conectividad directa {#login-and-tls}

| Síntoma | Comprobación y recuperación seguras |
| --- | --- |
| **Volver a iniciar sesión en CodeNomad** | Mantén abierta la página, introduce usuario/contraseña del servidor y selecciona **Iniciar sesión**. La recuperación reconecta en el mismo lugar para conservar borradores; no repite la acción fallida. |
| Servidor inaccesible | Verifica que el backend esté en ejecución y usa su dirección indicada/puerto real. |
| Error de nombre/confianza del certificado | Compara el nombre de host/IP real con los SAN del certificado e instala la confianza de CA prevista o un certificado de servidor válido. No desactives la verificación TLS. |
| Conexión directa rechazada | Comprueba las direcciones efectivas de escucha HTTP/HTTPS, el cortafuegos y el enrutamiento. |

Las contraseñas de ejecución deben proporcionarse en cada inicio del backend; una contraseña guardada en configuración persiste. Consulta [seguridad](security.md), [reglas TLS/de escucha](remote-access.md) y [referencia del servidor](server.md).

## Emparejamiento de Control remoto {#pairing}

1. En el anfitrión, abre **Configuración → Acceso remoto** y comprueba que Control remoto esté en ejecución.
2. Crea un enlace de emparejamiento nuevo y ábrelo en el dispositivo previsto antes de que caduque.
3. Si el cliente muestra **Vincular de nuevo este dispositivo**, empareja desde el anfitrión y selecciona después **Comprobar conexión** en el cliente.

Los enlaces de emparejamiento son de un solo uso y corta duración; la contraseña de acceso directo no los sustituye. Las credenciales de dispositivo revocadas o caducadas por inactividad requieren emparejar de nuevo. Cerrar la última ventana de escritorio detiene su backend y, por tanto, Control remoto; un servicio activado se reanuda en el siguiente inicio de la aplicación. Consulta [Control remoto](remote-control.md) para las superficies exclusivas del anfitrión no disponibles y la revocación.

## Estado de proveedores, plugins y extensiones {#providers-and-addons}

- Un plugin añadido falló o muestra **Sin confirmar** — Comprueba el nombre del paquete, su versión y el acceso al registro desde el equipo de OpenCode. Busca en el registro de OpenCode la referencia de error de la información emergente del plugin. **Sin confirmar** también aparece para un plugin desactivado.
- Falta una extensión instalada — Actívala en la personalización del panel. La instalación/reemplazo la deja desactivada hasta que la actives explícitamente y apruebes el consentimiento requerido.
- **Cronología completa no disponible** — Consulta el error de carga de `codenomad-session-pruning` en el registro de OpenCode.

Consulta [Proveedores](providers.md), [Integraciones](integrations.md) y [Extensiones](extensions.md).

## Historial, solicitudes pendientes y limpieza {#history-and-requests}

La búsqueda en todo el historial no se limita a las filas de transcripción cargadas actualmente. Un filtro de visualización oculta contenido sin eliminarlo; usa [Historial](history.md) para distinguir búsqueda, compactación, limpieza técnica y eliminación.

Para limpieza cancelada o parcial, lee su progreso/comprobantes antes de iniciar otra eliminación. Cancelar no deshace un lote ya enviado. No repares el historial editando la base de datos nativa.

## Registros y diagnósticos seguros {#diagnostics}

1. Abre **Configuración → OpenCode → Ver registros de OpenCode**. Se lee el archivo global `opencode.log` del host de ejecución seleccionado, localizado mediante `opencode debug paths log`. Muestra como máximo los últimos 128 KiB; **Actualizar** vuelve a leer el archivo.
2. En **Preferencias → OpenCode**, elige la **Verbosidad de logs** prevista solo cuando necesites más detalle. Para registros de CodeNomad independiente, usa las [opciones de registro de la CLI del servidor](server.md). El servidor de CodeNomad también guarda su propio registro en `logs/server.log`, junto a su archivo de configuración (`~/.config/codenomad` por defecto); el archivo completo anterior es `server.previous.log`.
3. Abre **Configuración → Info → Diagnósticos** y usa **Informar de un error**, **Copiar al portapapeles** o **Descargar .txt**.

El detalle de los registros puede exponer rutas, salida y datos de la aplicación. Oculta credenciales, enlaces de emparejamiento, direcciones de red, rutas privadas y contenido de conversaciones antes de compartir registros/capturas. El informe diagnóstico completo incluye rutas/direcciones; el formulario de error rellenado las excluye deliberadamente. Consulta [Informar de un error](support.md#report-a-bug).
