// server.js (纯服务器代理模式)

import express from 'express';
import http from 'http';
import { Server } from "socket.io";
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // 允许较大的buffer，用于文件块

const PORT = process.env.PORT || 3000;
const RECONNECTION_GRACE_PERIOD = 45000; // 45秒宽限期

const broadcasters = {};

// --- 日志工具 ---
function formatDate(date = new Date()) {
    const pad = (n) => n.toString().padStart(2, '0');
    return (
        date.getFullYear() + ':' +
        pad(date.getMonth() + 1) + ':' +
        pad(date.getDate()) + ' ' +
        pad(date.getHours()) + ':' +
        pad(date.getMinutes()) + ':' +
        pad(date.getSeconds())
    );
}

function log(...args) {
    console.log(`[${formatDate()}]`, ...args);
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/s/:shortId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', (socket) => {
    log(`一个用户连接: ${socket.id}`);

    // --- 广播方创建房间 (核心修改) ---
    socket.on('broadcaster-start', (filesInfo) => {
        const shortId = nanoid(6);
        const roomToken = crypto.randomBytes(16).toString('hex'); // 生成安全令牌
        broadcasters[shortId] = {
            broadcasterSocketId: socket.id,
            filesInfo: filesInfo,
            watchers: {},
            roomToken: roomToken,
            status: 'active',
            deletionTimer: null
        };
        socket.join(shortId);
        socket.emit('broadcast-started', { shortId, roomToken });
        log(`广播创建: ${shortId} by ${socket.id}`);
    });

    // --- 广播方重连并恢复会话 ---
    socket.on('reclaim-broadcast', ({ shortId, roomToken }) => {
        const room = broadcasters[shortId];
        if (room && room.roomToken === roomToken) {
            log(`广播方 ${socket.id} 成功恢复了房间 ${shortId}`);
            if (room.deletionTimer) {
                clearTimeout(room.deletionTimer);
                room.deletionTimer = null;
            }
            room.broadcasterSocketId = socket.id;
            room.status = 'active';
            socket.join(shortId);
            io.to(shortId).emit('broadcaster-reconnected');
            socket.emit('reclaim-successful');
        } else {
            socket.emit('reclaim-failed');
        }
    });

    // --- 下载方加入逻辑 ---
    socket.on('watcher-join', (shortId) => {
        const room = broadcasters[shortId];
        if (!room || room.status !== 'active') {
            return socket.emit('error-message', '广播不存在或已结束。');
        }
        socket.join(shortId);
        room.watchers[socket.id] = true;

        // [MODIFIED] 直接通知广播方开始通过代理发送文件
        io.to(room.broadcasterSocketId).emit('watcher-ready', socket.id);

        socket.emit('files-info', room.filesInfo);
        log(`下载方 ${socket.id} 加入了房间 ${shortId}`);
    });

    // --- [REMOVED] WebRTC 信令转发部分已完全移除 ---

    // --- Socket.IO 文件代理 ---
    socket.on('relay-file-chunk', (watcherSocketId, chunk) => {
        // 直接将数据块转发给指定的下载方
        io.to(watcherSocketId).emit('relay-file-chunk', chunk);
    });

    socket.on('relay-control-message', (watcherSocketId, message) => {
        // 将控制消息（如 file-start, file-end）转发给指定的下载方
        io.to(watcherSocketId).emit('relay-control-message', message);
    });

    // --- 停止和断开连接的清理逻辑 (已合并和修复) ---
    socket.on('broadcaster-stop', (shortId) => {
        const room = broadcasters[shortId];
        if (room && room.broadcasterSocketId === socket.id) {
            log(`广播方主动停止房间 ${shortId}`);
            io.to(shortId).emit('broadcast-stopped');
            delete broadcasters[shortId];
        }
    });

    socket.on('disconnect', () => {
        log(`一个用户断开连接: ${socket.id}`);
        for (const shortId in broadcasters) {
            const room = broadcasters[shortId];

            // 如果是广播方断开连接
            if (room.broadcasterSocketId === socket.id) {
                log(`广播方 ${socket.id} (房间: ${shortId}) 已断开. 进入宽限期...`);
                room.status = 'disconnected';
                io.to(shortId).emit('broadcaster-disconnected');

                // 设置一个计时器，如果在宽限期内没有重连，则永久关闭房间
                room.deletionTimer = setTimeout(() => {
                    if (room.status === 'disconnected') {
                        log(`宽限期结束，永久关闭房间 ${shortId}`);
                        io.to(shortId).emit('broadcast-stopped');
                        delete broadcasters[shortId];
                    }
                }, RECONNECTION_GRACE_PERIOD);
                break; // 找到后即可退出循环
            }

            // 如果是下载方断开连接
            if (room.watchers[socket.id]) {
                log(`下载方 ${socket.id} 从房间 ${shortId} 断开.`);
                delete room.watchers[socket.id];
                // 可选：通知广播方有下载者离开
                // io.to(room.broadcasterSocketId).emit('watcher-left', socket.id);
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    log(`服务器运行在 http://localhost:${PORT}`);
});