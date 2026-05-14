# Instalar X11 en KDE Plasma

**Por qué:** Para testear wake-lock fix en X11 (Issue #441)

---

## 🔧 Instalación

### Arch Linux (tu sistema)

```bash
# Instalar Xorg y sesión KDE X11
sudo pacman -S xorg-server plasma-workspace-x11

# Paquetes que se instalarán:
# - xorg-server: Servidor X11
# - plasma-workspace-x11: Sesión Plasma para X11
```

### Verificar Instalación

```bash
# Ver sesiones disponibles
ls /usr/share/xsessions/

# Deberías ver:
# - plasma.desktop (X11)
# - plasmawayland.desktop (Wayland - actual)
```

---

## 🚪 Cómo Usar X11

### Cambiar a X11

1. **Logout** (Cerrar sesión)
2. **En pantalla de login:**
   - Esquina inferior izquierda
   - Click en "Session" o "Sesión"
   - Seleccionar "Plasma (X11)" o "KDE Plasma on X11"
3. **Login**

### Verificar Sesión Activa

```bash
echo $XDG_SESSION_TYPE
# Debe mostrar: x11
```

### Volver a Wayland

1. **Logout**
2. **En pantalla de login:**
   - Seleccionar "Plasma (Wayland)"
3. **Login**

---

## 📋 Testing Wake-Lock en X11

**Después de instalar y cambiar a X11:**

1. Ver guía completa: `WAKE-LOCK-X11-TESTING-PLAN.md`

2. Quick test:
   ```bash
   cd /home/dark/Project/codenomad
   pm2 restart codenomad-fork
   
   # Abrir browser: https://192.168.50.45:9898
   # Iniciar sesión AI
   # Wake-lock debería activarse (no ver mensaje "Disabled on Wayland")
   # Lock screen: loginctl lock-session
   # Unlock y verificar que no crasheó
   ```

---

## ⚠️ Notas

### Si Ya Tenés xorg-server

Puede que solo necesites:
```bash
sudo pacman -S plasma-workspace-x11
```

### Si Hay Conflictos

```bash
# Ver paquetes instalados
pacman -Qq | grep xorg
pacman -Qq | grep plasma

# Reinstalar si es necesario
sudo pacman -S --overwrite '*' xorg-server plasma-workspace-x11
```

### Diferencias X11 vs Wayland

**Ventajas X11:**
- ✅ Wake-lock funciona sin crash
- ✅ Más estable con Electron
- ✅ Screen sharing mejor

**Ventajas Wayland:**
- ✅ Mejor seguridad
- ✅ Mejor rendimiento (en teoría)
- ✅ Más moderno

**Para testing:** Solo necesitás X11 temporalmente, luego podés volver a Wayland.

---

## 🎯 Después de Instalar

1. **No cambiar a X11 aún** - Descansá primero
2. **Cuando vuelvas:**
   - Logout → Login X11
   - Testing wake-lock (30 min)
   - Capturas
   - PR upstream
3. **Volver a Wayland** después del testing

---

## 📝 Checklist

- [ ] Ejecutar: `sudo pacman -S xorg-server plasma-workspace-x11`
- [ ] Verificar: `ls /usr/share/xsessions/`
- [ ] Logout/Login cuando listo para testing
- [ ] Seguir guía: `WAKE-LOCK-X11-TESTING-PLAN.md`

---

**Listo para ejecutar cuando quieras instalar!** ✅
