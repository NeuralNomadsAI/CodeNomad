# Entrada y reproducción de voz

## Configurar la API de voz {#configure}

1. Abre **Configuración → Voz**. La tarjeta **Voz** usa un adaptador del servidor compatible con OpenAI, independiente del proveedor de modelos de tu conversación.
2. Introduce **Clave API**, opcionalmente **URL base**, **Modelo de transcripción**, **Modelo de voz** y **Voz predeterminada**.
3. Si entrada y salida necesitan servicios distintos, activa **Proveedores separados para entrada y salida** y rellena los campos de clave, URL base y modelo de entrada/salida.
4. Elige **Modo de reproducción** y **Formato de salida** y después **Guardar** (disponible mientras haya cambios sin guardar). Comprueba el estado junto a los botones de prueba, **Configurado**, **Parcialmente configurado** o **Falta la clave API**, antes de probar; un guardado fallido muestra **Error al guardar**.

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
2. Elige **Probar entrada**, concede permiso de micrófono, habla y después **Detener grabación**. Comprueba la transcripción devuelta.
3. Elige **Probar reproducción** para escuchar la muestra; **Detener muestra** la finaliza.

La prueba de reproducción usa inmediatamente el modo/formato de reproducción seleccionado, pero endpoint, clave, modelo y voz proceden de los ajustes guardados. Probar entrada no envía un mensaje de conversación. Las pruebas sí envían audio/texto al proveedor de voz configurado y pueden generar cargos.

## Dictar un mensaje {#dictate}

1. Mantén activada **Entrada de voz del prompt** en **Voz** (está activada por defecto).
2. En el editor, abre **Más acciones → Dictar** y permite el acceso al micrófono. Si aparece **Dictar: abrir los ajustes de Voz**, elige o configura allí el motor y vuelve al borrador.
3. Elige **Detener grabación y transcribir** para obtener el texto o **Cancelar el dictado** para descartar la grabación. Cambiar de conversación o cerrar el editor también cancela el dictado.
4. Revisa el texto. Solo sustituye la selección original si el borrador y la selección no han cambiado. Si han cambiado, elige **Insertar la transcripción** o **Descartar la transcripción**. El dictado nunca envía el mensaje.

Si la API recurre a WAV en Tauri para Linux, el dictado y la prueba de entrada detienen la grabación a los 24 segundos. El fragmento queda en este dispositivo hasta que elijas **Transcribir** para enviarlo al proveedor de voz o **Cancelar** para descartarlo.

### Elegir un motor en el escritorio {#desktop-dictation}

En **Preferencias → Voz** de la aplicación de escritorio local, elige el **Motor de dictado en este dispositivo**. La elección se aplica a todos los proyectos del dispositivo; la tarjeta **Voz** sigue configurando la API del servidor conectado. El navegador y el móvil usan el proveedor de API configurado y necesitan un contexto seguro para acceder al micrófono.

- El **Reconocimiento local del sistema** funciona dentro de CodeNomad sin abrir el panel de dictado del sistema. Requiere un motor local instalado para el idioma de la aplicación en Windows o macOS. En Linux, o si falta el motor o el idioma, prueba Hex si está disponible.
- Voz muestra qué componentes faltan y el tamaño de descarga de cada uno y del total. Un clic en **Activar Hex** verifica y reutiliza los archivos compatibles, descarga lo que falta y selecciona Hex cuando está listo. Sigue el progreso en Voz. Puedes usar **Cancelar la activación de Hex** y, cuando aparezca, **Reanudar la activación de Hex**. Si falla o se cancela, se mantiene el motor anterior. Abrir Preferencias, seleccionar **Hex (local)** cuando ya está listo o dictar con él no inicia otra descarga.
- Hex se ofrece en equipos compatibles: Windows x64/arm64, Apple Silicon con macOS 15 o posterior y Linux x64/arm64 con glibc 2.36 o posterior y las bibliotecas que requiere Hex. Los Mac Intel y los sistemas Linux con una glibc anterior o con musl no son compatibles. El motor y los modelos se obtienen aparte del instalador de CodeNomad; no hace falta usar la terminal ni una clave de API.

Ubuntu 24.04 cumple el requisito de glibc, mientras que Ubuntu 22.04 no. Hex detecta el idioma hablado entre los [idiomas admitidos por Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), entre ellos el inglés y el francés. Esta lista es independiente del idioma de la aplicación.

El reconocimiento local usa el micrófono de este dispositivo y funciona sin conexión, también en proyectos WSL abiertos en la aplicación local. Desde una ventana remota compatible, **Dictar** abre la ventana local **Dictar en este dispositivo**. Comprueba el destino y elige **Iniciar entrada de voz**, **Detener grabación y transcribir** e **Insertar la transcripción** para devolver solo el texto al borrador. El proyecto remoto sigue necesitando conexión con su servidor.

En una ventana remota de Tauri en Linux, **Probar entrada** comprueba la API de voz del servidor sin cambiar el motor de dictado. Comprueba la dirección del servidor en el cuadro de diálogo nativo del micrófono antes de confirmar cada grabación para la API. La captura usa PulseAudio o el servicio PulseAudio de PipeWire y siempre se aplica el límite de WAV de 24 segundos descrito arriba.

Gemini Live y OpenAI Realtime no están disponibles en las ventanas remotas de Tauri en Linux: esas ventanas usan la grabadora nativa para el dictado y las pruebas de entrada, y WebKit bloquea el acceso directo al micrófono.

## Leer mensajes en voz alta {#playback}

1. Usa **Reproducir mensaje** en un mensaje, o la misma acción en una llamada a herramienta, cuando TTS esté disponible.
2. Usa **Detener reproducción** en el mismo control para terminarla; iniciar otra lectura detiene la actual.
3. Cambia la voz, el modelo, el modo o el formato guardados en **Voz** para solicitudes posteriores.

La reproducción usa la proyección de texto de CodeNomad, no una captura narrada: los bytes binarios/de imágenes y los comprobantes de permisos no son contenido de voz. No ejecuta un mensaje ni cambia el modelo OpenCode seleccionado.

Para voz automática de conversación, usa **Activar modo conversacion** en el menú **Más acciones** del editor; se aplica a esa pestaña de proyecto y no se conserva tras recargar. Mientras está activado, CodeNomad pide al agente, con cada mensaje que envías, que empiece su respuesta con un breve resumen delimitado `spoken`. Solo se lee ese bloque completado, en la sesión principal activa; no lee automáticamente todas las respuestas ni subagentes. **Desactivar modo conversacion** detiene su cola y deja de pedir el resumen. Iniciar la entrada de micrófono también detiene la voz de conversación activa. El modo de conversación requiere que la reproducción esté configurada en un formato compatible.

## Flujo de datos y privacidad {#privacy}

El dictado local conserva el audio en el dispositivo y no cambia al proveedor de API. Con **Proveedor de API**, el audio del micrófono pasa por el servidor de CodeNomad al endpoint de transcripción configurado. El texto seleccionado para síntesis viaja por ese servidor al endpoint TTS configurado; el audio devuelto se reproduce en el cliente. Las claves API permanecen en el servidor.

Usa un endpoint al que confíes el material dictado o leído. Las credenciales OpenCode no autorizan la voz automáticamente. Cambiar una clave o endpoint afecta a solicitudes futuras, no a datos ya enviados. Consulta [Seguridad](security.md) antes de exponer un servidor a otros usuarios.
