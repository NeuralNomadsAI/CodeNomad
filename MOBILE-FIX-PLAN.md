# Plan para Solucionar el Bug de Móvil

**Objetivo:** Resolver el problema de sesiones trabadas en móvil  
**Prioridad:** Alta (afecta tu uso principal)  
**Fecha:** Mayo 14, 2026

---

## 🎯 Objetivo Claro

**Eliminar la necesidad de hacer STOP + "?" para continuar respuestas.**

La IA debe:
- ✅ Continuar respondiendo sin trabarse
- ✅ Mostrar errores solo cuando realmente hay problema
- ✅ Auto-recuperarse si se traba
- ✅ No perder contexto

---

## 📋 Plan de Acción

### Fase 1: Capturar Evidencia (TÚ - 10 minutos)

**Próxima vez que uses CodeNomad desde el móvil:**

1. **Antes de empezar:**
   ```
   - Abre CodeNomad en móvil
   - Haz pregunta que se vaya a trabar
   - Ten lista la cámara para screenshot
   ```

2. **Cuando se trabe:**
   ```
   - NO presiones STOP todavía
   - Toma screenshot de la pantalla
   - Anota la hora exacta
   ```

3. **Presiona STOP:**
   ```
   - Toma screenshot del ERROR que aparece
   - Lee el mensaje completo
   - Si puedes, copia el texto
   ```

4. **Intenta reenviar pregunta:**
   ```
   - Toma screenshot del ERROR
   - Compara si es el mismo error
   ```

5. **Envía "?" para recuperar:**
   ```
   - Confirma que continúa
   - Toma screenshot de la respuesta continuando
   ```

6. **Mándame:**
   - Screenshots
   - Hora exacta del incidente
   - Texto de los errores (si pudiste copiar)

### Fase 2: Revisar Logs del Servidor (YO - 15 minutos)

Con la hora exacta que me des:

```bash
# Revisar logs en ese momento
grep "2026-05-14 HH:MM" ~/.config/codenomad/logs/opencode-*.log

# Buscar errores
grep -i "error\|fail\|timeout" ~/.config/codenomad/logs/opencode-*.log | tail -50

# Ver logs del servidor CodeNomad
journalctl --user -S "2026-05-14 HH:MM" | grep -i "codenomad\|error"
```

### Fase 3: Investigar Código (YO - 30 minutos)

Basado en los errores, buscaré:

1. **Dónde se genera el error**
   ```bash
   cd /home/dark/Project/codenomad
   grep -r "TEXTO_DEL_ERROR" packages/
   ```

2. **Cómo se maneja la cancelación**
   ```bash
   grep -r "abort\|cancel.*request" packages/server/src/
   grep -r "abort\|cancel.*request" packages/ui/src/
   ```

3. **Estado de la sesión**
   ```bash
   grep -r "session.*status\|status.*working" packages/ui/src/stores/
   ```

### Fase 4: Implementar Fix (YO - 1-2 horas)

Basado en lo encontrado, implementaré una de estas soluciones:

#### Solución A: Auto-Recovery (Más probable)

**Si el problema es:** Stream se traba pero sesión está viva

```typescript
// packages/ui/src/stores/session-state.ts o similar

// Detector de stream trabado
let lastMessageTime = Date.now()

createEffect(() => {
  // Cada vez que llega un mensaje
  if (session.status === 'working') {
    lastMessageTime = Date.now()
  }
})

// Watchdog que revisa cada 10 segundos
setInterval(() => {
  if (session.status === 'working') {
    const stuckTime = Date.now() - lastMessageTime
    
    if (stuckTime > 30000) {
      // Trabado por 30 segundos, auto-recuperar
      console.warn('[AUTO-RECOVERY] Session stuck, recovering...')
      
      // Enviar señal de recuperación (equivalente a enviar "?")
      recoverStuckSession()
    }
  }
}, 10000)

function recoverStuckSession() {
  // Limpia estado de error
  clearSessionErrors()
  
  // Envía señal mínima para desbloquear
  // (internamente, no visible para usuario)
  sendRecoveryPing()
}
```

#### Solución B: Fix de Cancelación (Si error es de abort)

**Si el problema es:** Abort/Cancel tira error

```typescript
// packages/server/src/workspaces/instance.ts o similar

async function cancelRequest(requestId: string) {
  try {
    await opencode.cancel(requestId)
    logger.debug('Request cancelled successfully', { requestId })
  } catch (error) {
    // Cancelación puede fallar si request ya terminó
    // Esto es NORMAL, no es error crítico
    logger.debug('Cancel failed (request may have completed)', { 
      requestId, 
      error: error.message 
    })
    
    // NO lanzar error a UI
    // return silently
  }
}
```

#### Solución C: Mejorar Manejo de Errores en UI

**Si el problema es:** Errores se muestran cuando no deberían

```typescript
// packages/ui/src/stores/session-state.ts

function setSessionError(error: Error) {
  // Filtrar errores que no son realmente problemas
  const ignorableErrors = [
    'AbortError',
    'Request cancelled',
    'Stream closed'
  ]
  
  if (ignorableErrors.some(msg => error.message.includes(msg))) {
    // No mostrar estos errores al usuario
    logger.debug('Ignorable error:', error.message)
    return
  }
  
  // Solo mostrar errores reales
  sessionErrors.set(error)
}
```

#### Solución D: Botón de Recuperación (UX improvement)

**Mientras investigamos causa raíz:**

```tsx
// packages/ui/src/components/SessionView.tsx

{session.status === 'working' && isStuck && (
  <div class="stuck-banner">
    <p>La respuesta parece detenida</p>
    <button onClick={handleRecover} class="recover-btn">
      Continuar
    </button>
  </div>
)}

function handleRecover() {
  // Limpia errores
  clearErrors()
  
  // Envía señal de recuperación
  // (equivalente a lo que hace "?")
  recoverSession()
}
```

### Fase 5: Testing (TÚ + YO - 30 minutos)

1. **Build del fix:**
   ```bash
   cd /home/dark/Project/codenomad
   npm run build
   
   # O si es solo UI
   npm run build:ui
   ```

2. **Restart CodeNomad:**
   ```bash
   # Detener el actual
   pkill -f codenomad-dev
   
   # Iniciar con el fix
   npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password 3467 --launch
   ```

3. **Testear desde móvil:**
   - Hacer pregunta que antes se trababa
   - Ver si sigue trabándose
   - Si se traba, ver si auto-recupera
   - Verificar que no hay errores molestos

4. **Documentar resultados:**
   - ¿Se sigue trabando?
   - ¿Auto-recuperó?
   - ¿Hay errores?
   - ¿Mejor que antes?

---

## 🔍 Información que Necesito

### Crítico (sin esto no puedo avanzar)

1. **Screenshot del error al presionar STOP**
   - Texto completo del mensaje
   - Color del error (rojo/amarillo)
   - Ubicación en pantalla

2. **Screenshot del error al reenviar**
   - ¿Es el mismo mensaje?
   - ¿Diferente?

3. **Hora exacta** cuando se traba
   - Formato: "14:23:45" (para buscar en logs)

### Muy Útil (ayuda mucho pero no bloqueante)

4. **Browser que usas en móvil**
   - Chrome? Firefox? Safari? Brave?
   - Versión si la sabes

5. **Cuánto tarda** en trabarse
   - ¿10 segundos? ¿30? ¿1 minuto?
   - ¿Siempre el mismo tiempo?

6. **Tipo de pregunta** que se traba
   - ¿Preguntas largas/complejas?
   - ¿Cualquier pregunta?
   - ¿Patrón específico?

### Bonus (nice to have)

7. **Console del browser** (si puedes acceder)
   - En móvil es difícil, pero si puedes:
   - Menú → More Tools → Developer Tools
   - Pestaña Console
   - Screenshot de errores en rojo

---

## 📱 Cómo Capturar Info en Móvil

### Método 1: Screenshots (Más fácil)

```
1. Cuando aparezca error
2. Presiona botones de screenshot de tu móvil
   - Android: Power + Volume Down
   - iOS: Power + Volume Up (o Home)
3. Guarda las imágenes
4. Mándamelas por donde sea más fácil
```

### Método 2: Copiar Texto (Si es posible)

```
1. Mantén presionado el mensaje de error
2. Selecciona "Copiar" si aparece
3. Pega en notas/mensaje
4. Mándame el texto
```

### Método 3: Video (Alternativa)

```
1. Graba pantalla del móvil mientras usas CodeNomad
2. Captura el momento cuando se traba
3. Captura los errores
4. Me mandas el video (puedo ver todo)
```

---

## ⚡ Quick Fixes Temporales

Mientras trabajo en el fix permanente, puedes usar:

### Opción 1: Acortar Timeouts (en servidor)

Modificar heartbeat para detectar trabados más rápido:

```bash
# Editar el código del servidor
nano /home/dark/Project/codenomad/packages/server/src/server/routes/events.ts

# Cambiar línea 50-53 de:
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 15000)

# A:
const heartbeat = setInterval(() => {
  const ping = { ts: Date.now() }
  reply.raw.write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
}, 5000)  // Ping cada 5s en lugar de 15s

# Guardar y rebuild
```

### Opción 2: Logging Extendido

Activar más logs para diagnosticar:

```bash
# Al iniciar CodeNomad
export LOG_LEVEL=trace
npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password 3467 --launch
```

### Opción 3: Usar Desktop Temporalmente

Para respuestas muy largas/importantes:
- Acceder desde desktop via VPN
- Más estable para esos casos
- Volver a móvil para uso normal

---

## 📊 Tabla de Soluciones por Causa

| Causa Probable | Solución | Dificultad | ETA |
|----------------|----------|------------|-----|
| Stream trabado | Auto-recovery watchdog | Media | 2 horas |
| Abort error | Ignorar error de cancel | Fácil | 30 min |
| Estado UI desync | Limpiar errores en send | Fácil | 30 min |
| OpenCode timeout | Timeout en requests | Media | 2 horas |
| VPN/Network | Heartbeat más frecuente | Fácil | 15 min |

---

## 🎯 Success Criteria

El fix será exitoso cuando:

1. ✅ Respuestas largas completan sin trabarse
2. ✅ Si se traba, auto-recupera sin intervención
3. ✅ No hay errores molestos (solo errores reales)
4. ✅ No necesitas hacer STOP + "?"
5. ✅ Contexto siempre se preserva

---

## 📝 Tracking del Progreso

### Status Actual
- [ ] Capturar screenshots de errores
- [ ] Obtener hora exacta de incidente
- [ ] Revisar logs del servidor
- [ ] Identificar causa raíz
- [ ] Implementar fix
- [ ] Testing del fix
- [ ] Commit y push
- [ ] Reportar a upstream (opcional)

### Cuando Completes

Actualiza aquí:
```
[ ] DONE - Fecha: _____
[ ] Screenshots capturados: _____
[ ] Errores identificados: _____
[ ] Fix implementado: _____
[ ] Testing exitoso: _____
```

---

## 🚀 Siguiente Acción INMEDIATA

**Tu parte (cuando vuelvas a usar CodeNomad):**

1. Abre CodeNomad en móvil
2. Haz una pregunta
3. Cuando se trabe:
   - Screenshot de la pantalla
   - Anota hora: ____:____:____
4. Presiona STOP
   - Screenshot del error
5. Mándame las imágenes + hora

**Mi parte (cuando me mandes la info):**

1. Revisar logs en esa hora
2. Buscar causa en código
3. Implementar fix
4. Rebuild y restart
5. Pedirte que testees

---

## 💬 Comunicación

**Mándame por cualquier medio:**
- Screenshots
- Hora del incidente
- Cualquier observación adicional

**Te responderé con:**
- Análisis de los logs
- Causa identificada
- Fix propuesto
- Instrucciones para testear

---

## 📚 Referencias

- `BUG-REPORT-MOBILE-SESSION-ERRORS.md` - Análisis detallado
- `MOBILE-WEB-TROUBLESHOOTING.md` - Guía completa
- `packages/server/src/server/routes/events.ts` - SSE implementation
- `packages/ui/src/stores/` - Session state management

---

**¡Estoy listo para resolver esto en cuanto tengas los screenshots!** 🚀

El bug tiene solución, solo necesitamos ver los errores exactos para saber qué path seguir.
