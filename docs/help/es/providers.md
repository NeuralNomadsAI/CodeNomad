# Proveedores y cuentas

La autenticación de proveedores pertenece al servicio OpenCode conectado, no al dispositivo del navegador ni a un proyecto de CodeNomad. Las preferencias de visualización de modelos, las cuotas de suscripción y las elecciones de búsqueda web tienen ámbitos distintos.

## Conectar un proveedor de modelos o búsqueda {#connect}

1. Abre un espacio de trabajo y después **Configuración → Proveedores**. **Modelos** empieza expandido; expande **Búsqueda web** para los proveedores de búsqueda.
2. En ese grupo, elige **Seleccionar proveedor** y después **Conectar**.
3. Para un proveedor de modelos, completa el **Método de autenticación** nativo ofrecido: clave API, OAuth o comando. Para OAuth, usa **Abrir página de autorización** y envía un código de autorización solo cuando se solicite. Los proveedores de búsqueda se conectan con una clave API.
4. Comprueba la fila del proveedor configurado al terminar. **Modelos** vuelve a leer tras las conexiones, los cambios de cuenta y las reconexiones; **Búsqueda web** también tiene **Actualizar**.

Las integraciones exclusivas de búsqueda aparecen en **Búsqueda web**, no en **Modelos**. Guardar la autenticación no elige un modelo ni cambia el proveedor de búsqueda predeterminado. Las claves API y las credenciales OAuth las guarda el servidor OpenCode activo. El navegador recibe metadatos de conexión, no secretos de credenciales guardadas. Una conexión procedente de variables de entorno es de solo lectura en esta interfaz: cambia el entorno propietario en lugar de intentar desconectarla aquí.

Si se bloquea la ventana de autorización, usa **Abrir página de autorización**, **Abrir en esta pestaña** o **Copiar enlace** en el flujo. No publiques el enlace ni el código de autorización en diagnósticos.

## Seleccionar y gestionar cuentas {#accounts}

1. En la fila del proveedor, usa **Cuenta activa** para seleccionar una credencial guardada.
2. Usa **Añadir cuenta** para autenticar otra conexión.
3. Para gestionar otra cuenta guardada, selecciónala primero y usa **Renombrar cuenta** o **Eliminar cuenta**. Para renombrar se usan **Nombre de cuenta** y **Guardar**; **Eliminar cuenta** actúa de inmediato, sin confirmación.

La selección, el cambio de nombre y la eliminación afectan a esa integración en todo el servicio OpenCode, incluidos otros proyectos y clientes. Eliminar una credencial puede dejar a esos clientes sin autenticación; no elimina el historial de conversaciones ni revoca la cuenta remota del proveedor. Las conexiones del entorno no pueden seleccionarse como credenciales guardadas modificables ni eliminarse aquí. Si una operación falla, CodeNomad vuelve a leer las cuentas: comprueba de nuevo **Cuenta activa** antes de actuar.

### Límites de selección automática {#automatic-selection}

Con varias credenciales guardadas en una integración compatible, **Seleccionar cuenta automáticamente** habilita la selección basada en cuotas antes de admitir el siguiente mensaje/comando personalizado a través de CodeNomad. El ajuste es por integración en la configuración de CodeNomad; la selección de cuenta resultante afecta a todo el servicio.

| Integración elegible | Tipo de cuenta elegible |
| --- | --- |
| OpenAI / Codex | Cuentas de suscripción OAuth de Codex por navegador/dispositivo, no claves de pago por uso de OpenAI ni el método de inicio de sesión de ChatGPT cuyo uso OpenAI no proporciona. |
| OpenCode Go | Clave Go o inicio de sesión/clave de OpenCode Console usados **solo para el proveedor Go**, no créditos Zen de pago por uso. |
| Anthropic | Inicio de sesión OAuth de Claude Pro/Max de OpenCode, **no** el inicio de sesión de Claude Code. |
| GitHub Copilot | OAuth con cuota legible de solicitudes premium; las credenciales de endpoint empresarial no son candidatas legibles. |
| Planes de programación | Basados en claves: `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Solo una cuenta actual con la cuota agotada provoca el cambio; tener una alternativa con más capacidad no basta. Las lecturas examinan credenciales guardadas explícitas sin activar candidatas ni intercambiar tokens de actualización. Codex, Copilot y los planes de programación requieren una candidata con disponibilidad demostrable. Go, Console y Claude pueden usar una candidata con cuota desconocida salvo que un fallo nativo reciente de cuota la marque como agotada. El endpoint de uso de OpenCode Go y el uso OAuth de Console siguen sin verificarse en el proveedor original, por lo que no se garantiza la disponibilidad.

Esto **no es conmutación durante una solicitud en curso**. No reintenta solicitudes fallidas ni repite mensajes, comandos o modificaciones. No rota conexiones de entorno, proveedores arbitrarios, saldos de pago por uso ni inicios de sesión externos de Claude Code. Los cambios manuales de cuenta se respetan durante la preparación de la selección; no existe un bloqueo de cuentas entre clientes. Ante errores de cuota/autenticación, inspecciona **Cuenta activa**, actualiza Uso e inicia sesión mediante el propietario de la credencial según sea necesario antes de volver a enviar deliberadamente.

## Visibilidad de modelos, favoritos y Razonamiento {#models}

1. Elige **Gestionar modelos** junto a un proveedor de modelos.
2. Busca por nombre/ID y cambia la visibilidad; **Mostrar todos** y **Ocultar todos** afectan a la lista del selector de ese proveedor.
3. En el selector **Modelo** de una conversación, usa **Agregar a favoritos** o **Quitar de favoritos**; **Mostrar todos los modelos** sale del filtrado de solo favoritos.
4. Usa **Razonamiento** en el editor para las variantes que ofrezca el modelo seleccionado.

La visibilidad y los favoritos organizan los selectores de CodeNomad; no desinstalan modelos, eliminan credenciales ni impiden que otros clientes OpenCode los usen. Ocultar un modelo no desconecta una cuenta. Razonamiento selecciona una variante del modelo para envíos posteriores, no la visibilidad del razonamiento ya presente en la transcripción. Restaura modelos ocultos con **Gestionar modelos → Mostrar todos**.

## Uso, recuentos de tokens e inicios de sesión caducados {#usage}

Usa **Uso** en el panel derecho para ver los periodos del plan del proveedor de la conversación activa, sus horas de reinicio y los saldos compatibles. Estas lecturas del proveedor difieren de los **Tokens** por mensaje y las estimaciones de coste: una cuota de suscripción no es una factura calculada a partir de la transcripción visible. Una lectura ausente, obsoleta o desconocida no equivale a uso cero ni demuestra capacidad restante. **Saldo de créditos del proveedor** en **Configuración → Avanzado** controla la visualización complementaria del saldo.

OpenAI no proporciona datos de uso para uno de los métodos de inicio de sesión de ChatGPT: Uso lo indica en lugar de mostrar periodos de cuota. Chatear sigue funcionando, y volver a conectar el mismo inicio de sesión no restaura la lectura.

Uso sigue la credencial nativa seleccionada. Claude mediante `anthropic`/`claude` usa el OAuth de Anthropic de OpenCode. El proveedor `claude-code` usa el inicio de sesión de Claude Code en el equipo del daemon, incluida su distribución WSL: `CLAUDE_CODE_OAUTH_TOKEN`, después el inicio de sesión almacenado, con `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` o `~/.claude` determinando el almacenamiento de archivos; macOS local puede usar el Llavero. CodeNomad no sustituye un inicio de sesión de Claude por el otro.

Si caduca el inicio de sesión de un proveedor, actualiza/inicia sesión mediante su propietario —OpenCode, Claude Code o Codex CLI— y actualiza después CodeNomad. CodeNomad no intercambia tokens de actualización de propietarios externos. La caducidad del inicio de sesión del servidor CodeNomad es independiente: reconecta/inicia sesión en CodeNomad sin suponer que una solicitud fallida del proveedor se reenviará. Consulta [Solución de problemas](troubleshooting.md).

### Variables de entorno opcionales para Uso {#usage-environment}

Establécelas en el entorno del **proceso del backend de CodeNomad** antes de iniciarlo. Son credenciales de lectores de uso, no ajustes de navegador ni controles de selección de modelo. Cambiar el editor **Variables de entorno** de la sesión no actualiza el `process.env` de un backend en ejecución para estos lectores. Reinicia el backend con el entorno previsto al cambiarlas; no reinicies el servicio compartido de OpenCode solo por una variable del lector de uso.

| Integración de uso | Variable de entorno |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, con `CURSOR_TOKEN` como alternativa |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| Uso complementario de OpenCode Go | `OPENCODE_GO_WORKSPACE_ID` y `OPENCODE_GO_AUTH_COOKIE` juntos |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — clave de plataforma, distinta de la clave de inferencia |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY` como alternativa cuando no hay una credencial nativa disponible |

Mantén tokens/cookies fuera del historial de shell, capturas e informes. Los lectores opcionales dependen de las API del proveedor y la validez de las credenciales; configurar una variable no garantiza datos de cuota utilizables.

## Búsqueda web predeterminada y valor de Proyecto {#web-search}

1. En **Configuración → Proveedores**, expande **Búsqueda web** y conecta la integración de búsqueda con su clave API si la necesita.
2. Elige **Búsqueda predeterminada** para la configuración Global.
3. Usa **Para el proyecto actual** para sustituirla en la Location activa. Pasa el puntero o enfoca ese selector para ver **Búsqueda en este proyecto** con el resultado efectivo.

Los cambios se guardan automáticamente. **Predeterminado / heredado** usa la configuración heredada o la elección nativa guardada; un valor de Proyecto prevalece sobre Global. **Desactivado** desactiva la búsqueda en el ámbito seleccionado; **Proveedor automático** solicita la selección automática nativa del proveedor. **Búsqueda web** carga sus conexiones y elecciones solo mientras está expandido. **Desconectar** elimina una clave de búsqueda guardada; una conexión proporcionada por una variable de entorno se etiqueta como de solo lectura y no tiene **Desconectar**.

Las credenciales de búsqueda siguen siendo globales al servicio aunque la elección de proveedor tenga ámbito de Proyecto. Guardar una clave no la selecciona como búsqueda predeterminada. Si falla la lectura/el guardado, actualiza antes de reintentar; no reemplaces la configuración a ciegas. Para detalles de configuración nativa, consulta la [documentación de OpenCode](https://opencode.ai/v2/docs/) y la [configuración de OpenCode](opencode.md).
