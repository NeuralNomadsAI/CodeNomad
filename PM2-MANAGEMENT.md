# Gestión de CodeNomad con PM2

**Tu configuración actual:**
- Proceso: `codenomad` (ID: 0)
- Comando: `npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password 3467 --launch`
- Logs: `~/.pm2/logs/codenomad-*.log`
- Uptime: Corriendo desde Mayo 13, 2026

---

## 📋 Comandos Útiles PM2

### Ver Estado
```bash
# Lista todos los procesos
pm2 list

# Detalles completos
pm2 describe codenomad

# Monitor en tiempo real
pm2 monit
```

### Ver Logs
```bash
# Logs en tiempo real
pm2 logs codenomad

# Solo errores
pm2 logs codenomad --err

# Solo output normal
pm2 logs codenomad --out

# Últimas 100 líneas
pm2 logs codenomad --lines 100

# Limpiar logs viejos
pm2 flush codenomad
```

### Control del Proceso
```bash
# Reiniciar
pm2 restart codenomad

# Detener
pm2 stop codenomad

# Iniciar
pm2 start codenomad

# Reiniciar con nuevo código (sin downtime)
pm2 reload codenomad

# Eliminar del PM2
pm2 delete codenomad
```

---

## 🔄 Cómo Aplicar Fixes

### Opción 1: Restart Rápido (Cambios de Config)

Si solo cambias flags o configuración:

```bash
# Modificar comando
pm2 delete codenomad
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

# Guardar configuración
pm2 save
```

### Opción 2: Update de Código (Fixes del Repo)

Si modificamos código del fork:

```bash
# 1. Detener PM2 temporalmente
pm2 stop codenomad

# 2. Rebuild (si cambiamos código)
cd /home/dark/Project/codenomad
npm run build

# 3. Reiniciar con nueva versión
pm2 restart codenomad

# O forzar reload
pm2 reload codenomad
```

### Opción 3: Usar Fork Local (En Lugar de NPM)

Para testear fixes sin publicar:

```bash
# 1. Detener actual
pm2 delete codenomad

# 2. Iniciar desde tu fork
cd /home/dark/Project/codenomad
pm2 start npm --name codenomad -- run start -- \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

# 3. Guardar
pm2 save
```

### Opción 4: Variables de Entorno

Para cambiar log level u otros settings:

```bash
pm2 delete codenomad

# Con variables de entorno
pm2 start npx --name codenomad \
  --env LOG_LEVEL=trace \
  -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch

pm2 save
```

---

## 📝 Configuración PM2 (ecosystem.config.js)

Crear archivo para gestión más fácil:

```bash
cd ~
nano ecosystem.config.js
```

Contenido:
```javascript
module.exports = {
  apps: [{
    name: 'codenomad',
    script: 'npx',
    args: '@neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password 3467 --launch',
    cwd: '/home/dark',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'
    },
    env_development: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug'
    },
    error_file: '~/.pm2/logs/codenomad-error.log',
    out_file: '~/.pm2/logs/codenomad-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
}
```

Usar:
```bash
# Iniciar desde config
pm2 start ecosystem.config.js

# Con environment específico
pm2 start ecosystem.config.js --env development

# Reload con config actualizado
pm2 reload ecosystem.config.js

# Guardar
pm2 save
```

---

## 🐛 Debugging con PM2

### Cuando el Bug Ocurre

```bash
# 1. Ver logs en tiempo real
pm2 logs codenomad --lines 200

# 2. En otra terminal, monitorear recursos
pm2 monit

# 3. Revisar últimos errores
tail -100 ~/.pm2/logs/codenomad-error.log

# 4. Revisar OpenCode logs
tail -100 ~/.config/codenomad/logs/opencode-*.log
```

### Habilitar Debug Logging

```bash
# Temporal (sin reiniciar)
# (si CodeNomad soporta señales para cambiar log level)

# Permanente
pm2 delete codenomad
pm2 start npx --name codenomad \
  --env LOG_LEVEL=debug \
  -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 \
  --https-port 9898 \
  --password 3467 \
  --launch \
  --log-level debug

pm2 save
```

---

## 🔧 Aplicar el Fix del Session Stuck

### Plan de Acción

**1. Primero capturar logs actuales:**
```bash
# Próxima vez que se trabe
pm2 logs codenomad --lines 100 > /tmp/stuck-session-$(date +%s).log
tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-session-$(date +%s).log
```

**2. Cuando tengamos el fix:**
```bash
# A. Si es fix en @neuralnomads/codenomad-dev (upstream)
pm2 restart codenomad  # Se actualiza automáticamente

# B. Si es fix en tu fork
cd /home/dark/Project/codenomad
git pull  # Si lo pusheamos
npm run build
pm2 restart codenomad

# C. Si necesitas testear código modificado
# Ver "Usar Fork Local" arriba
```

**3. Testing:**
```bash
# Ver logs mientras testeas
pm2 logs codenomad --lines 0

# En otra terminal, usa CodeNomad
# Observa si se traba
# Revisa logs para confirmar fix
```

---

## 📊 Monitoreo Continuo

### Setup de Alertas (Opcional)

```bash
# Instalar PM2 modules (si quieres)
pm2 install pm2-logrotate

# Configurar log rotation
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10
```

### Scripts de Monitoreo

Crear script para revisar periódicamente:

```bash
nano ~/check-codenomad.sh
```

Contenido:
```bash
#!/bin/bash

# Check if CodeNomad is running
if ! pm2 list | grep -q "codenomad.*online"; then
  echo "⚠️  CodeNomad is DOWN!"
  pm2 restart codenomad
fi

# Check memory usage
MEM=$(pm2 jlist | jq '.[0].monit.memory' 2>/dev/null)
if [ "$MEM" -gt 1000000000 ]; then
  echo "⚠️  High memory usage: $((MEM/1024/1024))MB"
fi

# Check for errors in last 10 lines
ERRORS=$(pm2 logs codenomad --lines 10 --nostream 2>&1 | grep -i error | wc -l)
if [ "$ERRORS" -gt 5 ]; then
  echo "⚠️  Many errors detected: $ERRORS"
fi
```

Automatizar:
```bash
chmod +x ~/check-codenomad.sh

# Agregar a crontab (cada 5 minutos)
crontab -e
# Agregar:
*/5 * * * * ~/check-codenomad.sh >> ~/codenomad-check.log 2>&1
```

---

## 🚀 Startup Automático

Para que inicie al boot:

```bash
# Generar startup script
pm2 startup

# Ejecutar el comando que te muestre (usará sudo)
# Ejemplo:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u dark --hp /home/dark

# Guardar lista actual de procesos
pm2 save
```

Verificar:
```bash
# Ver si está habilitado
systemctl status pm2-dark

# Logs del servicio
journalctl -u pm2-dark -f
```

---

## 📂 Archivos Importantes

**Logs:**
- PM2 out: `~/.pm2/logs/codenomad-out.log`
- PM2 errors: `~/.pm2/logs/codenomad-error.log`
- OpenCode: `~/.config/codenomad/logs/opencode-*.log`

**Config:**
- PM2 config: `~/ecosystem.config.js` (si lo creas)
- PM2 dump: `~/.pm2/dump.pm2` (lista de procesos guardada)

**PID:**
- `~/.pm2/pids/codenomad-0.pid`

---

## 🔍 Troubleshooting PM2

### CodeNomad no inicia
```bash
# Ver detalles del error
pm2 logs codenomad --err --lines 50

# Intentar iniciar manualmente para ver error
npx @neuralnomads/codenomad-dev --host 0.0.0.0 --https-port 9898 --password 3467 --launch

# Si funciona manual, problema con PM2
pm2 delete codenomad
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev ...
```

### Logs no se actualizan
```bash
# Flush y restart
pm2 flush codenomad
pm2 restart codenomad
```

### Proceso se reinicia constantemente
```bash
# Ver por qué
pm2 logs codenomad --err

# Incrementar memoria si es OOM
pm2 delete codenomad
pm2 start ... --max-memory-restart 2G
```

---

## 🎯 Quick Reference

```bash
# Ver logs del bug
pm2 logs codenomad

# Restart después de fix
pm2 restart codenomad

# Ver si está corriendo
pm2 list

# Monitor recursos
pm2 monit

# Guardar config actual
pm2 save
```

---

**Tu configuración está bien. Solo usa `pm2 restart codenomad` después de aplicar fixes.** ✅
