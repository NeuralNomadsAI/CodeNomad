# Proyectos y worktrees

Una pestaña de proyecto conecta CodeNomad a una carpeta del equipo del backend. Abrir una pestaña, explorar una copia de trabajo y mover una familia de conversaciones son operaciones distintas.

## Abrir un proyecto {#open-project}

1. **Nueva instancia** (`+`) o `Ctrl/Cmd+N` abre una pestaña vacía. Bajo el logotipo y el nombre CodeNomad centrados aparecen **Temporal** y después **Clonar**, encima de las dos columnas: **Pestañas recientes** a la izquierda; **Explorar** a la derecha, con **Dirección o enlace del servidor** cerca del pie. El fondo coincide con el de la pestaña activa. Se apilan en pantallas estrechas. El logotipo abre Inicio, con **Clonar repo Git**, **Nueva pestaña temporal**, **Nuevo SideCar** y la línea OpenCode a la izquierda; **Pestañas recientes | Explorar** a la derecha, con los recuentos bajo los títulos. El panel derecho se alinea con el borde inferior de la columna izquierda y su lista se desplaza dentro. Inicio conserva idioma, configuración, **Patrocinar** ([Apoyar CodeNomad](sponsor.md)), GitHub, estrellas y Discord. Los clones y carpetas temporales usan el backend local. Elegir un proyecto local, remoto o SideCar llena la pestaña en su posición. Las pestañas vacías duran hasta recargar y se cierran sin dejar proyecto.
2. En **Pestañas recientes**, elige un proyecto; o abre **Explorar**, elige **Este equipo** y luego selecciona la carpeta del backend y ábrela. **Explorar** también lista los servidores CodeNomad guardados ([pestañas de proyectos remotos](remote-access.md#remote-project-tabs)) y los SideCars ([SideCars](browser-sidecars.md#register-sidecar)).
3. Para obtener una copia de un repositorio, elige **Clonar repo Git**, introduce la **URL del repositorio** y la **Carpeta de destino** y pulsa **Clonar**. La **Carpeta de destino** se rellena con el nombre del repositorio en la carpeta que contiene tu último clon, o junto a tu proyecto más reciente. **Buscar** elige la carpeta que contendrá el clon; también puedes editar la ruta, incluido el nombre de la carpeta del clon.

Explorar un servidor remoto significa explorar el sistema de archivos de ese servidor, no el de tu teléfono o portátil. Abrir un proyecto no crea un daemon de OpenCode distinto para cada pestaña. Las conversaciones son sesiones nativas de OpenCode; su duración no es la de la pestaña.

Elegir un servidor en **Explorar** muestra sus carpetas y mantiene su nombre visible al iniciar sesión y navegar. Sus proyectos recientes aparecen solo en **Pestañas recientes**, a la izquierda de una pestaña vacía, con su acción separada **Abierta**. En Inicio, cambiar entre **Pestañas recientes** y **Explorar** conserva el servidor y la carpeta. Con un servidor seleccionado, los recientes proceden solo de él y ofrecen acciones de apertura; volver a Explorar restaura la lista mixta habitual. Los campos de acceso tienen etiquetas. Las filas de carpetas solo permiten navegar; pulsa Intro o la flecha al final del campo de ruta para abrir la carpeta que muestra. Solo elegir proyecto llena la pestaña vacía.

Si un proyecto remoto reciente necesita credenciales, Inicio, el panel izquierdo **Pestañas recientes** de una nueva pestaña y el menú `+` muestran el formulario en el mismo sitio antes de abrir la pestaña del proyecto. Una pestaña remota restaurada muestra el formulario dentro de ella. El usuario siempre es `codenomad`, con el foco en la contraseña. Los errores quedan junto al formulario para reintentar. Para un dispositivo revocado de Control remoto, usa la [reparación del emparejamiento](remote-access.md#saved-servers). El backend prepara automáticamente la sesión de la vista integrada; el acceso con contraseña usa una sesión dedicada y el acceso emparejado comparte la duración y revocación del dispositivo.

La clonación escribe un repositorio en el destino. **Eliminar primero la carpeta de destino si ya existe.** es destructivo: actívalo solo si se puede borrar todo lo que ya haya allí. Usa un destino nuevo si tienes dudas. Una clonación fallida no es motivo para eliminar un proyecto existente; inspecciona el destino y el error indicados antes de reintentar.

Los recientes son accesos directos. Los botones en línea de Inicio y el menú de acciones de las pestañas vacías ofrecen **Renombrar workspace** y **Eliminar de recientes** cuando corresponde; conserva archivos y conversaciones. En Inicio, pestañas vacías y lanzador rápido, pulsar un proyecto local, remoto o SideCar crea una nueva instancia aunque ya esté abierto. La acción separada **Abierta** (**Cambiar al proyecto abierto**) selecciona la existente.

## Usar el lanzador de nuevas instancias {#new-instance-launcher}

Al abrir, el foco queda en el menú. Tab o un clic accede a la búsqueda. Las flechas recorren los recientes; Escape cierra el menú.

1. Mantén pulsado `+` o haz clic derecho; con el foco del teclado allí, usa **Alt+Down**, **Shift+F10** o la tecla Menú.
2. **Pestañas recientes** contiene la búsqueda y los proyectos locales, remotos y SideCars recientes, con su acción independiente **Abierta**. Una fila crea una nueva instancia; **Abierta** cambia a la existente. El botón con reloj de arena **Nueva pestaña temporal**, en la barra de título, crea una pestaña temporal.

Un clic normal abre una pestaña vacía. Gestiona los recientes en Inicio o una pestaña vacía, los servidores en **Configuración → Servidores** y los SideCars en **Configuración → SideCars**. En Inicio, las pestañas vacías y el lanzador rápido, la selección de fila persiste solo al navegar con el teclado; el resaltado del puntero desaparece al salir de la fila. Escape cierra el lanzador y devuelve el foco a `+`.

## Cerrar una pestaña de proyecto {#close-stop}

1. Usa el botón de cierre de la pestaña o **Cerrar pestaña** en la paleta de comandos (`Ctrl/Cmd+W` en el renderer).
2. Cerrar la pestaña cierra ese proyecto en CodeNomad: deja de seguir sus eventos y solicitudes. Las sesiones siguen ejecutándose en OpenCode.
3. Vuelve a abrir la carpeta desde Buscar carpetas o Carpetas recientes para encontrar de nuevo esas conversaciones.

| Acción | Ámbito y efecto | Qué no hace |
| --- | --- | --- |
| Cerrar pestaña | Retira la conexión de proyecto de CodeNomad de esa pestaña; otra pestaña abierta por separado en la misma carpeta no se ve afectada | No elimina archivos del proyecto ni el historial nativo, no detiene sesiones ni descarga la Location de OpenCode |
| Detener sesión | Ejecución de la conversación seleccionada | No cierra el proyecto ni elimina su historial |

Si otra ventana muestra la misma conexión de proyecto, su pestaña también se cierra y esa ventana muestra una notificación. La ventana que inicia el cierre no muestra ninguna. El cierre es inmediato; si el backend no puede cerrar el proyecto, aparece un error y **Cambiar al proyecto abierto** en la página de inicio sigue llevando a él. No hay reintento automático. Los borradores sin enviar de la pestaña cerrada no se conservan en la restauración al iniciar.

Cerrar una ventana entera, salir o recargar no cierra sus conexiones de proyecto; se sigue aplicando la restauración normal al iniciar. Detén explícitamente las ejecuciones relevantes si necesitas verificar que la ejecución terminó. CodeNomad nunca descarga las Locations nativas; el mantenimiento del servicio compartido se describe en [configuración de OpenCode](opencode.md).

## Espacios de trabajo temporales {#temporary-workspaces}

1. Elige **Nueva pestaña temporal** en Inicio o **Temporal** sobre las columnas de una pestaña vacía.
2. Trabaja en la carpeta vacía gestionada por CodeNomad; Git no se inicializa automáticamente.
3. Al cerrar la pestaña, elige **Conservar**, **Descartar** o **Cancelar**. El menú de la pestaña también ofrece **Conservar como proyecto**.

| Opción | Efecto | Recuperación |
| --- | --- | --- |
| Conservar | Cierra el proyecto en CodeNomad, conserva la carpeta y las conversaciones, retira su condición temporal y añade un proyecto reciente | Vuelve a abrirlo desde Carpetas recientes; la carpeta no se mueve |
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
