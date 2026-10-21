# Actualizaciones

## Elegir el canal de versiones {#feed}

1. Abre **Configuración → Info → Actualizaciones**.
2. Establece **Canal de actualizaciones** en **Versiones estables** o **Versiones preliminares y estables**.
3. Actualiza/busca actualizaciones y revisa la versión ofrecida antes de aceptar una instalación.

El canal se guarda en la configuración del servidor CodeNomad y solo cambia qué versiones se ofrecen. No cambia perfiles de datos de escritorio, borradores, ventanas, sesiones OpenCode ni configuración del servicio. Sin una selección explícita, las compilaciones etiquetadas como preliminares usan por defecto las preliminares; las demás, las estables.

Estable selecciona la última versión final. Preliminar sigue el orden de publicación porque las compilaciones de desarrollo pueden compartir número de versión base; no compares solo sus versiones numéricas. Una versión preliminar solo se ofrece cuando se han publicado todas sus compilaciones. Los paquetes preliminares son para quienes aceptan probar comportamiento previo a una versión final; inspecciona las notas y protege los borradores importantes antes de reiniciar.

## Actualizar una instalación de escritorio {#desktop-update}

1. Usa **Ayuda → Buscar actualizaciones…**, la notificación de actualización o el botón en **Configuración → Info → Actualizaciones**.
2. En Electron, sigue la página de la versión y obtén el archivo/paquete para el anfitrión/plataforma que uses.
3. En instalaciones locales Tauri elegibles, revisa la oferta nativa y elige explícitamente **Instalar y reiniciar**.
4. Guarda el trabajo importante de todas las ventanas antes de instalar/reiniciar y verifica **Info** tras volver a iniciar.

| Instalación Tauri | Elegibilidad de instalación desde la aplicación |
| --- | --- |
| Instalación NSIS Windows x64 | Compatible con la clave de actualizador incluida y una carga de versión firmada. |
| Aplicación macOS x64 / arm64 | Compatible con la clave de actualizador incluida y una carga `.app.tar.gz` firmada. |
| AppImage Linux x64 | Requiere el marcador de paquete AppImage y una ruta `APPIMAGE` no vacía, además de compatibilidad con actualizaciones firmadas. `APPRUN` por sí solo no basta. |
| Debian/RPM, ejecutable suelto de Windows, compilación sin firma/clave | Abre la página de la versión en lugar de instalar desde la aplicación. |

En las ventanas de la aplicación Tauri y las ventanas nativas de **Preferencias**, la sección Actualizaciones muestra **Instalar actualización** cuando se ofrece una versión. Comprueba el canal seleccionado y ofrece **Instalar y reiniciar** cuando hay una actualización disponible desde la aplicación; de lo contrario, abre la página de la versión indicada en esa sección. Las ventanas Electron, web y remotas muestran en su lugar el enlace **Descargar actualización**, sin una comprobación del actualizador nativo.

El menú de Tauri **Ayuda → Buscar actualizaciones…** ejecuta el proceso de actualización en la ventana de la aplicación que tiene el foco. Desde Preferencias o una ventana remota, trae al frente la ventana de la aplicación utilizada más recientemente para ejecutar la comprobación; no instala a través de la ventana remota. Si ninguna ventana de la aplicación puede recibir la acción, incluso cuando la ventana de destino muestra una pantalla de carga, inicio de sesión o emparejamiento, el menú abre la página de la versión en su lugar.

Tauri solo instala versiones con un manifiesto de actualización publicado para el canal/destino elegido. Si una versión anunciada aún no se puede instalar, la notificación abre su página en su lugar. Se requiere verificación nativa de firma antes de instalar. Las firmas del actualizador son distintas de las garantías de notarización/firma de código del sistema operativo.

La instalación vuelca el estado de todas las ventanas de la aplicación y detiene el backend propio de CodeNomad antes de reemplazar/reiniciar la aplicación. El daemon OpenCode de propiedad independiente no forma parte de este apagado. Cerrar CodeNomad sigue retirando las funciones dependientes del backend hasta que vuelva; no deduzcas que los servicios de interfaz continúan sin interrupción porque una sesión OpenCode siga activa.

Si una comprobación está ocupada, espera a la operación de la otra ventana. Ante fallos de descarga, validación o apagado, lee el error y realiza una comprobación nueva; una notificación antigua no autoriza a reinstalar bytes obsoletos. Una instalación fallida puede restaurar el backend y recargar las ventanas, y no repite automáticamente la instalación. Si la instalación nativa no está disponible, usa la página de la versión para el paquete adecuado; consulta [Instalación](install.md).

## Actualizar un servidor independiente {#standalone-update}

1. Identifica cómo iniciaste CodeNomad y guarda el trabajo que dependa de ese backend.
2. Detén ese proceso de servidor CodeNomad con su control habitual de proceso/servicio.
3. Actualiza la misma instalación de paquete y reinicia con la configuración y opciones previstas.

| Método de inicio/instalación | Comando de actualización |
| --- | --- |
| Inicio npm estable puntual | `npx @neuralnomads/codenomad@latest` con tus opciones habituales |
| Instalación global estable | `npm install -g @neuralnomads/codenomad@latest` |
| Instalación local estable | `npm install @neuralnomads/codenomad@latest` en ese directorio de paquete |
| Inicio preliminar puntual | `npx @neuralnomads/codenomad-dev@latest` con tus opciones habituales |
| Instalación global/local preliminar | Instala `@neuralnomads/codenomad-dev@latest` con la misma forma npm global/local |

Un proceso ya en ejecución no adquiere código nuevo solo porque npm lo instaló. Mantén deliberadamente la misma ruta de configuración; seleccionar un canal en Configuración no reemplaza tu paquete npm ni cambia automáticamente los nombres de paquetes estable/preliminar. Conserva las opciones de autenticación/TLS al volver a iniciar; consulta [Servidor](server.md).

## Mantener separado el mantenimiento de OpenCode {#opencode-separate}

Actualizar CodeNomad no actualiza la CLI OpenCode seleccionada. Actualizar esa CLI no reinicia el daemon compartido en ejecución. Recargar la configuración nativa es otra operación explícita con sus propios efectos sobre Locations cargadas y solicitudes.

Los recursos Node/npm de escritorio se distribuyen con la aplicación; una versión de la aplicación entrega sus actualizaciones. Esto no reemplaza tu Node/npm del sistema, el entorno interno de Electron, el webview de la plataforma ni el servicio OpenCode gestionado independientemente.

Usa **Configuración → OpenCode** para selección del entorno, instalación/actualización y controles explícitos del servicio. Comprueba la [configuración de OpenCode](opencode.md) antes de reiniciar o recargar, sobre todo cuando otras ventanas/personas o Misiones comparten el daemon. Nunca repitas un mensaje o modificación inciertos solo porque terminó una actualización/reconexión.
