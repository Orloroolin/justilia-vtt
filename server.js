const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 100 * 1024 * 1024, // 100 MB — для крупных карт
    cors: { origin: '*' },
    pingTimeout: 60000
});

// Раздаём статику из public/
app.use(express.static(path.join(__dirname, 'public')));

// ==== ХРАНИЛИЩЕ СОСТОЯНИЯ ====
let globalState = null;  // null = первый клиент задаст начальное состояние

const SAVE_FILE = path.join(__dirname, 'world-state.json');

function loadPersisted() {
    try {
        if (fs.existsSync(SAVE_FILE)) {
            globalState = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
            console.log('✅ Состояние загружено с диска');
        }
    } catch (e) {
        console.warn('⚠️ Не удалось загрузить state:', e.message);
    }
}

let saveTimeout = null;
function persistSoon() {
    // Дебаунс, чтобы не писать файл 100 раз в секунду
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            if (globalState) {
                fs.writeFileSync(SAVE_FILE, JSON.stringify(globalState), 'utf-8');
            }
        } catch (e) {
            console.warn('⚠️ Не удалось сохранить state:', e.message);
        }
    }, 1000);
}

loadPersisted();

// ==== КТО КАКИМ ПЕРСОНАЖЕМ УПРАВЛЯЕТ ====
const claimedTokens = new Map(); // tokenId -> socket.id
const playerClaims = new Map();  // socket.id -> tokenId

// ==== SOCKET.IO ====
io.on('connection', (socket) => {
    console.log('🔌 Подключён:', socket.id);

    // Отправляем состояние новому клиенту
    socket.emit('state:init', globalState);

    // Клиент присылает полный state (сохранение)
    socket.on('state:update', (newState) => {
        if (!newState || !newState.scenes) return;
        globalState = newState;
        persistSoon();
        // Разослать всем КРОМЕ отправителя
        socket.broadcast.emit('state:apply', newState);
    });

    // Клиент просит актуальное состояние (например, при переподключении)
    socket.on('state:request', () => {
        socket.emit('state:init', globalState);
    });

    // Клиент хочет управлять персонажем
    socket.on('player:claim', (tokenId, ack) => {
        const existing = claimedTokens.get(tokenId);
        if (existing && existing !== socket.id) {
            if (typeof ack === 'function') ack({ ok: false, reason: 'Этот персонаж уже занят' });
            return;
        }
        // Освободить предыдущий токен этого сокета
        const prev = playerClaims.get(socket.id);
        if (prev && prev !== tokenId && claimedTokens.get(prev) === socket.id) {
            claimedTokens.delete(prev);
        }
        claimedTokens.set(tokenId, socket.id);
        playerClaims.set(socket.id, tokenId);
        if (typeof ack === 'function') ack({ ok: true });
        console.log(`🎭 ${socket.id} → персонаж ${tokenId}`);
    });

    socket.on('player:release', () => {
        const prev = playerClaims.get(socket.id);
        if (prev && claimedTokens.get(prev) === socket.id) claimedTokens.delete(prev);
        playerClaims.delete(socket.id);
    });

    socket.on('disconnect', () => {
        console.log('❌ Отключён:', socket.id);
        const prev = playerClaims.get(socket.id);
        if (prev && claimedTokens.get(prev) === socket.id) claimedTokens.delete(prev);
        playerClaims.delete(socket.id);
    });
});

// Health check (для хостингов)
app.get('/api/health', (req, res) => res.json({ ok: true, hasState: !!globalState }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});