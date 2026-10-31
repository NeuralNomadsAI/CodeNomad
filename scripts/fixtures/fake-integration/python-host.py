"""Drives the reference discovery client the way a headless native host does, inside a fixture.

Run with `python -I` and the fixture environment. Reads {"action", "rpc_id", "offer", "config_dir"} on stdin,
then prints the discovered service URLs, the advertise or withdraw results and every file and network access
made after start-up, so the caller can prove that nothing outside the fixture was read, written or reached.
The token arrives on stdin and is never printed.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")
sys.path.insert(0, VENDOR)

accesses = []


def audit(event, args):
    if event == "open" and isinstance(args[0], (str, bytes)):
        accesses.append({"kind": "open", "path": os.fsdecode(args[0]), "mode": str(args[1])})
    elif event in ("os.listdir", "os.scandir") and isinstance(args[0], (str, bytes)):
        accesses.append({"kind": "list", "path": os.fsdecode(args[0])})
    elif event == "socket.connect":
        address = args[1]
        accesses.append({"kind": "connect", "address": "%s:%s" % (address[0], address[1]) if isinstance(address, tuple) else str(address)})


request = json.load(sys.stdin)
sys.addaudithook(audit)
import opencode_service  # noqa: E402  imported under the hook, so its own reads are recorded too

prefixes = tuple(os.path.normcase(os.path.realpath(prefix)) for prefix in {sys.base_prefix, sys.prefix, sys.exec_prefix, HERE})


def outside_python(access):
    if access["kind"] == "connect":
        return True
    path = os.path.normcase(os.path.realpath(access["path"]))
    return not any(path == prefix or path.startswith(prefix + os.sep) for prefix in prefixes)


services = [service.url for service in opencode_service.discover()]
if request["action"] == "advertise":
    results = opencode_service.advertise_all(request["rpc_id"], request["offer"], config_dir_setting=request["config_dir"])
else:
    offer = request["offer"]
    results = opencode_service.withdraw_all(request["rpc_id"], offer["offer_key"], offer["token"], config_dir_setting=request["config_dir"])
print(json.dumps({
    "services": services,
    "results": results,
    "candidates": opencode_service.location_candidates(request["config_dir"]),
    "accesses": [access for access in accesses if outside_python(access)],
}))
