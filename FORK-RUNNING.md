# ✅ Fork Corriendo en PM2

**Fecha:** Mayo 14, 2026  
**Estado:** ACTIVO

---

## Configuración Actual

**Proceso PM2:**
```
ID: 0
Name: codenomad-fork
Status: online
Command: node packages/server/dist/bin.js
Working Dir: /home/dark/Project/codenomad
```

**Servidor:**
- Local: https://127.0.0.1:9898
- Remote: https://192.168.50.45:9898
- Password: 3467
- Username: codenomad

**OpenCode:**
- Port: 4096

---

## Comandos Útiles

### Ver Logs
```bash
pm2 logs codenomad-fork           # Tiempo real
pm2 logs codenomad-fork --lines 50  # Últimas 50 líneas
```

### Estado
```bash
pm2 list                          # Ver estado
pm2 describe codenomad-fork       # Detalles completos
pm2 monit                         # Monitor en tiempo real
```

### Control
```bash
# Restart (después de cambios)
cd /home/dark/Project/codenomad
npm run build
pm2 restart codenomad-fork

# Stop
pm2 stop codenomad-fork

# Start (si está stopped)
pm2 start codenomad-fork

# Delete (para remover)
pm2 delete codenomad-fork
```

---

## Workflow de Desarrollo

### 1. Hacer Cambios

Editar código en `/home/dark/Project/codenomad`

### 2. Rebuild

```bash
cd /home/dark/Project/codenomad
npm run build
```

Esto compila:
- UI (`packages/ui/`)
- Server (`packages/server/`)
- OpenCode plugin

### 3. Restart PM2

```bash
pm2 restart codenomad-fork
```

### 4. Ver Logs

```bash
pm2 logs codenomad-fork --lines 20
```

### 5. Testing

Abrir browser en `https://192.168.50.45:9898`

---

## Build Completo

El build tarda ~7 segundos e incluye:

1. **UI Build** (Vite):
   - SolidJS app
   - 389 archivos precached (PWA)
   - ~16 MB total

2. **Server Build** (TypeScript):
   - CLI compilado
   - Public assets copiados
   - Auth pages

3. **Plugin Build**:
   - OpenCode plugin empaquetado
   - `.tgz` generado

**Salida:**
```
packages/server/dist/
├── bin.js           # CLI entry point (este usamos en PM2)
├── cli.js           # CLI logic
├── index.js         # Server logic
├── server/          # Routes, services
├── opencode-plugin/ # Plugin .tgz
└── ...
```

---

## Aplicar Fixes

### Ejemplo: Implementar Timeout

1. **Editar código:**
   ```bash
   # Por ejemplo
   nano packages/server/src/workspaces/opencode-workspace.ts
   ```

2. **Build:**
   ```bash
   cd /home/dark/Project/codenomad
   npm run build
   ```

3. **Deploy:**
   ```bash
   pm2 restart codenomad-fork
   pm2 logs codenomad-fork
   ```

4. **Testing:**
   - Abrir CodeNomad en browser
   - Probar el fix
   - Ver logs para confirmar

5. **Commit:**
   ```bash
   git add .
   git commit -m "fix: add timeout to OpenCode requests"
   git push origin dev
   ```

6. **PR (si funciona):**
   ```bash
   gh pr create --base dev \
     --title "fix: add timeout to OpenCode requests" \
     --body "..."
   ```

---

## Volver al Official Package

Si querés volver al NPM official:

```bash
# Detener fork
pm2 delete codenomad-fork

# Iniciar official
pm2 start npx --name codenomad -- @neuralnomads/codenomad-dev \
  --host 0.0.0.0 --https-port 9898 --password 3467 --launch

pm2 save
```

---

## Troubleshooting

### Rebuild falla

```bash
cd /home/dark/Project/codenomad
npm install  # Por si hay nuevas deps
npm run build
```

### Proceso crashed

```bash
pm2 logs codenomad-fork --err --lines 50
pm2 restart codenomad-fork
```

### Puerto ocupado

```bash
# Si hay algo en 9898
lsof -ti:9898 | xargs kill -9

# Luego restart
pm2 restart codenomad-fork
```

### No se ve en browser

1. Verificar PM2: `pm2 list`
2. Verificar logs: `pm2 logs codenomad-fork`
3. Verificar firewall: `sudo ufw status`
4. Probar local primero: `https://127.0.0.1:9898`

---

## Listo para Implementar Fixes! 🚀

Ahora podés:
1. Implementar el timeout (ver `MOBILE-FIX-PLAN.md`)
2. Rebuild + restart
3. Testing
4. PR upstream

**Siguiente paso:** Decí "Implementá el timeout" y empezamos.
