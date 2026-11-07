# Acceso remoto directo

El acceso directo conecta a los listeners HTTP/HTTPS de CodeNomad usando su contraseña de servidor. Es independiente de [Control remoto](remote-control.md): el emparejamiento no necesita escucha en LAN ni puerto entrante, y ninguna vía recurre silenciosamente a la otra.

## Elegir una vía de acceso {#access-paths}

| Vía | Qué debes administrar |
| --- | --- |
| Navegador en el mismo equipo | Mantén la escucha en loopback; usa la URL local indicada. |
| LAN o VPN | Escucha en una interfaz accesible, restringe el cortafuegos a los clientes previstos y usa HTTPS de confianza. Una VPN no configura el listener de CodeNomad por ti. |
| Reenvío SSH | Mantén el backend escuchando en loopback; reenvía su puerto real indicado. El túnel protege el transporte, pero no sustituye la autenticación de CodeNomad. |
| Proxy inverso | Mantén el backend en una interfaz privada/loopback; termina TLS de confianza en el proxy, protege el salto al backend y admite SSE de larga duración y los WebSockets que necesiten tus herramientas de acceso directo. |
| Control remoto | Empareja el dispositivo desde el anfitrión; consulta [Control remoto](remote-control.md) para sus superficies más limitadas y su duración. |

Escuchar en una dirección no crea reglas de cortafuegos, reenvío de puertos, DNS ni VPN. No publiques en Internet un listener HTTP sin autenticar. Una raíz de espacio de trabajo no es un entorno aislado de seguridad; lee [Seguridad](security.md) antes de exponer el servidor.

## Activar el acceso directo {#enable-direct-access}

1. En el anfitrión, abre **Configuración → Acceso remoto** y expande **Acceso directo (red local, avanzado)**.
2. En **Contraseña del servidor**, elige **Configurar contraseña** o **Cambiar contraseña**, introduce **Nueva contraseña** y **Confirmar contraseña** y después **Guardar contraseña**. Las contraseñas proporcionadas en ejecución no pueden cambiarse aquí; consulta [Seguridad](security.md).
3. Activa **Permitir conexiones desde otras IP** en **Modo de escucha**. Lee la advertencia de reinicio y elige **Reiniciar ahora** solo cuando estés preparado para la interrupción temporal.
4. Tras reiniciar, usa **Actualizar** y comprueba **Direcciones accesibles**. Abre la dirección HTTPS accesible en el otro dispositivo, o elige **Mostrar QR** en el anfitrión y escanéalo con el otro dispositivo; después inicia sesión.

Esto cambia el modo de escucha directa del anfitrión, no un proyecto ni Control remoto. La sección se abre automáticamente mientras el servidor escucha más allá de localhost. Si el reinicio automático no está disponible, reinicia CodeNomad manualmente; los despliegues independientes deben definir coherentemente `--host` al iniciar. Para retirar la exposición, desactiva el interruptor y reinicia, o vuelve a iniciar la CLI escuchando en loopback. Esto no revoca los dispositivos emparejados de Control remoto.

### Matriz de direcciones de escucha {#binding-matrix}

`--host` usa por defecto `127.0.0.1`; `localhost` se normaliza a esa dirección. Se aplican las siguientes reglas a los listeners activados:

| Inicio/modo | HTTP escucha en | HTTPS escucha en |
| --- | --- | --- |
| Independiente, solo HTTPS (predeterminado) | Solo el listener privado de loopback (ver más abajo) | `--host` |
| Independiente, solo HTTP | **`--host`**, incluida una dirección LAN/comodín | No activado |
| Independiente, ambos listeners | `127.0.0.1` independientemente de `--host` | `--host` |
| Backend nativo de escritorio | Su listener HTTP permanece en `127.0.0.1`, incluido su listener interno del anfitrión | `--host` cuando HTTPS está activado |

Cada backend mantiene además un listener HTTP en `127.0.0.1` para los propios plugins de OpenCode incluidos con CodeNomad, como Misiones. Cuando no se solicitó HTTP, o el listener HTTP solicitado escucha en una dirección distinta de `127.0.0.1` o `0.0.0.0`, el backend añade un listener HTTP privado en un puerto aleatorio de `127.0.0.1`. Nunca se muestra ni se ofrece como dirección de conexión, no es accesible desde otras máquinas y sirve la misma aplicación autenticada.

Una dirección LAN concreta no tiene por qué aceptar conexiones loopback. `0.0.0.0` significa todas las interfaces IPv4; `::` es el listener comodín de doble pila. Usa en el navegador una dirección accesible real, no un comodín. Los identificadores de zona IPv6 no se admiten en `--host`.

Para un despliegue HTTPS independiente, establece una contraseña mediante el [procedimiento de inicialización](security.md) y ejecuta:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

Para HTTP solo en loopback, por ejemplo detrás de un proxy local de confianza:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

No supongas que el puerto es 9898 o 9899: los puertos omitidos pueden cambiar si están ocupados. Un `--https-port` explícito distinto de cero, o un `--http-port` con HTTP activado, fija el puerto y falla si no puede escuchar; `0` pide al sistema operativo que asigne uno. Las **Local Connection URL** y **Remote Connection URL** indicadas, y las **Direcciones accesibles** actualizadas, son autoritativas para esa ejecución. Consulta la [referencia completa de la CLI del servidor](server.md).

## Configurar TLS de confianza {#tls}

### Proporcionar tu propio certificado {#custom-certificates}

1. Obtén un certificado cuyos nombres alternativos del sujeto (SAN) cubran el nombre de host o la IP que realmente usan los clientes.
2. Proporciona tanto `--tls-key <path>` como `--tls-cert <path>` como archivos PEM. Añade `--tls-ca <path>` si tu despliegue necesita una cadena/conjunto de CA.
3. Reinicia CodeNomad y verifica el certificado y la dirección HTTPS indicada desde el dispositivo cliente.

Los archivos de certificados personalizados se leen al iniciar y CodeNomad nunca los reescribe. Tú te encargas de renovarlos y del reinicio necesario para cargar los archivos renovados. `--tlsSANs` configura certificados generados; no puede añadir nombres a un certificado proporcionado. Protege las claves privadas y confía solo en certificados cuya identidad de anfitrión hayas verificado.

### Usar la CA local generada {#generated-certificates}

Con HTTPS activado y sin un par clave/certificado proporcionado, CodeNomad crea una CA local y un certificado de servidor bajo la base de configuración:

| Archivo | Finalidad |
| --- | --- |
| `tls/ca-cert.pem` | Certificado público de la CA para distribuir de forma segura a los clientes que administras. |
| `tls/ca-key.pem` | Clave privada de la CA; nunca la distribuyas. |
| `tls/server-cert.pem` | Certificado del servidor. |
| `tls/server-key.pem` | Clave privada del servidor; nunca la distribuyas. |

1. Añade cada nombre DNS/IP usado por los clientes mediante `--tlsSANs "host.example.test,192.0.2.10"`. Escuchar con comodín no descubre todas tus direcciones LAN para los SAN.
2. Reinicia el backend para generar/volver a comprobar el certificado.
3. Verifica el anfitrión/la CA por un canal de confianza y luego importa **solo el certificado de la CA** al almacén de confianza de cada cliente/navegador previsto. También puedes usar un certificado de confianza pública o un proxy inverso TLS.

El certificado de servidor generado dura 30 días. El inicio lo renueva si faltan tres días o menos para caducar, si faltan SAN requeridos, si el certificado falla sus comprobaciones o si falta su archivo de clave privada. La CA generada dura 365 días y se reemplaza al caducar, si su certificado falla las comprobaciones o si falta su archivo de clave privada; reemplazarla también reemite el certificado del servidor. Las claves privadas existentes corruptas, ilegibles o que no coincidan no se reparan automáticamente. Los clientes deben confiar en la CA de reemplazo. No hay renovación continua dentro del proceso: organiza un reinicio deliberado antes de la caducidad en despliegues de larga duración.

Si un cliente muestra una advertencia de certificado, detente y comprueba el nombre de host, los SAN, el almacén de confianza y la caducidad. No desactives la verificación ni conviertas saltarse advertencias en tu procedimiento de despliegue. HTTPS de confianza también es necesario para funciones de navegador remoto como la [instalación PWA y el acceso al micrófono](mobile.md).

## Guardar un servidor remoto {#saved-servers}

1. En Inicio o una pestaña vacía **Abrir un proyecto**, abre **Explorar** e introduce la dirección o enlace en **Dirección o enlace del servidor**. Desde el lanzador rápido, elige primero **Abrir otro proyecto…**. Pegar añade al instante; Intro confirma el texto escrito. Se guarda el servidor, se enfoca su fila y el selector permanece; un enlace también empareja el backend local para explorar. Pulsa la fila para explorar. **Configuración → Servidores** ofrece el mismo campo.
2. Usa un origen HTTPS de confianza. Los errores de certificado y servidor inaccesible están traducidos; el control de información muestra el diagnóstico técnico bajo demanda. **Omitir la verificación TLS** exige una elección explícita: úsalo solo con un servidor de confianza y confirma otra vez. La acción de apertura anuncia al elegir el proyecto que este perfil usa otra ventana.
3. El nombre del servidor permanece visible durante el acceso y la navegación, con campos etiquetados y secciones **Recientes** y **Carpetas**. Los errores de emparejamiento nombran al servidor. **Editar servidor** en **Configuración → Servidores** cambia URL y nombre; sus botones `i` muestran ayuda de URL/TLS bajo demanda.

**Configuración → Servidores** gestiona los perfiles (**Editar servidor**, **Eliminar servidor guardado**). Al eliminar uno, primero se olvidan sus credenciales y sesión de exploración del backend, después se quita el marcador y se cierran sus pestañas. Los proyectos y conversaciones remotos permanecen en su servidor. El backend local guarda los secretos de exploración en `remote-server-credentials.json`, junto a su configuración; protege ese archivo como una contraseña. Las vistas integradas mantienen una autenticación separada.

Para abrir un servidor guardado directamente desde la línea de comandos, inicia la aplicación de escritorio con `--connect-server <nombre>` (o `--connect-server=<nombre>`), usando el nombre guardado del servidor o su URL `https://`. CodeNomad abre solo la ventana remota, con las comprobaciones TLS del perfil y el inicio de sesión propio de la ventana remota nativa; si CodeNomad ya se está ejecutando, su ventana actual lo abre en lugar de una nueva. Una URL que no coincide con ningún servidor guardado se guarda con su nombre de host. Los valores de inicio nunca llevan credenciales: se rechaza una URL con nombre de usuario, contraseña o código de emparejamiento. Si el nombre es desconocido, la URL no es válida o la conexión falla, CodeNomad se inicia con normalidad y muestra el error. Cuando la conexión necesita una confirmación, como instalar el certificado local para un servidor autofirmado, CodeNomad también se inicia con normalidad y la pide allí. En Windows, la compilación Tauri no se inicia si un argumento de inicio contiene `|`; usa en su lugar la URL del servidor o cambia el nombre del servidor.

Una ventana remota siempre deja una forma de volver a este equipo. Cerrar la última ventana local mientras siguen abiertas ventanas remotas conserva sus pestañas: **Ventana → Nueva ventana** en una ventana remota, o iniciar CodeNomad de nuevo, la vuelve a abrir. Si un servidor no se puede cargar, su ventana lo indica y ofrece **Reintentar**, **Abrir una ventana local** y **Cerrar ventana**; en la versión Tauri, usa el botón de recarga de la página y **Ventana → Nueva ventana**.

Pegar un enlace nuevo de Control remoto guarda el origen del túnel y empareja el backend local para explorar; su credencial de dispositivo se conserva de forma privada entre inicios. El código se descarta tras el intento. Tras una revocación, elige **Volver a Explorar** y pega un enlace nuevo en **Dirección o enlace del servidor**. Las vistas integradas se emparejan por separado. Si el emparejamiento del lado del servidor no está disponible, actualiza el servidor remoto o usa su URL de escucha directa para iniciar sesión con contraseña; las direcciones de túnel requieren emparejamiento. Consulta [Control remoto](remote-control.md).

## Abrir un proyecto remoto en una pestaña {#remote-project-tabs}

En la aplicación de escritorio (Electron, o Tauri en Windows), un servidor guardado también puede abrir uno de sus proyectos en una pestaña de esta ventana, junto a tus proyectos locales:

1. En Inicio o una pestaña vacía, abre **Explorar** y elige un servidor. Desde el lanzador rápido, usa primero **Abrir otro proyecto…**. Para añadir uno, usa **Dirección o enlace del servidor** y pulsa su fila.
2. El servidor identificado muestra **Recientes** y **Carpetas** en el mismo lugar. Accede en el formulario etiquetado si hace falta. Elige un reciente o navega y pulsa **Abrir esta carpeta**. **Volver a Explorar** regresa a los servidores.
3. Elegir carpeta crea una nueva instancia remota en lugar de la pestaña vacía y la añade a **Recientes**. La acción separada **Abierta** selecciona la existente. La acción de apertura anuncia otra ventana al elegir, incluidos los casos de TLS y Tauri macOS/Linux. Limitación conocida: la exploración del backend y la vista nativa se autentican de forma independiente.

Las conversaciones, archivos, Git, ajustes y Missions de la pestaña se ejecutan en el servidor remoto. Su vista integrada comparte el almacenamiento de la ventana remota y puede pedir otro inicio de sesión independiente de Explorar. Las pestañas remotas participan en la restauración al iniciar. Los servidores sin modo integrado muestran su interfaz completa; los perfiles que omiten TLS y Tauri en macOS/Linux abren otra ventana. La página integrada permanece en su servidor y solo dispone de notificaciones en el anfitrión. Los clientes web y dispositivos de Control remoto carecen de pestañas remotas.

La exploración del backend acepta la dirección de destino de cada perfil guardado, incluidas las de bucle local, LAN RFC1918, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS y `*.ts.net`, IPv6 ULA/link-local y los nombres que se resuelvan a estas direcciones. Las rutas de red y la configuración TLS deben permitir la conexión. La verificación del certificado sigue el perfil guardado y su confirmación TLS explícita.
