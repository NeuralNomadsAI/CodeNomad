"""Drives the reference discovery client the way a headless native host does, inside a fixture.

Run with `python -I` and the fixture environment. Reads {"action", "rpc_id", "offer", "config_dir"} on stdin,
then prints the discovered service URLs, the advertise or withdraw results and every audited file, name
resolution and connection made after start-up, plus any audit event that escapes the hook (child processes, raw
sockets, ctypes, shutil), so the caller can check that they all stay inside the fixture.
The token arrives on stdin and is never printed.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")
sys.path.insert(0, VENDOR)

accesses = []
# Audit events whose string arguments are paths. Metadata reads (os.stat, os.path.exists) raise no audit event:
# the fixture environment keeps the home, profile and XDG folders those would resolve inside the fixture.
PATH_EVENTS = {"open": "open", "os.listdir": "list", "os.scandir": "list"}
WRITE_EVENTS = ("os.mkdir", "os.rmdir", "os.remove", "os.rename", "os.replace", "os.chmod", "os.chown", "os.utime",
                "os.truncate", "os.link", "os.symlink", "os.chdir", "os.chflags", "os.lchflags", "os.removexattr", "os.setxattr")
# A child process or raw socket use escapes this hook, so either fails the check outright.
FORBIDDEN_PREFIXES = ("subprocess.", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile", "os.fork",
                      "_winapi.CreateProcess", "ctypes.", "socket.bind", "socket.sendto", "socket.sendmsg", "shutil.")


def strings(args):
    return [os.fsdecode(arg) for arg in args if isinstance(arg, (str, bytes))]


def audit(event, args):
    if event in PATH_EVENTS:
        for path in strings(args[:1]):
            accesses.append({"kind": PATH_EVENTS[event], "path": path})
    elif event in WRITE_EVENTS:
        for path in strings(args):
            accesses.append({"kind": "write", "event": event, "path": path})
    if event == "socket.connect":
        address = args[1]
        accesses.append({"kind": "connect", "address": "%s:%s" % (address[0], address[1]) if isinstance(address, tuple) else str(address)})
    elif event == "socket.getaddrinfo":
        accesses.append({"kind": "resolve", "address": str(args[0])})
    if event.startswith(FORBIDDEN_PREFIXES):
        accesses.append({"kind": "forbidden", "event": event})


request = json.load(sys.stdin)
sys.addaudithook(audit)
import opencode_service  # noqa: E402  imported under the hook, so its own reads are recorded too

prefixes = tuple(os.path.normcase(os.path.realpath(prefix)) for prefix in {sys.base_prefix, sys.prefix, sys.exec_prefix, HERE})


def outside_python(access):
    if "path" not in access:
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
