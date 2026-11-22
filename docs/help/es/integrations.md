# Integraciones nativas

CodeNomad expone las conexiones MCP nativas, la activación de plugins, las habilidades y los comandos personalizados de OpenCode. Se ejecutan en el equipo de ejecución. Son independientes de las [Extensiones de panel](extensions.md) aisladas y los [SideCars](browser-sidecars.md).

## Elegir el control adecuado {#integration-scopes}

| Integración | Dónde actuar | Qué cambia el control |
| --- | --- | --- |
| Servidor MCP | **Estado → Servidores MCP** | Conexión nativa en la Location mostrada; no instala un servidor. |
| Plugin nativo | **Estado → Plugins** | Añade o quita la declaración de un paquete y establece una regla persistente de activación **Global** o **Proyecto**; para un plugin de paquete, una comprobación o actualización explícita de ese paquete. |
| Habilidad | Menú `@` del editor | Adjunto explícito al siguiente mensaje en la Location de la conversación. |
| Comando personalizado | Menú `/` del editor | Ejecuta un comando expuesto por OpenCode para esa Location. |

Las integraciones nativas tienen los privilegios del proceso anfitrión, sujetos a los permisos de OpenCode; no son paneles HTML aislados.

## Conectar o desconectar MCP {#mcp}

1. Configura el servidor MCP en el equipo de ejecución de OpenCode con la [documentación MCP de OpenCode](https://opencode.ai/v2/docs/mcp-servers/).
2. Abre **Estado → Servidores MCP** para el proyecto.
3. Usa el interruptor junto al servidor para conectarlo o desconectarlo. Espera a que el indicador de conexión se estabilice.

Otros clientes que usen esa Location pueden observar el cambio de conexión. Desconectar no retira la declaración del servidor ni desinstala su ejecutable.

Si falla la conexión, comprueba la configuración del servidor, el entorno requerido y la autenticación; el interruptor no completa OAuth.

## Activar plugins con ámbito Global o Proyecto {#plugins}

Los plugins gestionados por CodeNomad quedan fuera de la lista ordinaria y de sus controles de activación, actualización y eliminación.

En **Los plugins de CodeNomad requieren atención**, abre **i** para ver los detalles. Un plugin desactivado ofrece **Reactivar**; comprueba antes el ámbito de configuración mostrado.

1. [Añade el plugin](#plugin-sources) o decláralo en la configuración de OpenCode; después abre **Estado → Plugins**.
2. Pasa el puntero o enfoca su nombre para inspeccionar el origen, los fallos de ejecución y los detalles del destino de configuración.
3. Cambia deliberadamente **Global** o **Proyecto**. Espera la escritura y usa **Actualizar controles de plugins** si el estado no está claro.
4. Para un plugin instalado desde un paquete, usa el icono junto a su nombre. Su menú indica la operación exacta: **Buscar actualizaciones de** ese paquete, o **Actualizar** el paquete cuando se encuentre una versión más reciente.

Global apunta a la configuración global descubierta del daemon conectado. Proyecto apunta a la configuración dentro de la Location activa, no a un archivo de un antecesor heredado. Una regla posterior de Proyecto puede prevalecer sobre Global; el interruptor Global sigue mostrando la regla Global en lugar de fingir que es el estado final del Proyecto. Sin regla de Proyecto, Proyecto hereda el estado Global resuelto.

Los plugins integrados de OpenCode no se ofrecen como interruptores de activación del usuario. Proyecto se desactiva cuando su destino no puede separarse de Global con seguridad o saldría de la Location activa.

Una actualización de paquete cambia ese paquete en la caché compartida de OpenCode para todas las Locations que lo usan, como indica su ayuda emergente; no cambia las reglas de activación, no reinicia OpenCode ni recarga la configuración. Los plugins locales, integrados y proporcionados por el SDK no tienen acción de paquete.

## Añadir o quitar un plugin {#plugin-sources}

1. En **Estado → Plugins**, abre **+** y elige **Añadir un plugin…**.
2. Escribe un paquete del registro npm (`nombre`, `nombre@1.2.3`, `@scope/nombre@^1`) o un repositorio Git (`github:propietario/repo`, `git+https://…`).
3. Mantén **Global**, salvo que el plugin deba ejecutarse solo para este proyecto, y elige **Añadir**.
4. La nueva fila muestra **Instalando** hasta que OpenCode la notifica.

Para quitar un plugin, abre el menú junto a su nombre y elige **Quitar de Global** o **Quitar de Proyecto**. Se eliminan su declaración y sus reglas de activación del archivo de configuración de ese ámbito, salvo una regla de desactivación mientras quede otra declaración del plugin y una regla de activación que una declaración anterior aún define. Una regla de activación que perdería su definición también se elimina de la configuración de este proyecto, porque si no OpenCode descargaría un paquete del registro con ese nombre; si está en un archivo que CodeNomad no edita, se rechaza la acción. La caché de paquetes de OpenCode se conserva. Las reglas de un plugin que OpenCode no pudo identificar (desactivado, o que falló antes de cargar) quedan en una fila propia cuyo menú ofrece la misma acción.

El código del plugin se ejecuta con tus permisos dentro de OpenCode. Una entrada de **Proyecto** se ejecuta cada vez que esa carpeta se abre en OpenCode, y los paquetes con partes para la aplicación de escritorio de OpenCode solo las cargan desde **Global**; la información emergente lo indica cuando ese paquete se declara en otro sitio. Aquí se rechazan las rutas locales, las variables de configuración y los ID de plugin: declara los plugins locales en el archivo de configuración. Se rechaza un paquete ya declarado en una configuración que se aplica a esta Location, sea cual sea su versión, rango o forma.

La versión del paquete instalado aparece junto al nombre del plugin. En los plugins Git, los detalles incluyen el commit; si la versión no está disponible, aparece el commit de siete caracteres junto al nombre. Pasa el puntero o el foco por el nombre para ver los detalles, **Actualización disponible** y, si la instalación falló, el error con su referencia en el registro de OpenCode.

## Adjuntar habilidades {#skills}

1. Escribe `@` en el editor, busca las habilidades disponibles en la Location y selecciona una.
2. Comprueba su adjunto removible junto a los archivos/agentes; quítalo antes de enviar si no era lo previsto.
3. Envía el mensaje. Las etiquetas de habilidades permanecen con el mensaje enviado.

Retirar un adjunto no puede deshacer un envío anterior.

La disponibilidad de habilidades procede de la Location de la conversación, no de un catálogo global de habilidades de CodeNomad. Consulta la [documentación de habilidades de OpenCode](https://opencode.ai/v2/docs/skills/) y [Conversaciones](conversations.md).

## Ejecutar comandos personalizados {#commands}

1. Escribe `/` en el editor y elige un comando nativo disponible.
2. Proporciona sus argumentos y comprueba **Agente**, **Modelo** y **Razonamiento** antes de enviar, según corresponda al comando.
3. Inspecciona la conversación resultante en lugar de enviarlo repetidamente si la confirmación no está clara.

Los comandos se descubren desde OpenCode para la Location activa. `/btw` es el flujo aparte de preguntas efímeras de CodeNomad, no un comando personalizado normal.

Para definiciones de comandos y herencia de configuración nativa, usa la [documentación de comandos de OpenCode](https://opencode.ai/v2/docs/commands/). Tras cambios de configuración, actualiza/reabre primero la superficie correspondiente; usa la recarga explícita de configuración solo si el entorno de ejecución aún la necesita. Nunca repitas un comando posiblemente admitido solo para actualizar su visualización.
## Integraciones en Plugins {#integration-rows}

En **Estado → Plugins**, **+** ofrece **Añadir una integración…** o **Añadir un plugin…**. El selector de integraciones muestra las entradas no instaladas del catálogo revisado. Elige el ámbito e **Instalar**: CodeNomad instala el ID del catálogo seleccionado. Las integraciones nativas usan **Solo global**. **Catálogo no disponible** ofrece **Actualizar**; **Catálogo del {date}** identifica el último catálogo válido cuando está obsoleto.

La línea de estado en color de acento permite **Instalar en Blender**, **Actualizar Blender** o **Vincular** la conversación visible a un documento abierto (**Vincular…** para elegir entre varios). Un icono de cadena y el documento indican un vínculo; púlsalos para desvincularlo. Una conversación también se vincula sola la primera vez que su agente usa la integración.

El menú **…** de la fila empieza por el estado de la conexión, por ejemplo **Blender: 1 documento abierto** o **Blender cerrado**. Después ofrece **Documentación**, **Instalar en la aplicación…**, **Actualizar la aplicación…** o **Reinstalar en la aplicación…** ([ver más abajo](#application-installation)), la comprobación de actualizaciones del paquete, **Quitar de Global** o **Quitar de Proyecto** y **Actualizar controles de plugins**. Desvincular requiere un clic sin confirmación y solo afecta a esta conversación: la aplicación sigue abierta, su parte sigue instalada y las demás conversaciones conservan su vínculo.

La instalación desde el catálogo, la instalación o actualización de la parte de la aplicación y la eliminación requieren confirmación. **Cancelar** recibe el foco primero; la acción de confirmación se habilita tras 600 ms. La activación, las actualizaciones de plugins, la vinculación y la desvinculación se ejecutan directamente.

Al quitar un plugin se muestra una advertencia con su nombre y ámbito exacto. **Cancelar** recibe el foco; **Quitar de Global/Proyecto** se habilita tras 600 ms y exige una acción explícita. Puede interrumpir la disponibilidad y las conexiones de las conversaciones que lo usan; Global también puede afectar a otros proyectos. Solo se quitan la declaración confirmada y las reglas de activación descritas arriba; se conservan caché, archivos de la aplicación y pistas guardadas de conexión. Si cambia la configuración, selecciona y confirma de nuevo.

## Instalar o actualizar la integración de la aplicación {#application-installation}

En **Estado → Plugins**, pulsa **Instalar en Blender** o **Actualizar Blender** en la línea de estado de la integración cuando su estado actual ofrece la acción, o elige **Instalar en la aplicación…**, **Actualizar la aplicación…** o **Reinstalar en la aplicación…** en su menú **…**. Reinstalar vuelve a escribir la parte de la aplicación, esté abierta o cerrada. Está disponible sin conversación ni documento abierto.

La confirmación indica la aplicación y la **versión del paquete de integración** que proporciona el instalador. Comprueba ambos datos y la advertencia sobre el equipo: la instalación se ejecuta en el equipo donde se ejecuta OpenCode, que puede ser remoto. **Cancelar** recibe el foco inicial. Confirma explícitamente para continuar.

WSL siempre rechaza la instalación en la aplicación, aunque una aplicación abierta parezca compatible. Abre la aplicación en un equipo compatible.

Tras instalar o actualizar, abre la aplicación y comprueba su integración.

Si un error deja el resultado incierto, nunca repitas esa solicitud: inspecciona primero la aplicación e inicia una nueva acción con confirmación si hace falta.
