# Móvil y PWA

Usa la interfaz de navegador en un teléfono o tableta para continuar trabajando en el equipo del backend. Instalar la PWA cambia cómo se abre la interfaz, no dónde residen los proyectos, las credenciales o la ejecución del agente.

## Conectarse desde un teléfono o tableta {#connect}

Los servidores guardados están disponibles en **Explorar** en una pestaña vacía y en Configuración → Servidores. [Restaurar pestañas remotas](projects.md#restore-remote-tabs).

1. En el anfitrión, abre **Configuración → Acceso remoto → Control remoto** y elige **Iniciar control remoto**.
2. Escanea el QR de emparejamiento con tu dispositivo móvil y abre el enlace en el navegador que quieras seguir usando.
3. Como alternativa, configura el [acceso directo](remote-access.md), abre la URL HTTPS accesible y de confianza del anfitrión e inicia sesión con su contraseña de servidor.

Control remoto requiere emparejar el dispositivo; las conexiones directas requieren enrutamiento, un listener accesible y autenticación. No uses `localhost` en el teléfono para llegar a tu equipo de trabajo. Perder los datos del sitio o cambiar de perfil de navegador puede exigir iniciar sesión o emparejarse de nuevo; consulta [Control remoto](remote-control.md). Si el túnel está bloqueado, empareja en una dirección HTTPS de confianza; consulta [Emparejar por HTTPS directo](remote-control.md#direct-https).

## Instalar la PWA {#install-pwa}

1. Abre la URL operativa de CodeNomad por HTTPS de confianza en un navegador que admita instalación.
2. En Chrome/Edge y navegadores similares, usa la acción de instalación de la barra de direcciones o **Install CodeNomad** del navegador cuando se ofrezca. En Safari de iPhone/iPad, usa **Share → Add to Home Screen**; la redacción exacta depende del sistema operativo/navegador.
3. Abre el nuevo acceso directo y completa allí el inicio de sesión o el emparejamiento si usa un almacenamiento de navegador separado.

La instalación es por dispositivo/navegador y origen. No instala Node, Git ni OpenCode en el teléfono, no inicia un backend ni concede integraciones nativas de escritorio. Quitar el acceso directo no elimina las conversaciones del anfitrión; revoca por separado un dispositivo emparejado cuando retires el acceso.

### Contexto seguro y certificados {#secure-context}

La instalación remota de PWA y el acceso al micrófono necesitan un contexto seguro reconocido por el navegador. Usa un certificado HTTPS de confianza que coincida con el nombre de host/IP exactos. Un certificado local generado debe recibir confianza explícita del dispositivo/navegador cliente; una página de advertencia o saltársela no es una configuración fiable de instalación. Las excepciones de localhost del navegador se aplican a ese dispositivo, no a una dirección LAN HTTP de otro anfitrión.

No desactives la autenticación ni la verificación TLS para arreglar la instalación.

## Trabajar con disposiciones táctiles {#touch-layout}

Usa los controles **Panel izquierdo** y **Panel derecho** para abrir la navegación y las herramientas. En disposiciones estrechas, los paneles se superponen a la conversación en lugar de imponer un lienzo de anchura de escritorio; abrir un panel flotante cierra el otro. Elegir una sesión en el panel flotante de sesiones lo cierra para mostrar tu elección, incluso la sesión ya mostrada; **Atrás** y **Adelante** lo mantienen abierto. Las acciones de la cabecera de conversación pasan al menú de desbordamiento cuando falta espacio.

El editor de mensajes mantiene Agente, Modelo y Razonamiento en su pie. El tamaño del campo se calcula a partir de la altura de la conversación sin el teclado en pantalla. Al abrirse el teclado, el campo puede reducirse temporalmente para dejar espacio a los controles y mensajes, sin cambiar la proporción de altura guardada. Los borradores largos se pueden seguir desplazando. En dispositivos solo táctiles, enviar no vuelve a abrir el teclado en pantalla, para que puedas leer la respuesta; toca el editor para continuar. Mientras una sesión se ejecuta, el menú **Más acciones** del editor ofrece **Poner mensaje en cola** o **Intervenir ahora**, lo que no haga tu envío normal, sin necesitar un atajo de teclado físico. Abrir una interrupción compacta temporalmente el editor sin cambiar su altura guardada ni su borrador. Responde permisos/preguntas en el panel superior, manteniendo accesible su pie de acciones. Consulta [Conversaciones](conversations.md) y [Permisos](permissions.md).

## Límites de capacidades y conectividad {#limits}

| Capacidad | Navegador móvil / PWA |
| --- | --- |
| Proyectos, conversaciones, archivos y permisos | Operan en el equipo del backend conectado, sujetos a sus controles de acceso. Los adjuntos del dispositivo se suben desde el teléfono; las referencias del proyecto se resuelven en el anfitrión. |
| Ventanas nativas de escritorio, menús del sistema operativo y automatización nativa del anfitrión | No se obtienen al instalar la PWA. |
| Vista previa de navegador | No adquiere capacidades nativas de navegador invitado; la representación alternativa sigue limitada por el navegador. |
| Contenido de SideCar y WebSockets | Dependen de la vía de conexión; Control remoto bloquea el proxy de contenido de SideCar y sirve las vistas previas web, con sus WebSockets, mientras el anfitrión las permita. Consulta sus [restricciones exactas](remote-control.md). |
| Micrófono, portapapeles, notificaciones y solicitud de instalación | Dependen de la compatibilidad del navegador/sistema operativo, el contexto seguro y los permisos del usuario. |
| Trabajo sin conexión | No hay backend sin conexión ni historial API en caché. Los recursos estáticos de interfaz pueden almacenarse en caché, pero los documentos y respuestas API no son un espacio de trabajo sin conexión. |

Mantén el backend accesible. Comprueba si una acción terminó antes de reintentar. Cerrar la PWA no detiene un backend independiente; salir de la aplicación de escritorio anfitriona y su backend deja Control remoto no disponible hasta el siguiente inicio.

Cada pestaña del navegador, incluida la PWA instalada, conserva para esa pestaña sus proyectos abiertos, conversaciones seleccionadas, borradores sin enviar y posiciones de desplazamiento: vuelven cuando la página se recarga, o cuando el sistema móvil la recarga tras cambiar de aplicación o bloquear la pantalla. Una pestaña nueva, o una PWA que el sistema cerró por completo, muestra una pestaña vacía. Desactívalo para la pestaña en **Configuración → General → Restaurar el estado anterior**.
