"""Check actual native app/guest scales after keys and native zoom-menu trials."""
from pathlib import Path
import re
import sys

samples = [tuple(map(float, match)) for match in re.findall(
    r'app=([0-9.]+) guest=([0-9.]+)', Path(sys.argv[1]).read_text())]
expected = [(1, 1), (1, 1.2), (1, 1), (1, .8), (1, 1),
            (1, 1.2), (1, 1), (1, .8), (1, 1)]
remaining = iter(samples)
for wanted in expected:
    assert any(sample == wanted for sample in remaining), (wanted, samples)
if '--app-fallback' in sys.argv:
    assert (1.2, 1) in samples and samples[-1] == (1, 1), samples
else:
    assert all(app == 1 for app, _ in samples), samples
print('PASS native keys/menu in-out-reset, isolated guest zoom; samples=' + str(samples))
