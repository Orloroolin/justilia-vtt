const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 100 * 1024 * 1024,
    cors: { origin: '*' },
    pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

// ==== ХРАНИЛИЩЕ КОМНАТ ====
const rooms = new Map();
// Исправлено: пишем во временную папку, чтобы не было EACCES
const SAVE_FILE = path.join(os.tmpdir(), 'world-state.json');

function loadPersisted() {
    try {
        if (fs.existsSync(SAVE_FILE)) {
            const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
            if (data && data.rooms) {
                Object.entries(data.rooms).forEach(([code, roomData]) => {
                    rooms.set(code, roomData);
                });
                console.log(`✅ Загружено комнат: ${rooms.size}`);
            } else if (data && data.scenes) {
                rooms.set('MAIN', { state: data, lastActivity: Date.now() });
                console.log('✅ Загружен старый формат мира в комнату MAIN');
            }
        }
    } catch (e) {
        console.warn('⚠️ Не удалось загрузить state:', e.message);
    }
}

let saveTimeout = null;
function persistSoon() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            const obj = { rooms: {} };
            rooms.forEach((roomData, code) => {
                obj.rooms[code] = roomData;
            });
            fs.writeFileSync(SAVE_FILE, JSON.stringify(obj), 'utf-8');
        } catch (e) {
            console.warn('⚠️ Не удалось сохранить state:', e.message);
        }
    }, 1000);
}

loadPersisted();

// Автоочистка пустых комнат старше 24 часов
setInterval(() => {
    const now = Date.now();
    const emptyRooms = new Set();
    rooms.forEach((roomData, code) => {
        const room = io.sockets.adapter.rooms.get('room-' + code);
        const isEmpty = !room || room.size === 0;
        if (isEmpty && (now - roomData.lastActivity) > 24 * 60 * 60 * 1000) {
            emptyRooms.add(code);
        }
    });
    emptyRooms.forEach(code => {
        rooms.delete(code);
        console.log(`🗑 Удалена неактивная комната: ${code}`);
    });
    if (emptyRooms.size > 0) persistSoon();
}, 60 * 60 * 1000);

// ==== SOCKET.IO ====
const roomClaims = new Map();

function getRoomClaims(code) {
    if (!roomClaims.has(code)) {
        roomClaims.set(code, { claimedTokens: new Map(), playerClaims: new Map() });
    }
    return roomClaims.get(code);
}

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('room:create', (ack) => {
        let code;
        do {
            code = Math.random().toString(36).substring(2, 8).toUpperCase();
        } while (rooms.has(code));
        rooms.set(code, { state: null, lastActivity: Date.now() });
        if (typeof ack === 'function') ack({ ok: true, code });
        console.log(`🏠 Создана комната: ${code}`);
    });

    socket.on('room:join', (code, ack) => {
        if (!code || typeof code !== 'string') {
            if (typeof ack === 'function') ack({ ok: false, reason: 'Неверный код' });
            return;
        }
        const roomCode = code.toUpperCase().trim();
        if (!rooms.has(roomCode)) {
            if (typeof ack === 'function') ack({ ok: false, reason: 'Комната не найдена' });
            return;
        }
        if (currentRoom) {
            socket.leave('room-' + currentRoom);
            releaseClaims(currentRoom, socket.id);
        }
        currentRoom = roomCode;
        socket.join('room-' + currentRoom);
        rooms.get(currentRoom).lastActivity = Date.now();
        socket.emit('state:init', rooms.get(currentRoom).state);
        if (typeof ack === 'function') ack({ ok: true, code: currentRoom });
        console.log(`🚪 ${socket.id} → комната ${currentRoom}`);
    });

    socket.on('state:update', (newState) => {
        if (!currentRoom || !newState || !newState.scenes) return;
        const roomData = rooms.get(currentRoom);
        if (!roomData) return;
        roomData.state = newState;
        roomData.lastActivity = Date.now();
        persistSoon();
        socket.to('room-' + currentRoom).emit('state:apply', newState);
    });

    socket.on('state:request', () => {
        if (!currentRoom) return;
        socket.emit('state:init', rooms.get(currentRoom)?.state || null);
    });

    socket.on('player:claim', (tokenId, ack) => {
        if (!currentRoom) {
            if (typeof ack === 'function') ack({ ok: false, reason: 'Нет комнаты' });
            return;
        }
        const claims = getRoomClaims(currentRoom);
        const existing = claims.claimedTokens.get(tokenId);
        if (existing && existing !== socket.id) {
            if (typeof ack === 'function') ack({ ok: false, reason: 'Этот персонаж уже занят' });
            return;
        }
        const prev = claims.playerClaims.get(socket.id);
        if (prev && prev !== tokenId && claims.claimedTokens.get(prev) === socket.id) {
            claims.claimedTokens.delete(prev);
        }
        claims.claimedTokens.set(tokenId, socket.id);
        claims.playerClaims.set(socket.id, tokenId);
        if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('player:release', () => {
        if (!currentRoom) return;
        const claims = getRoomClaims(currentRoom);
        const prev = claims.playerClaims.get(socket.id);
        if (prev && claims.claimedTokens.get(prev) === socket.id) claims.claimedTokens.delete(prev);
        claims.playerClaims.delete(socket.id);
    });

    socket.on('disconnect', () => {
        if (currentRoom) {
            releaseClaims(currentRoom, socket.id);
            const room = rooms.get(currentRoom);
            if (room) room.lastActivity = Date.now();
        }
    });
});

function releaseClaims(roomCode, socketId) {
    const claims = roomClaims.get(roomCode);
    if (!claims) return;
    const prev = claims.playerClaims.get(socketId);
    if (prev && claims.claimedTokens.get(prev) === socketId) claims.claimedTokens.delete(prev);
    claims.playerClaims.delete(socketId);
}

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});