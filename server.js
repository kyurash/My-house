const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory rooms (reset when the server restarts)
const rooms = {};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:id', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// YouTube search (needs YOUTUBE_API_KEY set in Render's environment settings)
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: 'missing_key' });
  if (!q) return res.json({ items: [] });
  try {
    const url =
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video' +
      '&videoEmbeddable=true&maxResults=10&q=' + encodeURIComponent(q) +
      '&key=' + encodeURIComponent(key);
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'youtube_error' });
    res.json({
      items: (data.items || []).map((i) => ({
        id: i.id.videoId,
        title: i.snippet.title,
        channel: i.snippet.channelTitle,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: 'youtube_error' });
  }
});

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = { videoId: null, playing: false, time: 0, at: Date.now(), queue: [], users: {} };
  }
  return rooms[id];
}

function currentTime(r) {
  return r.playing ? r.time + (Date.now() - r.at) / 1000 : r.time;
}

function setState(r, patch) {
  Object.assign(r, patch, { at: Date.now() });
}

function startVideo(roomId, r, videoId) {
  setState(r, { videoId, playing: true, time: 0 });
  io.to(roomId).emit('load', { videoId, time: 0, playing: true });
}

io.on('connection', (socket) => {
  let roomId = null;
  let name = 'Guest';

  socket.on('join', (data) => {
    roomId = String(data.room || '').slice(0, 40);
    name = String(data.name || 'Guest').slice(0, 24) || 'Guest';
    if (!roomId) return;
    const r = getRoom(roomId);
    socket.join(roomId);
    r.users[socket.id] = name;

    socket.emit('init', {
      videoId: r.videoId,
      playing: r.playing,
      time: currentTime(r),
      queue: r.queue,
    });
    io.to(roomId).emit('users', Object.values(r.users));
    io.to(roomId).emit('chat', { system: true, text: `${name} joined` });
  });

  socket.on('load', ({ videoId }) => {
    if (!roomId || !videoId) return;
    startVideo(roomId, getRoom(roomId), videoId);
  });

  ['play', 'pause', 'seek'].forEach((evt) => {
    socket.on(evt, ({ time }) => {
      if (!roomId || typeof time !== 'number') return;
      const r = getRoom(roomId);
      const playing = evt === 'play' ? true : evt === 'pause' ? false : r.playing;
      setState(r, { playing, time });
      socket.to(roomId).emit('sync', { playing, time });
    });
  });

  socket.on('queue:add', ({ videoId, title }) => {
    if (!roomId || !videoId) return;
    const r = getRoom(roomId);
    if (!r.videoId) return startVideo(roomId, r, videoId);
    r.queue.push({ id: videoId, title: String(title || 'YouTube video').slice(0, 120) });
    io.to(roomId).emit('queue', r.queue);
  });

  socket.on('queue:remove', ({ index }) => {
    if (!roomId) return;
    const r = getRoom(roomId);
    r.queue.splice(index, 1);
    io.to(roomId).emit('queue', r.queue);
  });

  // Several clients report "ended"; only advance once per video
  socket.on('ended', ({ videoId }) => {
    if (!roomId) return;
    const r = getRoom(roomId);
    if (r.videoId !== videoId) return;
    const next = r.queue.shift();
    io.to(roomId).emit('queue', r.queue);
    if (next) {
      startVideo(roomId, r, next.id);
    } else {
      setState(r, { playing: false, time: 0 });
    }
  });

  socket.on('chat', ({ text }) => {
    if (!roomId) return;
    text = String(text || '').trim().slice(0, 500);
    if (text) io.to(roomId).emit('chat', { name, text });
  });

  socket.on('disconnect', () => {
    if (!roomId || !rooms[roomId]) return;
    const r = rooms[roomId];
    delete r.users[socket.id];
    if (Object.keys(r.users).length === 0) {
      setTimeout(() => {
        if (rooms[roomId] && Object.keys(rooms[roomId].users).length === 0) delete rooms[roomId];
      }, 10 * 60 * 1000);
    } else {
      io.to(roomId).emit('users', Object.values(r.users));
      io.to(roomId).emit('chat', { system: true, text: `${name} left` });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
