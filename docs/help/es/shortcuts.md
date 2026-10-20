# Atajos de teclado

## Descubrir comandos y abrir la ayuda {#discover-commands}

1. Abre **Paleta de comandos** con `Ctrl+Shift+P` en Windows/Linux o `Cmd+Shift+P` en macOS, o usa su botón/opción de menú visible.
2. Escribe el nombre de una acción. La paleta incluye acciones de la aplicación y los comandos personalizados de la Location actual; la disponibilidad depende de la vista activa.
3. Ejecuta **Abrir ayuda** para abrir esta guía en el idioma actual de la interfaz en un contexto de navegador externo. **Ayuda → Ayuda de CodeNomad** nativo abre la misma guía.

La ayuda deja intactos la vista de la aplicación y el borrador. Si no se abre, visita directamente [Ayuda de CodeNomad](https://neuralnomadsai.github.io/CodeNomad/). Que un comando se pueda descubrir no significa que tenga un atajo personalizable: el gestor de atajos cubre un catálogo fijo de 49 comandos del renderer, no todas las acciones de la paleta o del menú nativo.

## Grabar, desactivar y restablecer {#customize}

1. Abre **Configuración → Atajos de teclado** y usa **Filtrar atajos** para buscar la acción.
2. Elige **Editar** y pulsa la combinación deseada en **Pulsa una combinación de teclas**. Grabar guarda esa asignación.
3. Usa **Desactivar** para retirar la asignación del renderer de esa acción, **Restablecer** para recuperar su valor predeterminado o **Restablecer todos** para todas las asignaciones del renderer.
4. Resuelve las advertencias de todas las filas en conflicto; los conflictos se notifican, no se desactivan silenciosamente.

Las asignaciones se guardan en la configuración de interfaz de CodeNomad y afectan a los clientes que la comparten. No editan las asignaciones CLI/TUI de OpenCode ni los aceleradores del menú nativo. La grabación suprime los atajos del renderer, pero no puede suprimir el sistema operativo ni el menú nativo. **Cancelar**, perder el foco, cerrar la sección o salir de la ventana termina la grabación. Se ignoran los modificadores solos y la composición IME; Tab/Shift+Tab sin modificadores adicionales mueve el foco.

Si el guardado falla, conserva disponible el atajo anterior y reintenta tras comprobar la asignación mostrada. Restablecer es la recuperación segura de una asignación accidental.

## Valores predeterminados del renderer {#renderer-defaults}

`Mod` significa `Ctrl` en Windows/Linux y `Cmd` en macOS. Son valores predeterminados, no garantías de que el sistema operativo/anfitrión nativo entregue la tecla. El ámbito importa: la misma tecla puede ejecutar una acción distinta en la página de inicio, el editor o la búsqueda.

| Acción | Valor predeterminado |
| --- | --- |
| Abrir paleta de comandos | `Mod+Shift+P` |
| Nueva instancia / Buscar una carpeta en la página de inicio | `Mod+N` |
| Cerrar pestaña de la aplicación | `Mod+W` |
| Pestaña anterior / siguiente de la aplicación | `Mod+[` / `Mod+]` |
| Pestaña 1–9 de la aplicación | `Mod+1` a `Mod+9` |
| Renombrar instancia (contexto de pestaña) | `F2` |
| Nueva sesión | `Mod+Shift+N` |
| Cerrar sesión | `Mod+Shift+W` |
| Sesión anterior / siguiente | `Mod+Shift+[` / `Mod+Shift+]` |
| Pestaña de sesión 1–9 | `Mod+Shift+1` a `Mod+Shift+9` |
| Info de la instancia | `Mod+Shift+L` |
| Buscar en el historial de sesión | `Mod+F` |
| Resultado de búsqueda siguiente / anterior (búsqueda enfocada) | `Enter` / `Shift+Enter` |
| Enfocar entrada / Borrar entrada | `Mod+P` / `Mod+K` |
| Abrir selector de modelo / agente | `Mod+Shift+M` / `Mod+Shift+A` |
| Seleccionar variante del modelo | `Mod+Shift+T` |
| Pasar herramientas bloqueantes a segundo plano (editor) | `Mod+B` |
| Enviar entrada | `Enter` |
| Enviar con comportamiento de seguimiento alternativo | `Alt+Enter` (Windows, Linux) o `Mod+Shift+Enter` |
| Insertar nueva línea | `Shift+Enter` o `Mod+Enter` |
| Entrada anterior / siguiente (editor) | `ArrowUp` / `ArrowDown` |
| Quitar foco de la entrada / Salir del modo shell | `Escape`, según el contexto del editor |
| Detener sesión | Pulsa `Escape` dos veces; la primera muestra una confirmación |
| Enviar pregunta aparte (ventana `/btw`) | `Mod+Enter` |
| Guardar archivo (editor del espacio de trabajo) | `Mod+S` |

En una configuración con envío mediante Enter desactivado, **Enviar entrada** usa por defecto `Mod+Enter` e **Insertar nueva línea**, `Enter` o `Shift+Enter`. Una asignación explícita de atajo reemplaza ese valor. Usa el gestor para ver la asignación efectiva. Sesión anterior/siguiente recorre la lista de sesiones; no es el historial tipo navegador **Atrás**/**Adelante** de la barra lateral, que no tiene atajo.

## Teclas nativas e interceptación de la plataforma {#native-keys}

Las teclas nativas son fijas y siguen activas aunque cambies o desactives la asignación correspondiente del renderer. En particular, **New Window** nativo usa `Mod+Shift+N`, el valor predeterminado del renderer para Nueva sesión. Usa un control visible de Nueva sesión o reasigna la acción del renderer si el menú nativo la intercepta. Del mismo modo, `Mod+W` nativo puede cerrar la ventana en lugar de solo una pestaña de la aplicación.

| Acción nativa | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | Controles del menú View y entrada de zoom del webview de la plataforma |
| Full Screen | `F11` en Windows/Linux; `Ctrl+Cmd+F` en macOS | Acelerador de menú `Ctrl+Cmd+F` en macOS; usa el menú en otras plataformas |
| Developer Tools | `Ctrl+Shift+I` en Windows/Linux; `Alt+Cmd+I` en macOS | `Alt+Mod+I` |

Las ventanas normales del navegador también conservan sus atajos. Si una asignación nunca llega a CodeNomad, elige otra combinación en lugar de desactivar seguridad o cambiar teclas de todo el sistema operativo.

## Distribuciones de teclado y entrada de texto {#layouts-ime}

Los atajos de la fila de dígitos y los corchetes usan las posiciones físicas de las teclas para grabar, ejecutar y comprobar conflictos, incluidas las distribuciones AZERTY/QWERTZ. Las demás teclas usan sus valores lógicos. Graba con el teclado que quieras usar y comprueba después el resultado mostrado.

Durante la composición IME, la entrada de texto tiene prioridad. El historial de entradas y las acciones de Escape también dependen del foco, el estado del selector/shell y la operación actual; no supongas que cada ArrowUp o Escape es una acción global incondicional. Las ayudas al pasar el puntero y el gestor de atajos muestran las asignaciones actuales sin añadir una franja permanente de ayuda de teclado.
