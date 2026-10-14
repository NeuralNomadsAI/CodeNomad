# Extensiones de panel

## Explorar extensiones instaladas y en línea {#browse}

1. Abre **Personalizar panel derecho** en la barra de pestañas del panel derecho.
2. Expande **Extensiones** debajo del separador.
3. Usa **Buscar extensiones** para buscar en la lista única de complementos instalados y del catálogo oficial en línea. Pasa el puntero o enfoca una entrada para ver sus metadatos.

La sección empieza contraída cada vez que se abre el popup de personalización. Las entradas instaladas y en línea se combinan por ID de extensión; no hay ventana de gestión separada ni modos instalado/en línea. Explorar metadatos del catálogo no descarga ni ejecuta el código del panel del autor. El catálogo se mantiene en [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions); la inclusión y los nombres de autor declarados no son firmas ni pruebas de confianza.

Si el catálogo no está disponible, las extensiones instaladas y **Instalar desde ZIP…** siguen disponibles. Actualiza para reintentar el descubrimiento. Contraer o cerrar el popup abandona su interfaz de revisión/confirmación pendiente; no instala nada silenciosamente.

## Revisar e instalar desactivada {#install}

1. Elige **Instalar…** en una entrada del catálogo o **Instalar desde ZIP…** para un paquete obtenido por separado.
2. Revisa el ID del paquete, autor, repositorio, versión, API/permisos y resumen SHA-256. Expande los detalles técnicos cuando lo necesites.
3. Verifica al editor y, cuando sea posible, compara el resumen por un canal de confianza.
4. Solo si confías en el código, selecciona **Confío en este paquete y en su autor** y después **Instalar desactivada**.

La inspección descarga/revalida el paquete seleccionado; no ejecuta el código del autor. Un resumen identifica bytes exactos, no la identidad del autor. Los paquetes del catálogo proceden del recurso exacto declarado de una versión de GitHub, no de una URL arbitraria. Los paquetes manuales son ZIP que contienen solo `manifest.json` y un `panel.html` autónomo; los paquetes inválidos o no compatibles se rechazan.

La instalación no necesita reiniciar OpenCode y nunca concede activación automáticamente. Un fallo de validación, conflicto u operación de almacenamiento no autoriza a reintentar con bytes distintos. Vuelve a inspeccionar el paquete antes de un nuevo intento de instalación.

## Activar y comprender el ámbito {#activate-scope}

1. Vuelve a la fila del complemento sobre la sección **Extensiones** en **Personalizar panel derecho**. Los complementos instalados desactivados permanecen en esa lista.
2. Marca su casilla para activarlo. Desmarca esa misma casilla para desactivarlo.

Esa casilla es el único control de activación: no hay un interruptor adicional en un gestor ni una barrera de visibilidad por ventana. La activación abarca todos los proyectos de la configuración, no una carpeta. En una conexión remota afecta al almacén de extensiones instaladas del servidor, no solo al dispositivo desde el que miras.

El almacén de extensiones es `panel-extensions/` junto a la configuración de CodeNomad seleccionada. Los perfiles de datos de escritorio separados **no** aíslan las extensiones cuando usan el mismo directorio de configuración. A la inversa, abrir otra configuración no concede permiso para ejecutar un complemento instalado en otro lugar. Consulta [Ventanas y datos de escritorio](desktop.md) para la distinción.

Un panel activado puede montarse al seleccionarlo; ocultarlo puede descartar su estado temporal de interfaz. Desactivarlo revoca su activación. **Restablecer** en personalización solo restaura la disposición integrada y no activa, desactiva ni desinstala extensiones.

## Reemplazar o eliminar {#replace-remove}

1. Usa **Cambiar versión…** o inspecciona otro ZIP con el mismo ID para reemplazar un paquete instalado.
2. Revisa el resumen y los permisos nuevos, confirma la confianza e instálalo desactivado.
3. Reactívalo mediante la casilla normal solo después de decidir confiar en el reemplazo.
4. Para desinstalar, usa **Eliminar…** y **Confirmar eliminación** tras revisar el objetivo.

Cada reemplazo revoca la activación en todos los proyectos, incluso si la lista de permisos no cambia. Un fallo de validación/conflicto/almacenamiento conserva el paquete instalado. No hay actualizaciones silenciosas de extensiones. Eliminar borra el paquete y sus ajustes de activación, no sesiones de OpenCode ni archivos del proyecto. Para recuperarte de código no deseado, desactívalo primero; reinstala solo un paquete verificado de confianza.

## Contexto, consentimiento de recursos y límites del aislamiento {#permissions-sandbox}

| Contrato | Qué permite la activación |
| --- | --- |
| API 1 / `session.context` | Identificador de sesión actual (o ninguno), idioma y apariencia de la interfaz. Sin texto de transcripción ni acceso al sistema de archivos. |
| API 2 / `session.assets.read` más contexto | Permiso revisado explícitamente para enumerar metadatos acotados de imágenes/adjuntos de resultados de herramientas de la sesión actual y leer bytes incrustados compatibles. No es acceso general a transcripciones, archivos o URL. |

El acceso a recursos sigue al anfitrión/sesión montado actualmente, no a una sesión elegida por el autor. Las referencias locales/remotas pueden enumerarse como no disponibles; la API de recursos no obtiene URL remotas arbitrarias ni abre archivos locales. Cambiar de sesión, desconectar o revocar el consentimiento invalida el acceso anterior.

El código del autor se ejecuta en un iframe restringido, no en el renderer de confianza de la aplicación. No recibe puente nativo/OpenCode, acceso a credenciales, RPC general, formularios, popups ni descargas; las API de red y los recursos externos están restringidos. Las extensiones son complementos de interfaz, no [plugins de OpenCode](integrations.md).

El aislamiento no es aislamiento de proceso/CPU ni una promesa de que el código aprobado sea inocuo. Una extensión hostil puede perturbar su renderer. Instala solo autores de confianza, no proporciones secretos y desactiva/elimina un complemento si se comporta inesperadamente.
