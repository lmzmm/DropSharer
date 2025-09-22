// server.js (混合模式：STUN P2P + Socket.IO 代理备用)

import express from 'express';
import http from 'http';
import { Server } from "socket.io";
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto'; // 引入加密模块

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const RECONNECTION_GRACE_PERIOD = 45000; // 45秒宽限期

const broadcasters = {};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/s/:shortId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', (socket) => {
    console.log(`一个用户连接: ${socket.id}`);

    // --- 广播方创建房间 (核心修改) ---
    socket.on('broadcaster-start', (filesInfo) => {
        const shortId = nanoid(6);
        const roomToken = crypto.randomBytes(16).toString('hex'); // 生成安全令牌
        broadcasters[shortId] = {
            broadcasterSocketId: socket.id,
            filesInfo: filesInfo,
            watchers: {},
            roomToken: roomToken, // 存储令牌
            status: 'active', // 'active' or 'disconnected'
            deletionTimer: null // 用于存储删除计时器
        };
        socket.join(shortId);
        // 将 shortId 和 roomToken 一起返回给广播方
        socket.emit('broadcast-started', { shortId, roomToken });
        console.log(`广播创建: ${shortId} by ${socket.id}`);
    });

    // --- 新增：广播方重连并恢复会话 ---
    socket.on('reclaim-broadcast', ({ shortId, roomToken }) => {
        const room = broadcasters[shortId];
        if (room && room.roomToken === roomToken) {
            console.log(`广播方 ${socket.id} 成功恢复了房间 ${shortId}`);
            // 清除可能存在的删除计时器
            if (room.deletionTimer) {
                clearTimeout(room.deletionTimer);
                room.deletionTimer = null;
            }
            // 更新为新的 socket.id 并激活房间
            room.broadcasterSocketId = socket.id;
            room.status = 'active';
            socket.join(shortId);
            // 通知房间内的所有接收方，广播方已重连
            io.to(shortId).emit('broadcaster-reconnected');
            socket.emit('reclaim-successful');
        } else {
            socket.emit('reclaim-failed');
        }
    });

    socket.on('disconnect', () => {
        console.log(`一个用户断开连接: ${socket.id}`);
        for (const shortId in broadcasters) {
            const room = broadcasters[shortId];
            if (room.broadcasterSocketId === socket.id) {
                console.log(`广播方 ${socket.id} (房间: ${shortId}) 已断开.`);
                room.status = 'disconnected';
                // 通知房间内的接收方，广播方暂时掉线
                io.to(shortId).emit('broadcaster-disconnected');

                // 启动删除计时器
                room.deletionTimer = setTimeout(() => {
                    if (room.status === 'disconnected') {
                        console.log(`宽限期结束，永久关闭房间 ${shortId}`);
                        io.to(shortId).emit('broadcast-stopped'); // 发送最终停止消息
                        delete broadcasters[shortId];
                    }
                }, RECONNECTION_GRACE_PERIOD);
                break;
            }
        }
    });

    // --- 下载方加入逻辑 (增加状态检查) ---
    socket.on('watcher-join', (shortId) => {
        const room = broadcasters[shortId];
        // 只有活跃的房间才能加入
        if (!room || room.status !== 'active') {
            return socket.emit('error-message', '广播不存在或已结束。');
        }
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
    socket.on('disconnect', () => {
        console.log(`一个用户断开连接: ${socket.id}`);

        // 遍历所有房间，检查断开的socket是否为广播方
        for (const shortId in broadcasters) {
            const room = broadcasters[shortId];
            if (room.broadcasterSocketId === socket.id) {
                console.log(`广播方 ${socket.id} (房间: ${shortId}) 已断开.`);

                // 向此房间内的所有 watcher 广播停止消息
                // 我们直接使用 shortId 作为房间名来广播
                io.to(shortId).emit('broadcast-stopped');

                // 从内存中删除该房间
                delete broadcasters[shortId];
                console.log(`广播房间 ${shortId} 已清理.`);
                break; // 找到后即可退出循环
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});