# 🔴 BUG: Mobile Sessions Show Errors + Get Stuck

## Descripción

Al usar CodeNomad web desde móvil vía VPN:

1. **La IA se queda "pensando"** después de un rato
2. **Al presionar STOP (botón rojo)** → **muestra errores**
3. **Al intentar reenviar la pregunta** → **muestra errores**
4. **Workaround:** Enviar "?" u otro mensaje → IA **continúa desde donde quedó**

## Síntomas Clave

- ✅ La IA **SÍ continúa** desde donde se quedó (no reinicia)
- ❌ **SIEMPRE muestra errores** al presionar STOP
- ❌ **SIEMPRE muestra errores** al reenviar pregunta
- ✅ Enviar mensaje nuevo (ej: "?") → funciona y continúa

## Patrón Observado

```
Usuario: [Pregunta compleja]
IA: [Empieza a responder...]
IA: [Texto... texto... texto...]
IA: [...] ← SE TRABA AQUÍ (sigue "pensando")

Usuario: [Presiona STOP] 
UI: ⚠️ ERROR [algún mensaje de error]

Usuario: [Intenta reenviar pregunta]
UI: ⚠️ ERROR [algún mensaje de error]

Usuario: [Envía "?"]
IA: [Continúa desde donde quedó] ✓
IA: [...más texto que faltaba...]
IA: [Completa la respuesta]
```

## Información Crítica

### La IA NO reinicia - CONTINÚA

Esto significa:
- ✅ El contexto/historial se mantiene
- ✅ La sesión no se pierde
- ✅ Los mensajes anteriores están intactos
- ✅ Solo necesita un "empujón" para continuar

### Los Errores son Consistentes

- **Siempre** hay error al presionar STOP
- **Siempre** hay error al reenviar
- Pero el sistema **sigue funcionando** (puedes continuar)

## ¿Qué Errores Muestra?

**NECESITAMOS VER LOS ERRORES EXACTOS**

Próxima vez que ocurra:

1. **Toma screenshot** del error cuando presionas STOP
2. **Abre DevTools** (si puedes en móvil)
3. **Copia el mensaje de error** completo
4. **Anota** cualquier código de error o stack trace

### Posibles mensajes de error:

Probablemente uno de estos:
- "Failed to cancel request"
- "Network error"
- "Session error"
- "Timeout"
- "Connection lost"
- Algún error en rojo/amarillo en la UI

## Hipótesis Refinada

### Hipótesis Principal: Request Cancelation Falla

**Lo que probablemente pasa:**

1. IA responde vía **streaming** (SSE)
2. En algún punto, el stream se **atasca** (no se cierra correctamente)
3. Usuario presiona **STOP**
4. CodeNomad intenta **cancelar** el request de OpenCode
5. La cancelación **falla** → muestra error
6. Pero la sesión sigue viva
7. Enviar nuevo mensaje **cierra el request anterior** implícitamente
8. Nuevo request funciona y **continúa desde el contexto guardado**

### Por qué "?" funciona:

- No es mágico del "?"
- Cualquier mensaje nuevo **desbloquea** el stream
- Crea un nuevo request
- Request anterior se abandona/cierra
- Sistema continúa normal

## Diagnóstico Técnico

### Revisar Código de Cancelación

**Ubicación probable:** `packages/server/src/workspaces/` o `packages/ui/src/`

```bash
cd /home/dark/Project/codenomad
grep -r "cancel\|abort" packages/server/src/workspaces/
grep -r "cancel\|abort" packages/ui/src/stores/
```

Buscar:
- Cómo se cancela un request a OpenCode
- Manejo de errores en cancelación
- AbortController o similar

### Revisar Manejo de Errores en UI

```bash
grep -r "error.*session\|session.*error" packages/ui/src/
```

Ver:
- Cómo se muestran los errores
- Si hay try/catch que no manejan bien la cancelación
- Si hay estado de error que no se limpia

### Revisar OpenCode Integration

```bash
grep -r "opencode.*stream\|stream.*opencode" packages/server/src/
```

Verificar:
- Cómo se hace streaming desde OpenCode
- Cómo se maneja el cierre de stream
- Si hay timeout o keep-alive

## Logs a Revisar

### Cuando se Traba

```bash
# En el servidor, mientras está trabado
tail -f ~/.config/codenomad/logs/opencode-*.log

# Buscar:
# - ¿Sigue streaming?
# - ¿Último chunk enviado?
# - ¿Algún error?
```

### Cuando Presionas STOP

```bash
# Logs inmediatamente después de STOP
tail -100 ~/.config/codenomad/logs/opencode-*.log

# Buscar:
# - "cancel" o "abort"
# - Errores de cancelación
# - Estado del stream
```

### Cuando Envías "?"

```bash
# Logs después de enviar "?"
tail -100 ~/.config/codenomad/logs/opencode-*.log

# Buscar:
# - Nuevo request iniciado
# - Stream anterior cerrado
# - Respuesta continúa
```

## Teorías Específicas

### Teoría 1: OpenCode Stream No Se Cierra

**Problema:**
```typescript
// En servidor
const stream = opencode.query(message)

// Usuario presiona STOP
// Código intenta cancelar:
stream.cancel() // ← ESTO FALLA

// Error se propaga a UI
// Pero sesión sigue viva
```

**Por qué "?" funciona:**
- Nuevo mensaje crea nuevo stream
- Stream anterior queda huérfano
- Se limpia eventualmente
- Nuevo stream funciona

### Teoría 2: AbortController No Funciona

**Problema:**
```typescript
const controller = new AbortController()
fetch(opencode, { signal: controller.signal })

// Usuario presiona STOP
controller.abort() // ← Lanza error

// Error no se maneja bien
// Se muestra en UI
```

**Solución:**
```typescript
try {
  controller.abort()
} catch (error) {
  // Ignorar error de abort
  // Es esperado
}
```

### Teoría 3: UI No Limpia Estado de Error

**Problema:**
```typescript
// Presionar STOP causa error
setError("Failed to cancel")

// Error se muestra
// Pero nunca se limpia

// Próximo mensaje debería limpiar:
setError(null) // ← ESTO FALTA
sendMessage("?")
```

## Soluciones Propuestas

### Solución 1: Mejorar Manejo de Cancelación

```typescript
// En packages/server/src/workspaces/
async function cancelOpenCodeRequest(requestId: string) {
  try {
    await opencode.cancel(requestId)
  } catch (error) {
    // Cancelación puede fallar si ya terminó
    // No es error crítico, solo log
    logger.debug('Cancel request failed (may be already complete)', { requestId, error })
    // NO lanzar error a UI
  }
}
```

### Solución 2: Limpiar Errores al Enviar Nuevo Mensaje

```typescript
// En packages/ui/src/stores/session.ts
function sendMessage(content: string) {
  // Limpiar cualquier error previo
  clearSessionError()
  
  // Enviar mensaje
  api.send(content)
}
```

### Solución 3: Auto-Recuperación de Sesión Trabada

```typescript
// Detectar stream trabado
let lastChunkTime = Date.now()

onStreamChunk(() => {
  lastChunkTime = Date.now()
})

setInterval(() => {
  if (isStreaming && Date.now() - lastChunkTime > 30000) {
    // Trabado por 30s, auto-recuperar
    logger.warn('Stream stuck, auto-recovering')
    
    // Enviar señal interna para desbloquear
    // (equivalente a enviar "?")
    sendRecoverySignal()
  }
}, 10000)
```

### Solución 4: Botón de Recuperación en UI

En lugar de que usuario tenga que descubrir el workaround:

```jsx
{session.isStuck && (
  <div className="error-banner">
    <p>La respuesta parece trabada</p>
    <button onClick={recoverSession}>
      Continuar respuesta
    </button>
  </div>
)}
```

## Testing Plan

### Test 1: Capturar Error Exacto

1. Usa CodeNomad desde móvil
2. Pregunta algo que se trabe
3. Presiona STOP
4. **CAPTURA EL ERROR** (screenshot + texto)
5. Abre DevTools si puedes
6. Copia stack trace completo

### Test 2: Verificar Logs del Servidor

Mientras haces Test 1:

```bash
# En servidor
tail -f ~/.config/codenomad/logs/opencode-*.log | tee /tmp/stuck-session.log

# Dejar corriendo
# Revisar después de reproducir bug
```

### Test 3: Comparar Desktop vs Mobile

Mismo flujo desde desktop:
- ¿Se traba también?
- ¿Muestra mismo error?
- ¿"?" también funciona?

### Test 4: Probar Diferentes Mensajes

Cuando se traba, en lugar de "?", probar:
- "continua"
- "continue"
- Espacio " "
- "ok"
- Emoji "👍"

¿Todos funcionan igual? O solo algunos?

## Información Necesaria

**Para reportar este bug upstream, necesitamos:**

1. ✅ **Mensaje de error exacto** (cuando presionas STOP)
2. ✅ **Mensaje de error exacto** (cuando reenvías pregunta)
3. ✅ **Screenshot** de la UI mostrando el error
4. ✅ **Logs del servidor** durante el incidente
5. ✅ **Browser DevTools console** (si accesible en móvil)
6. ✅ **Network tab** - estado del EventSource
7. ✅ **Versión exacta** de CodeNomad y OpenCode

## Severidad

**Media-Alta**

- No pierde datos ✅
- Tiene workaround ✅
- Pero afecta UX significativamente ❌
- Requiere conocer el workaround ❌
- Usuarios nuevos se frustran ❌

## Relación con Wake-Lock

**Probablemente NO relacionado**

- Este bug es de sesión/streaming
- Wake-lock es de power management
- Ocurren en diferentes capas
- Timing puede coincidir pero son independientes

## Próximos Pasos Inmediatos

1. **TÚ:** Próxima vez que pase:
   - Captura screenshot del error
   - Anota texto exacto
   - Si puedes, abre DevTools y copia console

2. **YO:** Con esa info:
   - Buscar en código dónde se genera el error
   - Revisar manejo de cancelación
   - Proponer fix específico
   - Crear PR o issue detallado

3. **JUNTOS:** 
   - Testear fix
   - Verificar que resuelve el problema
   - Reportar a upstream

---

**Reporter:** @JDis03  
**Date:** May 14, 2026  
**Workaround:** Stop + enviar cualquier mensaje (ej: "?")  
**Continúa desde donde quedó:** ✅ SÍ  
**Muestra errores:** ✅ SIEMPRE (STOP y reenvío)  
**Status:** Necesitamos ver los errores exactos  
**Priority:** Media-Alta (afecta UX pero tiene workaround)
