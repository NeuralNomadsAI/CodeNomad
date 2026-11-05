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
## Secciones de integración en Estado {#integration-sections}

En **Estado → Plugins**, **+** ofrece **Añadir una integración…** o **Añadir un plugin…**. El selector de integraciones muestra las entradas no instaladas del catálogo revisado. Elige el ámbito e **Instalar**: CodeNomad instala el ID del catálogo seleccionado. Las integraciones nativas usan **Solo global**. **Catálogo no disponible** ofrece **Actualizar**; **Catálogo del {date}** identifica el último catálogo válido cuando está obsoleto.

Cada integración reconocida con una declaración o un plugin cargado/con error tiene su sección en **Estado**, incluso desactivada o instalándose. Una fuente ambigua muestra **No conforme** en Plugins. Cada integración conserva su fila de Plugins con acciones de actualización, eliminación y refresco. Despliega su sección para ver la versión y los controles del plugin en el cuerpo; nombre y estado siguen visibles en la cabecera junto a **Documentación** e **i**. El popover **i** muestra detalles a petición: se abre con Intro/Espacio y se cierra con Escape.

La personalización de Estado permite ocultar todas las secciones y reordenarlas arrastrando o con las teclas Arriba/Abajo. La visibilidad y el orden persisten al recargar y durante la ausencia temporal de una integración. Si desaparece una sección enfocada, el foco vuelve a Plugins, o a otra sección de Estado visible si Plugins está oculto.

Instalar desde el catálogo, instalar/actualizar la parte de la aplicación, vincular y quitar requieren confirmación. **Cancelar** recibe el foco inicial; la acción de confirmación se habilita tras 600 ms. La activación y las actualizaciones del plugin se ejecutan directamente.

## Vincular una aplicación abierta {#application-attachment}

Ofrece un documento desde la integración de la aplicación, abre **Estado → la integración → Conversación** y elige **Vincular…**. Esta sección controla el vínculo de la conversación mostrada. Selecciona aplicación y documento, revisa la conversación de destino y la advertencia de modificación y confirma con **Vincular**. La aplicación se ejecuta en el equipo de OpenCode, también en conexiones remotas. Los hosts no compatibles, incluido WSL, ofrecen ayuda mediante **i**.

La fila **Conversación** consulta el vínculo de la conversación mostrada. **Vínculo desconocido** ofrece **Actualizar**. Cuando una consulta reciente y autoritativa confirma el vínculo, **Desvincular** sustituye a **Vincular…**. Un clic desvincula solo esta conversación, sin otra confirmación; la aplicación sigue abierta, su parte instalada y las demás conversaciones conservan sus vínculos. Los cambios nativos y las reconexiones actualizan el estado.

Una acción admitida conserva su resultado o error mientras siga visible la conversación de destino; navegar cierra su recibo. El vínculo actual sigue la consulta autoritativa. **Estado incierto** tras perder una respuesta, agotar el tiempo o desconectarse ofrece **Actualizar** para consultar el estado real. Nunca repitas la solicitud para refrescar la pantalla.

Tras consultar explícitamente las aplicaciones abiertas en el selector, los metadatos Q8 guardados pueden ofrecer **Volver a vincular** en el selector o la fila **Conversación** para la misma integración y una etiqueta de documento validada, mientras se mantengan el proyecto, la conversación y la generación de conexión. Volver a vincular requiere confirmación explícita; navegar o invalidar los datos borra la sugerencia. La autoridad sobre el vínculo actual procede de la consulta por sesión de la integración.

Quitar desde la sección de integración o su fila de Plugins usa la misma declaración y confirmación de ámbito. Se realiza sin censar conversaciones ni desvincularlas automáticamente.

Al quitar un plugin se muestra una advertencia con su nombre y ámbito exacto. **Cancelar** recibe el foco; **Quitar de Global/Proyecto** se habilita tras 600 ms y exige una acción explícita. Puede interrumpir la disponibilidad y las conexiones de las conversaciones que lo usan; Global también puede afectar a otros proyectos. Cancelar, dejar caducar o navegar antes del envío no cambia nada. Solo se quita la declaración confirmada; se conservan reglas, caché, archivos de la aplicación y pistas guardadas de conexión. Si cambia la configuración, selecciona y confirma de nuevo. El éxito confirma la eliminación de la declaración; el estado de ejecución sigue la recarga de OpenCode. Si se pierde la respuesta, actualiza Plugins para comprobar la configuración antes de reintentar. Reinstalar puede restaurar la disponibilidad; puede ser necesario recargar o volver a vincular y las operaciones interrumpidas podrían no reanudarse.

## Instalar o actualizar la integración de la aplicación {#application-installation}

En **Estado → la integración → Aplicación**, elige **Instalar en la aplicación…** o **Actualizar la aplicación…** cuando el estado reciente ofrezca la acción. Está disponible sin conversación ni documento ofrecido. Si la aplicación está cerrada, ábrela para comprobar su parte de aplicación; **i** muestra el equipo y los requisitos.

La confirmación indica la aplicación y la **versión del paquete de integración** que proporciona el instalador. Comprueba ambos datos y la advertencia sobre el equipo: la instalación se ejecuta en el equipo donde se ejecuta OpenCode, que puede ser remoto. **Cancelar** recibe el foco inicial. Confirma explícitamente para continuar. Cambiar de proyecto, Location o conversación, reconectar o recibir cambios nativos relevantes antes de confirmar cancela la aprobación pendiente; vuelve a abrir la acción para revisar los datos actualizados.

WSL siempre rechaza la instalación en la aplicación, aunque una aplicación abierta parezca compatible. Abre la aplicación en un equipo compatible.

El resultado indica instalación, actualización, versión ya actualizada, rechazo o fallo. Tras instalar o actualizar, abre la aplicación y comprueba su integración; vincula una conversación por separado mediante [Vincular una aplicación abierta](#application-attachment). El éxito describe la solicitud de instalación; la disponibilidad de la aplicación procede de su estado.

Las solicitudes nunca se reintentan automáticamente. Tras un rechazo o fallo, comprueba la aplicación antes de elegir una nueva acción. Si un error deja el resultado incierto, nunca repitas esa solicitud: inspecciona primero la aplicación e inicia una nueva acción con confirmación si hace falta.
