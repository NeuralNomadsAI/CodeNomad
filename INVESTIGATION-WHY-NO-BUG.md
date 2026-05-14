# 🔍 Investigación: ¿Por Qué el Fork No Falla?

**Fecha:** Mayo 14, 2026  
**Contexto:** El bug de session stuck ocurría con NPX, pero NO ocurre con el fork local

---

## 🧪 Observación

### Antes (con NPX)
- Command: `npx @neuralnomads/codenomad-dev`
- Bug: Session stuck frecuente
- Síntoma: Se trababa "de una vez" (muy rápido/consistente)

### Ahora (con Fork)
- Command: `node packages/server/dist/bin.js` (build local)
- Bug: **NO ha ocurrido**
- Comportamiento: Responde normalmente, sin trabarse

---

## 🔬 Análisis Realizado

### 1. Versiones Comparadas

**NPX (oficial):**
```
@neuralnomads/codenomad-dev@0.15.0-dev-20260513-5570929f
Publicado: Mayo 13, 2026 05:21:38 UTC
```

**Fork Local:**
```
Version: 0.15.0
Commit: 5570929 (Improve messages layouts on narrow screens #438)
Branch: dev
```

**Conclusión:** Mismo commit base (`5570929`), mismo código fuente.

---

### 2. Diferencias de Código

**Búsqueda realizada:**
```bash
git diff upstream/dev HEAD -- packages/server/src packages/ui/src
```

**Resultado:** ✅ **NO HAY DIFERENCIAS DE CÓDIGO**

Tu fork solo tiene commits de documentación (13 commits desde upstream):
- Todos son `docs:` commits
- Ninguno modifica código de server o UI
- Solo agregaste: investigación wake-lock, bug reports, guías PM2

**Conclusión:** El código ejecutable es **idéntico**.

---

### 3. Build Process

**NPX:**
- Build hecho por upstream (GitHub Actions o CI)
- Pre-compilado y publicado en NPM
- Dependencias resueltas en publish time

**Fork Local:**
```bash
npm run build
# → Vite build (UI)
# → TypeScript compile (server)
# → Plugin packaging
# Tiempo: ~7 segundos
# Node version: 25.9.0
# Build date: Mayo 14, 2026
```

**Posible diferencia:**
- Node version diferente en CI vs tu máquina
- TypeScript version (tu `npm install` vs NPM package)
- Optimizaciones de build diferentes

---

### 4. Dependencias

**Búsqueda en OpenCode workspace:**
```bash
git log --since="2026-01-01" -p packages/server/src/workspaces/opencode-workspace.ts
```

**Resultado:** ✅ **NO HAY CAMBIOS RELACIONADOS CON TIMEOUT/CANCEL**

Ningún commit menciona:
- `timeout`
- `abort`
- `cancel`
- `controller`
- `stream`

En el archivo crítico `opencode-workspace.ts`.

**Conclusión:** No hay fix explícito de timeout en el código.

---

### 5. Commits Recientes Relevantes

**Upstream desde Abril 2026:**
- `#434` - Refactor workspace startup (UI, no server)
- `#433` - Package OpenCode plugin
- `#432` - Fix prompt attachment picker (UI)
- `#397` - Add clone repository flow
- `#366` - Respect configured OpenCode auth
- `#361` - Preserve workspace root
- `#346` - Don't depend on Node anymore ⚠️
- `#341` - Fix WSL UNC paths
- `#311` - Refactor Git Changes workflow

**Potencialmente relevante:**
- `#346` (Don't depend on Node anymore) - commit `67a10d1`
  - Podría haber cambiado cómo se ejecutan requests
  - Pero fue en Abril 21, antes de tu problema

**Conclusión:** Ningún fix obvio de streaming/timeout.

---

## 🤔 Teorías

### Teoría A: Build Diferente (MÁS PROBABLE)

**Hipótesis:**
- NPX package fue compilado con configuración diferente
- Tu build local usa Node 25.9.0 + deps actuales
- NPX usa Node/deps del CI cuando se publicó
- Diferencia sutil en manejo de streams

**Evidencia:**
- Código idéntico
- Comportamiento diferente
- Build es la única variable

**Probabilidad:** 60%

---

### Teoría B: Timing / Race Condition

**Hipótesis:**
- Bug es intermitente / race condition
- NPX lo triggerea más frecuente por alguna optimización
- Fork local lo triggerea menos por build menos optimizado
- Todavía puede pasar, solo que menos frecuente

**Evidencia:**
- "Se trababa de una vez" sugiere alta frecuencia
- Ahora no pasa, pero podría pasar después

**Probabilidad:** 30%

---

### Teoría C: Dependencias Resueltas Diferente

**Hipótesis:**
- NPM package tiene `package-lock.json` frozen de publish time
- Tu fork tiene deps más nuevas (npm install actualizado)
- Alguna dep (openai SDK, undici, fastify) arregló un bug

**Deps clave:**
- `openai: ^6.27.0` (cliente streaming)
- `undici: ^6.19.8` (HTTP client)
- `fastify: ^4.28.1` (server)

**Probabilidad:** 10%

---

### Teoría D: Environment Variables

**Hipótesis:**
- NPX corre con env vars default
- Fork corre con env vars de tu shell
- Alguna variable afecta timeouts

**Menos probable:** No vimos evidencia de esto.

**Probabilidad:** <5%

---

## 🎯 Conclusión

**Lo más probable:**

1. **Build diferente** entre NPX package y fork local
2. **Mismo código**, pero compilación/optimización diferente
3. **Bug todavía existe** en el código, pero se manifiesta menos

**El código NO tiene timeout implementado**, por lo que:
- El bug puede volver en cualquier momento
- Fork local solo lo "mitiga" por alguna razón de build
- **Implementar timeout sigue siendo necesario**

---

## 💡 Recomendaciones

### Opción 1: Implementar Timeout Preventivo ⭐ RECOMENDADO

**Razones:**
- Bug todavía está en el código
- Fork solo lo mitiga, no lo arregla
- Puede volver en cualquier momento
- Timeout es buena práctica de todas formas

**Ventajas:**
- Protección definitiva
- Mejora robustez general
- 30-60 min de trabajo

---

### Opción 2: Seguir Monitoreando

**Razones:**
- Confirmar que realmente no pasa
- Esperar 1-2 semanas de uso intensivo

**Desventajas:**
- Si pasa de nuevo, no hay recovery
- Pierdes tiempo esperando

---

### Opción 3: Testing Comparativo

**Experimento:**

1. **Día 1-2:** Usar fork local (actual)
2. **Día 3-4:** Volver a NPX temporalmente
3. **Observar:** ¿Vuelve el bug con NPX?

**Si bug vuelve con NPX:**
- Confirma que es diferencia de build
- Fork es workaround temporal
- Timeout sigue siendo necesario

**Si bug NO vuelve con NPX:**
- Algo cambió upstream
- Posiblemente arreglado en nueva versión
- Verificar changelog

---

## 📋 Próximos Pasos Sugeridos

### Plan A (Preventivo - Recomendado)

```bash
# 1. Implementar timeout en fork (30-60 min)
# Ver: MOBILE-FIX-PLAN.md líneas 234-289

# 2. Testing en fork (1-2 días)

# 3. Si funciona bien, PR upstream
```

**Resultado:** Fork con timeout + PR upstream = problema resuelto definitivamente

---

### Plan B (Testing)

```bash
# 1. Usar fork 1 semana más

# 2. Si NO pasa:
pm2 delete codenomad-fork
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev ...

# 3. Usar NPX 2-3 días

# 4. Si pasa con NPX:
# → Confirma build diferente
# → Implementar timeout en fork
# → PR upstream

# 5. Si NO pasa con NPX:
# → Upstream arregló en nueva versión
# → Documentar y seguir con NPX
```

**Resultado:** Entender mejor la causa antes de fix

---

## 📊 Resumen Ejecutivo

| Aspecto | NPX | Fork Local |
|---------|-----|------------|
| **Código** | 5570929 | 5570929 (idéntico) |
| **Build** | CI/GitHub Actions | Local (Node 25.9.0) |
| **Bug** | Ocurre "de una vez" | No ha ocurrido |
| **Timeout en código** | ❌ No | ❌ No |
| **Deps** | Frozen (publish) | Actuales (npm install) |

**Conclusión:** Bug sigue en código, fork lo mitiga por razones de build.

**Acción recomendada:** Implementar timeout preventivo en fork → PR upstream.

---

**Siguiente decisión:** ¿Implementar timeout ahora o seguir monitoreando?
