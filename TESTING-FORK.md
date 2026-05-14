# 🧪 Testing Fork - Captura de Bug en Acción

**Objetivo:** Usar CodeNomad normalmente y capturar datos cuando ocurra el bug de session stuck

**Fork activo desde:** Mayo 14, 2026  
**Estado:** Monitoreando

---

## ✅ Setup Completado

```bash
✅ Fork corriendo en PM2 (codenomad-fork)
✅ Server: https://192.168.50.45:9898
✅ Logs disponibles en tiempo real
✅ Listo para capturar bug
```

---

## 🎯 Qué Hacer

### Uso Normal

1. **Abrí CodeNomad:**
   - Desktop: `https://192.168.50.45:9898`
   - Móvil: `https://192.168.50.45:9898` (via VPN)

2. **Usalo normalmente:**
   - Hacer requests al AI
   - Navegar código
   - Cualquier operación típica

3. **Esperá a que se trabe** (podría pasar en cualquier momento)

---

## 🚨 Cuando Se Trabe (Session Stuck)

### Síntomas a Buscar

- ⏳ Streaming se detiene a mitad de respuesta
- 🔄 Spinner sigue girando pero no avanza
- ❌ Botón STOP no funciona (muestra error)
- ❌ Re-enviar mensaje muestra error
- ✅ Enviar NUEVO mensaje funciona (continúa donde quedó)

### Captura Inmediata (2 minutos)

#### 1. Screenshots (desktop preferible)

Tomar capturas de:
- Interfaz stuck con spinner
- DevTools → Network tab (F12 → Network)
- DevTools → Console tab (errores en rojo)
- Lo que pasa al presionar STOP
- Lo que pasa al re-enviar el mensaje

Si usás móvil, al menos screenshot de la interfaz stuck.

#### 2. Logs del Servidor

**En terminal, ejecutá inmediatamente:**

```bash
# Capturar logs del momento exacto
pm2 logs codenomad-fork --lines 100 --nostream > /tmp/stuck-$(date +%s).log

# Agregar logs de OpenCode también
tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-$(date +%s).log

# Ver el archivo creado
ls -lh /tmp/stuck-*.log
```

El archivo tendrá un timestamp, por ejemplo: `/tmp/stuck-1715654890.log`

#### 3. Metadata

Anotar (mental o en texto):
- ¿Qué pediste al AI? (tipo de request)
- ¿Cuánto tiempo esperaste antes de trabarse?
- ¿Desktop o móvil?
- ¿Browser? (Chrome, Firefox, etc)
- ¿Hora exacta?

---

## 📤 Mandarme los Datos

Cuando tengas todo:

1. **Screenshots** (las que hayas tomado)
2. **Archivo de logs** (`/tmp/stuck-*.log`)
3. **Contexto:**
   ```
   - Request que hice: [descripción breve]
   - Tiempo antes de trabar: ~X segundos/minutos
   - Plataforma: desktop/móvil
   - Browser: Chrome/Firefox/etc
   - Hora: HH:MM
   ```

Decí: "Se trabó, aquí están los datos" y adjuntás/describís lo capturado.

---

## 🔧 Mientras Tanto: Logs en Tiempo Real (Opcional)

Si querés ver qué pasa internamente mientras usás CodeNomad:

### Terminal 1: Logs de CodeNomad
```bash
pm2 logs codenomad-fork --lines 0
```

Esto muestra logs en tiempo real. Dejalo abierto en una terminal.

### Terminal 2: Logs de OpenCode
```bash
tail -f ~/.config/codenomad/logs/opencode-*.log
```

Muestra lo que hace OpenCode internamente.

**No es obligatorio**, pero puede ser útil para ver cuándo se traba.

---

## 🎨 Formato de Captura Ideal (Desktop)

### Screenshot 1: Interfaz Stuck
- Ventana completa de CodeNomad
- Spinner visible
- Mensaje parcial visible

### Screenshot 2: DevTools Network
1. F12 → Network tab
2. Mostrar las requests activas
3. Ver si hay alguna "Pending" o stuck
4. Capturar pantalla completa

### Screenshot 3: DevTools Console
1. F12 → Console tab
2. Mostrar errores (líneas rojas)
3. Capturar cualquier stack trace

### Screenshot 4: Al presionar STOP
- Qué error muestra

### Screenshot 5: Al re-enviar
- Qué error muestra

---

## 📱 Si Pasa en Móvil

### Capturas Mínimas
1. Interfaz stuck
2. Error al presionar STOP (si podés)

### Logs
Igual que desktop:
```bash
# En tu servidor/PC
pm2 logs codenomad-fork --lines 100 --nostream > /tmp/stuck-mobile-$(date +%s).log
tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-mobile-$(date +%s).log
```

---

## ⏱️ Cuánto Tiempo Esperar?

**No hay límite de tiempo definido.** El bug puede pasar:
- En el primer request
- Después de 10 requests
- Después de horas
- Nunca (si tuvimos suerte y el fork lo arregló sin querer)

**Sugerencias:**
- Usalo como normalmente usarías CodeNomad
- No fuerces nada especial
- El bug pasa naturalmente

**Si NO pasa en 2-3 días:**
- Implementamos el timeout preventivo de todas formas
- Es mejor prevenir que curar

---

## 🧪 Testing Específico (Opcional)

Si querés intentar provocar el bug:

### Requests Largos
Pedí al AI:
- "Explicame todo el codebase de CodeNomad"
- "Listame todos los archivos y sus propósitos"
- "Dame un análisis completo de la arquitectura"

Requests largos tienen más chance de trabarse.

### Interrupciones
- Presionar STOP a mitad de respuesta
- Cambiar de tab mientras responde
- Minimizar ventana

### Network Issues (si estás en móvil)
- Cambiar de WiFi a datos móviles
- Mover entre zonas con señal débil

**Pero NO es necesario.** Uso normal debería ser suficiente.

---

## 🎯 Estado Actual

```
Fork: CORRIENDO ✅
Monitoring: ACTIVO 🔍
Esperando: BUG 🐛
Listo para: CAPTURAR 📸
```

**Próximo paso:** Usar CodeNomad normalmente.

Cuando se trabe → capturar → mandarme datos → implementamos fix preciso.

---

## 📊 Checklist Rápido

Cuando se trabe:

- [ ] Screenshots (desktop: DevTools Network + Console)
- [ ] `pm2 logs codenomad-fork --lines 100 --nostream > /tmp/stuck-$(date +%s).log`
- [ ] `tail -100 ~/.config/codenomad/logs/opencode-*.log >> /tmp/stuck-$(date +%s).log`
- [ ] Anotar contexto (qué pedí, cuánto tiempo, platform, browser)
- [ ] Decir: "Se trabó, aquí están los datos"

---

**¡A usarlo! Suerte con la caza del bug.** 🐛🔍
