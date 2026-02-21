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

// Pre-compute line counts per character so clients can show them on the cast screen
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

  if (beat.type === 'dialogue') {
    activePlayer = room.assignments[beat.character] || null;
  }

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

// Find a player's socket in the room (returns socket or undefined)
function findPlayerSocket(room, playerName) {
  const player = room.players.find((p) => p.name === playerName);
  return player ? io.sockets.sockets.get(player.id) : undefined;
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Application-level heartbeat to keep connections alive through proxies
  socket.on('ping', () => socket.emit('pong'));

  // Host creates a room
  socket.on('create-room', ({ name } = {}, callback) => {
    if (typeof callback !== 'function') return;

    const trimmedName = (name || '').trim();
    if (!trimmedName) return callback({ error: 'Please enter your name.' });

    const code = makeUniqueCode();
    const script = preparedScripts[0];
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

    console.log(`Room ${code} created by ${trimmedName}`);
    callback({ code, script: { title: script.title, characters: script.characters } });
  });

  // Player joins a room
  socket.on('join-room', ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: 'Room not found. Check your code and try again.' });
    if (room.state === 'performance') return callback({ error: 'Performance already started.' });

    const trimmedName = (name || '').trim();
    if (!trimmedName) return callback({ error: 'Please enter your name.' });

    const player = { id: socket.id, name: trimmedName };
    room.players.push(player);
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

  // Claim or unclaim a character (tap to toggle)
  socket.on('claim-character', ({ character }) => {
    const { code, name } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.state !== 'lobby') return;
    if (!(character in room.assignments)) return;

    if (room.assignments[character] === name) {
      room.assignments[character] = null; // unclaim
    } else if (!room.assignments[character]) {
      room.assignments[character] = name; // claim
    }
    // else: taken by someone else — ignore

    broadcastAssignments(code);
  });

  // Host force-assigns a character to any player (or clears it)
  // Works in both lobby and performance states
  socket.on('force-assign', ({ character, toPlayer }) => {
    const { code, role } = socket.data;
    if (!code || !rooms[code] || role !== 'host') return;
    const room = rooms[code];
    if (!(character in room.assignments)) return;

    // toPlayer must be a real person in the room, or null to clear
    if (toPlayer !== null) {
      const isHost = toPlayer === room.hostName;
      const isPlayer = room.players.some((p) => p.name === toPlayer);
      if (!isHost && !isPlayer) return;
    }

    room.assignments[character] = toPlayer || null;
    broadcastAssignments(code);

    // If a performance is in progress, re-send the current beat so the newly
    // assigned player immediately sees their cue (or loses it)
    if (room.state === 'performance') sendCurrentBeat(code);
  });

  // Host boots a player from the room
  socket.on('boot-player', ({ playerName }) => {
    const { code, role } = socket.data;
    if (!code || !rooms[code] || role !== 'host') return;
    const room = rooms[code];

    const target = room.players.find((p) => p.name === playerName);
    if (!target) return;

    // If in performance and the current beat belongs to this player's character,
    // auto-reassign that character to the host so the scene doesn't deadlock
    if (room.state === 'performance') {
      const currentBeat = room.script.beats[room.currentBeat];
      if (
        currentBeat.type === 'dialogue' &&
        room.assignments[currentBeat.character] === playerName
      ) {
        room.assignments[currentBeat.character] = room.hostName;
      }
    }

    // Release all other characters they held
    Object.keys(room.assignments).forEach((char) => {
      if (room.assignments[char] === playerName) room.assignments[char] = null;
    });

    // Remove them from the player list
    room.players = room.players.filter((p) => p.name !== playerName);

    // Tell their socket they've been removed
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) targetSocket.emit('kicked', { reason: 'You were removed by the host.' });

    broadcastPlayerList(code);
    broadcastAssignments(code);
    if (room.state === 'performance') sendCurrentBeat(code);

    console.log(`${playerName} was booted from room ${code}`);
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
    if (beat.type !== 'dialogue') return; // stage directions auto-advance

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
