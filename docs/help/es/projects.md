# Proyectos y worktrees

Una pestaña de proyecto conecta CodeNomad a una carpeta del equipo del backend. Abrir una pestaña, explorar una copia de trabajo y mover una familia de conversaciones son operaciones distintas.

## Abrir un proyecto {#open-project}

1. Haz clic en **Nueva instancia** (`+`) para abrir la página de inicio.
2. Elige **Buscar carpetas**, selecciona la carpeta del backend y ábrela; o elige una entrada de **Carpetas recientes**.
3. Para obtener una copia de un repositorio, elige **Clonar repo Git**, introduce la **URL del repositorio** y la **Carpeta de destino** y pulsa **Clonar**.

Explorar un servidor remoto significa explorar el sistema de archivos de ese servidor, no el de tu teléfono o portátil. Abrir un proyecto no crea un daemon de OpenCode distinto para cada pestaña. Las conversaciones son sesiones nativas de OpenCode; su duración no es la de la pestaña.

La clonación escribe un repositorio en el destino. **Eliminar primero la carpeta de destino si ya existe.** es destructivo: actívalo solo si se puede borrar todo lo que ya haya allí. Usa un destino nuevo si tienes dudas. Una clonación fallida no es motivo para eliminar un proyecto existente; inspecciona el destino y el error indicados antes de reintentar.

Las entradas recientes son accesos directos. **Renombrar workspace** cambia su nombre visible; **Eliminar de recientes** elimina el acceso directo, no sus archivos ni conversaciones. Un proyecto reciente que ya esté abierto puede llevarte a su pestaña existente.

## Usar el lanzador de nuevas instancias {#new-instance-launcher}

1. Mantén pulsado `+` o haz clic derecho; con el foco del teclado allí, usa **Alt+Down**, **Shift+F10** o la tecla Menú.
2. Busca proyectos recientes o selecciona **Examinar…**, **Temporal** o **Clonar…**.

Un clic normal sigue abriendo la página de inicio completa. El lanzador es un acceso directo, no la superficie de gestión: renombra/elimina proyectos recientes y gestiona los marcadores de servidores en la página de inicio. Escape cierra el lanzador y devuelve el foco a `+`.

## Cerrar una pestaña de proyecto {#close-stop}

1. Usa el botón de cierre de la pestaña o **Cerrar pestaña** en la paleta de comandos para cerrar el proyecto en CodeNomad. CodeNomad deja de seguir esa instancia abierta del proyecto.
2. Las sesiones siguen ejecutándose en OpenCode; los archivos del proyecto y el historial nativo se conservan.
3. Vuelve a abrir la carpeta desde Buscar carpetas o Carpetas recientes para encontrar de nuevo las sesiones.

| Acción | Ámbito y efecto | Qué no hace |
| --- | --- | --- |
| Cerrar pestaña | Cierra esa instancia abierta del proyecto en CodeNomad | No elimina archivos ni sesiones nativas, ni detiene la generación o el servicio compartido de OpenCode |
| Detener sesión | Ejecución de la conversación seleccionada | No cierra el proyecto ni elimina su historial |

Otra pestaña de la misma carpeta abierta por separado no se ve afectada. Si otra ventana muestra la misma instancia abierta del proyecto, su pestaña también se cierra y esa ventana muestra una notificación. CodeNomad no descarga la Location nativa de OpenCode. Detén explícitamente las ejecuciones relevantes antes de cerrar si quieres que terminen. El mantenimiento del servicio compartido se describe en [configuración de OpenCode](opencode.md).

## Espacios de trabajo temporales {#temporary-workspaces}

1. Elige **Temporal** en el lanzador o **Nueva instancia temporal** en la página de inicio.
2. Trabaja en la carpeta vacía gestionada por CodeNomad; Git no se inicializa automáticamente.
3. Al cerrar la pestaña, elige **Conservar**, **Descartar** o **Cancelar**. Tras **Conservar**, la pestaña se cierra como cualquier pestaña de proyecto. El menú de la pestaña también ofrece **Conservar como proyecto**.

| Opción | Efecto | Recuperación |
| --- | --- | --- |
| Conservar | Conserva la carpeta y las conversaciones, retira su condición temporal y añade un proyecto reciente | Vuelve a abrirlo desde Carpetas recientes; la carpeta no se mueve |
| Descartar | Elimina las conversaciones y los archivos del espacio de trabajo temporal | No se puede deshacer; guarda primero en otro lugar lo que necesites |
| Cancelar | Deja abierto el espacio de trabajo temporal | Continúa trabajando o decide más tarde |

Una pestaña temporal sin usar, sin conversación, archivo ni borrador sin enviar, se descarta silenciosamente al cerrarla. Las pestañas temporales abiertas participan en la restauración normal al iniciar, pero la página de inicio no tiene una lista aparte para reabrir carpetas temporales cerradas.

Descartar se rechaza mientras haya una conversación en ejecución o la carpeta esté abierta en otra pestaña/ventana. Detén la ejecución y cierra antes las otras vistas. Si el descarte falla, permanece temporal: resuelve el problema indicado y reintenta en lugar de eliminar manualmente un directorio padre.

## Seleccionar o crear un worktree {#select-create-worktree}

1. Abre una conversación padre y usa su selector de worktree en el editor de mensajes. En disposiciones estrechas es un control que solo muestra una flecha.
2. Selecciona un worktree descubierto existente o elige **+ Crear worktree**.
3. Para crearlo, introduce el **Nombre** y elige **Crear y usar worktree**.

CodeNomad descubre worktrees a través de OpenCode y verifica que pertenecen al repositorio abierto. Un nombre de rama nuevo parte del HEAD de la copia de trabajo seleccionada. Un nombre de rama existente usa la revisión actual de esa rama; Git puede rechazar una rama que ya esté abierta en otro lugar. Los worktrees usan la ubicación predeterminada `.codenomad/worktrees`. Los cambios sin confirmar permanecen en la copia de trabajo original; la creación no los copia al worktree nuevo.

El selector del editor de mensajes mueve la conversación padre y sus descendientes recursivos como una familia verificada. Una subsesión no puede cambiar este selector de forma independiente. Las sesiones activas bloquean la operación: deja que la familia termine o detén primero su ejecución. Espera a que un movimiento se resuelva antes de solicitar otro; si hay un error, inspecciona el estado actualizado de conversación/worktree antes de reintentar.

En cambio, **Worktree para consultar** en [Archivos](files.md) solo cambia qué copia de trabajo lee el panel. No mueve una conversación, no cambia de rama ni cambia dónde se ejecutará su siguiente comando de shell.

## Eliminar un worktree {#remove-worktree}

1. En la lista de worktrees del editor de mensajes, usa **Eliminar worktree** para un worktree de rama que se pueda eliminar.
2. Revisa la carpeta de destino. Deja desactivado **Forzar eliminación (descartar cambios locales)** salvo que se puedan perder los cambios locales.
3. Confirma la eliminación y comprueba el inventario resultante.

La eliminación borra la carpeta local del worktree. La copia principal de Git no se puede eliminar de esta forma. CodeNomad devuelve las familias de conversaciones afectadas a la copia raíz y verifica su ubicación antes de eliminar el worktree; las sesiones activas pueden bloquear la eliminación. Eliminar no archiva ni hace una copia de seguridad de los archivos sin confirmar.

Si Git rechaza archivos modificados/sin seguimiento, consérvalos o límpialos antes de reintentar. Forzar la eliminación los descarta explícitamente. Si un directorio está bloqueado, cierra terminales, editores, observadores y procesos en segundo plano que lo usen. Si falta un registro, actualiza los worktrees e inspecciona la ruta antes de volver a intentarlo. El diálogo de error ofrece **Copiar saneado** para compartir diagnósticos; revisa primero incluso el texto saneado.

## Inicializar Git o trabajar sin él {#initialize-git}

1. Para una carpeta normal con Git disponible, abre **Archivos → Cambios** o **Commits**.
2. Elige **Inicializar Git**. Actúa inmediatamente, sin confirmación adicional.
3. Espera a que se actualicen los metadatos del proyecto y las conversaciones; usa **Actualizar** si Git se inicializó fuera de CodeNomad.

La inicialización crea el repositorio en la carpeta abierta explícitamente, no en su carpeta padre. No crea un commit. Si falla, inspecciona el mensaje y actualiza antes de reintentar: una respuesta incierta no se repite automáticamente.

Si el backend no puede ejecutar Git, las conversaciones y la exploración acotada de archivos siguen disponibles para la carpeta abierta explícitamente en modo limitado al directorio. Las operaciones de worktree y la inicialización de Git requieren Git en ese backend. Consulta [instalación](install.md) y [Archivos](files.md).
