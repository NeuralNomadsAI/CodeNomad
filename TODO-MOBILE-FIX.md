# 🔴 TODO: Resolver Bug de Session Stuck (Todas las Plataformas)

**Creado:** Mayo 14, 2026  
**Actualizado:** Mayo 14, 2026 (bug confirmado en desktop también)  
**Prioridad:** CRÍTICA  
**Tiempo estimado:** 2-4 horas total  
**Setup:** PM2 (`pm2 list` para ver estado)

---

## ✅ Tu Parte (10 minutos)

**Próxima vez que uses CodeNomad (desktop o móvil):**

### Paso 1: Preparación
- [ ] Abre CodeNomad (desktop preferible para DevTools)
- [ ] Ten lista la cámara/screenshot tool
- [ ] Abre terminal con: `pm2 logs codenomad --lines 0`

### Paso 2: Cuando se TRABE
- [ ] **Screenshot** de la pantalla
- [ ] **Anota la HORA exacta**: ____:____:____

### Paso 3: Presiona STOP
- [ ] **Screenshot del ERROR**
- [ ] Lee el mensaje completo

### Paso 4: Intenta Reenviar
- [ ] **Screenshot del ERROR**

### Paso 5: Envía "?"
- [ ] Confirma que continúa
- [ ] **Screenshot** (opcional)

### Paso 6: Captura Logs
```bash
# Guarda los logs del momento
pm2 logs codenomad --lines 100 > /tmp/stuck-$(date +%s).log
tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-$(date +%s).log
```

### Paso 7: Mándame
- [ ] Screenshots (2-4 imágenes)
- [ ] Archivo de logs: `/tmp/stuck-*.log`
- [ ] Hora exacta
- [ ] Browser (Chrome/Firefox/etc)
- [ ] Desktop o móvil?

---

## 🔧 Mi Parte (2-3 horas)

Cuando me mandes la info:

### Paso 1: Análisis (15 min)
- [ ] Revisar logs del servidor en esa hora
- [ ] Identificar causa del error
- [ ] Buscar dónde se genera en el código

### Paso 2: Implementación (1-2 horas)
- [ ] Escribir el fix
- [ ] Testear localmente
- [ ] Commit el cambio

### Paso 3: Deploy (15 min)
```bash
# Si fix es en fork local
cd /home/dark/Project/codenomad
npm run build
pm2 restart codenomad

# O si fix es upstream
pm2 restart codenomad  # Auto-update de NPM
```
- [ ] Rebuild/restart CodeNomad
- [ ] Verificar con: `pm2 logs codenomad`

### Paso 4: Testing (30 min)
- [ ] Pedirte que testees desde móvil
- [ ] Confirmar que funciona
- [ ] Ajustar si es necesario

---

## 📋 Checklist Rápido

**Cuando tengas los screenshots, verifica que tengan:**

- ✅ Mensaje de error COMPLETO
- ✅ Hora exacta del incidente
- ✅ Son legibles (no borrosos)
- ✅ Muestran el contexto (qué estabas haciendo)

---

## 🎯 Resultado Esperado

**Después del fix:**
- ✅ No más trabadas (o auto-recupera)
- ✅ No más errores molestos
- ✅ Respuestas fluyen continuas
- ✅ Contexto siempre preservado

---

## 📞 Cómo Enviarme la Info

Por donde sea más fácil:
- WhatsApp/Telegram
- Email
- Compartir drive/dropbox
- Pegar en chat

**Solo necesito ver las imágenes y saber la hora.**

---

## ⚡ QUICK START

**Lee solo esto si tienes prisa:**

1. Úsalo normalmente
2. Cuando se trabe → Screenshot + hora
3. STOP → Screenshot del error
4. Mándamelo
5. Yo lo arreglo

**Eso es todo.** 🎯

---

**Archivo de referencia completo:** `MOBILE-FIX-PLAN.md`
