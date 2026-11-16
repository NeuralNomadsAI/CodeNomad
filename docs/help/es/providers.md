# Proveedores y cuentas

La autenticación de proveedores pertenece al servicio OpenCode conectado, no al dispositivo del navegador ni a un proyecto de CodeNomad. Las preferencias de visualización de modelos, las cuotas de suscripción y las elecciones de búsqueda web tienen ámbitos distintos.

## Conectar un proveedor de modelos o búsqueda {#connect}

1. Abre un espacio de trabajo y después **Configuración → Proveedores**. **Modelos** empieza expandido; expande **Búsqueda web** para los proveedores de búsqueda. **Imágenes** reúne los ajustes de imágenes.
2. En ese grupo, elige **Seleccionar proveedor** y después **Conectar**. Para un proveedor de modelos que ya aparece en la lista, usa **Añadir cuenta** (+) en su fila, también para su primera conexión.
3. Para un proveedor de modelos, completa el **Método de autenticación** nativo ofrecido: clave API, OAuth o comando. Para OAuth, usa **Abrir página de autorización** y envía un código de autorización solo cuando se solicite. Los proveedores de búsqueda se conectan con una clave API.
4. Comprueba la fila del proveedor configurado al terminar.

Las integraciones exclusivas de búsqueda aparecen en **Búsqueda web**, no en **Modelos**. Guardar la autenticación no elige un modelo ni cambia el proveedor de búsqueda predeterminado. Las claves API y las credenciales OAuth las guarda el servidor OpenCode activo. El navegador recibe metadatos de conexión, no secretos de credenciales guardadas. Una conexión procedente de variables de entorno es de solo lectura en esta interfaz: cambia el entorno propietario en lugar de intentar desconectarla aquí.

No publiques el enlace ni el código de autorización en diagnósticos.

## Seleccionar y gestionar cuentas {#accounts}

1. En la fila del proveedor, usa **Cuenta activa** para seleccionar una credencial guardada.
2. Usa **Añadir cuenta** para autenticar otra conexión.
3. Para gestionar otra cuenta guardada, selecciónala primero y usa **Renombrar cuenta** o **Eliminar cuenta**. Para renombrar se usan **Nombre de cuenta** y **Guardar**; **Eliminar cuenta** actúa de inmediato, sin confirmación.

La selección, el cambio de nombre y la eliminación afectan a esa integración en todo el servicio OpenCode, incluidos otros proyectos y clientes. Eliminar una credencial puede dejar a esos clientes sin autenticación; no elimina el historial de conversaciones ni revoca la cuenta remota del proveedor. Las conexiones del entorno no pueden seleccionarse como credenciales guardadas modificables ni eliminarse aquí.

### Límites de selección automática {#automatic-selection}

Con varias credenciales guardadas en una integración compatible, **Seleccionar cuenta automáticamente** habilita la selección basada en cuotas antes de admitir el siguiente mensaje/comando personalizado a través de CodeNomad. El ajuste es por integración en la configuración de CodeNomad; la selección de cuenta resultante afecta a todo el servicio.

| Integración elegible | Tipo de cuenta elegible |
| --- | --- |
| OpenAI / Codex | Cuentas de suscripción OAuth de Codex por navegador/dispositivo, no claves de pago por uso de OpenAI ni el método de inicio de sesión de ChatGPT cuyo uso OpenAI no proporciona. |
| OpenCode Go | Clave Go o inicio de sesión/clave de OpenCode Console usados **solo para el proveedor Go**; los modelos de pago de Console siguen siendo manuales. |
| Anthropic | Inicio de sesión OAuth de Claude Pro/Max de OpenCode, **no** el inicio de sesión de Claude Code. |
| GitHub Copilot | OAuth con cuota legible de solicitudes premium; las credenciales de endpoint empresarial no son candidatas legibles. |
| Planes de programación | Basados en claves: `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Solo una cuenta actual con la cuota agotada provoca el cambio; tener una alternativa con más capacidad no basta. Codex, Copilot y los planes de programación requieren una candidata con disponibilidad demostrable. Go, Console y Claude pueden usar una candidata con cuota desconocida salvo que un fallo nativo reciente de cuota la marque como agotada.

Esto **no es conmutación durante una solicitud en curso**. No reintenta solicitudes fallidas ni repite mensajes, comandos o modificaciones. No rota conexiones de entorno, proveedores arbitrarios, saldos de pago por uso ni inicios de sesión externos de Claude Code.

## Visibilidad de modelos, favoritos y Razonamiento {#models}

1. Elige **Gestionar modelos** junto a un proveedor de modelos.
2. Busca por nombre/ID y cambia la visibilidad; **Mostrar todos** y **Ocultar todos** afectan a la lista del selector de ese proveedor. Arrastra sobre las casillas para cambiar varios modelos a la vez.
3. En el selector **Modelo** de una conversación, usa **Agregar a favoritos** o **Quitar de favoritos**; **Mostrar todos los modelos** sale del filtrado de solo favoritos.
4. Usa **Razonamiento** en el editor para las variantes que ofrezca el modelo seleccionado.

La visibilidad y los favoritos organizan los selectores de CodeNomad; no desinstalan modelos, eliminan credenciales ni impiden que otros clientes OpenCode los usen. Razonamiento selecciona una variante del modelo para envíos posteriores, no la visibilidad del razonamiento ya presente en la transcripción. Restaura modelos ocultos con **Gestionar modelos → Mostrar todos**.

## Uso, recuentos de tokens e inicios de sesión caducados {#usage}

Usa **Uso** en el panel derecho para ver los periodos del plan del proveedor de la conversación activa, sus horas de reinicio y los saldos compatibles. Estas lecturas del proveedor difieren de los **Tokens** por mensaje y las estimaciones de coste: una cuota de suscripción no es una factura calculada a partir de la transcripción visible. Una lectura ausente, obsoleta o desconocida no equivale a uso cero ni demuestra capacidad restante. **Saldo de créditos del proveedor** en **Configuración → Avanzado** controla la visualización complementaria del saldo.

Las [preguntas frecuentes de Antigravity](https://antigravity.google/docs/faq/) de Google indican que usar software de terceros con un inicio de sesión de Antigravity infringe sus condiciones y puede provocar la suspensión o cancelación de la cuenta.

Para los modelos de pago de la integración `opencode`, **OpenCode Console** muestra **Solicitudes** para **24 horas**, **7 días** y **30 días**, según las indica Console. **Solicitudes por modelo · 30 días** indica cada modelo y su proveedor. Los contadores corresponden a la cuenta de Console conectada y usan el formato numérico del idioma de la aplicación. **Presupuestos de cuentas de servicio** muestra **Presupuestos no disponibles.** Con **Saldo de créditos del proveedor** activado, el saldo de créditos de Console aparece como **Créditos**. OpenCode Go usa su propio lector de cuota.

Repara una conexión OAuth de Console no válida o caducada mediante su propietario, aunque también haya una clave API guardada.

Ante un error de conexión a Console (401 o 403), comprueba el inicio de sesión, su ID de organización y el permiso **Usage › Read** en **Configuración → Proveedores**, y actualiza **Uso**. OAuth requiere `https://opencode.ai/console`.

Para los modelos gratuitos de OpenCode (`big-pickle` e IDs terminados en `-free`), **Uso** muestra una sola barra: las solicitudes gratuitas de la cuenta Console conectada en las últimas 24 horas de Console, frente a una referencia de **800**; los límites reales pueden variar. El contador incluye otros clientes de la cuenta y no tiene hora de reinicio. Con **Saldo de créditos del proveedor** activado, el saldo de créditos de Console aparece como **Créditos**. Conecta OpenCode Console mediante **Configuración → Proveedores** para consultar solicitudes de modelos gratuitos.

El uso gratuito y los contadores de pago de Console son solo informativos; la selección automática de cuenta usa sus propios lectores y reglas.

OpenAI no proporciona datos de uso para uno de los métodos de inicio de sesión de ChatGPT: Uso lo indica en lugar de mostrar periodos de cuota. Elija [Ver uso de ChatGPT](https://chatgpt.com/settings/usage) para consultar el uso de las aplicaciones y gestionar su acceso a su plan y créditos en ChatGPT.

Claude mediante `anthropic`/`claude` usa el OAuth de Anthropic de OpenCode. El proveedor **Claude Agent** de OpenCode (`claude-agent`) y el proveedor `claude-code` usan el inicio de sesión de Claude Code en el equipo del daemon, incluida su distribución WSL: `CLAUDE_CODE_OAUTH_TOKEN`, después el inicio de sesión almacenado, con `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` o `~/.claude` determinando el almacenamiento de archivos; macOS local puede usar el Llavero.

En OpenRouter, **Límite de la clave** muestra el importe restante en USD frente al límite de gasto de la clave; las claves sin límite no tienen esa fila. Uso emplea el `baseURL` configurado del proveedor, incluido su prefijo de ruta, o `https://openrouter.ai/api/v1` si no existe. Usa un nombre de host HTTPS público sin credenciales, puerto explícito, consulta ni fragmento; se rechazan direcciones IP y localhost. Una URL no válida o una pasarela sin `/key` deja el uso no disponible; la clave permanece en el destino configurado y se rechazan las redirecciones.

El **Uso** de GitHub Copilot muestra el consumo como **usados / límite usados**, o los créditos consumidos de una cuota ilimitada cuando GitHub los proporciona; de lo contrario muestra **Ilimitado**. Las conexiones Enterprise usan `https://api.<host>/copilot_internal/user` a partir del host o la URL HTTPS raíz de la conexión guardada. Usa un nombre de host cualificado sin credenciales, puerto explícito (incluido `:443`), ruta más allá de `/`, consulta ni fragmento; las direcciones IP y localhost se rechazan antes de enviar el token. Se rechazan las redirecciones. Las conexiones Enterprise siguen excluidas de la selección automática de cuentas.

Kimi admite `kimi-code-plan-cn`, `kimi-code-plan-global`, `kimi-for-coding` y `kimi`. Los límites disponibles de cinco horas, semanales, **Mensual** y **Programación mensual** muestran el porcentaje usado.

Los límites mensuales siguen la fecha de reinicio del proveedor; una cuenta `kimi-for-coding` con cualquiera de ellos agotado no está disponible para la selección automática, aunque una ventana más corta aún tenga capacidad.

Las claves API de OpenCode Go muestran los porcentajes usados y las horas de reinicio disponibles. El inicio de sesión de OpenCode Console también lee el saldo de la cartera en USD cuando los permisos de facturación lo permiten. Activa **Saldo de créditos del proveedor** para mostrar ese saldo separado (desactivado por defecto); las cuotas Go y Extra Usage siguen siendo independientes. Un saldo por sí solo deja la cuota desconocida para la selección automática.

Ante **El uso no está disponible temporalmente.** o **No se puede acceder a OpenCode Console.**, comprueba la conexión de red y actualiza **Uso**.

Si una clave OpenCode Go ha caducado, crea otra en [OpenCode Console](https://opencode.ai/console/login), en **Account → Personal API keys**, y sustituye la clave guardada mediante la conexión del proveedor.

### Variables de entorno opcionales para Uso {#usage-environment}

Proporciona un token de acceso de Cursor vigente mediante las variables siguientes. Las lecturas Enterprise requieren permiso para leer los datos del panel del equipo; la [API de administración](https://cursor.com/docs/account/teams/admin-api) usa una clave administrativa independiente. Actualiza el token caducado y reinicia el backend con el entorno actualizado.

Establécelas en el entorno del **proceso del backend de CodeNomad** antes de iniciarlo. Cambiar el editor **Variables de entorno** de la sesión no actualiza el `process.env` de un backend en ejecución para estos lectores. Reinicia el backend con el entorno previsto al cambiarlas; no reinicies el servicio compartido de OpenCode solo por una variable del lector de uso.

| Integración de uso | Variable de entorno |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, con `CURSOR_TOKEN` como alternativa |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| Uso complementario de OpenCode Go | `OPENCODE_GO_WORKSPACE_ID` y `OPENCODE_GO_AUTH_COOKIE` juntos |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — clave de plataforma, distinta de la clave de inferencia |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY` como alternativa cuando no hay una credencial nativa disponible |

Mantén tokens/cookies fuera del historial de shell, capturas e informes.

## Búsqueda web predeterminada y valor de Proyecto {#web-search}

1. En **Configuración → Proveedores**, expande **Búsqueda web** y conecta la integración de búsqueda con su clave API si la necesita.
2. Elige **Búsqueda predeterminada** para la configuración Global.
3. Usa **Para el proyecto actual** para sustituirla en la Location activa. Pasa el puntero o enfoca ese selector para ver **Búsqueda en este proyecto** con el resultado efectivo.

Los cambios se guardan automáticamente. **Predeterminado / heredado** usa la configuración heredada o la elección nativa guardada; un valor de Proyecto prevalece sobre Global. **Desactivado** desactiva la búsqueda en el ámbito seleccionado; **Proveedor automático** solicita la selección automática nativa del proveedor. **Desconectar** elimina una clave de búsqueda guardada; una conexión proporcionada por una variable de entorno se etiqueta como de solo lectura y no tiene **Desconectar**.

Las credenciales de búsqueda siguen siendo globales al servicio aunque la elección de proveedor tenga ámbito de Proyecto. Guardar una clave no la selecciona como búsqueda predeterminada. Para detalles de configuración nativa, consulta la [documentación de OpenCode](https://opencode.ai/v2/docs/) y la [configuración de OpenCode](opencode.md).

## Generación y almacenamiento de imágenes {#images}

1. En **Configuración → Proveedores**, expande **Imágenes**.
2. **Generación de imágenes** está en **Activada, modelo automático** mientras no la cambies: elige en su lugar uno de los modelos de imagen que ofrecen tus proveedores conectados, o **Desactivada** para desactivarla en la configuración Global.
3. Marca **Guardar las imágenes una sola vez** para guardar cada imagen adjunta o generada una sola vez, en lugar de dentro de cada mensaje que la usa.

Los cambios se guardan automáticamente en la configuración Global de OpenCode y se aplican a todos los proyectos. Ambas son funciones experimentales de OpenCode: **Imágenes** muestra solo los ajustes que admite la versión de OpenCode conectada. Los agentes solo tienen la herramienta de imágenes mientras un proveedor conectado ofrezca un modelo de imagen. **Guardar las imágenes una sola vez** se aplica a los mensajes nuevos. Si el propio archivo de configuración de OpenCode del proyecto decide **Guardar las imágenes una sola vez**, la casilla muestra el valor que se aplica allí y al guardar también se escribe en ese archivo. Si guardar ocultara otros ajustes de OpenCode, **Imágenes** queda en solo lectura; cambia las opciones en el archivo de configuración indicado en la descripción emergente de la advertencia.

Para crear, comparar y refinar imágenes en una conversación dedicada, consulta [Crear imágenes con la extensión Design](extensions.md#design).
