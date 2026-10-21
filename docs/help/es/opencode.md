# Configuración de OpenCode

CodeNomad se conecta a un servicio compartido de OpenCode en el equipo de ejecución. Seleccionar una CLI, actualizar sus archivos, reiniciar ese servicio y recargar la configuración son operaciones distintas; ninguna sustituye a las demás.

## Seleccionar o instalar la CLI {#select-cli}

1. Abre **Configuración → OpenCode** y usa la tarjeta **Binario de OpenCode**, debajo de **Versión de OpenCode**, para seleccionar el ejecutable.
2. Deja seleccionada la entrada automática para preferir el PATH del servidor, salvo que contenga un OpenCode anterior, y después su instalación npm de usuario de OpenCode 2; o usa **Explorar binario…** o introduce una ruta y elige **Agregar**.
3. Usa **Comprobar estado y actualizaciones**. Si falta OpenCode, elige **Instalar e iniciar OpenCode**; revisa primero el equipo y el ámbito de instalación.
4. Si la configuración inicial ofrece **Conectar y continuar**, úsalo tras resolver el problema indicado.

La instalación usa Node/npm incluidos para una instalación de usuario estándar compartida con otros clientes. **Instalar para el usuario y configurar PATH** cambia la configuración de terminal de ese usuario; abre una terminal nueva después. Un navegador se conecta al servidor de CodeNomad: su selector de archivos y selección de ejecutable se refieren a ese servidor, no al dispositivo que navega.

Cuando un OpenCode anterior aparece primero en el PATH, la acción ofrecida depende de cómo se instaló. Para OpenCode 1.x instalado con npm, **Reemplazar OpenCode {version} por OpenCode 2** pide confirmación, elimina ese paquete npm e instala OpenCode 2 en la misma carpeta npm; la carpeta de datos de OpenCode se conserva, y OpenCode 2 importa por sí mismo las conversaciones de 1.x. Un OpenCode anterior o inutilizable instalado de otra forma (winget, Homebrew, manual) nunca se modifica: **Instalar OpenCode 2 para CodeNomad** instala OpenCode 2 en la carpeta npm del usuario junto a él, y CodeNomad usa después esa copia. El comando `opencode` de una terminal puede seguir iniciando la versión anterior. Un ejecutable personalizado seleccionado explícitamente nunca se reemplaza.

El ejecutable instalado y el servicio en ejecución pueden tener versiones distintas. Compara **Versión instalada** con **Servicio en ejecución** en la tarjeta **Versión de OpenCode** en lugar de suponer que seleccionar otro ejecutable ha reemplazado el daemon activo; **Detalles de versiones** enumera las versiones mínima y recomendada. Si la instalación está ocupada o el ejecutable bloqueado, espera a que el instalador o proceso lo libere y comprueba el estado antes de reintentar; no ejecutes instaladores simultáneos.

## Versiones requeridas, recomendadas y no verificadas {#versions}

| Clasificación | Requisito actual | Significado |
| --- | --- | --- |
| Mínima | OpenCode **2.1.0** | Formato nativo de transcripciones, datos de reproducción y compactación requerido; las conversaciones guardadas con versiones anteriores siguen siendo legibles tras actualizar. |
| Recomendada | OpenCode **2.1.1** | Objetivo verificado, distinto del mínimo técnico. |
| No verificada | Una versión más nueva o personalizada no validada por completo | No se rechaza simplemente por no estar probada; se comprueban los contratos API reales del servicio conectado. |

También deben estar disponibles los contratos requeridos de sesiones, permisos, formularios, bandeja de entrada y entorno de sesión. La versión de un ejecutable no demuestra por sí sola que el servicio conectado los admita. Si la configuración inicial informa de un servicio en ejecución no compatible, selecciona/instala una CLI compatible y usa el reinicio explícito del servicio compartido cuando estés listo.

## Equipo, WSL y ámbito del servicio compartido {#execution-host}

En Windows, un ejecutable WSL seleccionado se ejecuta dentro de su distribución elegida. Instálalo/actualízalo allí y usa rutas que tengan sentido dentro de esa distribución. La conectividad WSL depende del reenvío de localhost de Windows. Una CLI de Windows y una CLI de WSL no son entornos de ejecución intercambiables.

OpenCode es propietario de su registro global de servicio, sesiones, mensajes y base de datos. CodeNomad no crea una base de datos privada de OpenCode por ventana o proyecto. Cerrar una pestaña de proyecto cierra ese proyecto en CodeNomad; las sesiones siguen ejecutándose en OpenCode y vuelven a aparecer al reabrir el proyecto. CodeNomad nunca descarga las Locations nativas. Cerrar una ventana entera, salir o recargar conserva las conexiones de proyecto para restaurarlas; ni esas acciones ni el apagado del backend detienen el daemon compartido. Consulta [Proyectos](projects.md).

## Actualizar, reiniciar o recargar {#maintenance}

1. En **Configuración → OpenCode**, elige **Comprobar estado y actualizaciones**.
2. Para reemplazar los archivos de la CLI instalada, elige **Actualizar a OpenCode {version}** cuando se ofrezca. Espera a que termine.
3. Revisa el estado del servicio en ejecución. Usa **Reiniciar servicio compartido** solo cuando quieras activar la instalación seleccionada para todos los clientes conectados.
4. Para reiniciar el proceso sin instalar nada, expande **Solución de problemas**, elige **Reiniciar servicio OpenCode** y confirma.

| Acción | Ámbito y efecto | Recuperación segura |
| --- | --- | --- |
| Actualizar CLI | Cambia el ejecutable instalado compatible; no reinicia implícitamente el daemon en ejecución. | Comprueba las versiones instalada y en ejecución tras un fallo; reintenta explícitamente solo después de resolver el error. |
| Reiniciar servicio | Reemplaza el proceso compartido e interrumpe el trabajo activo de todos los clientes OpenCode conectados; el historial de sesiones permanece. | Reconecta e inspecciona conversaciones y Misiones programadas; un reinicio no implica continuación automática. |
| Recargar la configuración de OpenCode | Mantiene el proceso, pero reconstruye **todas las Locations cargadas** para todos los clientes. Cancela permisos/formularios pendientes y cierra terminales/comandos en segundo plano; puede interrumpirse el trabajo activo. | Vuelve a comprobar recursos y trabajo pendiente tras recargar. No repitas un mensaje o modificación solo porque se perdió su respuesta. |

Usa **Recargar la configuración de OpenCode**, en **Solución de problemas** cuando el servicio en ejecución lo admite, explícitamente cuando una configuración guardada o un plugin instalado siga sin estar disponible y la interrupción sea aceptable. No es una actualización visual inofensiva. CodeNomad no usará una CLI seleccionada más antigua para rebajar un daemon en ejecución más nuevo.

## Entorno de sesión {#session-environment}

1. Abre **Configuración → Avanzado** y expande **Variables de entorno**.
2. Añade, cambia o retira los valores sobrescritos del perfil; cada cambio se guarda de inmediato.
3. Envía el siguiente mensaje, comando personalizado o solicitud shell de sesión a través de CodeNomad para aplicar el entorno actual a esa conversación.

Es un ajuste del perfil de configuración, aplicado en el servidor antes de cada envío. Abrir/leer una conversación o guardar ajustes no altera una sesión nativa. Retirar un valor sobrescrito restaura el valor heredado del equipo de ejecución, o lo elimina si allí no existe. Si no se puede aplicar el entorno, el envío se bloquea en lugar de usar valores obsoletos.

El entorno controla los posteriores lanzamientos locales de shell en esa sesión nativa. Los procesos ya en ejecución conservan su entorno. **No** reconfigura proveedores, servidores MCP/LSP, terminales independientes ni shells en segundo plano exclusivos de una Location. Los mensajes en cola no capturan cada uno su propio entorno, y otro cliente OpenCode puede reemplazar el entorno de la misma sesión. No supongas que las sesiones hijas creadas enteramente dentro de OpenCode reciben una actualización de CodeNomad en el momento del envío.

Las variables permitidas también se pasan al iniciar un servicio detenido; conectarse a un daemon existente no cambia el entorno de su proceso. En WSL, los valores se combinan con el entorno de ejecución Linux, no con PATH/HOME de Windows. Cambiar estos valores no traslada la base de datos ni el registro de servicio de OpenCode.

## Editar archivos de configuración nativos {#configuration-files}

1. Abre **Configuración → Archivos de configuración** y selecciona **Archivo**.
2. Comprueba la ruta mostrada, edita y elige **Guardar**.
3. Usa **Recargar** para volver a leer el archivo; no es **Recargar la configuración de OpenCode**.

Este editor expone solo los archivos globales `opencode.json` y `opencode.jsonc` enumerados bajo el directorio `.config/opencode` del **usuario del servidor CodeNomad**. No es un editor de archivos arbitrarios, un selector de configuración de Proyecto ni una garantía de que un daemon WSL/con descubrimiento personalizado lea ese archivo. Usa la ruta mostrada para verificar el destino; usa las herramientas propias del daemon para otras raíces.

Guardar escribe el archivo como texto; no valida toda la configuración nativa ni reinicia/recarga OpenCode. Coordina las ediciones con otros clientes: esta superficie no ofrece combinación de cambios externos. Conserva una copia antes de reemplazar una parte sustancial de la configuración. Cambiar de archivo o recargar un borrador modificado pregunta si quieres descartarlo.

Consulta [Integraciones](integrations.md), [Proveedores](providers.md), [Misiones](missions.md) y la [documentación de OpenCode](https://opencode.ai/v2/docs/) para flujos específicos de configuración.
