# 🔴 CRITICAL: Session Gets Stuck on ALL Platforms (Web Desktop + Mobile)

## ACTUALIZACIÓN CRÍTICA

**Este NO es un bug de móvil - es un bug GENERAL del sistema.**

Ocurre en:
- ✅ Web móvil (via VPN)
- ✅ Web desktop (PC)
- ❌ Probablemente también Electron app (por confirmar)

---

## Descripción

Al usar CodeNomad **web** (tanto desktop como móvil), las sesiones se traban regularmente:

### Síntomas
1. IA empieza a responder normalmente
2. Después de un tiempo, **se queda "pensando"**
3. No continúa la respuesta
4. UI muestra estado de "working" o loading

### Workaround Actual
1. Presionar botón **STOP** (rojo)
   - → Muestra **ERROR**
2. Intentar **reenviar pregunta**
   - → Muestra **ERROR**
3. Enviar **cualquier mensaje nuevo** (ej: "?")
   - → **Continúa desde donde quedó** ✓

### Características Clave
- ✅ **Contexto se preserva** (continúa, no reinicia)
- ❌ **Errores al presionar STOP** (siempre)
- ❌ **Errores al reenviar** (siempre)
- ✅ **Funciona después de mensaje nuevo**
- 🔴 **Ocurre en desktop Y móvil** (mismo comportamiento)

---

## Entornos Afectados

### Setup Actual Confirmado

**Servidor:**
```bash
npx @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password XXXX \
  --launch
```

**Clientes afectados:**
- ✅ **Desktop web** (browser en PC, via VPN)
- ✅ **Mobile web** (browser en móvil, via VPN)
- ⚠️ **Electron app** - por confirmar si también afecta

**OpenCode:**
- Puerto: 4096
- Logs: Debug level

---

## Severidad Actualizada

**CRÍTICO** 🔴

Razones:
- Afecta **TODOS** los usuarios web (no solo móvil)
- Es **frecuente** (no ocasional)
- Degrada **severamente** la experiencia
- Requiere workaround manual cada vez
- Los errores confunden a usuarios

**Impacto:**
- Desktop users: Afectados
- Mobile users: Afectados  
- Electron users: Posiblemente afectados
- **Estimado: 50-100% de sesiones largas**

---

## Análisis Revisado

### Lo que NO es (descartado)

❌ **NO es problema de móvil**
- Pasa igual en desktop

❌ **NO es problema de VPN**
- VPN afecta desktop y móvil igual
- Comportamiento idéntico en ambos

❌ **NO es problema de red/latencia**
- Si fuera network, no continuaría desde donde quedó
- Mensaje nuevo no desbloquearía

❌ **NO es problema de browser específico**
- Ocurre en múltiples browsers

### Lo que SÍ es (muy probable)

✅ **ES problema de session state management**

Evidencia:
1. Stop + nuevo mensaje = continúa (estado se resetea)
2. Contexto preservado (sesión sigue viva)
3. Errores al cancelar (cancelación falla)
4. Mismo comportamiento en todas las plataformas

✅ **ES problema de streaming/SSE**

Evidencia:
1. Ocurre durante respuestas largas
2. Se "traba" en medio del stream
3. Nueva request desbloquea
4. Heartbeat puede no ser suficiente

✅ **ES problema de request lifecycle**

Evidencia:
1. STOP causa error (cancelación falla)
2. Reenvío causa error (request anterior no cerró)
3. Nuevo mensaje funciona (crea nueva request)

---

## Hipótesis Refinada

### Causa Más Probable: Request No Se Cierra Correctamente

**El flujo problemático:**

```
1. Usuario hace pregunta
   → OpenCode empieza a streamear respuesta
   → SSE envía chunks al cliente
   
2. En algún punto, el stream se TRABA
   → Puede ser:
     - OpenCode deja de enviar chunks
     - SSE buffer se llena
     - Evento "done" nunca llega
   
3. CodeNomad espera indefinidamente
   → UI muestra "working"
   → Usuario ve "pensando..."
   → No hay timeout
   
4. Usuario presiona STOP
   → CodeNomad intenta cancelar request OpenCode
   → Cancelación FALLA (request en estado incorrecto)
   → Error se muestra en UI
   
5. Usuario intenta reenviar
   → Request anterior todavía "viva"
   → Nuevo request entra en conflicto
   → Error se muestra
   
6. Usuario envía mensaje diferente
   → Crea NUEVA request (diferente ID)
   → Request anterior se abandona
   → Nueva request funciona
   → OpenCode tiene el contexto, continúa
```

---

## Diagnóstico Inmediato

### Paso 1: Reproducir en Desktop

```bash
# En tu PC, accede a CodeNomad
firefox https://192.168.50.45:9898

# Haz una pregunta larga
# Espera a que se trabe
# Confirma mismo comportamiento
```

### Paso 2: Revisar Logs Mientras Está Trabado

```bash
# Terminal 1: Ver logs en tiempo real
tail -f ~/.config/codenomad/logs/opencode-*.log

# Terminal 2: Monitorear conexiones
watch -n 1 'lsof -i -P -n | grep -E "4096|9898"'

# Mientras está trabado, observar:
# - ¿Sigue apareciendo actividad en logs?
# - ¿OpenCode sigue enviando datos?
# - ¿Conexión SSE sigue abierta?
```

### Paso 3: Capturar Estado Completo

Cuando se trabe la próxima vez:

```bash
# Timestamp
date

# Logs recientes
tail -100 ~/.config/codenomad/logs/opencode-*.log > /tmp/stuck-$(date +%s).log

# Estado de procesos
ps aux | grep -E "opencode|codenomad" > /tmp/processes-$(date +%s).log

# Conexiones activas
lsof -i -P -n | grep -E "4096|9898" > /tmp/connections-$(date +%s).log

# Estado de OpenCode (si tiene status endpoint)
curl http://localhost:4096/status 2>/dev/null > /tmp/opencode-status-$(date +%s).log
```

---

## Investigación de Código

### Archivos Críticos a Revisar

**SSE Streaming:**
```bash
cd /home/dark/Project/codenomad

# SSE implementation
cat packages/server/src/server/routes/events.ts

# OpenCode integration
find packages/server/src -name "*.ts" | xargs grep -l "opencode.*stream"

# Request lifecycle
find packages/server/src/workspaces -name "*.ts" | xargs grep -l "cancel\|abort"
```

### Buscar Timeouts

```bash
# Buscar configuración de timeouts
grep -r "timeout" packages/server/src/ | grep -E "request|stream|sse"

# Buscar configuración de OpenCode
grep -r "opencode.*timeout\|timeout.*opencode" packages/server/src/
```

### Revisar Manejo de "Done"

```bash
# Buscar evento de completado
grep -r "done\|complete\|finish" packages/server/src/workspaces/
```

---

## Soluciones Propuestas (Actualizadas)

### Solución 1: Agregar Timeout a Requests (CRÍTICO)

**Problema:** No hay timeout, requests se quedan colgadas indefinidamente

**Fix:**
```typescript
// packages/server/src/workspaces/instance.ts o similar

const REQUEST_TIMEOUT = 120000 // 2 minutos

async function streamOpenCodeResponse(message: string) {
  const controller = new AbortController()
  
  // Timeout que cancela request
  const timeout = setTimeout(() => {
    logger.warn('Request timeout, aborting')
    controller.abort()
  }, REQUEST_TIMEOUT)
  
  try {
    const stream = await opencode.query(message, {
      signal: controller.signal
    })
    
    for await (const chunk of stream) {
      // Reset timeout on cada chunk
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
      
      yield chunk
    }
  } finally {
    clearTimeout(timeout)
  }
}
```

### Solución 2: Auto-Recovery en Cliente

**Problema:** Cliente no detecta que stream murió

**Fix:**
```typescript
// packages/ui/src/stores/session-state.ts

let lastChunkTime = Date.now()
const STUCK_THRESHOLD = 45000 // 45 segundos sin chunks

onStreamChunk(() => {
  lastChunkTime = Date.now()
})

setInterval(() => {
  if (session.status === 'working') {
    const elapsed = Date.now() - lastChunkTime
    
    if (elapsed > STUCK_THRESHOLD) {
      logger.warn('Stream appears stuck, auto-recovering')
      
      // Enviar señal de recovery
      sendRecoveryPing()
      
      // O marcar como error para que usuario sepa
      setSessionWarning('Response may be incomplete, click Continue if needed')
    }
  }
}, 10000) // Check cada 10s
```

### Solución 3: Mejorar Cancelación

**Problema:** Cancelar request tira error

**Fix:**
```typescript
// packages/server/src/workspaces/instance.ts

async function cancelRequest(requestId: string) {
  try {
    await opencode.cancel(requestId)
    logger.info('Request cancelled', { requestId })
  } catch (error) {
    // Cancelación puede fallar legítimamente
    if (error.message.includes('already completed')) {
      logger.debug('Cancel ignored, request already done')
      return // No error
    }
    
    // Solo loggear, no lanzar a UI
    logger.warn('Cancel failed', { requestId, error: error.message })
    // No throw
  }
}
```

### Solución 4: Heartbeat Mejorado

**Problema:** Heartbeat cada 15s puede no ser suficiente

**Fix:**
```typescript
// packages/server/src/server/routes/events.ts

// Cambiar de 15000 a 5000 o menos
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 5000) // Ping cada 5s
```

### Solución 5: Forzar "Done" Event

**Problema:** Stream nunca envía evento final

**Fix:**
```typescript
// packages/server/src/workspaces/instance.ts

try {
  await streamResponse()
} finally {
  // SIEMPRE enviar done, pase lo que pase
  sendEvent({
    type: 'response.done',
    sessionId,
    timestamp: Date.now()
  })
  
  logger.info('Response completed', { sessionId })
}
```

---

## Plan de Acción Urgente

### Fase 1: Confirmar Diagnóstico (15 min)

1. **Reproducir en desktop:**
   - Accede desde PC
   - Haz pregunta larga
   - Confirma que se traba igual

2. **Capturar logs:**
   - Deja logs corriendo
   - Cuando se trabe, guarda todo
   - Revisa qué muestra

### Fase 2: Quick Fix (30 min)

**Mientras investigamos causa raíz:**

```typescript
// Quick patch: Auto-recovery después de 45s

setInterval(() => {
  if (isStuck()) {
    autoRecover()
  }
}, 10000)
```

### Fase 3: Fix Permanente (2-4 horas)

Basado en logs, implementar:
1. Timeout en requests
2. Mejor manejo de cancelación
3. Forzar evento "done"
4. Heartbeat más frecuente

### Fase 4: Testing (1 hora)

1. Testear en desktop
2. Testear en móvil
3. Verificar que funciona en ambos
4. Confirmar errores eliminados

---

## Testing Protocol

### Test 1: Desktop Web

```bash
# En PC
firefox https://192.168.50.45:9898

# Hacer 5 preguntas largas
# Documentar cuántas se traban
# Documentar comportamiento
```

### Test 2: Mobile Web

```bash
# En móvil
# Hacer 5 preguntas largas
# Documentar comportamiento
# Comparar con desktop
```

### Test 3: Logs Analysis

```bash
# Mientras haces tests
tail -f ~/.config/codenomad/logs/opencode-*.log | tee /tmp/full-test.log

# Revisar después
grep -i "error\|timeout\|stuck\|fail" /tmp/full-test.log
```

---

## Información Necesaria URGENTE

### Crítico para Fix

1. **Logs cuando está trabado**
   ```bash
   # Mientras está trabado, ejecuta:
   tail -50 ~/.config/codenomad/logs/opencode-*.log
   ```

2. **Confirmar en desktop**
   - ¿Se traba también en PC?
   - ¿Mismo comportamiento exacto?

3. **Screenshots de errores**
   - Error al presionar STOP
   - Error al reenviar
   - Desde desktop (más fácil capturar)

### Para Análisis Profundo

4. **Browser DevTools (Desktop)**
   ```
   F12 → Console
   F12 → Network → EventSource
   
   Cuando se trabe:
   - Screenshot de Console (errores en rojo)
   - Screenshot de Network (estado de SSE)
   ```

5. **Frecuencia**
   - ¿Cada cuánto pasa?
   - ¿Siempre? ¿A veces?
   - ¿Después de cuánto tiempo de respuesta?

---

## Prioridad Actualizada

**CRÍTICA** 🔴🔴🔴

Razones:
- Afecta TODOS los usuarios web
- Es frecuente (no raro)
- Degrada experiencia severamente  
- Bloquea uso productivo
- Más grave que bug de wake-lock

**Debe ser prioridad #1 para CodeNomad.**

---

## Reportar a Upstream

Una vez confirmemos diagnóstico:

**Issue Title:**
"🔴 CRITICAL: Sessions get stuck during long responses (all web platforms)"

**Labels:**
- bug
- critical
- web
- session
- streaming

**Body:**
- Reproducible en desktop y móvil
- Workaround: STOP + nuevo mensaje
- Contexto preservado
- Errores de cancelación
- Afecta experiencia de usuarios

---

## Próximos Pasos Inmediatos

1. **TÚ:** 
   - Confirma que pasa en desktop
   - Captura logs cuando se trabe
   - Screenshot de errores (desde desktop, más fácil)

2. **YO:**
   - Reviso logs
   - Implemento timeout + auto-recovery
   - Rebuild y restart
   - Te pido testing

3. **JUNTOS:**
   - Verificamos fix funciona
   - Reportamos a upstream
   - Contribuimos el fix via PR

---

**Este es el bug más importante a resolver ahora.** 🚨

Gracias por aclarar que pasa también en desktop - eso nos da mucha más información sobre la causa raíz.

---

**Status:** Diagnosis updated - Platform-agnostic bug  
**Priority:** CRITICAL  
**Next:** Capture logs + error messages from desktop
