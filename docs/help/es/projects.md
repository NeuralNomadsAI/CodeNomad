# Proyectos y worktrees

Una pestaña de proyecto conecta CodeNomad a una carpeta del equipo del backend. Abrir una pestaña, explorar una copia de trabajo y mover una familia de conversaciones son operaciones distintas.

## Abrir un proyecto {#open-project}

Pulsa **Nueva instancia** (`+`) o `Ctrl/Cmd+N` para abrir una nueva pestaña vacía. Elige un proyecto en **Pestañas recientes** o **Explorar**. Si no hay pestañas que restaurar o cierras la última, CodeNomad muestra una pestaña vacía. La clonación y las pestañas temporales usan el servidor local.

En las pestañas recientes, **Abierta** cambia a una pestaña de esta ventana. El punto verde **Abierto en otra ventana** indica una conexión en el servidor del proyecto fuera de esta ventana. Seleccionar la fila abre una pestaña independiente.

[Abrir un proyecto remoto en una pestaña](remote-access.md#remote-project-tabs) · [SideCars](browser-sidecars.md#register-sidecar)

Para obtener una copia de un repositorio, elige **Clonar repo Git**, introduce la **URL del repositorio** y la **Carpeta de destino** y pulsa **Clonar**. La **Carpeta de destino** se rellena con el nombre del repositorio en la carpeta que contiene tu último clon, o junto a tu proyecto más reciente. **Buscar** elige la carpeta que contendrá el clon; también puedes editar la ruta, incluido el nombre de la carpeta del clon.

Explorar un servidor remoto significa explorar el sistema de archivos de ese servidor, no el de tu teléfono o portátil. Abrir un proyecto no crea un daemon de OpenCode distinto para cada pestaña. Las conversaciones son sesiones nativas de OpenCode; su duración no es la de la pestaña.

La clonación escribe un repositorio en el destino. **Eliminar primero la carpeta de destino si ya existe.** es destructivo: actívalo solo si se puede borrar todo lo que ya haya allí. Usa un destino nuevo si tienes dudas. Una clonación fallida no es motivo para eliminar un proyecto existente; inspecciona el destino y el error indicados antes de reintentar.

Los recientes son accesos directos. El menú de acciones de la pestaña vacía ofrece **Renombrar workspace** y **Eliminar de recientes** cuando corresponde; conserva archivos y conversaciones. En la pestaña vacía y el lanzador rápido, pulsar un proyecto local, remoto o SideCar crea una nueva instancia aunque ya esté abierto. La acción separada **Abierta** (**Cambiar al proyecto abierto**) selecciona la existente.

La acción para cambiar de pestaña también selecciona una pestaña que espera a su servidor y cierra la pestaña vacía de origen.

## Usar el lanzador de nuevas instancias {#new-instance-launcher}

Mantén pulsado `+` o haz clic derecho; con el foco del teclado allí, usa **Alt+Down**, **Shift+F10** o la tecla Menú.
Tab permite buscar, las flechas y Enter seleccionan y Escape devuelve el foco a `+`.

## Cerrar una pestaña de proyecto {#close-stop}

1. Usa el botón de cierre de la pestaña o **Cerrar pestaña** en la paleta de comandos (`Ctrl/Cmd+W` en el renderer).
2. Cerrar la pestaña cierra ese proyecto en CodeNomad: deja de seguir sus eventos y solicitudes. Las sesiones siguen ejecutándose en OpenCode.
3. Vuelve a abrir la carpeta desde Buscar carpetas o Carpetas recientes para encontrar de nuevo esas conversaciones.

| Acción | Ámbito y efecto | Qué no hace |
| --- | --- | --- |
| Cerrar pestaña | Retira la conexión de proyecto de CodeNomad de esa pestaña; otra pestaña abierta por separado en la misma carpeta no se ve afectada | No elimina archivos del proyecto ni el historial nativo, no detiene sesiones ni descarga la Location de OpenCode |
| Detener sesión | Ejecución de la conversación seleccionada | No cierra el proyecto ni elimina su historial |

Los borradores y adjuntos sin enviar de la pestaña cerrada vuelven al reabrir la misma carpeta en esa ventana; la ventana los conserva para sus 16 últimos proyectos cerrados hasta que se recarga o se cierra. No forman parte de la restauración al iniciar.

Al cerrar o recargar una ventana o pestaña del navegador, o al salir de la aplicación, CodeNomad pide a los servidores que liberen las conexiones de proyecto correspondientes. Si no se puede acceder a un servidor, este puede conservar los registros. Las demás ventanas conservan sus pestañas. La restauración al iniciar vuelve a conectar las pestañas guardadas y conserva las carpetas temporales abiertas. Detén las ejecuciones explícitamente si quieres terminarlas; consulta la [configuración de OpenCode](opencode.md) para el mantenimiento del servicio compartido.

Con la restauración al iniciar activada, cada pestaña restante recupera sus propias opciones de paneles, selección y lector de Misión, y elección entre chat y vista previa web. Las URL y el historial del navegador se comparten por sesión; las páginas guardadas se cargan solo al reabrir explícitamente la vista previa web. Cerrar una instancia elimina solo su vista guardada; reabrir la carpeta crea una instancia nueva.

Al duplicar una pestaña del navegador, se abren conexiones de proyecto propias. Solo se puede reutilizar una conexión que siga abierta al reanudar la misma pestaña después de que el navegador la haya descartado.

## Restaurar pestañas remotas {#restore-remote-tabs}

Al recargar con la restauración activada, las pestañas remotas conservan su orden, selección y borradores. Un servidor no disponible deja una pestaña en espera: elige **Reintentar** cuando vuelva, o **Conectar** con su usuario/contraseña o un enlace en **Nuevo enlace de emparejamiento**. Los demás servidores siguen disponibles. **Servidor no encontrado** indica que falta el servidor guardado.

**Reintentar** vuelve a conectar el proyecto en el servidor guardado y recrea su conexión si hace falta.

**Reintentar** también recupera pestañas en espera con la restauración automática al iniciar desactivada. Las notificaciones seleccionan la pestaña en espera existente. Comprueba el resultado de una acción de conversación no confirmada antes de enviarla otra vez.

## Espacios de trabajo temporales {#temporary-workspaces}

1. Elige **Pestaña temporal** en la parte superior de la pestaña vacía.
2. Trabaja en la carpeta vacía gestionada por CodeNomad; Git no se inicializa automáticamente.
3. Al cerrar la pestaña, elige **Conservar**, **Descartar** o **Cancelar**. El menú de la pestaña también ofrece **Conservar como proyecto**.

| Opción | Efecto | Recuperación |
| --- | --- | --- |
| Conservar | Cierra el proyecto en CodeNomad, conserva la carpeta y las conversaciones, retira su condición temporal y añade un proyecto reciente | Vuelve a abrirlo desde Carpetas recientes; la carpeta no se mueve |
| Descartar | Elimina las conversaciones, los archivos y los borradores sin enviar del espacio de trabajo temporal | No se puede deshacer; guarda primero en otro lugar lo que necesites |
| Cancelar | Deja abierto el espacio de trabajo temporal | Continúa trabajando o decide más tarde |

Una pestaña temporal sin usar, sin conversación, archivo ni borrador sin enviar, se descarta silenciosamente al cerrarla. Las pestañas temporales abiertas participan en la restauración normal al iniciar.

Descartar se rechaza mientras haya una conversación en ejecución o la carpeta esté abierta en otra pestaña/ventana. Detén la ejecución y cierra antes las otras vistas. Si el descarte falla, permanece temporal: resuelve el problema indicado y reintenta en lugar de eliminar manualmente un directorio padre.

## Seleccionar o crear un worktree {#select-create-worktree}

1. Abre una conversación padre y usa su selector de worktree en el editor de mensajes. En disposiciones estrechas es un control que solo muestra una flecha.
2. Selecciona un worktree descubierto existente o elige **+ Crear worktree**.
3. Para crearlo, introduce el **Nombre** y elige **Crear y usar worktree**.

Si el proyecto es una carpeta dentro de un repositorio, solo se muestran los worktrees que contienen esa carpeta. Para crear un worktree desde una carpeta así, Git debe seguirla. Un nombre de rama nuevo parte del HEAD de la copia de trabajo seleccionada. Un nombre de rama existente usa la revisión actual de esa rama; Git puede rechazar una rama que ya esté abierta en otro lugar. Los worktrees usan la ubicación predeterminada `.codenomad/worktrees`. Los cambios sin confirmar permanecen en la copia de trabajo original; la creación no los copia al worktree nuevo.

El selector del editor de mensajes mueve la conversación padre y sus descendientes recursivos como una familia verificada. Una subsesión no puede cambiar este selector de forma independiente. Las sesiones activas bloquean la operación: deja que la familia termine o detén primero su ejecución. Espera a que un movimiento se resuelva antes de solicitar otro; si hay un error, inspecciona el estado actualizado de conversación/worktree antes de reintentar.

En cambio, **Worktree para consultar** en [Archivos](files.md) solo cambia qué copia de trabajo lee el panel. No mueve una conversación, no cambia de rama ni cambia dónde se ejecutará su siguiente comando de shell.

## Eliminar un worktree {#remove-worktree}

1. En la lista de worktrees del editor de mensajes, usa **Eliminar worktree** para un worktree de rama que se pueda eliminar.
2. Revisa la carpeta de destino. Deja desactivado **Forzar eliminación (descartar cambios locales)** salvo que se puedan perder los cambios locales.
3. Confirma la eliminación y comprueba el inventario resultante.

La eliminación borra la carpeta local del worktree. La copia principal de Git no se puede eliminar de esta forma. CodeNomad devuelve las familias de conversaciones afectadas a la copia raíz y verifica su ubicación antes de eliminar el worktree; las sesiones activas pueden bloquear la eliminación. Eliminar no archiva ni hace una copia de seguridad de los archivos sin confirmar.

Si Git rechaza archivos modificados/sin seguimiento, consérvalos o límpialos antes de reintentar. Forzar la eliminación los descarta explícitamente. Si un directorio está bloqueado, cierra terminales, editores, observadores y procesos en segundo plano que lo usen. El diálogo de error ofrece **Copiar saneado** para compartir diagnósticos; revisa primero incluso el texto saneado.

## Inicializar Git o trabajar sin él {#initialize-git}

1. Para una carpeta normal con Git disponible, abre **Archivos → Cambios** o **Commits**.
2. Elige **Inicializar Git**. Actúa inmediatamente, sin confirmación adicional.
3. Espera a que se actualicen los metadatos del proyecto y las conversaciones; usa **Actualizar** si Git se inicializó fuera de CodeNomad.

La inicialización crea el repositorio en la carpeta abierta explícitamente, no en su carpeta padre. No crea un commit.

Si el backend no puede ejecutar Git, las conversaciones y la exploración acotada de archivos siguen disponibles para la carpeta abierta explícitamente en modo limitado al directorio. Las operaciones de worktree y la inicialización de Git requieren Git en ese backend. Consulta [instalación](install.md) y [Archivos](files.md).
