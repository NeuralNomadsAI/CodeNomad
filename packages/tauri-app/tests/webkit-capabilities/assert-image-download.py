"""Assert native context-menu downloads after an owned trial's marker file."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
from fixture import PNG_BASE64

marker = Path(sys.argv[1]).stat().st_mtime_ns
expected_count = int(sys.argv[2])
directory = Path(sys.argv[3]) if len(sys.argv) > 3 else Path.home() / 'Downloads'
expected = base64.b64decode(PNG_BASE64)
for _ in range(100):
    files = [p for p in directory.glob('*-image.png') if p.stat().st_mtime_ns >= marker]
    if len(files) == expected_count and all(p.read_bytes() == expected for p in files):
        break
    time.sleep(0.05)
assert len(files) == expected_count, [p.name for p in files]
for path in files:
    uuid.UUID(path.name.removesuffix('-image.png'))
    assert path.read_bytes() == expected, path.name
print(json.dumps({'files': [p.name for p in files], 'bytes': len(expected),
                  'sha256': hashlib.sha256(expected).hexdigest()}))
