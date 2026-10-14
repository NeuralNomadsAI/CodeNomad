# Autenticación y seguridad

El acceso a CodeNomad permite ejecutar trabajo en el equipo del backend mediante OpenCode. Trata las contraseñas de servidor, las sesiones de navegador y los dispositivos emparejados como credenciales potentes. CodeNomad no es un entorno aislado de ejecución multiusuario.

## Elegir cómo autentica el servidor {#authentication}

| Método | Duración y ámbito |
| --- | --- |
| `--password` o `CODENOMAD_SERVER_PASSWORD` | Valor de ejecución para ese proceso del backend. Debe proporcionarse en cada inicio; no se conserva. Prevalece sobre el archivo de contraseña gestionado. |
| Contraseña establecida en Configuración | Conserva un hash scrypt con sal en `auth.json` junto al YAML de configuración activo. Se usa en inicios posteriores sin un valor de ejecución que lo sustituya. |
| `--generate-token` | Activa la inicialización local de un solo uso; el token indicado dura 60 segundos. No es un token API reutilizable ni un enlace de Control remoto. |
| Emparejamiento de Control remoto | Autenticación independiente por cookie de dispositivo, gestionada desde el anfitrión; consulta [Control remoto](remote-control.md). |

El usuario predeterminado es `codenomad`. Un archivo de autenticación almacenado conserva su nombre de usuario; cambiar solo `--username` no renombra esa identidad almacenada. Sin una contraseña configurada, modo de inicialización o autenticación omitida explícitamente, el servidor rechaza el inicio.

Prefiere un secreto protegido del entorno/servicio a insertar una contraseña en argumentos de comandos o en el historial del shell. Cualquiera que pueda inspeccionar el entorno de tu proceso o el directorio de configuración aún puede comprometer el despliegue.

## Inicializar una contraseña persistente {#bootstrap}

1. Inicia localmente sin un valor de contraseña de ejecución. Para inicializar en loopback sin configurar antes un certificado, usa `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch`.
2. En el equipo del backend, abre `/auth/token` en la **Local Connection URL** indicada y envía el valor mostrado después de `CODENOMAD_BOOTSTRAP_TOKEN:`. No compartas esa salida.
3. Abre **Configuración → Acceso remoto → Acceso directo (red local, avanzado) → Contraseña del servidor**.
4. Elige **Configurar contraseña**, rellena **Nueva contraseña** y **Confirmar contraseña** con al menos ocho caracteres y elige **Guardar contraseña**.
5. En el siguiente inicio, omite `--generate-token` y usa la contraseña guardada para las conexiones directas. Antes de activar el acceso remoto, configura [HTTPS de confianza](remote-access.md); el comando de configuración HTTP en loopback no es un comando de despliegue remoto.

La inicialización se acepta solo desde el listener loopback del propio anfitrión, no desde un cliente LAN ni la entrada de Control remoto. Mantén la escucha loopback predeterminada para la configuración inicial. Un token caducado o consumido requiere un inicio nuevo de inicialización. Si ya existe una contraseña persistente, la sesión de inicialización permite elegir **Cambiar contraseña** en su lugar.

`auth.json` lo gestiona la aplicación; no edites un hash a mano ni publiques el archivo. Si la contraseña procede de CLI/entorno, Configuración se niega a reemplazarla: reinicia sin ese valor para usar una contraseña gestionada existente o usa la inicialización local para establecer una. Un archivo de autenticación ilegible o no escribible necesita reparar permisos/ruta del sistema operativo, no desactivar la autenticación.

## Sesiones de navegador y revocación {#sessions}

El inicio de sesión directo crea una sesión opaca en memoria del backend y una cookie `codenomad_session` (o el nombre de cookie configurado). Las cookies son `HttpOnly`, `SameSite=Lax`, tienen ámbito `/` y se marcan `Secure` al emitirse por HTTPS. Son cookies de sesión del navegador; reiniciar el backend invalida las sesiones en memoria. Vuelve a autenticarte sin abandonar la vista cuando se solicite, en lugar de reenviar modificaciones fallidas.

Cambiar una contraseña cambia las comprobaciones de credenciales posteriores; **no** invalida las sesiones directas ya emitidas ni los dispositivos de Control remoto. Si sospechas una intrusión:

1. Restringe la exposición de red y establece una contraseña nueva en el anfitrión, o cambia el secreto de ejecución y reinicia.
2. Reinicia el backend para invalidar sus sesiones directas existentes.
3. En **Control remoto → Dispositivos emparejados**, usa **Revocar** por separado para los dispositivos desconocidos. Detén Control remoto si necesitas cortar inmediatamente toda su vía de acceso.
4. Revisa los archivos afectados, las cuentas de proveedores y la actividad nativa de OpenCode. Detener el acceso no revierte el trabajo ya admitido.

Consulta [Control remoto](remote-control.md) para su caducidad independiente de 30 días de inactividad y sus enlaces de emparejamiento de cinco minutos. Cambiar una contraseña no revoca dispositivos, y detener un túnel no elimina dispositivos.

## Proteger el transporte y la exposición de listeners {#transport}

Usa HTTPS de confianza para el acceso remoto directo. HTTP sin cifrar expone contraseñas, cookies de sesión y contenido de trabajo a quien pueda observar ese salto de red. Si TLS termina en un proxy inverso, mantén el salto al backend en loopback u otra red protegida; TLS del proxy no cifra una conexión HTTP expuesta al backend.

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH` desactiva el inicio de sesión del listener directo de CodeNomad y trata las solicitudes como autenticadas. **No** hace seguro exponer el servidor. Un listener accesible sin un perímetro que imponga controles concede acceso a cualquiera que pueda alcanzarlo; una conexión VPN por sí sola no distingue usuarios VPN fiables de no fiables. Mantén la autenticación activada salvo que hayas diseñado y verificado de forma independiente todas las vías de acceso. Control remoto sigue exigiendo un dispositivo emparejado, incluso con esta opción.

Comprueba la [matriz de escucha y los procedimientos TLS](remote-access.md), especialmente el modo independiente solo HTTP: respeta `--host` y puede exponer texto sin cifrar más allá de loopback. Nunca resuelvas errores de certificado desactivando la verificación.

**`CODENOMAD_SKIP_AUTH=false` sigue desactivando la autenticación.** Esta variable de entorno de tipo interruptor se activa siempre que esté definida, incluso como `false`, `0` o un valor vacío. Elimínala del entorno para desactivar el interruptor; consulta la [referencia CLI](server.md#cli-reference).

## Comprender el límite del anfitrión {#host-boundary}

`--workspace-root` restringe qué espacios de trabajo se pueden abrir y `--unrestricted-root` flexibiliza la exploración. Ninguno es una jaula del sistema operativo, un contenedor, un entorno aislado de sistema de archivos ni una restricción sobre lo que puede hacer una herramienta nativa autorizada. Los agentes, comandos de shell, plugins y herramientas MCP actúan con los permisos del equipo de ejecución y sus propias credenciales configuradas.

Usa cuentas del sistema operativo, contenedores/máquinas virtuales y configuración de permisos de origen cuando necesites aislamiento real. No concedas acceso a un dispositivo solo porque esperas que vea una única pestaña. La configuración del servidor y el servicio compartido de OpenCode pueden afectar a otras conversaciones/proyectos; consulta [configuración de OpenCode](opencode.md), [Permisos](permissions.md) y [Extensiones](extensions.md) para sus límites independientes.

## Mantener privados credenciales y diagnósticos {#privacy}

OpenCode es propietario de las conexiones de proveedores y de su almacenamiento global de conversaciones. CodeNomad lee en el servidor metadatos de conexión y credenciales seleccionadas para integraciones compatibles de uso; las API del navegador no devuelven secretos de proveedores. La renovación de inicios de sesión OAuth externos corresponde a su propietario; CodeNomad no intercambia esos tokens de actualización. Consulta [Proveedores](providers.md).

| Material | Tratamiento |
| --- | --- |
| Contraseñas, tokens de inicialización, enlaces de emparejamiento, cookies | Nunca los pegues en incidencias, capturas, transcripciones de shell ni registros compartidos. |
| `auth.json`, claves privadas TLS, identidad de túnel, secretos de configuración | Protégelos con permisos del sistema operativo y copias de seguridad cifradas; no subas directorios completos para obtener soporte. |
| Texto de conversaciones, adjuntos, rutas de espacios de trabajo y direcciones remotas | Revisa/oculta datos antes de compartir; pueden identificar personas, proyectos o infraestructura. |
| Claves de proveedores y credenciales de voz | Introdúcelas solo en la configuración/propietario de credenciales previsto; comprueba qué proveedor recibe los datos. Consulta [Voz](voice.md). |
| Registros debug/trace y capturas de red | Recoge solo lo necesario, inspecciona localmente y oculta datos antes de informar. No supongas que la salida de todas las herramientas posteriores está libre de secretos. |

**Configuración → Info → Informar de un error** prepara diagnósticos acotados sin rellenar listeners, direcciones, rutas, credenciales ni contenido de conversaciones. Revisa todo lo que añadas antes de enviarlo. Consulta [Soporte](support.md).
