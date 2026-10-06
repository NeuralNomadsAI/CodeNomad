// Private authenticated peer; no service command, addon load or daemon access.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
function connect(boot, role, pipe, closed = () => {}) {
  const socket = net.connect(pipe), challenge = crypto.randomBytes(32).toString('hex');
  const proof = domain => crypto.createHmac('sha256', Buffer.from(boot.secret, 'hex'))
    .update(`codenomad-runtime-v1\n${boot.profile}\n${boot.generation}\n${role}\n${boot.peer.pid}\n${boot.peer.creationFiletime}\n${boot.supervisor.pid}\n${boot.supervisor.creationFiletime}\n${challenge}\n${domain}`).digest('hex');
  socket.once('connect', () => {
    const hello = Buffer.from(JSON.stringify({ v: 1, profile: boot.profile, generation: boot.generation, role, peer: boot.peer, challenge, proof: proof('client') }));
    const size = Buffer.alloc(4); size.writeUInt32LE(hello.length);
    socket.write(Buffer.concat([size, hello]));
  });
  let data = Buffer.alloc(0), authenticated = false;
  socket.on('data', bytes => {
    data = Buffer.concat([data, bytes]);
    if (data.length > 8192) process.exit(92);
    if (!authenticated && data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) {
      const hello = JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)));
      if (hello.proof !== proof('server')) process.exit(93);
      authenticated = true; data = Buffer.alloc(0);
    }
  });
  socket.on('error', () => {});
  socket.once('close', closed);
  return socket;
}
exports.connect = connect;
if (require.main === module) {
  setTimeout(() => process.exit(91), 20000);
  let input = Buffer.alloc(0), challenged = false, boot;
  process.stdin.on('data', bytes => {
    input = Buffer.concat([input, bytes]);
    if (input.length > 8192) process.exit(94);
    if (!challenged && input.length >= 64) {
      process.stdout.write(input.subarray(0, 64)); input = input.subarray(64); challenged = true;
    }
    if (challenged && !boot && input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
      boot = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)));
      fs.writeFileSync('broker.json', JSON.stringify({ pid: process.pid }));
      connect(boot, 'broker.control', boot.controlPipe);
      connect(boot, boot.role, boot.pipe, () => {
        fs.writeFileSync('broker-eof.json', JSON.stringify({ closedAt: Date.now() }));
        setTimeout(() => process.exit(0), JSON.parse(fs.readFileSync('broker-delay.json')).delayMs);
      });
    }
  });
}
