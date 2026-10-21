# Entrada y reproducción de voz

## Configurar la voz {#configure}

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

Son solicitudes al servicio configurado, no una garantía de que todos los endpoints compatibles implementen todos los modelos, voces o formatos. Un guardado fallido deja un error; inspecciona la configuración antes de hacer otro cambio.

## Probar entrada y salida {#test}

1. Guarda primero los cambios de endpoint, clave, modelo y voz.
2. Elige **Probar entrada**, concede permiso de micrófono, habla y después **Detener grabación**. Comprueba la transcripción devuelta.
3. Elige **Probar reproducción** para escuchar la muestra; **Detener muestra** la finaliza.

La prueba de reproducción usa inmediatamente el modo/formato de reproducción seleccionado, pero endpoint, clave, modelo y voz proceden de los ajustes guardados. Probar entrada no envía un mensaje de conversación. Las pruebas sí envían audio/texto al proveedor de voz configurado y pueden generar cargos.

Si falla el streaming, selecciona **Con búfer**, prueba `mp3`, guarda y vuelve a probar. «Configurado» confirma los ajustes, no la autenticación correcta del proveedor ni la reproducción del códec. Comprueba la disponibilidad del endpoint desde el servidor, los nombres de modelo/voz del proveedor y la cuota antes de reintentar.

## Dictar un mensaje {#dictate}

1. Mantén activada **Entrada de voz del prompt** en **Voz** (está activada por defecto).
2. En el editor, abre **Más acciones**, elige **Iniciar entrada de voz** y permite el acceso al micrófono de este dispositivo.
3. Cuando termines de hablar, elige **Detener grabación y transcribir** en el mismo menú; **Transcribiendo audio** se muestra mientras se procesa.
4. Revisa y edita el texto insertado antes de enviar el mensaje normalmente.

La transcripción inserta texto en la selección actual; no lo envía automáticamente a OpenCode. La entrada del menú aparece solo cuando STT está configurado y el cliente admite grabación. La grabación usa el micrófono del dispositivo cliente, incluso si CodeNomad se ejecuta en un servidor remoto.

Si falta la entrada, comprueba el interruptor y la configuración STT. Ante errores de permiso, permite el micrófono tanto en los ajustes de privacidad del navegador como del sistema operativo. La grabación en navegador remoto necesita un contexto seguro, normalmente HTTPS de confianza; consulta [Acceso móvil](mobile.md) y [Acceso remoto directo](remote-access.md). Cambiar de vista o cerrar el editor termina su ciclo de grabación; no confíes en poder recuperar audio sin enviar. El borrador escrito sigue siendo el lugar donde revisar el resultado.

## Leer mensajes en voz alta {#playback}

1. Usa **Reproducir mensaje** en un mensaje, o la misma acción en una llamada a herramienta, cuando TTS esté disponible.
2. Usa **Detener reproduccion** en el mismo control para terminarla; iniciar otra lectura detiene la actual.
3. Cambia la voz, el modelo, el modo o el formato guardados en **Voz** para solicitudes posteriores.

La reproducción usa la proyección de texto de CodeNomad, no una captura narrada: los bytes binarios/de imágenes y los comprobantes de permisos no son contenido de voz. No ejecuta un mensaje ni cambia el modelo OpenCode seleccionado. La compatibilidad de audio del navegador y las respuestas del proveedor aún pueden impedir la reproducción aunque se pueda seleccionar un formato.

Para voz automática de conversación, usa **Activar modo conversacion** en el menú **Más acciones** del editor; se aplica a esa pestaña de proyecto y no se conserva tras recargar. Mientras está activado, CodeNomad pide al agente, con cada mensaje que envías, que empiece su respuesta con un breve resumen delimitado `spoken`. Solo se lee ese bloque completado, en la sesión principal activa; no lee automáticamente todas las respuestas ni subagentes. **Desactivar modo conversacion** detiene su cola y deja de pedir el resumen. Iniciar la entrada de micrófono también detiene la voz de conversación activa. El interruptor aparece con la entrada de voz o mientras el modo conversación ya está activado y requiere TTS operativo para activarse.

## Flujo de datos y privacidad {#privacy}

El audio del micrófono viaja del cliente al backend de CodeNomad y después al endpoint STT configurado. El texto seleccionado para síntesis viaja por ese backend al endpoint TTS configurado; el audio devuelto se reproduce en el cliente. Las claves API permanecen en el servidor y no se devuelven como valores guardados al formulario de configuración.

Usa un endpoint al que confíes el material dictado o leído. Esto no garantiza transcripción sin conexión, y las credenciales OpenCode no autorizan la voz automáticamente. Detén la grabación/reproducción al terminar; cambiar una clave o endpoint afecta a solicitudes futuras, no a datos ya enviados a un proveedor. Consulta [Seguridad](security.md) antes de exponer un servidor a otros usuarios.
