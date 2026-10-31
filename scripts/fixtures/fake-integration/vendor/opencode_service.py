"""Reference discovery client of a headless native host (Python standard library only).

Contract (spec/host-handshake.md, HST-18 to HST-22):

- Discovery reads only the service registrations under
  $XDG_STATE_HOME/opencode (default ~/.local/state/opencode): service.json,
  shared by the latest, dev, beta and next channels, and service-<name>.json
  for named services. A registration counts when its URL is loopback and
  /api/info answers with the same pid and version. Nothing here ever starts
  a daemon. Requests never use a proxy and never follow a redirect: the
  daemon password and the host token go to the loopback service only.
- advertise and withdraw target the conventional Location: the daemon's
  global configuration directory, $XDG_CONFIG_HOME/opencode (default
  ~/.config/opencode). A daemon started with OPENCODE_CONFIG_DIR has another
  global configuration directory that cannot be deduced: when the default
  Location reports the RPC unavailable, the client retries with the
  directory of an explicit add-on setting.
- Every service is targeted by default; a service name selects one
  registration file.
- Nothing is logged or printed: neither the daemon password nor the host
  token appears in results, reprs or exceptions.

Call these functions off the application's main thread.
"""

import base64
import hashlib
import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 3.0
SHARED_CHANNELS = ("latest", "dev", "beta", "next")
SERVICE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
LOOPBACK_HOSTS = ("127.0.0.1", "::1")
OUTCOMES = {
    "advertise": ("accepted", "renewed", "refused"),
    "withdraw": ("withdrawn", "none"),
}


def _home(env):
    # The daemon resolves its home like Node's os.homedir(): USERPROFILE on Windows, HOME elsewhere.
    names = ("USERPROFILE", "HOME") if os.name == "nt" else ("HOME",)
    for name in names:
        if env.get(name):
            return env[name]
    return os.path.expanduser("~")


def state_dir(env=None):
    env = os.environ if env is None else env
    return os.path.join(env.get("XDG_STATE_HOME") or os.path.join(_home(env), ".local", "state"), "opencode")


def default_config_dir(env=None):
    env = os.environ if env is None else env
    return os.path.join(env.get("XDG_CONFIG_HOME") or os.path.join(_home(env), ".config"), "opencode")


def registration_name(service_name):
    """File name for a service name: service.json for empty and shared channel names."""
    if service_name in (None, "") or service_name in SHARED_CHANNELS:
        return "service.json"
    if not SERVICE_NAME.match(service_name):
        raise ValueError("invalid service name")
    return "service-%s.json" % service_name


class Service(object):
    __slots__ = ("file", "url", "version", "_password")

    def __init__(self, file, url, version, password):
        self.file = file
        self.url = url
        self.version = version
        self._password = password

    def __repr__(self):
        return "Service(file=%r, url=%r, version=%r)" % (self.file, self.url, self.version)


def _headers(password):
    headers = {"content-type": "application/json"}
    if password is not None:
        raw = ("opencode:%s" % password).encode("utf-8")
        headers["authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    return headers


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# No proxy (environment or system settings) and no redirect.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _request(url, password, body=None, timeout=TIMEOUT):
    """(status, JSON body); raises OSError or ValueError when the service is unusable."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=_headers(password),
                                     method="GET" if body is None else "POST")
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"null")
        except ValueError:
            return error.code, None
    except http.client.HTTPException:
        # A process that does not speak HTTP holds the registered port.
        raise OSError("invalid HTTP response")


def _is_loopback(url):
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in LOOPBACK_HOSTS


def discover(service_name=None, env=None, timeout=TIMEOUT):
    """Healthy registered services; service_name selects one registration file."""
    directory = state_dir(env)
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    files = [name for name in names if name == "service.json" or re.match(r"^service-[A-Za-z0-9._-]{1,64}\.json$", name)]
    if service_name not in (None, ""):
        wanted = registration_name(service_name)
        files = [name for name in files if name == wanted]
    found = []
    for name in files:
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                info = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(info, dict) or not isinstance(info.get("url"), str) or not isinstance(info.get("pid"), int):
            continue
        if not _is_loopback(info["url"]):
            continue
        password = info.get("password") if isinstance(info.get("password"), str) else None
        try:
            status, body = _request(info["url"].rstrip("/") + "/api/info", password, timeout=timeout)
        except (OSError, ValueError):
            continue
        if status != 200 or not isinstance(body, dict) or body.get("pid") != info["pid"]:
            continue
        if not isinstance(info.get("version"), str) or body.get("version") != info["version"]:
            continue
        found.append(Service(name, info["url"], body.get("version"), password))
    return found


def location_candidates(config_dir_setting=None, env=None):
    """The default global configuration directory, then the explicit add-on setting."""
    candidates = [default_config_dir(env)]
    if config_dir_setting:
        setting = os.path.abspath(os.path.expanduser(config_dir_setting))
        if os.path.normcase(setting) != os.path.normcase(candidates[0]):
            candidates.append(setting)
    return candidates


def _unavailable(status, body):
    return status == 404 or (isinstance(body, dict) and body.get("type") in ("rpc.unavailable", "rpc.method_not_found"))


def call(service, rpc_id, method, payload, directory, timeout=TIMEOUT):
    url = "%s/api/rpc/%s/%s?%s" % (
        service.url.rstrip("/"),
        urllib.parse.quote(rpc_id, safe=""),
        urllib.parse.quote(method, safe=""),
        urllib.parse.urlencode({"location[directory]": directory}),
    )
    return _request(url, service._password, {"input": payload}, timeout=timeout)


def _outcome(method, status, body):
    output = body.get("output") if isinstance(body, dict) else None
    value = output.get("outcome") if isinstance(output, dict) else None
    return value if status == 200 and value in OUTCOMES[method] else "error"


def _each_service(method, rpc_id, payload, service_name, config_dir_setting, env, timeout):
    results = []
    for service in discover(service_name, env, timeout):
        outcome = "unavailable"
        for directory in location_candidates(config_dir_setting, env):
            try:
                status, body = call(service, rpc_id, method, payload, directory, timeout)
            except (OSError, ValueError):
                outcome = "error"
                break
            if _unavailable(status, body):
                continue
            outcome = _outcome(method, status, body)
            break
        results.append({"service": service.file, "outcome": outcome})
    return results


def advertise_all(rpc_id, offer, service_name=None, config_dir_setting=None, env=None, timeout=TIMEOUT):
    """Advertise one offer to every discovered service, or to the named one."""
    return _each_service("advertise", rpc_id, offer, service_name, config_dir_setting, env, timeout)


def withdraw_all(rpc_id, offer_key, token, service_name=None, config_dir_setting=None, env=None, timeout=TIMEOUT):
    payload = {"offer_key": offer_key, "token": token}
    return _each_service("withdraw", rpc_id, payload, service_name, config_dir_setting, env, timeout)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def capability_hash(capabilities):
    return hashlib.sha256(canonical_json(capabilities).encode("utf-8")).hexdigest()
