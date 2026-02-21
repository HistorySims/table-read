const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const scripts = require('./scripts');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;

// Pre-compute line counts per character so clients can show them on the cast screen.
// Keeps the JSON files clean — no need to maintain counts by hand.
const preparedScripts = scripts.map((script) => {
  const counts = {};
  script.characters.forEach((c) => { counts[c.name] = 0; });
  script.beats.forEach((b) => {
    if (b.type === 'dialogue' && b.character in counts) counts[b.character]++;
  });
  return {
    ...script,
    characters: script.characters.map((c) => ({ ...c, lineCount: counts[c.name] })),
  };
});

// { [code]: { hostId, hostName, players:[{id,name}], script, assignments:{char:name|null}, state, currentBeat } }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeUniqueCode() {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  return code;
}

function allCharactersAssigned(room) {
  return room.script.characters.every((c) => room.assignments[c.name]);
}

function broadcastPlayerList(code) {
  const room = rooms[code];
  if (!room) return;
  const list = [
    { name: room.hostName, isHost: true },
    ...room.players.map((p) => ({ name: p.name, isHost: false })),
  ];
  io.to(code).emit('player-list', list);
}

function broadcastAssignments(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('assignments', room.assignments);
  io.to(code).emit('casting-complete', allCharactersAssigned(room));
}

function sendCurrentBeat(code) {
  const room = rooms[code];
  if (!room || room.state !== 'performance') return;

  const beat = room.script.beats[room.currentBeat];
  let activePlayer = null;
  if (beat.type === 'dialogue') activePlayer = room.assignments[beat.character] || null;

  io.to(code).emit('beat', {
    index: room.currentBeat,
    total: room.script.beats.length,
    beat,
    activePlayer,
  });

  // Auto-advance non-dialogue beats after 4 seconds
  if (beat.type !== 'dialogue') {
    const beatIndex = room.currentBeat;
    setTimeout(() => {
      if (rooms[code] && rooms[code].currentBeat === beatIndex && rooms[code].state === 'performance') {
        advanceBeat(code);
      }
    }, 4000);
  }
}

function advanceBeat(code) {
  const room = rooms[code];
  if (!room || room.state !== 'performance') return;

  room.currentBeat++;
  if (room.currentBeat >= room.script.beats.length) {
    room.state = 'ended';
    io.to(code).emit('performance-ended');
    return;
  }
  sendCurrentBeat(code);
}

app.use(express.static(path.join(__dirname, 'public')));

// Script catalogue — used by the host's script-selection screen
app.get('/api/scripts', (req, res) => {
  res.json(preparedScripts.map((s, i) => ({
    id: i,
    title: s.title,
    author: s.author || null,
    description: s.description || null,
    characters: s.characters.map((c) => ({
      name: c.name,
      lineCount: c.lineCount,
      difficulty: c.difficulty || null,
    })),
    beatCount: s.beats.length,
  })));
});

io.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong'));

  // Host creates a room with a chosen script
  socket.on('create-room', ({ name, scriptIndex = 0 } = {}, callback) => {
    if (typeof callback !== 'function') return;

    const trimmedName = (name || '').trim();
    if (!trimmedName) return callback({ error: 'Please enter your name.' });

    const script = preparedScripts[scriptIndex] || preparedScripts[0];
    const code = makeUniqueCode();
    const assignments = {};
    script.characters.forEach((c) => { assignments[c.name] = null; });

    rooms[code] = {
      hostId: socket.id,
      hostName: trimmedName,
      players: [],
      script,
      assignments,
      state: 'lobby',
      currentBeat: 0,
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    socket.data.name = trimmedName;

    console.log(`Room ${code} created by ${trimmedName} (script: ${script.title})`);
    callback({ code, script: { title: script.title, characters: script.characters } });
  });

  // Player joins a room
  socket.on('join-room', ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: 'Room not found. Check your code and try again.' });
    if (room.state === 'performance') return callback({ error: 'Performance already started.' });

    const trimmedName = (name || '').trim();
    if (!trimmedName) return callback({ error: 'Please enter your name.' });

    room.players.push({ id: socket.id, name: trimmedName });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'player';
    socket.data.name = trimmedName;

    console.log(`${trimmedName} joined room ${code}`);
    callback({
      ok: true,
      name: trimmedName,
      script: { title: room.script.title, characters: room.script.characters },
      assignments: room.assignments,
    });

    broadcastPlayerList(code);
    broadcastAssignments(code);
  });

  // Claim or unclaim a character (player self-service, lobby only)
  socket.on('claim-character', ({ character }) => {
    const { code, name } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.state !== 'lobby') return;
    if (!(character in room.assignments)) return;

    if (room.assignments[character] === name) {
      room.assignments[character] = null;
    } else if (!room.assignments[character]) {
      room.assignments[character] = name;
    }
    broadcastAssignments(code);
  });

  // Host force-assigns a character to any player (lobby or performance)
  socket.on('force-assign', ({ character, toPlayer }) => {
    const { code, role } = socket.data;
    if (!code || !rooms[code] || role !== 'host') return;
    const room = rooms[code];
    if (!(character in room.assignments)) return;

    if (toPlayer !== null) {
      const valid = toPlayer === room.hostName || room.players.some((p) => p.name === toPlayer);
      if (!valid) return;
    }

    room.assignments[character] = toPlayer || null;
    broadcastAssignments(code);
    if (room.state === 'performance') sendCurrentBeat(code);
  });

  // Host boots a player from the room
  socket.on('boot-player', ({ playerName }) => {
    const { code, role } = socket.data;
    if (!code || !rooms[code] || role !== 'host') return;
    const room = rooms[code];

    const target = room.players.find((p) => p.name === playerName);
    if (!target) return;

    // If the booted player owns the current active beat, hand it to the host
    if (room.state === 'performance') {
      const beat = room.script.beats[room.currentBeat];
      if (beat.type === 'dialogue' && room.assignments[beat.character] === playerName) {
        room.assignments[beat.character] = room.hostName;
      }
    }

    Object.keys(room.assignments).forEach((char) => {
      if (room.assignments[char] === playerName) room.assignments[char] = null;
    });

    room.players = room.players.filter((p) => p.name !== playerName);

    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) targetSocket.emit('kicked', { reason: 'You were removed by the host.' });

    broadcastPlayerList(code);
    broadcastAssignments(code);
    if (room.state === 'performance') sendCurrentBeat(code);

    console.log(`${playerName} booted from room ${code}`);
  });

  // Host starts the performance
  socket.on('start-performance', () => {
    const { code, role } = socket.data;
    if (!code || !rooms[code] || role !== 'host') return;
    const room = rooms[code];
    if (!allCharactersAssigned(room)) return;

    room.state = 'performance';
    room.currentBeat = 0;

    io.to(code).emit('performance-started', { title: room.script.title });
    sendCurrentBeat(code);
    console.log(`Performance started in room ${code}`);
  });

  // Active player (or host) marks their line done
  socket.on('beat-done', () => {
    const { code, name, role } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.state !== 'performance') return;

    const beat = room.script.beats[room.currentBeat];
    if (beat.type !== 'dialogue') return;

    const activePlayer = room.assignments[beat.character];
    if (name !== activePlayer && role !== 'host') return;

    advanceBeat(code);
  });

  socket.on('disconnect', () => {
    const { code, role, name } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (role === 'host') {
      io.to(code).emit('host-left');
      delete rooms[code];
      console.log(`Room ${code} closed (host disconnected)`);
    } else {
      room.players = room.players.filter((p) => p.id !== socket.id);
      Object.keys(room.assignments).forEach((char) => {
        if (room.assignments[char] === name) room.assignments[char] = null;
      });
      broadcastPlayerList(code);
      broadcastAssignments(code);
      console.log(`${name} left room ${code}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Table Read running at http://localhost:${PORT}`);
});
