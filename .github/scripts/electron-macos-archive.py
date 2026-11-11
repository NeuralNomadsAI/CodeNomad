"""Private CI gate for the macOS Electron artifact; Python standard library only."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unicodedata
import zipfile


ARM_ZIP = re.compile(r"CodeNomad-Electron-macos-arm64-[A-Za-z0-9.+_-]+\.zip")
MAX_ARCHIVE = 1024 ** 3


def require(ok, message):
    if not ok:
        raise ValueError(message)


def key(name):
    return unicodedata.normalize("NFD", name).casefold()


def parts(name):
    require(name and "\x00" not in name and "\\" not in name, "invalid ZIP name")
    require(not name.endswith("//"), "ambiguous directory suffix")
    require(not name.startswith("/") and not re.match(r"^[A-Za-z]:", name), "absolute ZIP name")
    result = name.rstrip("/").split("/")
    require(all(p not in ("", ".", "..") and ":" not in p for p in result), "unsafe ZIP path")
    return result


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_extra(extra):
    offset = 0
    while offset < len(extra):
        require(offset + 4 <= len(extra), "malformed ZIP extra")
        tag, size = struct.unpack_from("<HH", extra, offset)
        offset += 4 + size
        # Unix time/uid/gid only: no alternate paths, hardlinks or ZIP64.
        require(offset <= len(extra) and tag in (0x5855, 0x5455, 0x7875), "unsupported ZIP extra")


def validate(path, outer=False):
    """Read every member (CRC/EOF), then validate native names and transitive links."""
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_ARCHIVE,
            "invalid archive file/size")
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - 65557))
        tail = stream.read()
    end = tail.rfind(b"PK\x05\x06")
    require(end >= 0 and len(tail) >= end + 22, "missing ZIP end")
    require(end + 22 + struct.unpack_from("<H", tail, end + 20)[0] == len(tail), "ZIP trailing bytes")
    require(struct.unpack_from("<HH", tail, end + 4) == (0, 0), "split ZIP")
    # ditto writes raw UTF-8 even without bit 11 (e.g. fastify's snow fixture).
    # Decode those exact bytes as UTF-8 too, before macOS alias/path validation.
    with zipfile.ZipFile(path, metadata_encoding="utf-8") as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= (16 if outer else 100000), "ZIP member count")
        require(sum(i.file_size for i in infos) <= 2 * MAX_ARCHIVE, "ZIP total size")
        entries, aliases, links = {}, {}, {}
        for info in infos:
            name = info.orig_filename
            components = parts(name)
            name = "/".join(components)
            require(name not in entries, "duplicate ZIP entry")
            for n in range(1, len(components) + 1):
                prefix = "/".join(components[:n])
                require(aliases.setdefault(key(prefix), prefix) == prefix, "macOS ZIP name alias")
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            require(kind in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK), "special ZIP entry")
            directory = info.is_dir()
            require(not directory or kind in (0, stat.S_IFDIR), "ZIP directory type")
            require(kind != stat.S_IFDIR or directory, "ZIP directory suffix")
            require(not info.external_attr & 0x10 or directory, "DOS directory suffix")
            require(not info.flag_bits & 1 and info.compress_type in (0, 8), "encrypted/unsupported ZIP")
            require(info.file_size <= MAX_ARCHIVE and info.file_size <= max(1, info.compress_size) * 1000,
                    "ZIP expansion bound")
            check_extra(info.extra)
            with path.open("rb") as raw:
                raw.seek(info.header_offset)
                header = raw.read(30)
                require(len(header) == 30 and header[:4] == b"PK\x03\x04", "bad local ZIP header")
                flags, method = struct.unpack_from("<HH", header, 6)
                name_size, extra_size = struct.unpack_from("<HH", header, 26)
                require(flags == info.flag_bits and method == info.compress_type, "ZIP header mismatch")
                require(raw.read(name_size).decode("utf-8") == info.orig_filename, "local ZIP name mismatch")
                check_extra(raw.read(extra_size))
            if outer:
                require(len(components) == 1 and not directory and kind in (0, stat.S_IFREG),
                        "outer ZIP must contain regular basenames")
            else:
                require(components[0] in ("CodeNomad.app", "__MACOSX"), "unexpected bundle root")
                require(components[0] != "__MACOSX" or kind != stat.S_IFLNK, "metadata link")
            payload = bytearray() if kind == stat.S_IFLNK else None
            if payload is not None:
                require(info.file_size <= 4096, "oversized link")
            with archive.open(info) as stream:
                count = 0
                while chunk := stream.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= info.file_size, "ZIP size mismatch")
                    if payload is not None:
                        payload.extend(chunk)
                require(count == info.file_size, "truncated ZIP member")
            entries[name] = (info, "dir" if directory else "link" if payload is not None else "file")
            if payload is not None:
                target = payload.decode("utf-8")
                require(target and not target.startswith("/") and not re.match(r"^[A-Za-z]:", target)
                        and not any(c in target for c in ("\\", "\x00", ":")), "unsafe link target")
                links[name] = target
        for name, (_, kind) in entries.items():
            ancestors = name.split("/")[:-1]
            for n in range(1, len(ancestors) + 1):
                parent = "/".join(ancestors[:n])
                require(parent not in entries or entries[parent][1] == "dir", "write under non-directory")
            if name.startswith("__MACOSX/"):
                bits = name.split("/")[1:]
                if kind == "dir":
                    require(bits[0] == "CodeNomad.app", "unexpected metadata directory")
                    counterpart = "/".join(bits)
                    require(counterpart in entries or any(n.startswith(counterpart + "/") for n in entries),
                            "orphan metadata directory")
                else:
                    require(bits[-1].startswith("._"), "unexpected metadata file")
                    bits[-1] = bits[-1][2:]
                    require("/".join(bits) in entries, "orphan AppleDouble metadata")
        for name, target in links.items():
            pending = name.split("/")[:-1] + target.split("/")
            resolved, seen = [], set()
            while pending:
                bit, *pending = pending
                if bit in ("", "."):
                    continue
                if bit == "..":
                    require(len(resolved) > 1, "escaping link")
                    resolved.pop()
                    continue
                resolved.append(bit)
                current = "/".join(resolved)
                require(resolved[0] == "CodeNomad.app", "link outside app")
                if current in links:
                    require(current not in seen, "link cycle")
                    seen.add(current)
                    pending = links[current].split("/") + pending
                    resolved.pop()
            destination = "/".join(resolved)
            require(destination in entries or any(n.startswith(destination + "/") for n in entries),
                    "dangling link")
        if outer:
            candidates = [i for n, (i, _) in entries.items() if ARM_ZIP.fullmatch(n)]
            require(len(candidates) == 1, "expected exactly one ARM ZIP")
            return candidates[0].filename
        require("CodeNomad.app" not in entries or entries["CodeNomad.app"][1] == "dir", "app root type")
        return digest(path)


def run(command, env, cwd):
    result = subprocess.run([str(c) for c in command], env=env, cwd=cwd, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    print(result.stdout, end="", flush=True)
    result.check_returncode()
    return result.stdout.strip()


def smoke(app, source, node, private, runner_arch):
    """All native commands, including the packaged process, get a positive environment."""
    env = {"PATH": f"{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
           "HOME": str(private / "home"), "TMPDIR": str(private / "tmp"),
           "XDG_CONFIG_HOME": str(private / "config"), "XDG_CACHE_HOME": str(private / "cache"),
           "XDG_DATA_HOME": str(private / "data"), "CLI_CONFIG": str(private / "config/config.yaml"),
           "CODENOMAD_PROFILE": "ci-arm-smoke", "CLI_UI_NO_UPDATE": "1",
           "ELECTRON_RUN_AS_NODE": "1", "ELECTRON_NO_ASAR": "1",
           "npm_config_offline": "true", "npm_config_update_notifier": "false",
           "npm_config_audit": "false", "npm_config_fund": "false",
           "npm_config_userconfig": str(private / "config/npmrc"),
           "npm_config_cache": str(private / "cache/npm")}
    for name in ("home", "tmp", "config", "cache", "data"):
        (private / name).mkdir()
    require(runner_arch == "ARM64", "RUNNER_ARCH must be ARM64")
    require(run(["/usr/bin/uname", "-m"], env, private) == "arm64", "non-ARM kernel")
    require(run([node, "-p", "process.platform + '/' + process.arch"], env, private) == "darwin/arm64",
            "non-ARM host Node")
    # -i returns empty for the absent proc_translated key on native ARM.
    translated = run(["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"], env, private)
    require(translated in ("", "0"), "Rosetta process")
    exe, resources = app / "Contents/MacOS/CodeNomad", app / "Contents/Resources"
    require(exe.is_file() and os.access(exe, os.X_OK) and resources.is_dir(), "missing bundle runtime")
    for required in ("app.asar", "server/dist/bin.js", "node/darwin-arm64/npm/bin/npm-cli.js"):
        require((resources / required).is_file(), "missing bundle resource: " + required)
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], env, private)
    require(run(["/usr/bin/lipo", "-archs", exe], env, private) == "arm64", "non-ARM executable slice")
    run(["/usr/bin/file", exe], env, private)
    require(run([exe, "-p", "process.platform + '/' + process.arch"], env, private) == "darwin/arm64",
            "non-ARM packaged process")
    script = source / "scripts/smoke-packaged-resources.cjs"
    print(f"smoke source={script} electron={exe} resources={resources}", flush=True)
    output = run([node, script, "--resources", resources, "--target", "darwin-arm64", "--electron", exe],
                 env, private)
    require("skipping executable smoke" not in output, "executable smoke skipped")
    for marker in ("packaged server static checks ok for darwin-arm64", "Electron's integrated Node version ok:",
                   "bundled npm ", " engine ok:", "packaged dependency imports ok"):
        require(marker in output, "missing smoke success marker: " + marker)


def qualify(download, source, node):
    os.umask(0o077)
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    require(download.is_relative_to(runner_temp) and download.is_dir() and not download.is_symlink(),
            "download outside RUNNER_TEMP")
    files = list(download.iterdir())
    require(len(files) == 1 and files[0].is_file() and not files[0].is_symlink(), "expected one outer ZIP")
    with tempfile.TemporaryDirectory(prefix="electron-arm-", dir=runner_temp) as directory:
        private = Path(directory)
        outer = private / "artifact.zip"
        require(files[0].stat().st_size <= MAX_ARCHIVE, "outer archive too large")
        shutil.copyfile(files[0], outer)
        outer.chmod(0o400)
        selected = validate(outer, outer=True)
        payload = private / "payload.zip"
        with zipfile.ZipFile(outer, metadata_encoding="utf-8") as archive:
            with archive.open(selected) as src, payload.open("xb") as dst:
                shutil.copyfileobj(src, dst)
        payload.chmod(0o400)
        sha = validate(payload)
        print(json.dumps({"payload_name": selected, "payload_sha256": sha,
                          "outer_sha256": digest(outer)}), flush=True)
        extracted = private / "extracted"
        extracted.mkdir()
        subprocess.run(["/usr/bin/ditto", "-x", "-k", str(payload), str(extracted)],
                       env={"PATH": "/usr/bin:/bin", "HOME": str(private), "LANG": "en_US.UTF-8"},
                       check=True, timeout=240)
        require(digest(payload) == sha, "payload changed during extraction")
        require({p.name for p in extracted.iterdir()} == {"CodeNomad.app"}, "unexpected extracted root")
        app = extracted / "CodeNomad.app"
        require(app.is_dir() and not app.is_symlink(), "invalid extracted app")
        for root, dirs, files in os.walk(app, followlinks=False):
            for name in dirs + files:
                path = Path(root) / name
                require(path.resolve(strict=True).is_relative_to(app), "extracted path escaped app")
                require(stat.S_IFMT(path.lstat().st_mode) in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK),
                        "extracted special entry")
        smoke(app, source, node, private, os.environ.get("RUNNER_ARCH"))
        print("Native ARM packaged smoke passed (exit 0)", flush=True)


if __name__ == "__main__":
    try:
        qualify(Path(sys.argv[1]).absolute(), Path(sys.argv[2]).resolve(strict=True),
                Path(sys.argv[3]).resolve(strict=True))
    except Exception as error:
        print(f"Electron ARM qualification failed: {error}", file=sys.stderr)
        sys.exit(1)
