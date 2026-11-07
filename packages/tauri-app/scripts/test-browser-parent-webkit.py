#!/usr/bin/env python3
"""Production native-parent/controller qualification without a shared daemon.

Build the TypeScript fixture with esbuild first; pass its .mjs path via --fixture.
The owning-window inventory and renderer's open-claim callback are fixture-owned.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import threading
import time


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/ok')
            self.end_headers()
            return
        if self.path == '/slow':
            time.sleep(.3)
        body = b'<!doctype html><meta charset="utf-8"><title>Parent channel fixture</title><h1>Native parent fixture</h1><dialog>Overlay</dialog>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--node', default=shutil.which('node'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(CARGO_TARGET_DIR=str(args.target.resolve()), CARGO_PROFILE_DEV_DEBUG='0', CARGO_INCREMENTAL='0')
    if platform.system() == 'Darwin':
        env['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
    else:
        session = subprocess.check_output(['systemctl', '--user', 'show-environment'], text=True)
        for line in session.splitlines():
            key, separator, value = line.partition('=')
            if separator and key in {'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'}:
                env.setdefault(key, value)
    with tempfile.TemporaryDirectory(prefix='codenomad-parent-build-') as directory:
        manifest = Path(directory) / 'Cargo.toml'
        source = root / 'src-tauri/examples/browser-parent-webkit.rs'
        native = root / 'src-tauri/src/embedded_view'
        manifest.write_text(
            '[package]\nname="codenomad-parent-qualification"\nversion="0.0.0"\nedition="2021"\n'
            '[dependencies]\ntauri={version="=2.12.5",features=["unstable","test"]}\nserde={version="1",features=["derive"]}\nserde_json="1"\nuuid={version="1",features=["v4"]}\nbase64="0.22"\nsha2="0.10"\n'
            '[target.\'cfg(target_os="linux")\'.dependencies]\ngtk="0.18"\nwebkit2gtk="=2.0.2"\n'
            '[target.\'cfg(target_os="macos")\'.dependencies]\nobjc2="0.6.4"\nobjc2-web-kit={version="0.3.2",default-features=false,features=["std","objc2-app-kit","WKWebView","WKBackForwardList","WKBackForwardListItem","WKNavigation"]}\n'
            '[build-dependencies]\ncc="1"\npkg-config="0.3"\n'
            f'[[bin]]\nname="browser-parent-webkit"\npath={json.dumps(str(source))}\n'
            '[patch.crates-io]\n' + ''.join(f'{name}={{path={json.dumps(str(root / "vendor" / folder))}}}\n' for name, folder in [('tao','tao-0.37.2'),('wry','wry-0.57.1'),('tauri-runtime-wry','tauri-runtime-wry-2.12.3')]),
            encoding='utf-8')
        (Path(directory) / 'build.rs').write_text(
            f'#[path={json.dumps(str(root / "src-tauri/build_webkit.rs"))}] mod build_webkit;\nfn main() {{ build_webkit::build(std::path::Path::new({json.dumps(str(native))})); }}\n', encoding='utf-8')
        shutil.copyfile(root / 'Cargo.lock', Path(directory) / 'Cargo.lock')
        subprocess.run(['cargo', 'build', '--offline', '--manifest-path', str(manifest)], env=env, check=True, timeout=300)
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                subprocess.run([str(args.target.resolve() / 'debug/browser-parent-webkit'), args.node,
                                str(args.fixture.resolve()), f'http://127.0.0.1:{server.server_port}', str(output)],
                               env=env, check=True, timeout=150)
            finally:
                server.shutdown()
                thread.join()


if __name__ == '__main__':
    main()
