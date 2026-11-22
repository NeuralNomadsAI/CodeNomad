# Dictado, reproducción y conversación por voz

## Configurar Voz {#configure}

Abre **Preferencias → Voz** (**Configuración → Voz** en un navegador o una ventana remota). Las tarjetas **Dictado**, **Reproducción** y **Conversación** muestran su estado.

1. En **Dictado**, elige el [motor del dispositivo](#desktop-dictation) en las preferencias locales de escritorio. El navegador y el móvil solo usan la API.
2. Para el dictado por API y la reproducción, abre **Credenciales de API** desde cualquiera de las dos tarjetas. Introduce **Clave API** y, si hace falta, **URL base**, **Modelo de transcripción** y **Modelo de voz**. Para usar dos servicios, activa **Proveedores separados para entrada y salida**, rellena sus campos y pulsa **Guardar**.
3. **Reproducción** muestra el **Proveedor**. Ajusta **Voz predeterminada**, **Modo de reproducción** y **Formato de salida** y pulsa **Guardar**.

Los ajustes y claves de voz pertenecen a la configuración del servidor CodeNomad conectado, no al proyecto seleccionado ni a la conexión del proveedor OpenCode. Los demás clientes que la compartan usan esos ajustes. Las claves guardadas se ocultan: un campo de clave vacío conserva el valor guardado; **Borrar clave guardada** programa su eliminación al guardar. Una dirección de entrada o salida sin endpoint ni clave propios puede usar los ajustes compartidos; un endpoint separado necesita su propia clave, y una clave separada necesita su endpoint. Al cambiar un endpoint, proporciona explícitamente la clave prevista y verifica la configuración guardada; los cambios de endpoint borran la clave guardada de esa posición en lugar de enviarla a otro anfitrión.

El backend también puede usar `OPENAI_API_KEY` y `OPENAI_BASE_URL` como valores compartidos predeterminados. Borrar una clave guardada no retira una credencial proporcionada por el entorno; cambia ese entorno en el backend y reinícialo si quieres eliminar la alternativa.

| Ajuste | Significado / valor predeterminado |
| --- | --- |
| URL base | Raíz API compatible con OpenAI, por defecto `https://api.openai.com/v1`. La entrada usa `audio/transcriptions`; la salida, `audio/speech`. |
| Modelo de transcripción / Modelo de entrada | Modelo aceptado por el endpoint STT; por defecto `gpt-4o-mini-transcribe`. |
| Modelo de voz / Modelo de salida | Modelo aceptado por el endpoint TTS; por defecto `gpt-4o-mini-tts`. |
| Voz predeterminada | Identificador de voz del proveedor; por defecto `alloy`. No es un selector de voces del sistema operativo. |
| Streaming | Predeterminado. Empieza a reproducir conforme llega el audio, cuando proveedor y navegador admiten el formato seleccionado. |
| Con búfer | Espera la respuesta de audio completa antes de reproducir. |
| Formato de salida | `mp3`, `wav`, `opus` o `aac`; por defecto `mp3`. La compatibilidad varía según navegador/proveedor. |

Son solicitudes al servicio configurado, no una garantía de que todos los endpoints compatibles implementen todos los modelos, voces o formatos.

## Probar entrada y salida {#test}

1. Guarda primero los cambios de endpoint, clave, modelo y voz.
2. Elige **Probar entrada por API**, concede permiso de micrófono, habla y después **Detener grabación**. Comprueba la transcripción devuelta.
3. Elige **Probar reproducción** para escuchar la muestra; **Detener muestra** la finaliza.

La prueba de reproducción usa inmediatamente el modo y el formato seleccionados, pero el endpoint, la clave, el modelo y la voz proceden de los ajustes guardados. **Probar entrada por API** envía audio al proveedor de API configurado, sea cual sea el motor de dictado. No envía un mensaje de conversación. El proveedor puede cobrar por estas pruebas.

## Dictar un mensaje {#dictate}

1. Mantén activada **Entrada de voz del prompt** en **Voz** (está activada por defecto).
2. En **Más acciones**, marca **Modo de dictado**. Desmarca el modo activo antes de elegir el otro.
3. Mantén pulsado el micrófono junto a **Más acciones**, habla y suéltalo para transcribir. Concede acceso al micrófono si se solicita. En una ventana remota compatible, púlsalo para abrir los controles de dictado locales.
4. Revisa el texto. Solo sustituye la selección original si el borrador y la selección no han cambiado. Si han cambiado, elige **Insertar la transcripción** en modo normal o **Descartar la transcripción** antes de volver a dictar. El dictado nunca envía el mensaje.

Si la API recurre a WAV en Tauri para Linux, el dictado y la prueba de entrada detienen la grabación a los 24 segundos. El fragmento queda en este dispositivo hasta que elijas **Transcribir** para enviarlo al proveedor de voz o **Cancelar** para descartarlo.

Las grabaciones comprimidas para la API también se detienen al alcanzar el límite de tamaño y ofrecen **Transcribir** o **Cancelar**.

### Elegir un motor en el escritorio {#desktop-dictation}

En **Preferencias → Voz → Dictado** de la aplicación de escritorio local, elige el **Motor de dictado en este dispositivo**. La elección se aplica a todos los proyectos del dispositivo. **Proveedor de API** usa los ajustes del servidor conectado y necesita un contexto seguro para el micrófono.

- Si el motor guardado no está disponible, elige aquí **Hex (local)**, si se ofrece, o **Proveedor de API**. En los Mac Intel o con una versión anterior a macOS 15, usa **Proveedor de API**.
- Voz muestra qué componentes faltan y el tamaño de descarga de cada uno y del total. Un clic en **Activar Hex** verifica y reutiliza los archivos compatibles, descarga lo que falta y selecciona Hex cuando está listo. Sigue el progreso en Voz. Puedes usar **Cancelar la activación de Hex** y, cuando aparezca, **Reanudar la activación de Hex**. Si falla o se cancela, se mantiene el motor anterior. Abrir Preferencias, seleccionar **Hex (local)** cuando ya está listo o dictar con él no inicia otra descarga.
- Hex se ofrece en equipos compatibles: Windows x64/arm64, Apple Silicon con macOS 15 o posterior y Linux x64/arm64 con glibc 2.36 o posterior y las bibliotecas que requiere Hex. Los Mac Intel y los sistemas Linux con una glibc anterior o con musl no son compatibles. El motor y los modelos se obtienen aparte del instalador de CodeNomad; no hace falta usar la terminal ni una clave de API.

Ubuntu 24.04 cumple el requisito de glibc, mientras que Ubuntu 22.04 no. Hex detecta el idioma hablado entre los [idiomas admitidos por Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), entre ellos el inglés y el francés. Esta lista es independiente del idioma de la aplicación.

Hex carga su modelo en segundo plano al iniciar la grabación y lo mantiene listo durante tres minutos tras el último dictado.

El reconocimiento local funciona sin conexión, también en proyectos WSL abiertos en la aplicación local. En una ventana remota compatible, pulsa el micrófono para abrir **Dictar en este dispositivo**. Comprueba el destino y usa los controles de grabación e inserción de esa ventana. Solo vuelve el texto al borrador. El proyecto remoto sigue necesitando conexión con su servidor.

En una ventana remota de Tauri en Linux, **Probar entrada por API** comprueba la API de voz del servidor sin cambiar el motor de dictado. Comprueba la dirección del servidor en el cuadro de diálogo nativo del micrófono antes de confirmar cada grabación para la API. La captura usa PulseAudio o el servicio PulseAudio de PipeWire y siempre se aplica el límite de WAV de 24 segundos descrito arriba.

Gemini Live y OpenAI Realtime no están disponibles en las ventanas remotas de Tauri en Linux: esas ventanas usan la grabadora nativa para el dictado y las pruebas de entrada, y WebKit bloquea el acceso directo al micrófono.

## Leer mensajes en voz alta {#playback}

1. Usa **Reproducir mensaje** en un mensaje, o la misma acción en una llamada a herramienta, cuando TTS esté disponible.
2. Usa **Detener reproducción** en el mismo control para terminarla; iniciar otra lectura detiene la actual.
3. Cambia la voz, el modo o el formato en **Reproducción**, o el modelo en **Credenciales de API**, y guarda los cambios.

La reproducción usa la proyección de texto de CodeNomad, no una captura narrada: los bytes binarios/de imágenes y los comprobantes de permisos no son contenido de voz. No ejecuta un mensaje ni cambia el modelo OpenCode seleccionado.

## Conversación por voz {#conversation}

Gemini Live y OpenAI Realtime solo están disponibles para las sesiones del servidor que abrió esta ventana.

En **Conversación**, elige el **Motor de conversación**:

- **Clásico** solo requiere reproducción configurada en un formato compatible. Marca **Modo de conversación** en **Más acciones**. CodeNomad lee el resumen `spoken` completo de la respuesta en la sesión principal activa. Se aplica a la pestaña del proyecto hasta que lo desmarques o recargues.
- **Gemini Live** y **OpenAI Realtime** tienen cada uno su propia **Clave API**, su **Modelo** y una **Voz** opcional. Guarda los ajustes del proveedor elegido. Abre la sesión de destino, elige **Modo de conversación** en **Más acciones** y, cuando aparezca el aviso del proveedor, pulsa **Aceptar y empezar**. Permite el acceso al micrófono.

Si el proveedor deja de estar disponible mientras el aviso sigue abierto, elige **Ajustes de voz** para abrir la tarjeta de conversación.

El modelo de voz puede leer el estado de la sesión fijada al inicio, la última respuesta visible y los errores recientes. No tiene acceso a archivos. Si le pides que envíe una solicitud al agente, la envía directamente como mensaje tuyo, sin confirmación en pantalla. Se mantienen el [modo de permisos de la conversación](permissions.md#conversation-mode) y las preguntas del agente.

El servidor admite una conversación en directo a la vez por usuario autenticado o por dispositivo emparejado con Control remoto. **Detener** finaliza el audio y deja abierta la transcripción. Esta se conserva en memoria hasta que se cierra la ventana; las solicitudes enviadas al agente quedan como mensajes de la sesión. La conversación también termina tras dos minutos sin hablar, a los ocho minutos en total, al cambiar de sesión de destino, al cerrar la ventana o al perder la conexión. No hay reconexión automática ni cambio de proveedor.

En OpenAI Realtime, **Interrumpir la respuesta** detiene la reproducción y solicita cancelar la respuesta en curso. En Gemini Live, **Detener reproducción** solo silencia la respuesta en este dispositivo: Gemini puede seguir generándola y enviar solicitudes al agente.

## Flujo de datos y privacidad {#privacy}

El dictado local conserva el audio en el dispositivo y no cambia al proveedor de API. Con **Proveedor de API**, el audio del micrófono pasa por el servidor de CodeNomad al endpoint de transcripción configurado. El texto seleccionado para síntesis viaja por ese servidor al endpoint TTS configurado; el audio devuelto se reproduce en el cliente. Las claves API permanecen en el servidor.

Con **Gemini Live** u **OpenAI Realtime**, Google u OpenAI recibe el audio del micrófono, el nombre del proyecto, la rama, el árbol de trabajo, el título y el estado de la sesión. El proveedor también puede recibir el texto de la última respuesta visible del agente y los errores recientes. El uso puede facturarse a tu cuenta con el proveedor elegido.

Usa un proveedor al que confíes lo que dictas, lees o compartes. Las credenciales de OpenCode no autorizan automáticamente los servicios de voz. Consulta [Seguridad](security.md) antes de exponer un servidor a otros usuarios.
