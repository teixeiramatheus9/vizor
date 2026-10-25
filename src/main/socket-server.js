import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// win32 named pipes live in the pipe namespace: nothing to mkdir or unlink.
export function isPipePath(socketPath) {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

// A client that waits (the rule guard) gets one JSON line back through
// reply(obj); fire-and-forget clients (hook-emit) never see one. reply.end()
// hangs up without an answer, and reply.onClose(cb) fires when the client
// leaves.
function replierFor(socket) {
  const reply = (payload) => {
    if (!socket.destroyed && socket.writable) socket.end(`${JSON.stringify(payload)}\n`);
  };
  reply.end = () => {
    if (!socket.destroyed) socket.end();
  };
  reply.onClose = (callback) => socket.once('close', callback);
  return reply;
}

export function startSocketServer(socketPath, onEvent, log) {
  if (!isPipePath(socketPath)) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // no stale socket, fine
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    const reply = replierFor(socket);
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line), reply);
        } catch (error) {
          log(`socket-server: dropped bad line: ${error}`);
        }
      }
    });
    socket.on('error', () => {
      // client went away mid-write; nothing to do
    });
  });

  server.on('error', (error) => log(`socket-server: ${error}`));
  server.listen(socketPath);
  return server;
}

// The socket file used to be left behind on quit — only the next start cleaned
// it up, and only because it unlinks a stale one before listening.
export function stopSocketServer(server, socketPath) {
  try {
    server?.close();
  } catch {
    // never listened
  }
  if (!isPipePath(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // already gone
    }
  }
}
