import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { setTimeout } from "node:timers/promises"
import { mutateWindowsSupervisionFile } from "./service-supervision-windows-gate"

test("both scheduled actions request a hidden PowerShell window", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-launch-"))
  const fixture = path.join(root, "check.ps1")
  await writeFile(fixture, String.raw`
param([string]$Guard)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Guard,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'syntax'}
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Arguments'},$true)
. ([scriptblock]::Create($f.Extent.Text))
$d=@{script='C:\private path\guard.ps1'};$Directory='C:\private path';$Key='a'*64
foreach($mode in @('Main','Recovery')){
 $args=Arguments $mode
 if($args -notmatch '(?:^| )-WindowStyle Hidden(?: |$)'){throw ($mode+': visible action')}
 if(!$args.Contains('-File "C:\private path\guard.ps1" -Directory "C:\private path" -Key '+$Key+' -Mode '+$mode)){throw 'argv changed'}
}
'hidden actions'
`)
  const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture, "-Guard", path.join(import.meta.dirname, "service-supervision-windows.ps1")],
    { windowsHide: true, timeout: 15_000 })
  assert.match(stdout, /hidden actions/)
  const guard = await readFile(new URL("./service-supervision-windows.ps1", import.meta.url), "utf8")
  assert.match(guard, /CreateProcessW\([^\n]+\$true,0x08000400,/, "host and WSL child creation retain CREATE_NO_WINDOW")
})

test("Main hosts and restarts a windowless fake child, then releases it unchanged at OFF", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-child-")), key = randomBytes(32).toString("hex")
  const directory = path.join(root, key), exec = promisify(execFile)
  await mkdir(directory)
  const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true, timeout: 5000 })
  const source = path.join(root, "child.cs"), binary = path.join(root, "child.exe"), probe = path.join(root, "probe.cjs")
  await writeFile(source, `using System;using System.IO;using System.Diagnostics;using System.Threading;using System.Runtime.InteropServices;
    class Child { [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
      static int Main(string[] args) { if(args.Length!=2||args[0]!="serve"||args[1]!="--service")return 1;
        File.WriteAllText("child.txt",Process.GetCurrentProcess().Id+"|"+GetConsoleWindow().ToInt64());
        while(!File.Exists("exit"))Thread.Sleep(20);File.Delete("exit");return 0; } }`)
  await exec(path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    ["/nologo", "/target:exe", `/out:${binary}`, source], { windowsHide: true, timeout: 15_000 })
  await writeFile(probe, `const fs=require('fs'),path=require('path'),dir=process.argv[2],m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    let state='absent';try{const pid=Number(fs.readFileSync(path.join(dir,'child.txt'),'utf8').split('|')[0]);process.kill(pid,0);state='healthy'}catch{}
    console.log(JSON.stringify({revision:m.revision,permitted:true,targetReady:true,health:{state}}));`)
  const guard = path.join(import.meta.dirname, "service-supervision-windows.ps1"), file = path.join(directory, "manifest.json")
  const manifest = { v: 1, key, revision: 1, desired: "on", namespace: { platform: "win32", user: stdout.trim() }, target: { binary } }
  await writeFile(file, JSON.stringify(manifest))
  await writeFile(path.join(directory, "windows.json"), JSON.stringify({ v: 1, key, directory, script: guard, powershell,
    node: process.execPath, probe, launcher: binary, environment: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: root, TMP: root } }))
  const main = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", guard,
    "-Directory", directory, "-Key", key, "-Mode", "Main"], { windowsHide: true, stdio: "ignore" })
  const ended = new Promise<number | null>((resolve, reject) => { main.once("exit", resolve); main.once("error", reject) })
  async function until<T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 15_000
    while (Date.now() < end) { try { const value = await read(); if (match(value)) return value } catch {} await setTimeout(50) }
    throw new Error("fake child deadline")
  }
  const child = async () => (await readFile(path.join(directory, "child.txt"), "utf8")).split("|").map(Number)
  try {
    const first = await until(child, value => value.length === 2)
    assert.equal(first[1], 0)
    await until(async () => JSON.parse(await readFile(path.join(directory, "windows-status.json"), "utf8")), value => value.mode === "hosted")
    await writeFile(path.join(directory, "exit"), "")
    const second = await until(child, value => value[0] !== first[0])
    assert.equal(second[1], 0, "restart retains CREATE_NO_WINDOW")
    await until(() => mutateWindowsSupervisionFile(file, async () => JSON.stringify({ ...manifest, revision: 2, desired: "off" })).then(() => true), Boolean)
    assert.equal(await Promise.race([ended, setTimeout(15_000, "timeout", { ref: false })]), 0)
    process.kill(second[0]!, 0)
    assert.deepEqual(await child(), second, "OFF preserves the hosted process")
  } finally {
    await writeFile(path.join(directory, "exit"), "")
    try {
      await until(() => mutateWindowsSupervisionFile(file, async () => JSON.stringify({ ...manifest, revision: 2, desired: "off" })).then(() => true), Boolean)
      await Promise.race([ended, setTimeout(15_000, undefined, { ref: false })])
    } finally { if (main.exitCode === null) main.kill(); await ended }
    await until(async () => { const [pid] = await child(); try { process.kill(pid!, 0); return false } catch { return true } }, Boolean)
  }
})

test("scheduled launcher is a GUI image, creates no console, preserves argv and exit status", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-launcher-")), exec = promisify(execFile)
  const compiler = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
  const launcher = path.join(root, "launcher.exe"), probe = path.join(root, "probe.exe"), output = path.join(root, "result.txt")
  await exec(compiler, ["/nologo", "/target:winexe", `/out:${launcher}`, path.join(import.meta.dirname, "service-supervision-windows-launcher.cs")], { windowsHide: true, timeout: 15_000 })
  const image = await readFile(launcher), pe = image.readUInt32LE(0x3c)
  assert.equal(image.readUInt16LE(pe + 24 + 68), 2, "IMAGE_SUBSYSTEM_WINDOWS_GUI")
  const source = path.join(root, "probe.cs")
  await writeFile(source, `using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
    class Probe { [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
      static int Main(string[] args) { var lines=new string[args.Length]; lines[0]=GetConsoleWindow().ToInt64().ToString();
        for(int i=1;i<args.Length;i++) lines[i]=Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
        File.WriteAllLines(args[0],lines); return 23; } }`)
  await exec(compiler, ["/nologo", "/target:exe", `/out:${probe}`, source], { windowsHide: true, timeout: 15_000 })
  const values = ["a b", 'a"b', "", "a\\", "C:\\path with spaces\\", "é日本語"]
  await assert.rejects(exec(launcher, [probe, output, ...values], { windowsHide: true, timeout: 15_000 }),
    error => (error as { code?: number }).code === 23)
  const [console, ...lines] = (await readFile(output, "utf8")).trimEnd().split(/\r?\n/)
  assert.equal(console, "0", "CREATE_NO_WINDOW reaches the console child")
  assert.deepEqual(lines.map(line => Buffer.from(line, "base64").toString("utf8")), values)
})
