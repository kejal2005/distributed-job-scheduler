require('dotenv').config();
const http = require('http');
const { createApp } = require('./app');
const wsHub = require('./utils/wsHub');

const PORT = process.env.PORT || 4000;
const app = createApp();
const server = http.createServer(app);
wsHub.attach(server);

server.listen(PORT, () => {
  console.log(`Job Scheduler API listening on port ${PORT}`);
  console.log(`WebSocket live-updates available at ws://localhost:${PORT}/ws`);
});

module.exports = server;
