// server.js (混合模式：STUN P2P + Socket.IO 代理备用)

import express from 'express';
import http from 'http';
import { Server } from "socket.io";
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 为代理模式设置 100 MB 的缓冲区
});

const PORT = process.env.PORT || 3000;

const broadcasters = {};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/s/:shortId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`一个用户连接: ${socket.id}`);

    // --- 广播方创建房间 (无变化) ---
    socket.on('broadcaster-start', (filesInfo) => {
        const shortId = nanoid(6);
        broadcasters[shortId] = {
            broadcasterSocketId: socket.id,
            filesInfo: filesInfo,
            watchers: {}
        };
        socket.join(shortId);
        socket.emit('broadcast-started', shortId);
        console.log(`广播创建: ${shortId} by ${socket.id}`);
    });

    // --- 下载方加入房间 (无变化) ---
    socket.on('watcher-join', (shortId) => {
        const room = broadcasters[shortId];
        if (!room) { return socket.emit('error-message', '广播不存在或已结束。'); }
        socket.join(shortId);
        room.watchers[socket.id] = true;
        io.to(room.broadcasterSocketId).emit('watcher-ready', socket.id);
        socket.emit('files-info', room.filesInfo);
        console.log(`下载方 ${socket.id} 加入了房间 ${shortId}`);
    });

    // --- Section A: WebRTC (P2P) 信令转发 ---
    socket.on('webrtc-offer', (payload) => {
        io.to(payload.watcherSocketId).emit('webrtc-offer', { sdp: payload.sdp, broadcasterSocketId: socket.id });
    });
    socket.on('webrtc-answer', (payload) => {
        io.to(payload.broadcasterSocketId).emit('webrtc-answer', { sdp: payload.sdp, watcherSocketId: socket.id });
    });
    socket.on('webrtc-ice-candidate', (payload) => {
        io.to(payload.targetSocketId).emit('webrtc-ice-candidate', { candidate: payload.candidate, senderSocketId: socket.id });
    });

    // --- Section B: Socket.IO (代理) 备用方案逻辑 ---
    socket.on('request-relay-fallback', (shortId, watcherSocketId) => {
        const room = broadcasters[shortId];
        if (room && room.broadcasterSocketId === socket.id) {
            console.log(`房间 ${shortId} -> ${watcherSocketId} 请求切换到代理模式`);
            io.to(watcherSocketId).emit('initiate-relay-fallback');
        }
    });

    socket.on('relay-file-chunk', (watcherSocketId, chunk) => {
        io.to(watcherSocketId).emit('relay-file-chunk', chunk);
    });

    socket.on('relay-control-message', (watcherSocketId, message) => {
        io.to(watcherSocketId).emit('relay-control-message', message);
    });

    // --- 清理逻辑 (无变化) ---
    socket.on('broadcaster-stop', (shortId) => { /* ... */ });
    socket.on('disconnect', () => { /* ... */ });
});

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});