# Integraciones nativas

CodeNomad expone las conexiones MCP nativas, la activación de plugins, las habilidades y los comandos personalizados de OpenCode. Se ejecutan en el equipo de ejecución. Son independientes de las [Extensiones de panel](extensions.md) aisladas y los [SideCars](browser-sidecars.md).

## Elegir el control adecuado {#integration-scopes}

| Integración | Dónde actuar | Qué cambia el control |
| --- | --- | --- |
| Servidor MCP | **Estado → Servidores MCP** | Conexión nativa en la Location mostrada; no instala un servidor. |
| Plugin nativo | **Estado → Plugins** | Regla persistente de activación **Global** o **Proyecto**; no instala/actualiza/elimina el paquete. |
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

1. Instala/declara el plugin nativo con OpenCode; después abre **Estado → Plugins**.
2. Pasa el puntero o enfoca su nombre para inspeccionar el origen, los fallos de ejecución y los detalles del destino de configuración.
3. Cambia deliberadamente **Global** o **Proyecto**. Espera la escritura y usa **Actualizar controles de plugins** si el estado no está claro.

Global apunta a la configuración global descubierta del daemon conectado. Proyecto apunta a la configuración dentro de la Location activa, no a un archivo de un antecesor heredado. Una regla posterior de Proyecto puede prevalecer sobre Global; el interruptor Global sigue mostrando la regla Global en lugar de fingir que es el estado final del Proyecto. Sin regla de Proyecto, Proyecto hereda el estado Global resuelto.

Estos interruptores añaden reglas exactas de activación conservando las declaraciones de origen y la configuración no relacionada. No editan opciones de plugins, instalan paquetes ni eliminan archivos. Los plugins integrados de OpenCode no se ofrecen como interruptores de activación del usuario. Proyecto se desactiva cuando su destino no puede separarse de Global con seguridad o saldría de la Location activa.

La superficie conserva su última instantánea mientras está oculta y se revalida al mostrarse, tras cambios nativos/reconexión y al actualizar explícitamente. Una regla guardada y la disponibilidad real en ejecución pueden diferir brevemente. Si un plugin sigue sin estar disponible, inspecciona su ayuda emergente y la configuración nativa antes de elegir **Recargar la configuración de OpenCode**; esa acción afecta a todas las Locations cargadas, no solo a ese plugin. Una configuración mal formada o una edición concurrente no se sobrescriben silenciosamente: resuélvelas, actualiza y reintenta explícitamente.

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
