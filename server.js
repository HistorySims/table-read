const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// In-memory room store: { [code]: { hostId, players: [{ id, name }] } }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makeUniqueCode() {
  let code;
  do {
    code = generateCode();
  } while (rooms[code]);
  return code;
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Host creates a room
  socket.on('create-room', (callback) => {
    const code = makeUniqueCode();
    rooms[code] = { hostId: socket.id, players: [] };
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    console.log(`Room created: ${code} by ${socket.id}`);
    callback({ code });
  });

  // Player joins a room
  socket.on('join-room', ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) {
      return callback({ error: 'Room not found. Check your code and try again.' });
    }

    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return callback({ error: 'Please enter your name.' });
    }

    const player = { id: socket.id, name: trimmedName };
    room.players.push(player);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'player';
    socket.data.name = trimmedName;

    console.log(`${trimmedName} joined room ${code}`);

    // Tell the joining player it worked
    callback({ ok: true, name: trimmedName });

    // Tell everyone in the room (including host) the updated player list
    io.to(code).emit('player-list', room.players.map((p) => p.name));
  });

  socket.on('disconnect', () => {
    const { code, role, name } = socket.data;
    if (!code || !rooms[code]) return;

    const room = rooms[code];

    if (role === 'host') {
      // Host left — notify players and tear down the room
      io.to(code).emit('host-left');
      delete rooms[code];
      console.log(`Room ${code} closed (host disconnected)`);
    } else {
      // Player left — remove from list and notify others
      room.players = room.players.filter((p) => p.id !== socket.id);
      io.to(code).emit('player-list', room.players.map((p) => p.name));
      console.log(`${name} left room ${code}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Table Read server running at http://localhost:${PORT}`);
});
