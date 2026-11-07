#!/usr/bin/env python3
"""Ubuntu GNOME native input trial: python3 gtk-child-trial.py [prebuilt-binary].

Requires python3-dbus and a logged-in GNOME session. Runs X11 and Wayland;
keeps logs in the current directory. Input goes through Mutter's native seat.
"""
import dbus
import http.server
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

if len(sys.argv) > 1:
    binary = sys.argv[1]
else:
    build = tempfile.TemporaryDirectory(prefix="gtk-child-build-")
    root = Path(__file__).resolve().parents[2]
    manifest = Path(build.name) / "Cargo.toml"
    manifest.write_text(f'''[package]
name = "gtk-native-trial"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "gtk-native-trial"
path = "{Path(__file__).with_name('gtk-child-layout.rs').resolve()}"
[dependencies]
gtk = "0.18"
webkit2gtk = "2.0.2"
wry = {{ path = "{root / 'wry-0.57.1'}" }}
''')
    target = Path(os.environ.get("CARGO_TARGET_DIR", str(Path(build.name) / "target")))
    subprocess.run(["cargo", "build", "--offline", "--manifest-path", str(manifest),
                    "--target-dir", str(target)], check=True)
    binary = str(target / "debug" / "gtk-native-trial")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        if self.path == "/download":
            self.send_header("Content-Disposition", 'attachment; filename="denied.txt"')
            body = b"must never be saved"
        else:
            body = b'''<body style="margin:0;background:#ffddaa"><h1>child</h1>
<script>
document.onclick=e=>window.ipc.postMessage('click child '+e.clientX+','+e.clientY);
navigator.geolocation.getCurrentPosition(()=>window.ipc.postMessage('UNEXPECTED_PERMISSION'),
 e=>window.ipc.postMessage('geolocation denied '+e.code));
setTimeout(()=>{let a=document.createElement('a');a.href='/download';a.download='denied.txt';a.click()},500);
</script>'''
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
bus = dbus.SessionBus()
service = "org.gnome.Mutter.RemoteDesktop"
path = dbus.Interface(bus.get_object(service, "/org/gnome/Mutter/RemoteDesktop"), service).CreateSession()
seat = dbus.Interface(bus.get_object(service, path), service + ".Session")
seat.Start()
scale = 1


def click(x, y):
    seat.NotifyPointerMotionRelative(-10000., -10000.)
    time.sleep(.1)
    seat.NotifyPointerMotionRelative(float(x * scale), float(y * scale))
    time.sleep(.1)
    # The first click can activate the new window; the second must reach HTML.
    for _ in range(2):
        seat.NotifyPointerButton(272, True)
        seat.NotifyPointerButton(272, False)
        time.sleep(.15)


try:
    for backend in ("wayland", "x11"):
        with tempfile.TemporaryDirectory(prefix="gtk-trial-") as storage:
            env = dict(os.environ, GDK_BACKEND=backend,
                       WAYLAND_DISPLAY=os.environ.get("WAYLAND_DISPLAY", "wayland-0"),
                       DISPLAY=os.environ.get("DISPLAY", ":0"),
                       XDG_DATA_HOME=storage, XDG_CACHE_HOME=storage,
                       GTK_TRIAL_URL=f"http://127.0.0.1:{server.server_port}/")
            # Use the current desktop's Xauthority instead of relying on a name.
            authorities = list(Path(os.environ["XDG_RUNTIME_DIR"]).glob(".mutter-Xwaylandauth.*"))
            if authorities:
                env["XAUTHORITY"] = str(authorities[0])
            process = subprocess.Popen([binary], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, env=env)
            def kill_child(child=process):
                try:
                    child.kill()
                except ProcessLookupError:
                    pass

            watchdog = threading.Timer(60, kill_child)
            watchdog.daemon = True
            watchdog.start()
            lines = []
            hidden_index = None
            try:
                for line in process.stdout:
                    print(backend, line, end="", flush=True)
                    lines.append(line)
                    if "DISPLAY_SCALE " in line:
                        scale = int(line.split("DISPLAY_SCALE ", 1)[1])
                    if line.startswith("READY_FOR_CLICKS:"):
                        time.sleep(.8)
                        click(20, 100)
                        click(180, 200)
                    if "WINDOW_B_READY_FOR_CLICKS" in line:
                        time.sleep(.8)
                        click(20, 100)
                    if "HIDDEN_FOR_CLICKS" in line:
                        hidden_index = len(lines)
                        time.sleep(.3)
                        click(180, 200)
                assert process.wait() == 0, backend
            finally:
                watchdog.cancel()
                if process.poll() is None:
                    kill_child()
                process.wait()
                watchdog.join()
                process.stdout.close()
            text = "".join(lines)
            Path(backend + ".log").write_text(text)
            for expected in ("click main", "click child", "PERMISSION_DENIED", "geolocation denied 1", "DOWNLOAD_DENIED", "OWNER_A_CHILD_RELEASED", "OWNER_B_STABLE phase=9", "click main-B 20,40"):
                assert expected in text, (backend, expected)
            assert hidden_index is not None
            assert "click main 180,140" in "".join(lines[hidden_index:]), backend
            assert "UNEXPECTED_PERMISSION" not in text
            stores = [line.split("PERSISTENT_STORE ", 1)[1].strip()
                      for line in lines if "PERSISTENT_STORE " in line]
            assert len(stores) == len(set(stores)) == 3, (backend, stores)
            destinations = [line.split("DOWNLOAD_DESTINATION ", 1)[1].strip()
                            for line in lines if "DOWNLOAD_DESTINATION " in line]
            assert destinations and all(not Path(path).exists() for path in destinations), backend
            assert not list(Path(storage).rglob("denied.txt")), backend
            print(backend, "PASS: allocation, native input, hidden input, permission and download denial")
finally:
    seat.Stop()
    server.shutdown()
