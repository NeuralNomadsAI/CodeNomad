# 🚀 Quick Start - CodeNomad Contribution

**Última actualización:** Mayo 14, 2026  
**Estado:** Esperando captura del bug en acción

---

## Tu Setup Actual

```bash
# CodeNomad corriendo en PM2
pm2 list
# → codenomad (ID: 0) online, uptime: 53m+

# IMPORTANTE: Estás corriendo el OFFICIAL NPM package
# → npx @neuralnomads/codenomad-dev
# NO tu fork local (/home/dark/Project/codenomad)

# Para aplicar fixes, necesitás switch a tu fork
# Ver: RUN-FORK-WITH-PM2.md

# Ver logs en tiempo real
pm2 logs codenomad

# Servidor
# → https://192.168.50.45:9898 (password: 3467)

# OpenCode
# → http://localhost:4096

# Tu fork (código local)
# → /home/dark/Project/codenomad
```

---

## 🎯 Estado del Proyecto

### ✅ Completado (90% del trabajo)

**Wake-Lock Investigation (Tasks 055-056):**
- Código verificado: implementación correcta en Electron/Tauri/Web
- Runtime testing: wake-lock activa correctamente (`qdbus6` confirmado)
- Bug crítico descubierto: screen lock causa crash en KDE Wayland + Electron
- Issue #441 creado con 4 soluciones propuestas
- Documentación completa: 5,901+ líneas en 19 archivos

**Session Stuck Bug:**
- Investigación completa: NO es móvil, NO es red, ES estado de sesión
- Root cause: OpenCode request sin timeout ni cancelación adecuada
- 5 soluciones propuestas (timeout, watchdog, retry, etc)
- Plan detallado en `MOBILE-FIX-PLAN.md`

**Setup:**
- PM2 configuration documentada
- Fork configurado (JDis03/CodeNomad)
- Skill creado para continuidad (`~/.agents/skills/codenomad-contrib/`)

### ⏳ Pendiente (10%)

**Captura del Bug:**
- Screenshots cuando ocurra el stuck (desktop preferible)
- Logs del momento exacto: `pm2 logs codenomad --lines 100 > /tmp/stuck-$(date +%s).log`
- DevTools Network/Console (si es desktop)

**Una vez con datos:**
- Implementar fix (30-60 min)
- Testing (15 min)
- Deploy via PM2 (5 min)
- PR upstream (15 min)

---

## 📋 Próximos Pasos

### Opción A: Bug Ocurre Pronto (Lo Más Probable)

**Cuando se trabe CodeNomad:**

1. **Captura Inmediata** (2 min):
   ```bash
   # En terminal
   pm2 logs codenomad --lines 100 > /tmp/stuck-$(date +%s).log
   tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-$(date +%s).log
   ```

2. **Screenshots** (1 min):
   - Interfaz stuck con spinner
   - DevTools Network tab (si desktop)
   - DevTools Console con errores (si desktop)
   - Resultado de presionar STOP
   - Resultado de re-enviar mensaje

3. **Notifícame**:
   - "Hey, se trabó, aquí están los logs y screenshots"
   - Mándame el archivo `/tmp/stuck-*.log`

4. **Yo implemento fix** (1-2 horas):
   - Analizo logs
   - Implemento timeout + watchdog
   - Testeo localmente
   - Te paso el código

5. **Tú aplicas** (5 min):
   ```bash
   cd /home/dark/Project/codenomad
   # (copias mis cambios o haces git pull de mi branch)
   npm run build
   pm2 restart codenomad
   pm2 logs codenomad  # verificar que corre
   ```

6. **Testing** (15 min):
   - Usas CodeNomad normalmente
   - Esperamos a que pase de nuevo
   - Si se autorecupera: SUCCESS
   - Si no, iteramos

7. **Contribución upstream** (15 min):
   - PR con el fix
   - Issue #441 updated
   - Docs finales

**Total: ~3 horas desde que mandes logs hasta PR merged**

---

### Opción B: Bug No Ocurre (Poco Probable)

Si no se traba en los próximos días:

1. **Completar Task 057** (wake-lock implementation):
   - Implementar una de las 4 soluciones del Issue #441
   - Probablemente: "Disable wake-lock on Wayland+Electron"
   - Testing en X11 vs Wayland
   - PR upstream

2. **Implementar timeout preventivo** (aunque no hayamos visto el bug):
   - Timeout de 2 min en OpenCode requests
   - Watchdog de 45s
   - Auto-recovery
   - Mejor que esperar al bug

**Recomendación:** Opción B es segura pero menos eficiente. Mejor esperar 2-3 días a capturar el bug real.

---

### Opción C: Trabajar en Paralelo (Óptimo)

**Mientras esperamos el bug:**

1. **Switch a fork local** (ver `RUN-FORK-WITH-PM2.md`):
   ```bash
   pm2 delete codenomad
   cd /home/dark/Project/codenomad
   npm run build
   pm2 start npm --name codenomad-fork -- run start -- \
     --host 0.0.0.0 --https-port 9898 --password 3467 --launch
   pm2 save
   ```

2. **Implementar timeout preventivo**:
   ```typescript
   // packages/server/src/workspaces/opencode-workspace.ts
   // Agregar timeout de 2 min a executeRequest()
   // Ver MOBILE-FIX-PLAN.md líneas 234-289
   ```

3. **Testing básico**:
   - Deploy via PM2: `npm run build && pm2 restart codenomad-fork`
   - Verificar que no rompe nada
   - Timeout funciona correctamente

4. **Cuando bug ocurra:**
   - Ya tenemos timeout implementado
   - Ver si lo previene o necesita ajustes
   - Logs nos dirán si timeout se activó

5. **Beneficio doble:**
   - Fix preventivo deployed en tu fork
   - Datos del bug para optimizar
   - PR upstream cuando esté probado

**Recomendación:** Esta es la mejor opción. Implementamos timeout ahora en fork, luego refinamos con datos reales.

---

## 🛠️ Implementación Rápida (Si eliges Opción C)

### Paso 0: Switch a Fork (5 min) - **NUEVO**

```bash
# Detener official package
pm2 delete codenomad

# Iniciar tu fork
cd /home/dark/Project/codenomad
npm install  # si no lo hiciste
npm run build
pm2 start npm --name codenomad-fork -- run start -- \
  --host 0.0.0.0 --https-port 9898 --password 3467 --launch
pm2 save

# Verificar
pm2 logs codenomad-fork --lines 20
```

Ver detalles en: `RUN-FORK-WITH-PM2.md`

### Paso 1: Implementar Timeout (30 min)

Abrir CodeNomad y decir:

```
Implementa timeout de 2 minutos en OpenCode requests según
MOBILE-FIX-PLAN.md líneas 234-289. Usa RequestController + 
watchdog timer. Testea con timeout simulado.
```

### Paso 2: Build & Deploy (5 min)

```bash
cd /home/dark/Project/codenomad
npm run build
pm2 restart codenomad-fork
pm2 logs codenomad-fork --lines 20
```

### Paso 3: Testing Manual (15 min)

1. Abre CodeNomad en browser
2. Haz request grande (ej: "explica todo el codebase")
3. Si tarda >2 min, debería timeout
4. Si se traba, presiona STOP
5. Verifica logs: `pm2 logs codenomad-fork`

### Paso 4: Monitoring (ongoing)

```bash
# Logs en tiempo real
pm2 logs codenomad-fork --lines 0

# Uso normal de CodeNomad
# Observar si mejora o necesita ajustes
```

### Paso 5: PR Upstream (cuando esté probado)

```bash
cd /home/dark/Project/codenomad
git checkout -b fix/session-timeout
git add .
git commit -m "fix: add timeout to OpenCode requests"
git push origin fix/session-timeout
gh pr create --base dev --title "fix: add timeout to OpenCode requests"
```

---

## 📚 Documentos de Referencia

**Para implementar fix:**
- `MOBILE-FIX-PLAN.md` → Plan detallado con código
- `BUG-REPORT-SESSION-STUCK-ALL-PLATFORMS.md` → Análisis técnico
- `TODO-MOBILE-FIX.md` → Checklist simple

**Para PM2:**
- `PM2-MANAGEMENT.md` → Todas las operaciones PM2

**Para wake-lock (Task 057):**
- `wake-lock-verification-report.md` → Análisis completo
- `BUG-REPORT-SCREEN-LOCK-CRASH.md` → Issue #441
- `TESTING-WAKE-LOCK.md` → Test procedures

**Resumen ejecutivo:**
- `FINAL-SESSION-SUMMARY.md` → Todo lo hecho
- `codenomad-contrib` skill → Continuidad entre sesiones

---

## 💡 Recomendación Final

**Path sugerido:**

1. **HOY (30 min):** Implementar timeout preventivo (Opción C)
   ```bash
   # Abrir CodeNomad
   # Decir: "implementa timeout según MOBILE-FIX-PLAN.md líneas 234-289"
   # Build, deploy, test básico
   ```

2. **PRÓXIMOS DÍAS (cuando ocurra):** Capturar logs del bug
   - Si timeout lo previno: SUCCESS
   - Si no: tenemos datos para refinar

3. **DESPUÉS:** Wake-lock Task 057
   - Implementar solución para screen lock crash
   - Testing X11 vs Wayland
   - PR final

**Razón:** Fix preventivo es bajo riesgo, alto valor. 30 min de trabajo pueden resolver el 80% del problema. Los logs del bug real nos darán el 20% restante para perfeccionar.

---

## 🎯 Decisión Rápida

**Elige una:**

- **A)** Esperar a que bug ocurra → mándame logs → yo implemento
- **B)** Trabajar en wake-lock Task 057 mientras esperamos
- **C)** Implementar timeout preventivo YA → refinar con datos después

**Mi recomendación: C** (30 min de trabajo, máximo impacto)

---

## 📞 Cómo Continuar

**Si quieres implementar timeout ahora:**

Di: "Implementa el timeout preventivo" y sigo con el código.

**Si prefieres esperar:**

Di: "Esperaré a que ocurra el bug" y te mando el checklist simple.

**Si quieres trabajar en wake-lock:**

Di: "Trabajemos en Task 057" y continuamos con el screen lock fix.

**Si tienes otra prioridad:**

Dime y ajustamos el plan.

---

**Estado:** Listo para continuar. Esperando tu decisión. 🚀
