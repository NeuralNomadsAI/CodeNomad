const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")
const { spawnSync } = require("node:child_process")

function python(code, args = []) {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "-c", code, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 120000,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

const workflow = (name) => yaml.parse(fs.readFileSync(path.join(__dirname, "../workflows", name), "utf8"))

test("Tauri Windows is the first binary build and gates every other platform", () => {
  const { jobs } = workflow("build-and-upload.yml")
  const first = jobs["build-tauri-windows"]
  assert.match(first["runs-on"], /^windows-/)
  assert.equal(first.needs, undefined)
  assert.equal(first.if, undefined)
  assert.equal(first["continue-on-error"], undefined)
  for (const [id, job] of Object.entries(jobs)) {
    if (!id.startsWith("build-") || id === "build-tauri-windows") continue
    assert.equal(job.needs, "build-tauri-windows", id)
    assert.equal(job["continue-on-error"], undefined, id)
  }
  assert.deepEqual(jobs["publish-tauri-updater"].needs, [
    "build-tauri-windows", "build-tauri-macos", "build-tauri-macos-arm64", "build-tauri-linux",
  ])
})

test("PR builds and both release channels share the ordering without bypassing PR tests", () => {
  const pr = workflow("pr-build.yml").jobs.build
  const release = workflow("reusable-release.yml").jobs["build-and-upload"]
  assert.equal(pr.uses, "./.github/workflows/build-and-upload.yml")
  assert.equal(release.uses, pr.uses)
  assert.equal(workflow("dev-release.yml").jobs.prerelease.uses, "./.github/workflows/reusable-release.yml")
  assert.equal(workflow("release.yml").jobs.release.uses, "./.github/workflows/reusable-release.yml")
  assert.deepEqual(pr.needs, [
    "authorize", "tests", "tests-browser", "tests-tauri-windows", "tests-opencode-compatibility",
    "tests-session-pruning-native", "tests-runtime-contracts", "tests-tauri-macos", "tests-tauri-webkit",
  ])
  assert.equal(pr.with.upload, false)
  assert.equal(pr.with.set_versions, false)
})

test("npm server publication installs the locked optional dependencies once before building", () => {
  const { steps } = workflow("manual-npm-publish.yml").jobs.publish
  const installs = steps.filter(step => /^node "\$PINNED_NPM_CLI" (?:ci|install)\b/.test(step.run ?? ""))
  assert.deepEqual(installs.map(step => step.run), ['node "$PINNED_NPM_CLI" ci --include=optional'])
  const build = steps.findIndex(step => step.run === 'node "$PINNED_NPM_CLI" run build --workspace packages/server')
  assert.ok(build > steps.indexOf(installs[0]), "build follows the frozen installation")
})

test("native ARM smoke consumes only the successful Intel producer's immutable artifact", () => {
  const { jobs } = workflow("build-and-upload.yml")
  const producer = jobs["build-macos"]
  const job = jobs["smoke-electron-macos-arm64"]
  assert.equal(producer["runs-on"], "macos-15-intel")
  assert.deepEqual(producer.outputs, {
    "artifact-id": "${{ steps.electron-artifact.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.electron-artifact.outputs.artifact-digest }}",
    "source-sha": "${{ steps.source.outputs.sha }}",
    "run-id": "${{ steps.source.outputs.run-id }}",
    "run-attempt": "${{ steps.source.outputs.run-attempt }}",
    started: "${{ steps.source.outputs.started }}",
  })
  const uploads = Object.values(jobs).flatMap(j => j.steps ?? []).filter(s => s.name?.startsWith("Upload Actions artifacts ("))
  assert.equal(uploads.length, 7, "same seven desktop Actions artifacts")
  const upload = producer.steps.find(s => s.id === "electron-artifact")
  assert.equal(upload.name, "Upload Actions artifacts (Electron macOS)")
  assert.equal(upload.if, "${{ inputs.upload_actions_artifacts }}")
  assert.deepEqual(upload.with, {
    name: "${{ inputs.actions_artifacts_name_prefix }}electron-macos",
    path: "packages/electron-app/release/*.zip",
    "retention-days": "${{ inputs.actions_artifacts_retention_days }}",
    "if-no-files-found": "error",
  })
  assert.match(producer.steps.find(s => s.id === "source").run, /git rev-parse HEAD/)
  assert.equal(producer.steps.find(s => s.name === "Build macOS binaries (Electron)").run,
    "npm run build:mac --workspace @neuralnomads/codenomad-electron-app")
  assert.match(producer.steps.find(s => s.name === "Verify bundled npm resource (Electron macOS)").run,
    /mac\/CodeNomad.app\/Contents\/Resources@darwin-x64 .*mac-arm64\/CodeNomad.app\/Contents\/Resources@darwin-arm64$/)
  assert.ok(producer.steps.some(s => s.name === "Validate Electron macOS codesign (unzipped)"))
  assert.equal(job.needs, "build-macos")
  assert.equal(job.if, "${{ inputs.upload_actions_artifacts && needs.build-macos.result == 'success' }}")
  assert.equal(workflow("pr-build.yml").jobs.build.with.upload_actions_artifacts, true)
  assert.equal(job["runs-on"], "macos-26")
  assert.equal(job["timeout-minutes"], 15)
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" })
  assert.equal(job["continue-on-error"], undefined)
  assert.equal(job.environment, undefined)
  assert.equal(job.secrets, undefined)
  assert.equal(job.env, undefined)
  const [checkout, node, identity, download, smoke] = job.steps
  assert.equal(job.steps.length, 5)
  assert.deepEqual(checkout.with, { ref: "${{ needs.build-macos.outputs.source-sha }}", "persist-credentials": false })
  assert.equal(checkout.uses, "actions/checkout@v7.0.1")
  assert.equal(node.uses, "actions/setup-node@v7.1.0")
  assert.deepEqual(node.with, { "node-version-file": ".node-version" })
  assert.equal(identity.env.ARTIFACT_ID, producer.outputs["artifact-id"].replace("steps.electron-artifact", "needs.build-macos"))
  assert.equal(identity.env.ARTIFACT_DIGEST, "${{ needs.build-macos.outputs.artifact-digest }}")
  assert.equal(identity.env.ARTIFACT_NAME, upload.with.name)
  assert.equal(identity.env.PR_HEAD, "${{ github.event.pull_request.head.sha }}")
  assert.equal(identity.env.GITHUB_TOKEN, "${{ github.token }}")
  assert.equal(download.uses, "actions/download-artifact@v8.0.2")
  assert.deepEqual(download.with, {
    "artifact-ids": "${{ needs.build-macos.outputs.artifact-id }}",
    path: "${{ steps.identity.outputs.download }}",
    "digest-mismatch": "error", "skip-decompress": true,
  })
  assert.deepEqual(smoke.env, { DOWNLOAD: "${{ steps.identity.outputs.download }}" })
  assert.match(smoke.run, /python3 \.github\/scripts\/electron-macos-archive.py "\$DOWNLOAD" "\$GITHUB_WORKSPACE" "\$\(command -v node\)"/)
  for (const step of job.steps) {
    assert.equal(step.if, undefined)
    assert.equal(step["continue-on-error"], undefined)
    assert.doesNotMatch(step.run ?? "", /\$\{\{|npm (?:ci|install)|npx|always\(|codesign.*--sign/)
    if (step !== identity) assert.doesNotMatch(JSON.stringify(step), /GITHUB_TOKEN|GH_TOKEN|secrets\.|github.token/)
  }
})

test("artifact identity rejects missing/mismatched provenance before download (API double, no network)", () => {
  const script = workflow("build-and-upload.yml").jobs["smoke-electron-macos-arm64"].steps[2].run.split("<<'PY'\n")[1].split("\nPY")[0]
  python(String.raw`
import contextlib, copy, datetime, io, json, os, pathlib, subprocess, sys, tempfile, urllib.request
from unittest.mock import patch, Mock
script = sys.argv[1]
source, workflow_sha, checksum = 'a' * 40, 'b' * 40, 'c' * 64
now = datetime.datetime.now(datetime.timezone.utc)
artifact = dict(id=123, name='pr-1-' + source + '-electron-macos', expired=False,
    workflow_run=dict(id=42, head_sha=source), digest='sha256:' + checksum, size_in_bytes=10,
    created_at=now.isoformat(), expires_at=(now + datetime.timedelta(days=1)).isoformat())
with tempfile.TemporaryDirectory() as tmp:
    env = dict(PRODUCER_SHA=source, PRODUCER_RUN='42', PRODUCER_ATTEMPT='2', PRODUCER_STARTED=str(int(now.timestamp())-1),
        GITHUB_RUN_ID='42', GITHUB_RUN_ATTEMPT='2', PR_HEAD=source, WORKFLOW_SHA=workflow_sha,
        ARTIFACT_ID='123', ARTIFACT_DIGEST=checksum, ARTIFACT_NAME=artifact['name'], GITHUB_TOKEN='test-only',
        GITHUB_API_URL='https://api.github.com', GITHUB_REPOSITORY='owner/repo', RUNNER_TEMP=tmp,
        GITHUB_OUTPUT=tmp+'/output', GITHUB_STEP_SUMMARY=tmp+'/summary')
    def execute(value, changes=None, head=source, error=False):
        with patch.dict(os.environ, env | (changes or {}), clear=True), \
             patch.object(subprocess, 'check_output', return_value=head+'\n'), \
             patch.object(urllib.request, 'build_opener', return_value=Mock(open=Mock(return_value=io.BytesIO(json.dumps(value).encode())))) as opener, \
             contextlib.redirect_stdout(io.StringIO()):
            try:
                exec(script, {})
            except (ValueError, KeyError, TypeError):
                assert error, 'unexpected rejection'
            else:
                assert not error, 'accepted invalid metadata'
            get = opener.return_value.open
            assert get.call_count <= 1
            if get.call_count:
                assert opener.call_args.args[0].redirect_request(None, None, None, None, None, None) is None
                request = get.call_args.args[0]
                assert request.full_url == 'https://api.github.com/repos/owner/repo/actions/artifacts/123'
    execute(artifact)
    for changes in ({'PRODUCER_SHA':''}, {'ARTIFACT_ID':''}, {'ARTIFACT_ID':'123,456'}, {'ARTIFACT_DIGEST':''},
                    {'PRODUCER_RUN':'43'}, {'PRODUCER_ATTEMPT':'1'}, {'PR_HEAD':'d'*40}):
        execute(artifact, changes, error=True)
    execute(artifact, head='d'*40, error=True)
    for field, value in [('id',124), ('name','other'), ('expired',True), ('digest','d'*64),
                         ('size_in_bytes',0), ('expires_at',(now-datetime.timedelta(days=1)).isoformat()),
                         ('created_at',(now-datetime.timedelta(days=1)).isoformat()),
                         ('workflow_run',dict(id=43,head_sha=source)), ('workflow_run',dict(id=42,head_sha='d'*40))]:
        execute(artifact | {field:value}, error=True)
    execute({}, error=True)
print('metadata: positive and 18 fail-closed cases; no network')
`, [script])
})

test("real stdlib ZIP validation and smoke subprocess doubles (not native ARM proof)", () => {
  const output = python(String.raw`
import contextlib, importlib.util, io, os, pathlib, stat, struct, subprocess, sys, tempfile, warnings, zipfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('archive', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
warnings.simplefilter('ignore', UserWarning)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    sequence = 0
    def zip_path(entries):
        global sequence
        sequence += 1
        p = root / (str(sequence)+'.zip')
        with zipfile.ZipFile(p, 'w') as z:
            for name, kind, content in entries:
                i = zipfile.ZipInfo(name)
                i.filename = name  # Keep deliberately hostile raw names on Windows too.
                i.create_system = 3
                i.external_attr = ((kind | 0o755) << 16)
                z.writestr(i, content)
        return p
    F, D, L = stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK
    base = [('CodeNomad.app/',D,b''), ('CodeNomad.app/Contents/',D,b'')]
    def rejected(p, outer=False):
        try:
            m.validate(p, outer)
        except (ValueError, zipfile.BadZipFile, UnicodeError):
            return
        raise AssertionError('accepted unsafe ZIP: '+str(p))
    framework = base + [
        ('CodeNomad.app/Contents/F.framework/Versions/A/bin',F,b'binary'),
        ('CodeNomad.app/Contents/F.framework/Versions/Current',L,b'A'),
        ('CodeNomad.app/Contents/F.framework/bin',L,b'Versions/Current/bin')]
    m.validate(zip_path(framework))
    m.validate(zip_path(base+[('__MACOSX/._CodeNomad.app',F,b'appledouble')]))
    # Clear UTF-8 bit in BOTH local and central records; bytes stay UTF-8, as ditto writes them.
    def unflag(p):
        raw = bytearray(p.read_bytes())
        for signature, flag_offset in ((b'PK\x03\x04',6),(b'PK\x01\x02',8)):
            start = 0
            while (start := raw.find(signature,start)) >= 0:
                flags = struct.unpack_from('<H',raw,start+flag_offset)[0]
                struct.pack_into('<H',raw,start+flag_offset,flags & ~0x800)
                start += 4
        p.write_bytes(raw)
        return p
    snow = 'CodeNomad.app/Contents/Resources/server/node_modules/@fastify/send/test/fixtures/snow ☃'
    m.validate(unflag(zip_path(base+[(snow+'/',D,b''),(snow+'/index.html',F,b'snow')])) )
    rejected(unflag(zip_path(base+[(snow,F,b'1'),(snow,F,b'2')])))
    rejected(unflag(zip_path(base+[(snow+'É',F,b'1'),(snow+'e\u0301',F,b'2')])))
    for name in ('../out','/out','C:/out','CodeNomad.app/../out','CodeNomad.app/back\\slash','CodeNomad.app/nul\x00end','CodeNomad.app//',
                 'Other.app/file', 'CodeNomad.app/a/../../out'):
        rejected(zip_path(base+[(name,F,b'x')]))
    for entries in (
        [('CodeNomad.app/File',F,b'x'),('CodeNomad.app/file',F,b'y')],
        [('CodeNomad.app/Dir/a',F,b'x'),('CodeNomad.app/dir/b',F,b'y')],
        [('CodeNomad.app/a',F,b'x'),('CodeNomad.app/a',F,b'y')],
        [('CodeNomad.app/a',stat.S_IFIFO,b'')],
        [('CodeNomad.app/a',L,b'../../out')],
        [('CodeNomad.app/a',L,b'/etc/passwd')],
        [('CodeNomad.app/a',L,b'B'),('CodeNomad.app/B',L,b'a')],
        [('CodeNomad.app/a',L,b'Contents'),('CodeNomad.app/a/write',F,b'x')],
        [('CodeNomad.app/a',L,b'b'),('CodeNomad.app/b',L,b'../../out')],
        [('CodeNomad.app/a',F,b'x'),('CodeNomad.app/a/write',F,b'x')],
        [('__MACOSX/._missing',F,b'x')],
    ):
        rejected(zip_path(base+entries))
    p = zip_path(base+[('CodeNomad.app/a',F,b'crc')])
    raw = bytearray(p.read_bytes()); raw[raw.index(b'crc')] ^= 1; p.write_bytes(raw); rejected(p)
    p = zip_path(base); p.write_bytes(p.read_bytes()[:-5]); rejected(p)
    p = zip_path(base); p.write_bytes(p.read_bytes()+b'trailer'); rejected(p)
    p = zip_path(base+[('CodeNomad.app/a',F,b'x')])
    raw = bytearray(p.read_bytes())
    for signature, offset in ((b'PK\x03\x04',6),(b'PK\x01\x02',8)):
        at = raw.index(signature)+offset; struct.pack_into('<H',raw,at,struct.unpack_from('<H',raw,at)[0] | 1)
    p.write_bytes(raw); rejected(p)
    p = zip_path(base)
    raw = bytearray(p.read_bytes()); struct.pack_into('<H',raw,6,0x800); p.write_bytes(raw); rejected(p)
    p = root/'bomb.zip'
    with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('CodeNomad.app/bomb',b'0'*2000000)
    rejected(p)
    arm = 'CodeNomad-Electron-macos-arm64-1.0.zip'
    intel = 'CodeNomad-Electron-macos-x64-1.0.zip'
    assert m.validate(zip_path([(arm,F,b'payload'),(intel,F,b'x64')]),True) == arm
    for entries in ([],[(intel,F,b'x64')],[(arm,F,b'a'),(arm.replace('1.0','2.0'),F,b'b')],
                    [(arm,L,b'elsewhere')],[(arm,F,b'a'),('../escape',F,b'x')]):
        rejected(zip_path(entries),True)
    # Mock only subprocess transport. Native tests still require an actual ARM runner.
    app = root/'CodeNomad.app'
    exe = app/'Contents/MacOS/CodeNomad'
    resources = app/'Contents/Resources'
    for p in (exe,resources/'app.asar',resources/'server/dist/bin.js',resources/'node/darwin-arm64/npm/bin/npm-cli.js'):
        p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(b'double'); p.chmod(0o755)
    markers = "packaged server static checks ok for darwin-arm64\nElectron's integrated Node version ok: v1\nbundled npm 1 engine ok: v1\npackaged dependency imports ok\n"
    def trial(arch='ARM64', bad=None):
        global sequence
        sequence += 1; private = root/('smoke'+str(sequence)); private.mkdir()
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            env = kwargs['env']
            assert not any(k in env for k in ('GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS','NODE_PATH','DYLD_INSERT_LIBRARIES','PROVIDER_KEY'))
            assert env['HOME'].startswith(str(private)) and env['npm_config_offline'] == 'true'
            program = pathlib.Path(command[0]).name
            output = {'uname':'arm64', 'node':'darwin/arm64', 'sysctl':'0','lipo':'arm64','CodeNomad':'darwin/arm64'}.get(program,'')
            is_smoke = len(command)>1 and str(command[1]).endswith('smoke-packaged-resources.cjs')
            if is_smoke:
                assert command[-1] == str(exe) and command[-3] == 'darwin-arm64'
                assert command[3] == str(resources)
                output = markers
            if bad == program: output = 'x64'
            if is_smoke and bad == 'skip': output += 'skipping executable smoke'
            if is_smoke and bad == 'marker': output = 'no markers'
            return subprocess.CompletedProcess(command, 17 if is_smoke and bad=='exit' else 0, output)
        with patch.object(m.subprocess,'run',side_effect=fake), patch.dict(os.environ,{'GITHUB_TOKEN':'do-not-inherit','NODE_OPTIONS':'hostile'}), contextlib.redirect_stdout(io.StringIO()):
            try: m.smoke(app,root,pathlib.Path('/control/node'),private,arch)
            except (ValueError,subprocess.CalledProcessError):
                assert arch!='ARM64' or bad
            else: assert arch=='ARM64' and not bad
        return calls
    assert trial()
    assert not trial(arch='X64')
    for bad in ('uname','node','sysctl','lipo','CodeNomad','skip','marker','exit'):
        trial(bad=bad)
print('ZIP positive/negative cases and subprocess failure propagation passed; not native ARM proof')
`, [path.join(__dirname, "electron-macos-archive.py")])
  assert.match(output, /failure propagation passed; not native ARM proof/)
})
