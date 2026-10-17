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

Esto cambia el modo de escucha directa del anfitrión, no un proyecto ni Control remoto. La sección está contraída por defecto incluso si el servidor escucha más allá de localhost. Si el reinicio automático no está disponible, reinicia CodeNomad manualmente; los despliegues independientes deben definir coherentemente `--host` al iniciar. Para retirar la exposición, desactiva el interruptor y reinicia, o vuelve a iniciar la CLI escuchando en loopback. Esto no revoca los dispositivos emparejados de Control remoto.

### Matriz de direcciones de escucha {#binding-matrix}

`--host` usa por defecto `127.0.0.1`; `localhost` se normaliza a esa dirección. Se aplican las siguientes reglas a los listeners activados:

| Inicio/modo | HTTP escucha en | HTTPS escucha en |
| --- | --- | --- |
| Independiente, solo HTTPS (predeterminado) | No activado | `--host` |
| Independiente, solo HTTP | **`--host`**, incluida una dirección LAN/comodín | No activado |
| Independiente, ambos listeners | `127.0.0.1` independientemente de `--host` | `--host` |
| Backend nativo de escritorio | Su listener HTTP permanece en `127.0.0.1`, incluido su listener interno del anfitrión | `--host` cuando HTTPS está activado |

Una dirección LAN concreta no tiene por qué aceptar conexiones loopback. `0.0.0.0` significa todas las interfaces IPv4; `::` es el listener comodín de doble pila. Usa en el navegador una dirección accesible real, no un comodín. Los identificadores de zona IPv6 no se admiten en `--host`.

Para un despliegue HTTPS independiente, establece una contraseña mediante el [procedimiento de inicialización](security.md) y ejecuta:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

Para HTTP solo en loopback, por ejemplo detrás de un proxy local de confianza:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

No supongas que el puerto es 9898 o 9899: los puertos omitidos pueden cambiar si están ocupados. Un `--https-port` o `--http-port` explícito distinto de cero fija el puerto y falla si no puede escuchar; `0` pide al sistema operativo que asigne uno. Las **Local Connection URL** y **Remote Connection URL** indicadas, y las **Direcciones accesibles** actualizadas, son autoritativas para esa ejecución. Consulta la [referencia completa de la CLI del servidor](server.md).

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

1. En la página de inicio de escritorio, selecciona **Servidores** y después **Conectar a un servidor**.
2. Introduce **Nombre del servidor** y **URL del servidor** usando un origen HTTPS de confianza. Deja sin marcar **Omitir la verificación TLS para certificados autofirmados.**; establece confianza en su lugar.
3. Elige **Guardar** para crear un marcador o **Conectar** para guardarlo y abrirlo. Inicia sesión en ese servidor.

Los marcadores pertenecen a esta configuración de CodeNomad, no a los proyectos del servidor remoto. Guardar una URL no inicia el servidor ni concede acceso. **Eliminar servidor guardado** elimina el marcador, no las conversaciones remotas, el backend ni sus credenciales. Los servidores guardados también se pueden abrir desde la lista **Servidores remotos** del lanzador de nuevas instancias.

Para Control remoto, pega en su lugar un enlace de emparejamiento nuevo en **URL del servidor**. El marcador conserva solo el origen del túnel, nunca el código de un solo uso; consulta [Control remoto](remote-control.md) para volver a emparejar tras perder la cookie del dispositivo.
