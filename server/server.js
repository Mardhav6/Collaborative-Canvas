const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createRooms } = require('./rooms');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Static client
app.use('/', express.static(path.join(__dirname, '..', 'client')));

// Ensure data directory exists for persistence
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function roomFile(roomName) {
  const safe = roomName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, `${safe}.json`);
}

// Persistence API: save current room state to disk
app.post('/api/rooms/:room/save', async (req, res) => {
  try {
    const roomName = req.params.room || 'lobby';
    const r = rooms.get(roomName);
    if (!r) return res.status(404).json({ ok: false, error: 'room_not_found' });
    const file = roomFile(roomName);
    await fsp.writeFile(file, JSON.stringify({ ops: r.state.ops }, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

// Persistence API: load room state from disk and broadcast
app.post('/api/rooms/:room/load', async (req, res) => {
  try {
    const roomName = req.params.room || 'lobby';
    const r = rooms.get(roomName);
    if (!r) return res.status(404).json({ ok: false, error: 'room_not_found' });
    const file = roomFile(roomName);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'no_saved_state' });
    const content = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(content);
    if (!Array.isArray(data.ops)) return res.status(400).json({ ok: false, error: 'invalid_file' });
    // Replace in-memory state and notify clients
    r.state.clear();
    for (const op of data.ops) {
      r.state.appendOp(op);
    }
    io.to(roomName).emit('state:replace', r.state.ops);
    res.json({ ok: true, count: r.state.ops.length });
  } catch (err) {
    console.error('Load error:', err);
    res.status(500).json({ ok: false, error: 'load_failed' });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = createRooms();

io.on('connection', (socket) => {
  let joinedRoom = null;
  let userId = null;
  let userColor = null;

  socket.on('join', ({ room, userId: uid, color }) => {
    userId = uid; userColor = color || '#000';
    joinedRoom = room || 'lobby';
    socket.join(joinedRoom);
    const r = rooms.get(joinedRoom);
    r.addUser({ id: userId, socketId: socket.id, color: userColor });
    // initial state
    socket.emit('state:init', r.state.ops);
    // presence to all
    io.to(joinedRoom).emit('presence', r.getPresence());
    console.log(`[room:${joinedRoom}] users connected: ${r.getPresence().length}`);
  });

  socket.on('ping:latency', (ack) => { if (ack) ack(); });

  socket.on('stroke:start', (op) => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.appendOp(op);
      // Broadcast to ALL clients including sender for consistency
      io.to(joinedRoom).emit('stroke:append', op);
    } catch (err) {
      console.error('Error handling stroke:start:', err);
    }
  });

  socket.on('stroke:update', ({ id, points }) => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.patchPoints(id, points);
      // Broadcast to ALL clients including sender for consistency
      io.to(joinedRoom).emit('stroke:patch', { id, points });
    } catch (err) {
      console.error('Error handling stroke:update:', err);
    }
  });

  socket.on('stroke:end', ({ id }) => {
    // no-op server-side; clients already have points and append
  });

  // Shapes: append single op (rect, circle, text, image URL)
  socket.on('shape:add', (op) => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.appendOp(op);
      io.to(joinedRoom).emit('shape:append', op);
    } catch (err) {
      console.error('Error handling shape:add:', err);
    }
  });

  socket.on('cursor', ({ x, y }) => {
    if (!joinedRoom) return;
    // Broadcast to ALL clients including sender for consistency
    io.to(joinedRoom).emit('cursor', { id: userId, x, y, color: userColor });
  });

  // Debug: render order toggle broadcast within room
  socket.on('debug:renderOrder', ({ enabled }) => {
    if (!joinedRoom) return;
    io.to(joinedRoom).emit('debug:renderOrder', { enabled });
  });

  socket.on('history:undo', () => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.globalUndo();
      io.to(joinedRoom).emit('state:replace', r.state.ops);
    } catch (err) {
      console.error('Error handling undo:', err);
    }
  });

  socket.on('history:redo', () => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.globalRedo();
      io.to(joinedRoom).emit('state:replace', r.state.ops);
    } catch (err) {
      console.error('Error handling redo:', err);
    }
  });

  socket.on('history:clear', () => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.state.clear();
      io.to(joinedRoom).emit('state:replace', r.state.ops);
    } catch (err) {
      console.error('Error handling clear:', err);
    }
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    try {
      const r = rooms.get(joinedRoom);
      r.removeUser(socket.id);
      io.to(joinedRoom).emit('presence', r.getPresence());
      console.log(`[room:${joinedRoom}] users connected: ${r.getPresence().length}`);
    } catch (err) {
      console.error('Error handling disconnect:', err);
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


