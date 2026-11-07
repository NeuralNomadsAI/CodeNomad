#!/usr/bin/env python3
"""Compile and exercise the production native primitives on a graphical session.

Linux: GDK_BACKEND=wayland|x11 python3 packages/tauri-app/scripts/test-webkit-input.py
macOS: python3 packages/tauri-app/scripts/test-webkit-input.py
Artifacts remain in --output (default: a printed temporary directory).
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shlex
import struct
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = args.output or Path(tempfile.mkdtemp(prefix='codenomad-webkit-input-'))
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    source = root / 'src-tauri/src/embedded_view'
    test = root / 'tests/webkit-input'
    env = os.environ.copy()
    binary = output / 'native-input'
    if platform.system() == 'Darwin':
        command = ['clang', '-Wall', '-Wextra', '-Werror', '-fobjc-arc', '-fblocks',
                   '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'WebKit',
                   '-framework', 'ApplicationServices', str(source / 'input_macos.m'), str(test / 'macos.m')]
    else:
        session = subprocess.run(['systemctl', '--user', 'show-environment'],
                                 check=True, capture_output=True, text=True).stdout
        for line in session.splitlines():
            key, separator, value = line.partition('=')
            if separator and key in {'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'}:
                env.setdefault(key, value)
        flags = subprocess.run(['pkg-config', '--cflags', '--libs', 'webkit2gtk-4.1'],
                               check=True, capture_output=True, text=True).stdout
        command = ['cc', '-Wall', '-Wextra', '-Werror', str(source / 'input_linux.c'), str(test / 'linux.c'), *shlex.split(flags)]
    subprocess.run([*command, '-o', str(binary)], check=True, timeout=120)
    print(f'Artifacts: {output}', flush=True)
    subprocess.run([str(binary), str(test / 'fixture.html')], env=env, cwd=output, check=True, timeout=30)
    checkpoint = json.loads((output / 'checkpoint.json').read_text())
    assert checkpoint['pageGlobal'] == 'undefined', checkpoint
    # innerText contains the pointer pad label followed by the fixture JSON.
    body = checkpoint['body']
    observations = json.loads(body[body.index('{'):])
    events = observations['observations']
    assert events and all(event['trusted'] for event in events), events
    required = {'click', 'contextmenu', 'pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'beforeinput'}
    assert required <= {event['type'] for event in events}, events
    assert any(event['type'] == 'pointermove' and event.get('buttons') == 1 for event in events), events
    assert any(event['type'] == 'keydown' and (event.get('ctrl') or event.get('meta')) for event in events), events
    assert observations['input'] == 'remplacé漢🙂', observations
    assert observations['editor'].startswith('éditeur漢🙂'), observations
    png = (output / 'capture.png').read_bytes()
    assert png[:8] == b'\x89PNG\r\n\x1a\n'
    dimensions = struct.unpack('>II', png[16:24])
    assert all(0 < value <= 2000 for value in dimensions), dimensions
    print(json.dumps({'passed': True, 'events': len(events), 'png': dimensions, 'checkpoint': checkpoint}, ensure_ascii=False))


if __name__ == '__main__':
    main()
