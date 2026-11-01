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

1. [Añade el plugin](#plugin-sources) o decláralo en la configuración de OpenCode; después abre **Estado → Plugins**.
2. Pasa el puntero o enfoca su nombre para inspeccionar el origen, los fallos de ejecución y los detalles del destino de configuración.
3. Cambia deliberadamente **Global** o **Proyecto**. Espera la escritura y usa **Actualizar controles de plugins** si el estado no está claro.
4. Para un plugin instalado desde un paquete, usa el icono junto a su nombre. Su menú indica la operación exacta: **Buscar actualizaciones de** ese paquete, o **Actualizar** el paquete cuando se encuentre una versión más reciente.

Global apunta a la configuración global descubierta del daemon conectado. Proyecto apunta a la configuración dentro de la Location activa, no a un archivo de un antecesor heredado. Una regla posterior de Proyecto puede prevalecer sobre Global; el interruptor Global sigue mostrando la regla Global en lugar de fingir que es el estado final del Proyecto. Sin regla de Proyecto, Proyecto hereda el estado Global resuelto.

Estos interruptores añaden reglas exactas de activación conservando las declaraciones de origen y la configuración no relacionada. No editan opciones de plugins, instalan paquetes ni eliminan archivos. Los plugins integrados de OpenCode no se ofrecen como interruptores de activación del usuario. Proyecto se desactiva cuando su destino no puede separarse de Global con seguridad o saldría de la Location activa.

Una actualización de paquete cambia ese paquete en la caché compartida de OpenCode para todas las Locations que lo usan, como indica su ayuda emergente; no cambia las reglas de activación, no reinicia OpenCode ni recarga la configuración. Los plugins locales, integrados y proporcionados por el SDK no tienen acción de paquete. Un paquete que falla antes de informar del ID de su plugin aparece con su nombre de paquete, con el fallo en su ayuda emergente y las acciones de comprobar/actualizar, pero sin interruptores de activación. Una comprobación o actualización fallida se notifica y nunca se reintenta automáticamente.

La superficie conserva su última instantánea mientras está oculta y se revalida al mostrarse, tras cambios nativos/reconexión y al actualizar explícitamente. Una regla guardada y la disponibilidad real en ejecución pueden diferir brevemente. Si un plugin sigue sin estar disponible, inspecciona su ayuda emergente y la configuración nativa antes de elegir **Recargar la configuración de OpenCode**; esa acción afecta a todas las Locations cargadas, no solo a ese plugin. Una configuración mal formada o una edición concurrente no se sobrescriben silenciosamente: resuélvelas, actualiza y reintenta explícitamente.

## Añadir o quitar un plugin {#plugin-sources}

1. En **Estado → Plugins**, elige **Añadir plugin** (el icono de suma junto a **Actualizar controles de plugins**).
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
## Vincular una aplicación abierta {#application-attachment}

Ofrece un documento desde la integración de la aplicación y elige **Vincular una aplicación abierta…** en la cabecera de la conversación (o su menú de desbordamiento) o en el menú de su fila de Plugins. Solo aparece para una integración nativa activa con ofertas. Selecciona aplicación y documento, revisa la conversación de destino y la advertencia de modificación y elige **Confirmar vinculación**. Cancelar recibe el foco inicial. La aplicación se ejecuta en el equipo de OpenCode, también en conexiones remotas. Un host no compatible, incluido WSL no compatible, muestra ayuda en lugar de la acción.

Una acción admitida conserva su resultado o error ante cambios nativos y reconexiones mientras siga visible la conversación de destino. El éxito es un recibo local con **Desvincular esta conversación**, seguro aunque ya esté desvinculada. La desvinculación también muestra un recibo local. Al navegar se cierran estos recibos. Este contrato no permite consultar los vínculos actuales por conversación. Los metadatos guardados son solo una pista: **Volver a vincular** aparece en el selector únicamente si coinciden integración y etiqueta y requiere confirmación. Otros clientes pueden cambiar los vínculos. Tras reabrir, usa los controles de la aplicación para desvincular uno existente.

Plugins muestra que el catálogo no está disponible o conserva el último catálogo válido con su fecha de obtención si está obsoleto. Actualiza Plugins para reintentar. La eliminación se rechaza si hay conversaciones vinculadas o no se pueden verificar sus vínculos. Desvincúlalas en la aplicación, activa la integración si hace falta y actualiza antes de reintentar.

## Instalar o actualizar la integración de la aplicación {#application-installation}

En **Estado → Plugins**, abre el menú de la propia fila de la integración y elige **Instalar la integración de la aplicación…** o **Actualizar la integración de la aplicación…**. La acción aparece cuando un estado reciente de una integración nativa activa solicita instalar o actualizar. Está disponible sin una conversación ni un documento ofrecido.

La confirmación indica la aplicación y la **versión del paquete de integración** que proporciona el instalador. Comprueba ambos datos y la advertencia sobre el equipo: la instalación se ejecuta en el equipo donde se ejecuta OpenCode, que puede ser remoto. **Cancelar** recibe el foco inicial. Confirma explícitamente para continuar. Cambiar de proyecto, Location o conversación, reconectar o recibir cambios nativos relevantes antes de confirmar cancela la aprobación pendiente; vuelve a abrir la acción para revisar los datos actualizados.

WSL siempre rechaza la instalación en la aplicación, aunque una aplicación abierta parezca compatible. Abre la aplicación en un equipo compatible.

El resultado indica instalación, actualización, versión ya actualizada, rechazo o fallo. Tras instalar o actualizar, abre la aplicación y comprueba su integración; vincula una conversación por separado mediante [Vincular una aplicación abierta](#application-attachment). El éxito describe la solicitud de instalación; la disponibilidad de la aplicación procede de su estado.

Las solicitudes nunca se reintentan automáticamente. Tras un rechazo o fallo, comprueba la aplicación antes de elegir una nueva acción. Si un error deja el resultado incierto, nunca repitas esa solicitud: inspecciona primero la aplicación e inicia una nueva acción con confirmación si hace falta.
