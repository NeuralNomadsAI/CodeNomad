# 🔧 Cómo Correr Tu Fork con PM2

**Situación Actual:**
- PM2 corre: `npx @neuralnomads/codenomad-dev` (paquete oficial NPM)
- Tu fork: `/home/dark/Project/codenomad` (código local con fixes)

**Objetivo:** Correr tu fork local en lugar del NPM package

---

## 🚀 Método 1: PM2 con npm start (Recomendado)

### Paso 1: Preparar el Fork

```bash
cd /home/dark/Project/codenomad

# Instalar dependencias (si no lo hiciste)
npm install

# Build del proyecto
npm run build

# Verificar que los scripts existen
npm run
```

### Paso 2: Detener PM2 Actual

```bash
# Detener y eliminar el proceso actual
pm2 delete codenomad

# Verificar que se eliminó
pm2 list
```

### Paso 3: Iniciar Fork desde PM2

```bash
# Iniciar desde tu fork local
cd /home/dark/Project/codenomad

pm2 start npm --name codenomad -- run start -- \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

# Guardar configuración
pm2 save
```

### Paso 4: Verificar

```bash
# Ver si está corriendo
pm2 list

# Ver logs
pm2 logs codenomad

# Debería mostrar algo como:
# "CodeNomad server running on https://0.0.0.0:9898"
```

### Paso 5: Probar

Abrí el browser en `https://192.168.50.45:9898` y verificá que funciona.

---

## 🔄 Método 2: PM2 con Script Directo

### Opción A: Usando el CLI Built

```bash
cd /home/dark/Project/codenomad

# Build primero
npm run build

# Detener actual
pm2 delete codenomad

# Iniciar usando el CLI compilado
pm2 start node --name codenomad -- \
  packages/server/dist/cli.js \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

pm2 save
```

### Opción B: Usando tsx (Development)

```bash
cd /home/dark/Project/codenomad

# Detener actual
pm2 delete codenomad

# Iniciar con tsx (no-build, más rápido para desarrollo)
pm2 start npx --name codenomad-dev -- \
  tsx packages/server/src/cli.ts \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

pm2 save
```

---

## 📝 Método 3: PM2 Ecosystem Config

Crear archivo para gestión más fácil:

```bash
cd /home/dark/Project/codenomad
nano ecosystem.config.js
```

**Contenido:**

```javascript
module.exports = {
  apps: [
    {
      name: 'codenomad-fork',
      script: 'npm',
      args: 'run start -- --host 0.0.0.0 --https-port 9898 --password 3467 --launch',
      cwd: '/home/dark/Project/codenomad',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },
      error_file: '~/.pm2/logs/codenomad-fork-error.log',
      out_file: '~/.pm2/logs/codenomad-fork-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
}
```

**Uso:**

```bash
# Detener actual
pm2 delete codenomad

# Iniciar desde config
pm2 start ecosystem.config.js

# Guardar
pm2 save

# Ver logs
pm2 logs codenomad-fork
```

---

## 🔀 Switching Entre Fork y Official

### Volver al Official NPM Package

```bash
# Detener fork
pm2 delete codenomad  # o codenomad-fork

# Iniciar official
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

pm2 save
```

### Usar Fork

```bash
# Detener official
pm2 delete codenomad

# Iniciar fork
cd /home/dark/Project/codenomad
pm2 start npm --name codenomad-fork -- run start -- \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

pm2 save
```

### Script de Toggle (Opcional)

```bash
nano ~/toggle-codenomad.sh
```

**Contenido:**

```bash
#!/bin/bash

if pm2 list | grep -q "codenomad-fork.*online"; then
  echo "Switching to OFFICIAL..."
  pm2 delete codenomad-fork
  pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev \
    --host 0.0.0.0 --https-port 9898 --password 3467 --launch
  pm2 save
  echo "✅ Running OFFICIAL package"
else
  echo "Switching to FORK..."
  pm2 delete codenomad 2>/dev/null
  cd /home/dark/Project/codenomad
  npm run build
  pm2 start npm --name codenomad-fork -- run start -- \
    --host 0.0.0.0 --https-port 9898 --password 3467 --launch
  pm2 save
  echo "✅ Running FORK"
fi

pm2 list
```

**Uso:**

```bash
chmod +x ~/toggle-codenomad.sh
~/toggle-codenomad.sh  # Toggle entre fork y official
```

---

## 🛠️ Workflow de Desarrollo con Fork

### Desarrollo Iterativo

```bash
# 1. Hacer cambios en el código
cd /home/dark/Project/codenomad
# ... editar archivos ...

# 2. Rebuild
npm run build

# 3. Restart PM2 (usa el nuevo build)
pm2 restart codenomad-fork

# 4. Ver logs
pm2 logs codenomad-fork --lines 20

# 5. Probar en browser
# https://192.168.50.45:9898
```

### Desarrollo Rápido (Sin Build)

Si querés iterar más rápido sin rebuild:

```bash
# Usar tsx en modo watch
pm2 delete codenomad-fork

cd /home/dark/Project/codenomad
pm2 start npx --name codenomad-dev -- \
  tsx watch packages/server/src/cli.ts \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

# Ahora los cambios en server se recargan automáticamente
# (cambios en UI necesitan rebuild)
```

---

## 🐛 Aplicar Fixes al Fork

### Workflow Completo

```bash
# 1. Asegurate de estar en fork
cd /home/dark/Project/codenomad

# 2. Crear branch para el fix
git checkout -b fix/session-timeout

# 3. Hacer cambios (ej: implementar timeout)
# ... editar packages/server/src/workspaces/opencode-workspace.ts ...

# 4. Typecheck
npm run typecheck

# 5. Build
npm run build

# 6. Si PM2 corre fork, restart
pm2 restart codenomad-fork

# 7. Si PM2 corre official, switch temporalmente
pm2 delete codenomad
pm2 start npm --name codenomad-fork -- run start -- \
  --host 0.0.0.0 --https-port 9898 --password 3467 --launch

# 8. Testing
pm2 logs codenomad-fork
# ... probar en browser ...

# 9. Si funciona, commit
git add .
git commit -m "fix: add timeout to OpenCode requests"

# 10. Push a tu fork
git push origin fix/session-timeout

# 11. Crear PR en GitHub
gh pr create --base dev --head fix/session-timeout \
  --title "fix: add timeout to OpenCode requests" \
  --body "Fixes session stuck bug..."
```

---

## 📊 Comparación

| Aspecto | Official NPM | Fork Local |
|---------|--------------|------------|
| **Inicio** | `npx @neuralnomads/codenomad-dev` | `npm run start` en `/home/dark/Project/codenomad` |
| **Velocidad de inicio** | Más lento (descarga) | Más rápido (ya built) |
| **Aplicar fixes** | Esperar release upstream | Inmediato |
| **Testing de cambios** | No posible | Sí |
| **Actualizaciones** | Automático con npx | Manual (git pull + rebuild) |
| **Estabilidad** | Release oficial | Tu código |
| **Para desarrollo** | ❌ | ✅ |
| **Para uso normal** | ✅ | ⚠️ (si no hay fixes pendientes) |

---

## 🎯 Recomendación

### Para Desarrollo de Fixes:

```bash
# Usa fork local
pm2 delete codenomad
cd /home/dark/Project/codenomad
npm run build
pm2 start npm --name codenomad-fork -- run start -- \
  --host 0.0.0.0 --https-port 9898 --password 3467 --launch
pm2 save
```

### Para Uso Normal:

```bash
# Usa official package
pm2 delete codenomad-fork
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 --https-port 9898 --password 3467 --launch
pm2 save
```

---

## 🚨 Troubleshooting

### "Cannot find module" después de pm2 start

```bash
# Instalar dependencias
cd /home/dark/Project/codenomad
npm install
npm run build
pm2 restart codenomad-fork
```

### Puerto ya en uso

```bash
# Matar proceso en puerto 9898
lsof -ti:9898 | xargs kill -9

# O cambiar puerto en PM2
pm2 start ... -- --https-port 9899 ...
```

### Fork no tiene últimos cambios

```bash
cd /home/dark/Project/codenomad
git fetch upstream
git merge upstream/dev
npm install  # por si hay nuevas dependencias
npm run build
pm2 restart codenomad-fork
```

### Logs no aparecen

```bash
pm2 flush codenomad-fork
pm2 restart codenomad-fork
pm2 logs codenomad-fork --lines 50
```

---

## ✅ Verificación Rápida

Para saber cuál estás corriendo:

```bash
pm2 list

# Si ves "codenomad" → Official NPM
# Si ves "codenomad-fork" → Tu fork local

# O verificar el script path:
pm2 describe 0 | grep "script path"

# Si dice "/usr/bin/npx" con "@neuralnomads" → Official
# Si dice "npm" con tu path → Fork
```

---

## 🎯 Siguiente Paso

**Para implementar el timeout fix:**

1. **Switch a fork:**
   ```bash
   pm2 delete codenomad
   cd /home/dark/Project/codenomad
   npm install && npm run build
   pm2 start npm --name codenomad-fork -- run start -- \
     --host 0.0.0.0 --https-port 9898 --password 3467 --launch
   pm2 save
   ```

2. **Decime:** "Implementá el timeout según MOBILE-FIX-PLAN.md"

3. **Yo hago el código** (30 min)

4. **Vos aplicás:**
   ```bash
   cd /home/dark/Project/codenomad
   npm run build
   pm2 restart codenomad-fork
   pm2 logs codenomad-fork
   ```

5. **Testing** (15 min)

6. **PR upstream** si funciona

---

**¿Querés que hagamos el switch ahora y empecemos con el fix?** 🚀
