const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve blundermind.html as the root page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'blundermind.html'));
});

// Also serve it by name directly
app.get('/blundermind.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'blundermind.html'));
});

// ── Multiplayer room system ───────────────────────────────────────────────────
const rooms = {}; // roomCode → { white: ws, black: ws }

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'create') {
      // Create a new room
      const code = generateRoomCode();
      rooms[code] = { white: ws, black: null };
      ws.roomCode = code;
      ws.role = 'white';
      ws.send(JSON.stringify({ type: 'created', code, role: 'white' }));

    } else if (msg.type === 'join') {
      // Join an existing room
      const code = msg.code?.toUpperCase();
      const room = rooms[code];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }
      if (room.black) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
      }
      room.black = ws;
      ws.roomCode = code;
      ws.role = 'black';
      ws.send(JSON.stringify({ type: 'joined', code, role: 'black' }));
      // Tell white that black has joined
      if (room.white && room.white.readyState === 1) {
        room.white.send(JSON.stringify({ type: 'opponent_joined' }));
      }

    } else if (msg.type === 'move') {
      // Relay move to opponent
      const room = rooms[ws.roomCode];
      if (!room) return;
      const opponent = ws.role === 'white' ? room.black : room.white;
      if (opponent && opponent.readyState === 1) {
        opponent.send(JSON.stringify({ type: 'move', move: msg.move }));
      }

    } else if (msg.type === 'resign' || msg.type === 'rematch' || msg.type === 'chat') {
      // Relay resign/rematch/chat to opponent
      const room = rooms[ws.roomCode];
      if (!room) return;
      const opponent = ws.role === 'white' ? room.black : room.white;
      if (opponent && opponent.readyState === 1) {
        // For chat, include the text; sanitize length
        if (msg.type === 'chat') {
          const text = String(msg.text || '').slice(0, 200);
          opponent.send(JSON.stringify({ type: 'chat', text }));
        } else {
          opponent.send(JSON.stringify({ type: msg.type }));
        }
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if (!room) return;
    // Notify opponent
    const opponent = ws.role === 'white' ? room.black : room.white;
    if (opponent && opponent.readyState === 1) {
      opponent.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
    // Clean up room
    delete rooms[ws.roomCode];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blundermind running on port ${PORT}`);
});
