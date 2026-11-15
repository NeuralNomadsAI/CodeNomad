# Integraciones nativas

CodeNomad expone las conexiones MCP nativas, la activación de plugins, las habilidades y los comandos personalizados de OpenCode. Se ejecutan en el equipo de ejecución. Son independientes de las [Extensiones de panel](extensions.md) aisladas y los [SideCars](browser-sidecars.md).

## Elegir el control adecuado {#integration-scopes}

| Integración | Dónde actuar | Qué cambia el control |
| --- | --- | --- |
| Servidor MCP | **Estado → Servidores MCP** | Conexión nativa en la Location mostrada; no instala un servidor. |
| Plugin nativo | **Estado → Plugins** | Añade o quita la declaración de un paquete y establece una regla persistente de activación **Global** o **Proyecto**; para un plugin de paquete, una comprobación o actualización explícita de ese paquete. |
| Habilidad | Menú `@` del editor | Adjunto explícito al siguiente mensaje en la Location de la conversación. |
| Comando personalizado | Menú `/` del editor | Ejecuta un comando expuesto por OpenCode para esa Location. |

Configura/instala primero la integración mediante la configuración y la CLI compatibles de OpenCode. Instalar un paquete, declarar su origen, activar su regla, conectar un servicio y hacer disponibles sus herramientas son pasos independientes. Las integraciones nativas tienen los privilegios del proceso anfitrión, sujetos a los permisos de OpenCode; no son paneles HTML aislados.

## Conectar o desconectar MCP {#mcp}

1. Configura el servidor MCP en el equipo de ejecución de OpenCode con la [documentación MCP de OpenCode](https://opencode.ai/v2/docs/mcp-servers/).
2. Abre **Estado → Servidores MCP** para el proyecto.
3. Usa el interruptor junto al servidor para conectarlo o desconectarlo. Espera a que el indicador de conexión se estabilice.

El interruptor llama a la API nativa de conexión para la Location indicada, no a un instalador local del dispositivo ni a una preferencia de visibilidad por ventana. Otros clientes que usen esa Location pueden observar el cambio de conexión. Desconectar no retira la declaración del servidor ni desinstala su ejecutable.

Si no aparece ningún servidor, verifica la Location activa y su configuración nativa. Si falla la conexión, inspecciona la configuración del servidor, el entorno requerido y el flujo nativo de autenticación; no supongas que el interruptor completa OAuth. Vuelve a comprobar el estado después de reconectar. Usa la recarga explícita de configuración solo cuando sea necesaria, con las interrupciones descritas en [configuración de OpenCode](opencode.md).

## Activar plugins con ámbito Global o Proyecto {#plugins}

Los plugins gestionados por CodeNomad quedan fuera de la lista ordinaria y de sus controles de activación, actualización y eliminación. CodeNomad los reconoce por la entrada validada del instalador y la ubicación de su código identificado por su huella de contenido; un plugin de terceros con el mismo nombre o ID conserva sus controles ordinarios.

Si un plugin gestionado está desactivado, no se carga o su carga sigue sin confirmarse, aparece **Los plugins de CodeNomad requieren atención** encima de la lista de Plugins. Abre su botón **i** (**Detalles de** ese plugin) para ver el error disponible y la referencia en el registro de OpenCode. Solo un plugin desactivado ofrece **Reactivar**: añade una regla de activación positiva para el ID exacto y conserva la regla de desactivación. Escribe en el ámbito **Global** o **Proyecto** de la regla de desactivación si permite escritura; de lo contrario, en **Proyecto**. OpenCode sigue funcionando; el aviso permanece hasta que los eventos nativos o **Actualizar controles de plugins** confirmen que el plugin está activo.

El aviso y sus detalles identifican el origen de la configuración como **Heredada / externa** o **Configuración virtual**, según corresponda. Una etiqueta **Proyecto** separada indica el destino de reactivación cuando difiere del origen de la regla de desactivación.

1. [Añade el plugin](#plugin-sources) o decláralo en la configuración de OpenCode; después abre **Estado → Plugins**.
2. Pasa el puntero o enfoca su nombre para inspeccionar el origen, los fallos de ejecución y los detalles del destino de configuración.
3. Cambia deliberadamente **Global** o **Proyecto**. Espera la escritura y usa **Actualizar controles de plugins** si el estado no está claro.
4. Para un plugin instalado desde un paquete, usa el icono junto a su nombre. Su menú indica la operación exacta: **Buscar actualizaciones de** ese paquete, o **Actualizar** el paquete cuando se encuentre una versión más reciente.

Global apunta a la configuración global descubierta del daemon conectado. Proyecto apunta a la configuración dentro de la Location activa, no a un archivo de un antecesor heredado. Una regla posterior de Proyecto puede prevalecer sobre Global; el interruptor Global sigue mostrando la regla Global en lugar de fingir que es el estado final del Proyecto. Sin regla de Proyecto, Proyecto hereda el estado Global resuelto.

Estos interruptores añaden reglas exactas de activación conservando las declaraciones de origen y la configuración no relacionada. No editan opciones de plugins, instalan paquetes ni eliminan archivos. Los plugins integrados de OpenCode no se ofrecen como interruptores de activación del usuario. Proyecto se desactiva cuando su destino no puede separarse de Global con seguridad o saldría de la Location activa.

Una actualización de paquete cambia ese paquete en la caché compartida de OpenCode para todas las Locations que lo usan, como indica su ayuda emergente; no cambia las reglas de activación, no reinicia OpenCode ni recarga la configuración. Los plugins locales, integrados y proporcionados por el SDK no tienen acción de paquete. Un paquete que falla antes de informar del ID de su plugin aparece con su nombre de paquete, con el fallo en su ayuda emergente y las acciones de comprobar/actualizar, pero sin interruptores de activación. Una comprobación o actualización fallida se notifica y nunca se reintenta automáticamente.

La superficie conserva su última instantánea mientras está oculta y se revalida al mostrarse, tras cambios nativos/reconexión y al actualizar explícitamente. Una regla guardada y la disponibilidad real en ejecución pueden diferir brevemente. Si un plugin sigue sin estar disponible, inspecciona su ayuda emergente y la configuración nativa antes de elegir **Recargar la configuración de OpenCode**; esa acción afecta a todas las Locations cargadas, no solo a ese plugin. Una configuración mal formada o una edición concurrente no se sobrescriben silenciosamente: resuélvelas, actualiza y reintenta explícitamente.

## Añadir o quitar un plugin {#plugin-sources}

1. En **Estado → Plugins**, abre **+** y elige **Añadir un plugin…**.
2. Escribe un paquete del registro npm (`nombre`, `nombre@1.2.3`, `@scope/nombre@^1`) o un repositorio Git (`github:propietario/repo`, `git+https://…`).
3. Mantén **Global**, salvo que el plugin deba ejecutarse solo para este proyecto, y elige **Añadir**.
4. La nueva fila muestra **Instalando** hasta que OpenCode la notifica. Entonces pasa a ser una fila de plugin normal con sus interruptores, o una fila con error.

Para quitar un plugin, abre el menú junto a su nombre y elige **Quitar de Global** o **Quitar de Proyecto**. Solo se elimina la declaración del archivo de configuración de ese ámbito; sus reglas de activación **Global**/**Proyecto** siguen como reglas y la caché de paquetes de OpenCode se conserva.

El código del plugin se ejecuta con tus permisos dentro de OpenCode. Una entrada de **Proyecto** se ejecuta cada vez que esa carpeta se abre en OpenCode, y los paquetes con partes para la aplicación de escritorio de OpenCode solo las cargan desde **Global**; la información emergente lo indica cuando ese paquete se declara en otro sitio. Aquí se rechazan las rutas locales, las variables de configuración y los ID de plugin: declara los plugins locales en el archivo de configuración. Se rechaza un paquete ya declarado en una configuración que se aplica a esta Location, sea cual sea su versión, rango o forma.

Una integración de OpenCode del catálogo revisado (por ejemplo, la integración de Blender) se reconoce antes de instalarla. La que tiene una parte dentro de una aplicación se añade solo en **Global**: **Proyecto** se rechaza para ella. Su paquete del registro y sus builds de Git cuentan como un solo paquete, así que añadir una segunda forma de una integración ya declarada o cargada se rechaza.

Pasa el puntero o el foco por el nombre de un plugin para ver su versión, **Actualización disponible** y, si la instalación falló, el error con su referencia en el registro de OpenCode. Una fila que OpenCode no ha notificado tras dos minutos muestra **Sin confirmar** con la acción **Actualizar controles de plugins**: el plugin puede estar desactivado, o su instalación nunca terminó (consulta [Solución de problemas](troubleshooting.md#providers-and-addons)).

## Adjuntar habilidades {#skills}

1. Escribe `@` en el editor, busca las habilidades disponibles en la Location y selecciona una.
2. Comprueba su adjunto removible junto a los archivos/agentes; quítalo antes de enviar si no era lo previsto.
3. Envía el mensaje. Las etiquetas de habilidades permanecen con el mensaje enviado.

La selección adjunta el ID nativo de la habilidad y retira el token `@query`; no pega las instrucciones en el borrador visible. Enviar borra la selección del editor, no las instrucciones ya almacenadas por OpenCode con ese mensaje. Retirar un adjunto no puede deshacer un envío anterior.

La disponibilidad de habilidades procede de la Location de la conversación, no de un catálogo global de habilidades de CodeNomad. Si la lista no carga, cierra y vuelve a abrir el selector para reintentar; si está vacía, comprueba el descubrimiento/configuración nativos. Consulta la [documentación de habilidades de OpenCode](https://opencode.ai/v2/docs/skills/) y [Conversaciones](conversations.md).

## Ejecutar comandos personalizados {#commands}

1. Escribe `/` en el editor y elige un comando nativo disponible.
2. Proporciona sus argumentos y comprueba **Agente**, **Modelo** y **Razonamiento** antes de enviar, según corresponda al comando.
3. Inspecciona la conversación resultante en lugar de enviarlo repetidamente si la confirmación no está clara.

Los comandos se descubren desde OpenCode para la Location activa. Su propia definición nativa puede elegir el comportamiento de ejecución; el menú no es un instalador de paquetes ni un editor de configuración sin restricciones. CodeNomad aplica el entorno de sesión del perfil antes de enviar el comando personalizado nativo; un fallo al actualizar el entorno bloquea el envío. `/btw` es el flujo aparte de preguntas efímeras de CodeNomad, no un comando personalizado normal.

Para definiciones de comandos y herencia de configuración nativa, usa la [documentación de comandos de OpenCode](https://opencode.ai/v2/docs/commands/). Tras cambios de configuración, actualiza/reabre primero la superficie correspondiente; usa la recarga explícita de configuración solo si el entorno de ejecución aún la necesita. Nunca repitas un comando posiblemente admitido solo para actualizar su visualización.
## Integraciones en Plugins {#integration-rows}

En **Estado → Plugins**, **+** ofrece **Añadir una integración…** o **Añadir un plugin…**. El selector de integraciones muestra las entradas no instaladas del catálogo revisado. Elige el ámbito e **Instalar**: CodeNomad instala el ID del catálogo seleccionado. Las integraciones nativas usan **Solo global**. **Catálogo no disponible** ofrece **Actualizar**; **Catálogo del {date}** identifica el último catálogo válido cuando está obsoleto.

Una integración reconocida tiene una fila en **Estado → Plugins**, con su nombre (por ejemplo **OpenCode for Blender**) y su versión. Sus interruptores **Global** y **Proyecto** usan el color de acento como los demás interruptores, los de un plugin simple son verdes; una integración con una parte dentro de una aplicación es **Solo global**. Pasa el puntero sobre su nombre: los detalles empiezan por **Integración** en lugar de **Plugin**; los lectores de pantalla los leen como descripción de la fila. Una fuente ambigua muestra **No conforme**.

Bajo el nombre, una línea de estado indica siempre en qué punto está la integración. El texto gris informa; el texto en color de acento es un botón. En una integración con una parte dentro de una aplicación se muestra el estado más importante: **Instalar en Blender** o **Actualizar Blender** cuando su parte falta o es antigua (con la confirmación de instalación), una incompatibilidad en el color de aviso, un icono de cadena y el documento cuando la conversación visible está vinculada (púlsalo para desvincularla), **Blender cerrado**, **Blender: ningún documento abierto**, **No se muestra ninguna conversación**, y después **Vincular** con el nombre del documento, o **Vincular…** para elegir entre varios documentos. Una conversación también se vincula sola la primera vez que su agente usa la integración. Las integraciones MCP de editor muestran **Servidor detectado** o **Servidor no encontrado**; las de API, **Conectado** o **Desconectado**. Un estado largo se acorta; pasa el puntero para ver el texto completo. Los cambios que comunica la integración y las reconexiones actualizan la línea.

El menú **…** de la fila empieza por el estado de la conexión, por ejemplo **Blender: 1 documento abierto** o **Blender cerrado**. Después ofrece **Documentación**, **Instalar en la aplicación…**, **Actualizar la aplicación…** o **Reinstalar en la aplicación…** ([ver más abajo](#application-installation)), la comprobación de actualizaciones del paquete, **Quitar de Global** o **Quitar de Proyecto** y **Actualizar controles de plugins**. Desvincular requiere un clic sin confirmación y solo afecta a esta conversación: la aplicación sigue abierta, su parte sigue instalada y las demás conversaciones conservan su vínculo. Si se pierde la respuesta, la fila vuelve a leer el estado; la solicitud nunca se repite.

La instalación desde el catálogo, la instalación o actualización de la parte de la aplicación y la eliminación requieren confirmación. **Cancelar** recibe el foco primero; la acción de confirmación se habilita tras 600 ms. La activación, las actualizaciones de plugins, la vinculación y la desvinculación se ejecutan directamente.

La eliminación se realiza sin recuento de conversaciones ni desvinculación automática.

Al quitar un plugin se muestra una advertencia con su nombre y ámbito exacto. **Cancelar** recibe el foco; **Quitar de Global/Proyecto** se habilita tras 600 ms y exige una acción explícita. Puede interrumpir la disponibilidad y las conexiones de las conversaciones que lo usan; Global también puede afectar a otros proyectos. Cancelar, dejar caducar o navegar antes del envío no cambia nada. Solo se quita la declaración confirmada; se conservan reglas, caché, archivos de la aplicación y pistas guardadas de conexión. Si cambia la configuración, selecciona y confirma de nuevo. El éxito confirma la eliminación de la declaración; el estado de ejecución sigue la recarga de OpenCode. Si se pierde la respuesta, actualiza Plugins para comprobar la configuración antes de reintentar. Reinstalar puede restaurar la disponibilidad; puede ser necesario recargar o volver a vincular y las operaciones interrumpidas podrían no reanudarse.

## Instalar o actualizar la integración de la aplicación {#application-installation}

En **Estado → Plugins**, pulsa **Instalar en Blender** o **Actualizar Blender** en la línea de estado de la integración cuando su estado actual ofrece la acción, o elige **Instalar en la aplicación…**, **Actualizar la aplicación…** o **Reinstalar en la aplicación…** en su menú **…**. Reinstalar vuelve a escribir la parte de la aplicación, esté abierta o cerrada. Está disponible sin conversación ni documento abierto.

La confirmación indica la aplicación y la **versión del paquete de integración** que proporciona el instalador. Comprueba ambos datos y la advertencia sobre el equipo: la instalación se ejecuta en el equipo donde se ejecuta OpenCode, que puede ser remoto. **Cancelar** recibe el foco inicial. Confirma explícitamente para continuar. Cambiar de proyecto, Location o conversación, reconectar o recibir cambios nativos relevantes antes de confirmar cancela la aprobación pendiente; vuelve a abrir la acción para revisar los datos actualizados.

WSL siempre rechaza la instalación en la aplicación, aunque una aplicación abierta parezca compatible. Abre la aplicación en un equipo compatible.

El resultado indica que la parte de la aplicación se instaló, se actualizó, ya estaba al día, se rechazó o falló. Tras instalar o actualizar, abre la aplicación y comprueba su integración. El éxito de la instalación describe la solicitud del instalador; la disponibilidad real de la aplicación procede de su estado.

Las solicitudes nunca se reintentan automáticamente. Tras un rechazo o fallo, comprueba la aplicación antes de elegir una nueva acción. Si un error deja el resultado incierto, nunca repitas esa solicitud: inspecciona primero la aplicación e inicia una nueva acción con confirmación si hace falta.
