// Private native drain regression. No addon/SDK-shaped ownership assertions.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
setTimeout(() => process.exit(91), 20000);
let input = Buffer.alloc(0), challenged = false, boot;
process.stdin.on('data', bytes => {
  input = Buffer.concat([input, bytes]);
  if (!challenged && input.length >= 64) {
    process.stdout.write(input.subarray(0, 64));
    input = input.subarray(64); challenged = true;
  }
  if (challenged && !boot && input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    boot = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)));
    start();
  }
});
function start() {
  const idle = 'setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)';
  const backend = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{detached:true,stdio:'ignore'});process.stdout.write(String(d.pid)+'\\n');${idle}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  backend.stdout.once('data', bytes => {
    fs.writeFileSync('members.json', JSON.stringify({ backend: backend.pid, descendant: Number(bytes.toString().trim()) }));
    connect(backend.pid, Number(bytes.toString().trim()));
  });
}
function connect(backend, descendant) {
  if (boot.controlPipe) require('./broker.cjs').connect(boot, 'manager.control', boot.controlPipe);
  const key = Buffer.from(boot.secret, 'hex');
  const mac = bytes => crypto.createHmac('sha256', key).update(bytes).digest();
  const challenge = crypto.randomBytes(32).toString('hex');
  const proof = domain => mac(`codenomad-runtime-v1\n${boot.profile}\n${boot.generation}\n${boot.role}\n${boot.peer.pid}\n${boot.peer.creationFiletime}\n${boot.supervisor.pid}\n${boot.supervisor.creationFiletime}\n${challenge}\n${domain}`).toString('hex');
  const socket = net.connect(boot.pipe);
  socket.on('error', () => {});
  const identity = Buffer.concat([Buffer.from('CNHRv001'), Buffer.from(boot.profile, 'hex'), Buffer.from(boot.generation.replaceAll('-', ''), 'hex')]);
  function send(id, opcode, payload) {
    const tail = Buffer.alloc(6); tail.writeUInt32LE(id); tail[4] = opcode;
    const content = Buffer.concat([identity, tail, payload]);
    const size = Buffer.alloc(4); size.writeUInt32LE(content.length + 32);
    socket.write(Buffer.concat([size, content, mac(content)]));
  }
  function member(id, pid) {
    const payload = Buffer.concat([crypto.randomBytes(32), Buffer.alloc(4)]);
    payload.writeUInt32LE(pid, 32); send(id, 1, payload);
  }
  socket.once('connect', () => {
    const hello = Buffer.from(JSON.stringify({ v: 1, profile: boot.profile, generation: boot.generation, role: boot.role, peer: boot.peer, challenge, proof: proof('client') }));
    const size = Buffer.alloc(4); size.writeUInt32LE(hello.length);
    socket.write(Buffer.concat([size, hello]));
  });
  let data = Buffer.alloc(0), authenticated = false;
  socket.on('data', bytes => {
    data = Buffer.concat([data, bytes]);
    while (data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) {
      const frame = data.subarray(4, 4 + data.readUInt32LE(0));
      data = data.subarray(4 + data.readUInt32LE(0));
      if (!authenticated) {
        const hello = JSON.parse(frame);
        if (hello.proof !== proof('server')) process.exit(92);
        authenticated = true; member(1, backend); continue;
      }
      const content = frame.subarray(0, -32);
      if (!crypto.timingSafeEqual(frame.subarray(-32), mac(content)) || !content.subarray(0, 56).equals(identity) || content[61] !== 1) process.exit(93);
      const id = content.readUInt32LE(56);
      if (id === 1) member(2, descendant);
      else if (id === 2) send(3, 3, Buffer.alloc(0));
      else if (id === 3 && content[60] === 3 && content.length === 62) {
        fs.writeFileSync('ack.json', JSON.stringify({ acknowledgedAt: Date.now() }));
        setTimeout(() => { fs.writeFileSync('closed.json', JSON.stringify({ closedAt: Date.now() })); socket.destroy(); }, boot.application.closeMs);
        setTimeout(() => process.exit(0), boot.application.exitMs);
      } else process.exit(94);
    }
  });
}
