# Control remoto

Control remoto permite a un navegador o cliente de escritorio emparejado usar tu backend de CodeNomad en ejecución sin abrir un puerto de red entrante. No requiere contraseña de servidor, un `--host` distinto de loopback ni VPN. Es una vía de acceso independiente de las [conexiones directas](remote-access.md).

## Iniciar y emparejar {#start-and-pair}

1. En el equipo anfitrión, abre **Configuración → Acceso remoto**.
2. Elige **Iniciar control remoto**. Espera a **Listo para conexiones remotas**; el primer uso puede tardar en aprovisionar la identidad del túnel y el certificado.
3. En **Conectar otro dispositivo**, escanea el código QR o elige **Copiar enlace** y abre ese enlace de un solo uso en el dispositivo previsto.
4. Conserva los datos del sitio del navegador emparejado. Vuelve a abrir la dirección del túnel para reconectar mientras el backend esté en ejecución.

El enlace es válido durante **cinco minutos** y funciona **una vez**. Trátalo como una credencial: cualquiera que lo consuma puede convertirse en un dispositivo emparejado. El código está en el fragmento de la URL, no en la cadena de consulta. **Crear nuevo enlace de emparejamiento** invalida inmediatamente el enlace anterior sin usar. Apagar el backend cancela el enlace de emparejamiento pendiente; detener y los fallos del túnel cancelan un enlace del túnel.

En otro CodeNomad de escritorio, pega el enlace de emparejamiento en **Configuración → Servidores → Dirección o enlace del servidor**.

Para volver a emparejarlo, pega el nuevo enlace en el formulario de conexión del servidor o del proyecto.

## Emparejar por HTTPS directo {#direct-https}

Cuando el túnel está bloqueado pero el backend es accesible por HTTPS de confianza, por ejemplo tras un proxy inverso con un certificado real, los dispositivos pueden emparejarse en esa dirección. Se admiten las direcciones HTTPS propias de este backend y los orígenes HTTPS de `CODENOMAD_ALLOWED_ORIGINS` (consulta [Orígenes permitidos](remote-access.md#upgrading)); los nombres de bucle local y HTTP sin cifrar nunca emparejan. No hace falta iniciar el control remoto.

1. En el equipo anfitrión, abre **Configuración → Acceso remoto → Control remoto**.
2. En **Emparejamiento HTTPS directo**, elige la **Dirección HTTPS** si hay varias y luego **Crear enlace de emparejamiento HTTPS**.
3. Abre el enlace en el dispositivo, como un enlace del túnel. Puedes pulsarlo desde otra página.

El enlace sigue las mismas reglas de cinco minutos y un solo uso, y reemplaza cualquier enlace sin usar; los códigos erróneos repetidos se limitan. Un proxy inverso debe terminar TLS de confianza, pasar las cabeceras `Host` y `Origin` originales y llegar al backend por bucle local o una red protegida.

Ese dispositivo se conecta solo por su dirección HTTPS, nunca por el túnel, y **Dispositivos emparejados** muestra esa dirección bajo su nombre. Detener el control remoto no cancela el enlace ni desconecta estos dispositivos; **Revocar**, 30 días sin uso, el límite de 32 dispositivos o quitar la dirección de la configuración terminan su acceso. Un navegador que presenta una credencial de dispositivo revocada o caducada en esa dirección no puede recurrir a la contraseña del servidor: vuelve a emparejarlo o borra los datos del sitio para iniciar sesión con la contraseña.

Consulta las [funciones disponibles](#remote-surface), incluida la excepción de HTTPS directo para el contenido de SideCar. El emparejamiento no concede privilegios de bucle local, ni siquiera a través de un proxy en el anfitrión.

## Gestionar dispositivos emparejados {#paired-devices}

1. En el equipo anfitrión, vuelve a **Configuración → Acceso remoto → Control remoto**.
2. Revisa **Dispositivos emparejados** y su hora de **Última actividad**. Cada dispositivo recibe el nombre de la plataforma y el navegador que lo emparejaron, como `iPhone · Safari`.
3. Elige **Revocar** para un dispositivo que ya no deba conectarse. Si aparece **Revocación pendiente**, vuelve a seleccionar **Revocar** antes de reiniciar el anfitrión.

La revocación finaliza las conexiones HTTP/SSE actuales del dispositivo y su acceso futuro. Vuelve a emparejarlo con un enlace nuevo para restaurar el acceso. Un dispositivo caduca tras **30 días sin uso**. Al alcanzar el **límite de 32 dispositivos**, un emparejamiento nuevo reemplaza el dispositivo con actividad más antigua y cierra sus conexiones.

Borrar los datos del sitio, cambiar de perfil de navegador o usar navegación privada puede exigir emparejarse de nuevo.

Cambiar la contraseña de acceso directo **no** revoca dispositivos. **Detener control remoto** desconecta el túnel, pero conserva la lista de dispositivos emparejados; usa **Revocar** cuando quieras retirar la autorización.

### Volver a emparejar sin perder tu lugar {#re-pair}

1. Si el cliente muestra **Vincular de nuevo este dispositivo**, deja abierta esa página.
2. En el anfitrión, crea un enlace para la conexión original: **Crear nuevo enlace de emparejamiento** para el túnel, o selecciona la **Dirección HTTPS** original en **Emparejamiento HTTPS directo** y elige **Crear enlace de emparejamiento HTTPS**. Ábrelo en el **mismo navegador/perfil del cliente**. Una ventana remota independiente reutiliza su almacenamiento.
3. Vuelve a la página en espera y elige **Comprobar conexión**; también vuelve a comprobarla cuando la página recupera el foco.

La recuperación conserva la página abierta y los borradores; no repite una acción fallida. Comprueba si un envío, respuesta o eliminación surtió efecto antes de reintentarlo. Una contraseña de acceso directo no puede recuperar el emparejamiento de Control remoto.

## Disponibilidad y duración {#lifetime}

| Acción/estado | Efecto |
| --- | --- |
| Iniciar control remoto | Conecta este backend y recuerda la elección para inicios futuros. |
| Cerrar el navegador remoto | No detiene el backend anfitrión ni revoca el dispositivo. |
| Detener control remoto | Desconecta el acceso por el túnel y borra la reanudación automática al iniciar; conserva los registros de dispositivos. |
| Apagado del backend / se cierra la última ventana de escritorio y la aplicación termina | Control remoto queda sin conexión. El servicio compartido de OpenCode puede seguir ejecutándose, pero no puede servir esta interfaz mediante un backend detenido. |
| Iniciar después de dejar Control remoto activado | Reconecta en segundo plano sin emitir un enlace de emparejamiento nuevo. Las instalaciones donde nunca se inició no se activan solas. |

La reanudación automática al iniciar se limita a un backend por directorio de configuración. No inicies anfitriones que compitan con la misma configuración para obtener más capacidad de túnel. Para un equipo que deba seguir accesible tras salir del escritorio, despliega un [servidor independiente](server.md) gestionado por separado; Control remoto no es un daemon independiente.

## Superficies disponibles y no disponibles {#remote-surface}

Los dispositivos emparejados pueden usar las API normales de proyectos/conversaciones, enviar mensajes, inspeccionar archivos y responder permisos/formularios sujetos a las mismas comprobaciones de propiedad. El emparejamiento concede acceso potente, no un enlace compartido de solo lectura. Nunca concede privilegios de loopback, aunque el túnel reenvíe tráfico internamente en el anfitrión.

| Superficie | Mediante Control remoto |
| --- | --- |
| Interfaz autenticada normal, espacios de trabajo, conversaciones y SSE | Disponible para un dispositivo emparejado. |
| Inicio/cierre de sesión con contraseña, cambios de contraseña, inicialización local por token | No disponible; se requieren credenciales de dispositivo incluso si la autenticación directa está desactivada. |
| Estado de Control remoto | Legible para un dispositivo emparejado; la gestión no está disponible. Iniciar/Detener, crear emparejamientos, la lista de dispositivos y la revocación permanecen en la vía de acceso del anfitrión. |
| Servidores guardados y relé del backend | Los clientes remotos autenticados pueden usar/administrar todos los servidores guardados en el anfitrión si la función y sus capacidades lo permiten. Las nuevas contraseñas o enlaces de emparejamiento requieren Control remoto o HTTPS. Consulta [servidores guardados](remote-access.md#saved-servers). |
| Ventanas remotas de escritorio y su proxy | Solo en el anfitrión (`/api/remote-proxy/`). |
| Contenido y WebSockets de SideCar (`/sidecars/`) | No disponibles a través del túnel. Usa el bucle local o activa el [acceso HTTPS directo a SideCars](browser-sidecars.md#register-sidecar) en el anfitrión. |
| Registro de SideCar (`/api/sidecars`) | Disponible para dispositivos emparejados y clientes directos autenticados. |
| Contenido de vistas previas web | [Abrir el navegador de una sesión](browser-sidecars.md#session-browser) |
| Puente de automatización | No disponible (`/api/opencode-plugin/`). Las capacidades nativas de escritorio no se convierten en capacidades del navegador. |
| Actualizaciones de conexión a WebSocket | Disponibles para vistas previas web y, en dispositivos emparejados, para [conversaciones de voz en directo](voice.md#conversation). |

Usa una conexión loopback en el anfitrión para los proxies/WebSockets reservados al anfitrión y la gestión de Control remoto (`/api/remote-control/`). El acceso directo por LAN también requiere loopback para estas operaciones; consulta [Orígenes permitidos](remote-access.md#upgrading).

## Relé y privacidad {#relay-privacy}

CodeNomad usa [OpenTunnel](https://github.com/anomalyco/opentunnel) y reserva una ruta aleatoria en la identidad de túnel predeterminada compartida del equipo.

TLS termina en el backend de CodeNomad. El relé reenvía texto cifrado y no puede leer el contenido de la aplicación, pero puede observar nombres de host, tiempos de conexión y tamaños de tráfico. El certificado/clave privada del túnel permanece en el anfitrión. Protege el almacenamiento del túnel del anfitrión y la configuración de CodeNomad como credenciales; una dirección imposible de adivinar no es autorización.

`CODENOMAD_REMOTE_CONTROL_API` selecciona una API de OpenTunnel autoalojada; sin definir se usa el servicio alojado. Esto cambia el despliegue del túnel, no los requisitos de emparejamiento ni las superficies bloqueadas. Consulta [Seguridad](security.md) para el tratamiento de credenciales y diagnósticos.

## Política del administrador {#administrator-policy}

Un administrador puede desactivar el control remoto para todos los usuarios de un equipo: define la variable de entorno `CODENOMAD_REMOTE_CONTROL=disabled` para todo el sistema y reinicia CodeNomad. El backend nunca conecta un túnel, rechaza **Iniciar control remoto** y los enlaces de emparejamiento y no se reconecta al iniciar; Ajustes muestra **Desactivado por el administrador**. Los dispositivos emparejados antes no pueden conectarse y siguen en la lista para que puedas revocarlos. Sin definir o vacía no aplica ninguna política; cualquier otro valor, incluso solo espacios, impide que el backend se inicie.
