let wss = null;
const clients = new Set();

function attach(server) {
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'connected' }));
    socket.on('close', () => clients.delete(socket));
  });
  return wss;
}

/** Broadcast an event to every connected dashboard client. Safe no-op if WS isn't attached (e.g. tests). */
function broadcast(event) {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ ...event, ts: new Date().toISOString() });
  for (const socket of clients) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

module.exports = { attach, broadcast };
