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
import shutil
import struct
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--nested-kde', action='store_true', help='Own a separate headless KWin Wayland compositor; leave the desktop session intact')
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
    compositor = None
    desktop_pointer = None
    if platform.system() == 'Linux' and env.get('DISPLAY') and shutil.which('xdotool'):
        # Observation only: synthetic input goes exclusively through the native adapter.
        desktop_pointer = subprocess.check_output(['xdotool', 'getmouselocation', '--shell'], env=env, text=True)
    try:
        if args.nested_kde:
            socket = f'codenomad-input-{os.getpid()}'
            env['WAYLAND_DISPLAY'] = socket
            env['GDK_BACKEND'] = 'wayland'
            env['CN_NESTED_KDE'] = '1'
            compositor_env = {**env, 'QT_QPA_PLATFORM': 'offscreen', 'KWIN_COMPOSE': 'Q'}
            with (output / 'kwin.log').open('w') as log:
                compositor = subprocess.Popen(['kwin_wayland', '--virtual', '--socket', socket,
                                               '--width', '1024', '--height', '768'],
                                              env=compositor_env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 15
            while not (Path(env['XDG_RUNTIME_DIR']) / socket).exists():
                assert compositor.poll() is None, (output / 'kwin.log').read_text()
                assert time.monotonic() < deadline, 'KWin socket startup timed out'
                time.sleep(.1)
        run = subprocess.run([str(binary), str(test / 'fixture.html')], env=env, cwd=output,
                             capture_output=True, text=True, timeout=30)
        (output / 'native.log').write_text(run.stdout + run.stderr)
        print(run.stdout + run.stderr, flush=True)
        run.check_returncode()
    finally:
        if compositor:
            compositor.terminate()
            compositor.wait(timeout=10)
    pointer_unchanged = True
    if desktop_pointer is not None:
        after = subprocess.check_output(['xdotool', 'getmouselocation', '--shell'], env=env, text=True)
        # WINDOW identifies the surface under a stationary pointer and can change on mapping.
        coordinates = lambda value: [line for line in value.splitlines() if line.startswith(('X=', 'Y='))]
        pointer_unchanged = coordinates(desktop_pointer) == coordinates(after)
        (output / 'desktop-pointer.json').write_text(json.dumps({'before': desktop_pointer, 'after': after}))
    checkpoint = json.loads((output / 'checkpoint.json').read_text())
    # innerText contains the pointer pad label followed by the fixture JSON.
    body = checkpoint['body']
    observations = json.loads(body[body.index('{'):])
    events = observations['observations']
    required = {'click', 'contextmenu', 'pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'beforeinput'}
    png = (output / 'capture.png').read_bytes()
    dimensions = struct.unpack('>II', png[16:24])
    criteria = {
        'isolated_world': checkpoint['pageGlobal'] == 'undefined',
        'trusted_events': bool(events) and all(event['trusted'] for event in events),
        'event_types': required <= {event['type'] for event in events},
        'hover': any(event['type'] == 'pointermove' and event.get('buttons') == 0 and event.get('x') == 30 and event.get('y') == 160 for event in events),
        'drag_buttons': any(event['type'] == 'pointermove' and event.get('buttons') == 1 for event in events),
        'chord_event': any(event['type'] == 'keydown' and (event.get('ctrl') or event.get('meta')) for event in events),
        'chord_select_all': observations['input'] == 'remplacé漢🙂',
        'contenteditable_unicode': observations['editor'].startswith('éditeur漢🙂'),
        'contenteditable_enter': any(event['type'] == 'keydown' and event.get('key') == 'Enter' and event['target'] == 'DIV' for event in events),
        'visible_png': png[:8] == b'\x89PNG\r\n\x1a\n' and all(0 < value <= 2000 for value in dimensions),
        'desktop_pointer_unchanged': pointer_unchanged,
    }
    result = {'passed': all(criteria.values()), 'criteria': criteria, 'events': len(events), 'png': dimensions,
              'platform': platform.platform(), 'native': run.stdout}
    (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    assert result['passed'], [name for name, passed in criteria.items() if not passed]


if __name__ == '__main__':
    main()
