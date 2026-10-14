# Control remoto

Control remoto permite a un navegador o cliente de escritorio emparejado usar tu backend de CodeNomad en ejecución sin abrir un puerto de red entrante. No requiere contraseña de servidor, un `--host` distinto de loopback ni VPN. Es una vía de acceso independiente de las [conexiones directas](remote-access.md).

## Iniciar y emparejar {#start-and-pair}

1. En el equipo anfitrión, abre **Configuración → Acceso remoto**.
2. Elige **Iniciar control remoto**. Espera a **Listo para conexiones remotas**; el primer uso puede tardar en aprovisionar la identidad del túnel y el certificado.
3. En **Conectar otro dispositivo**, escanea el código QR o elige **Copiar enlace** y abre ese enlace de un solo uso en el dispositivo previsto.
4. Conserva los datos del sitio del navegador emparejado. Vuelve a abrir la dirección del túnel para reconectar mientras el backend esté en ejecución.

El enlace es válido durante **cinco minutos** y funciona **una vez**. Trátalo como una credencial: cualquiera que lo consuma puede convertirse en un dispositivo emparejado. El código está en el fragmento de la URL, no en la cadena de consulta. **Crear nuevo enlace de emparejamiento** invalida inmediatamente el enlace anterior sin usar. Detener, apagar el backend y los fallos del túnel cancelan los enlaces de emparejamiento pendientes.

Para emparejar otro CodeNomad de escritorio, abre **Servidores → Conectar a un servidor**, pega el enlace en **URL del servidor** y elige **Conectar**. Solo se guarda el origen del túnel como marcador; el código no se conserva. La verificación TLS permanece activada para enlaces de emparejamiento.

## Gestionar dispositivos emparejados {#paired-devices}

1. En el equipo anfitrión, vuelve a **Configuración → Acceso remoto → Control remoto**.
2. Revisa **Dispositivos emparejados** y su hora de **Última actividad**.
3. Elige **Revocar** para un dispositivo que ya no deba conectarse.

La revocación finaliza las conexiones HTTP/SSE actuales del dispositivo y su acceso futuro. Vuelve a emparejarlo con un enlace nuevo para restaurar el acceso. Un dispositivo caduca tras **30 días sin uso**. Al alcanzar el **límite de 32 dispositivos**, un emparejamiento nuevo reemplaza el dispositivo con actividad más antigua y cierra sus conexiones.

El backend almacena hashes de credenciales, no credenciales de dispositivo en bruto, en `remote-control-devices.json` bajo su base de configuración. El cliente conserva una cookie de dispositivo con ámbito del anfitrión, `Secure`, `HttpOnly` y `SameSite=Lax`. Su duración en el navegador puede superar el límite de inactividad de 30 días del servidor; el registro sigue siendo autoritativo. Borrar los datos del sitio, cambiar de perfil de navegador o usar navegación privada puede exigir emparejarse de nuevo.

Cambiar la contraseña de acceso directo **no** revoca dispositivos. **Detener control remoto** desconecta el túnel, pero conserva la lista de dispositivos emparejados; usa **Revocar** cuando quieras retirar la autorización.

### Volver a emparejar sin perder tu lugar {#re-pair}

1. Si el cliente indica que el dispositivo ya no está emparejado, deja abierta esa página.
2. En el anfitrión, elige **Crear nuevo enlace de emparejamiento** y ábrelo en el **mismo navegador/perfil del cliente**. Para un servidor de escritorio guardado, reconecta usando el enlace nuevo para reutilizar el almacenamiento de su ventana remota existente.
3. Vuelve a la página en espera y comprueba de nuevo la autenticación.

La recuperación conserva la página abierta y los borradores; no repite una acción fallida. Comprueba si un envío, respuesta o eliminación surtió efecto antes de reintentarlo. Una contraseña de acceso directo no puede recuperar el emparejamiento de Control remoto.

## Disponibilidad y duración {#lifetime}

| Acción/estado | Efecto |
| --- | --- |
| Iniciar control remoto | Conecta este backend y recuerda la elección para inicios futuros. |
| Cerrar el navegador remoto | No detiene el backend anfitrión ni revoca el dispositivo. |
| Detener control remoto | Desconecta el acceso y borra la reanudación automática al iniciar; conserva los registros de dispositivos. |
| Apagado del backend / se cierra la última ventana de escritorio y la aplicación termina | Control remoto queda sin conexión. El servicio compartido de OpenCode puede seguir ejecutándose, pero no puede servir esta interfaz mediante un backend detenido. |
| Iniciar después de dejar Control remoto activado | Reconecta en segundo plano sin emitir un enlace de emparejamiento nuevo. Las instalaciones donde nunca se inició no se activan solas. |
| Reanudación fallida o error fatal del túnel | La elección recordada permanece; consulta **Actualizar** en el anfitrión. **Detener control remoto** la borra; un inicio posterior reintenta si permanece activada. |

La reanudación automática al iniciar se limita a un backend por directorio de configuración. No inicies anfitriones que compitan con la misma configuración para obtener más capacidad de túnel. Para un equipo que deba seguir accesible tras salir del escritorio, despliega un [servidor independiente](server.md) gestionado por separado; Control remoto no es un daemon independiente.

## Superficies disponibles y no disponibles {#remote-surface}

Los dispositivos emparejados pueden usar las API normales de proyectos/conversaciones, enviar mensajes, inspeccionar archivos y responder permisos/formularios sujetos a las mismas comprobaciones de propiedad. El emparejamiento concede acceso potente, no un enlace compartido de solo lectura. Nunca concede privilegios de loopback, aunque el túnel reenvíe tráfico internamente en el anfitrión.

| Superficie | Mediante Control remoto |
| --- | --- |
| Interfaz autenticada normal, espacios de trabajo, conversaciones y SSE | Disponible para un dispositivo emparejado. |
| Inicio/cierre de sesión con contraseña, cambios de contraseña, inicialización local por token | No disponible; se requieren credenciales de dispositivo incluso si la autenticación directa está desactivada. |
| Estado de Control remoto | Legible para un dispositivo emparejado; la gestión no está disponible. Iniciar/Detener, crear emparejamientos, la lista de dispositivos y la revocación permanecen en la vía de acceso del anfitrión. |
| Gestión de ventanas remotas/servidores de escritorio y rutas proxy | No disponible (`/api/remote-servers/`, `/api/remote-proxy/`). |
| **Proxy de contenido** de SideCar | No disponible (`/sidecars/`). Esto **no** significa que todas las API de SideCar estén bloqueadas: los clientes emparejados pueden seguir accediendo a las API de registro `/api/sidecars`. |
| Contenido de vistas previas y puente de automatización | No disponible (`/previews/`, `/api/opencode-plugin/`). Las capacidades nativas de escritorio no se convierten en capacidades del navegador. |
| Actualizaciones de conexión a WebSocket | No disponibles en la entrada de Control remoto. |

Usa una [conexión directa](remote-access.md) debidamente protegida cuando un flujo requiera una superficie proxy/WebSocket bloqueada. Control remoto no cambia automáticamente a esa vía.

## Relé y privacidad {#relay-privacy}

CodeNomad usa [OpenTunnel](https://github.com/anomalyco/opentunnel) y reserva una ruta aleatoria en la identidad de túnel predeterminada compartida del equipo. Detener libera el puente de CodeNomad, no la identidad compartida usada por otras aplicaciones.

TLS termina en el backend de CodeNomad. El relé reenvía texto cifrado y no puede leer el contenido de la aplicación, pero puede observar nombres de host, tiempos de conexión y tamaños de tráfico. El certificado/clave privada del túnel permanece en el anfitrión. Protege el almacenamiento del túnel del anfitrión y la configuración de CodeNomad como credenciales; una dirección imposible de adivinar no es autorización.

`CODENOMAD_REMOTE_CONTROL_API` selecciona una API de OpenTunnel autoalojada; sin definir se usa el servicio alojado. Esto cambia el despliegue del túnel, no los requisitos de emparejamiento ni las superficies bloqueadas. Consulta [Seguridad](security.md) para el tratamiento de credenciales y diagnósticos.
