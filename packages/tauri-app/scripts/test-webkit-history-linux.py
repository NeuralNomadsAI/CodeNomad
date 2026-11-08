#!/usr/bin/env python3
"""Run the production history adapters against real GTK/WebKit without Tauri.

Usage on Linux with GTK 3 / WebKitGTK 4.1 development packages and a display:
    python3 packages/tauri-app/scripts/test-webkit-history-linux.py
Only a temporary standalone Cargo manifest is generated; sources are included
directly from this checkout. CARGO_TARGET_DIR can reuse an existing build cache.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()
            return
        body = b"<!doctype html><title>Native history fixture</title><p>History fixture</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main():
    source = Path(__file__).resolve().parents[1] / "src-tauri/examples/browser-history-linux.rs"
    environment = os.environ.copy()
    # SSH users can inherit the real GNOME display/session without shell eval.
    if not environment.get("DISPLAY") and not environment.get("WAYLAND_DISPLAY"):
        session = subprocess.run(
            ["systemctl", "--user", "show-environment"], text=True,
            capture_output=True, check=True,
        )
        for line in session.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator and key in {"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"}:
                environment[key] = value
    with tempfile.TemporaryDirectory(prefix="codenomad-webkit-history-") as directory:
        manifest = Path(directory) / "Cargo.toml"
        manifest.write_text(
            '[package]\nname = "codenomad-webkit-history-regression"\nversion = "0.0.0"\nedition = "2021"\n'
            '[dependencies]\ngtk = "0.18"\nwebkit2gtk = { version = "=2.0.2", features = ["v2_40"] }\n'
            f'[[bin]]\nname = "browser-history-linux"\npath = {json.dumps(str(source))}\n',
            encoding="utf-8",
        )
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                subprocess.run(
                    ["cargo", "run", "--manifest-path", str(manifest), "--",
                     f"http://127.0.0.1:{server.server_port}"],
                    env=environment, check=True, timeout=600,
                )
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    main()
