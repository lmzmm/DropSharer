// public/script.js (修正版：混合模式 + 实时速度监控 + 断线处理 + 会话恢复 + P2P抖动容错)
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // --- DOM 元素获取 ---
    const broadcasterView = document.getElementById('broadcaster-view');
    const watcherView = document.getElementById('watcher-view');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const selectFilesButton = document.getElementById('select-files-button');
    const selectFolderButton = document.getElementById('select-folder-button');
    const fileListContainer = document.getElementById('file-list-container');
    const fileList = document.getElementById('file-list');
    const startBroadcastButton = document.getElementById('start-broadcast-button');
    const broadcastControls = document.getElementById('broadcast-controls');
    const shareLinkInput = document.getElementById('share-link');
    const copyButton = document.getElementById('copy-button');
    const stopBroadcastButton = document.getElementById('stop-broadcast-button');
    const fileCountSpan = document.getElementById('file-count');
    const totalSizeSpan = document.getElementById('total-size');
    const incomingFileList = document.getElementById('incoming-file-list');
    const progressBar = document.getElementById('progress-bar');
    const statusMessage = document.getElementById('status-message');

    // --- 全局变量和配置 ---
    let roomToken = null; //用于存储令牌
    let filesToShare = [];
    let shortId;
    const peerConnections = new Map();
    const CHUNK_SIZE = 256 * 1024;
    const P2P_TIMEOUT = 15000;
    const SPEED_THRESHOLD = 10 * 1024 * 1024 / 8; // 10 Mbps in Bytes/sec (1.25 MB/s)
    const rtcConfig = {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    };
    // 在全局作用域声明下载方需要的变量，以便 broadcast-stopped 能访问
    let isSingleFileMode = false, currentFileStreamWriter = null;

    // ================== 实用函数 ==================
    const formatBytes = (bytes, decimals = 2) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    };

    // ================== 页面路由逻辑 ==================
    const path = window.location.pathname;
    if (path.startsWith('/s/')) {
        broadcasterView.classList.add('hidden');
        watcherView.classList.remove('hidden');
    } else {
        broadcasterView.classList.remove('hidden');
        watcherView.classList.add('hidden');
    }

    // ================== 广播方逻辑 ==================
    if (!path.startsWith('/s/')) {
        // --- 文件选择、拖放UI逻辑 ---
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
        selectFilesButton.addEventListener('click', () => fileInput.click());
        selectFolderButton.addEventListener('click', () => folderInput.click());
        fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
        folderInput.addEventListener('change', (e) => handleFiles(e.target.files));

        const handleFiles = (files) => {
            filesToShare.push(...Array.from(files));
            updateFileListView();
        };
        const updateFileListView = () => {
            fileList.innerHTML = '';
            if (filesToShare.length > 0) {
                filesToShare.forEach(file => {
                    const li = document.createElement('li');
                    li.textContent = `${file.webkitRelativePath || file.name} (${formatBytes(file.size)})`;
                    fileList.appendChild(li);
                });
                fileListContainer.classList.remove('hidden');
            }
        };

        // --- 开始广播 & 会话管理 ---
        startBroadcastButton.addEventListener('click', () => {
            if (filesToShare.length === 0) return alert('请先选择文件！');
            const filesMetadata = filesToShare.map(file => ({
                name: file.name, size: file.size, type: file.type,
                relativePath: file.webkitRelativePath || file.name,
            }));
            socket.emit('broadcaster-start', filesMetadata);
            dropZone.classList.add('hidden');
            fileListContainer.classList.add('hidden');
        });

        socket.on('broadcast-started', (data) => {
            shortId = data.shortId;
            roomToken = data.roomToken;
            shareLinkInput.value = `${window.location.origin}/s/${shortId}`;
            broadcastControls.classList.remove('hidden');
        });

        copyButton.addEventListener('click', () => { shareLinkInput.select(); document.execCommand('copy'); });
        stopBroadcastButton.addEventListener('click', () => { socket.emit('broadcaster-stop', shortId); window.location.reload(); });

        // --- P2P 连接创建与智能测速 (包含网络抖动容错) ---
        const createPeerConnectionForWatcher = async (watcherSocketId) => {
            const pc = new RTCPeerConnection(rtcConfig);
            peerConnections.set(watcherSocketId, pc);

            let initialFallbackTimer = setTimeout(() => handleP2PFailure(watcherSocketId, "初始连接超时"), P2P_TIMEOUT);
            let disconnectionTimer = null;

            // 关键：发送本端 ICE 候选给 watcher（要与服务器协议一致：使用 targetSocketId）
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('webrtc-ice-candidate', { targetSocketId: watcherSocketId, candidate: event.candidate });
                }
            };

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log(`[P2P] ICE state for ${watcherSocketId}: ${state}`);

                switch (state) {
                    case 'connected':
                    case 'completed':
                        clearTimeout(initialFallbackTimer);
                        if (disconnectionTimer) {
                            console.log("[P2P] ✅ 连接已从'disconnected'状态自动恢复！");
                            clearTimeout(disconnectionTimer);
                            disconnectionTimer = null;
                        }
                        break;

                    case 'disconnected':
                        console.warn("[P2P] ⚠️ 连接暂时中断，进入5秒观察期...");
                        if (!disconnectionTimer) {
                            disconnectionTimer = setTimeout(() => {
                                handleP2PFailure(watcherSocketId, "短暂断线后未能恢复");
                            }, 5000);
                        }
                        break;

                    case 'failed':
                    case 'closed':
                        handleP2PFailure(watcherSocketId, `连接状态变为 ${state}`);
                        break;
                }
            };

            // 创建 dataChannel 并准备传输（ordered: true）
            const dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
            dataChannel.binaryType = 'arraybuffer';

            // [MODIFIED] DataChannel 打开后直接传输并监控速度
            dataChannel.onopen = () => {
                console.log(`[P2P] ✅ DataChannel 打开，直接开始传输文件并监控实时速度...`);

                let totalBytesSentSinceLastCheck = 0;
                let lastCheckTime = Date.now();

                // 设置一个定时器来监控速度
                const monitoringInterval = setInterval(() => {
                    const now = Date.now();
                    const duration = (now - lastCheckTime) / 1000; // a-secondes

                    if (duration < 1) return; // a-check

                    const speed = totalBytesSentSinceLastCheck / duration; // Bytes per second
                    console.log(`[P2P] 实时传输速度: ${(speed * 8 / 1024 / 1024).toFixed(2)} Mbps`);

                    // 如果速度低于阈值，则切换到代理模式
                    if (speed < SPEED_THRESHOLD) {
                        console.warn(`[P2P] 速度低于阈值 (${(SPEED_THRESHOLD * 8 / 1024 / 1024).toFixed(2)} Mbps)，切换到代理模式。`);
                        clearInterval(monitoringInterval); // 停止监控
                        handleP2PFailure(watcherSocketId, "传输速度过低");
                        return; // 确保只触发一次
                    }

                    // 重置计数器和时间以进行下一次检查
                    totalBytesSentSinceLastCheck = 0;
                    lastCheckTime = now;

                }, 2000); // a-deux secondes

                // 将 interval ID 附加到 pc 对象，以便在失败时清除它
                pc.monitoringInterval = monitoringInterval;

                // 定义一个回调函数来更新已发送的字节数
                const onProgress = (bytes) => {
                    totalBytesSentSinceLastCheck += bytes;
                };

                // 开始传输所有文件
                sendAllFilesViaP2P(dataChannel, watcherSocketId, onProgress);
            };


            // 生成并发送 offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('webrtc-offer', { watcherSocketId: watcherSocketId, sdp: offer });

            // 失败处理（复用）
            function handleP2PFailure(id, reason) {
                if (!peerConnections.has(id)) return;
                console.warn(`[P2P] ❌ 与 ${id} 的连接失败 (${reason})，切换到代理模式`);

                clearTimeout(initialFallbackTimer);
                if (disconnectionTimer) clearTimeout(disconnectionTimer);

                // [MODIFIED] 清除速度监控定时器
                if (pc.monitoringInterval) {
                    clearInterval(pc.monitoringInterval);
                }

                try { pc.close(); } catch (e) {}
                peerConnections.delete(id);
                socket.emit('request-relay-fallback', shortId, id);
                sendAllFilesViaRelay(id);
            }
        };

        // 可靠的文件分片发送：按顺序读取切片并在 bufferedAmount 控制下发送
        const sendFileInChunksViaP2P = (dataChannel, file, onProgress) => {
            return new Promise(async (resolve, reject) => {
                let offset = 0;

                const readChunk = (start, end) => {
                    return new Promise((res, rej) => {
                        const fr = new FileReader();
                        fr.onload = (e) => res(e.target.result);
                        fr.onerror = (e) => rej(e);
                        fr.readAsArrayBuffer(file.slice(start, end));
                    });
                };

                try {
                    while (offset < file.size) {
                        if (dataChannel.bufferedAmount > 16 * 1024 * 1024) {
                            await new Promise(r => {
                                const onLow = () => {
                                    dataChannel.removeEventListener('bufferedamountlow', onLow);
                                    r();
                                };
                                dataChannel.addEventListener('bufferedamountlow', onLow);
                                dataChannel.bufferedAmountLowThreshold = 8 * 1024 * 1024;
                            });
                        }

                        const chunk = await readChunk(offset, Math.min(offset + CHUNK_SIZE, file.size));
                        if (dataChannel.readyState !== 'open') return reject(new Error('Data channel closed.'));
                        dataChannel.send(chunk);
                        offset += chunk.byteLength;

                        // 调用 onProgress 回调 (如果存在)
                        if (onProgress) {
                            onProgress(chunk.byteLength);
                        }
                    }
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        };

        // --- Plan A: P2P 传输逻辑 ---
        const sendAllFilesViaP2P = async (dataChannel, watcherSocketId, onProgress) => {
            try {
                for (const file of filesToShare) {
                    const metadata = { type: 'file-start', name: file.name, size: file.size, fileType: file.type, relativePath: file.webkitRelativePath || file.name };
                    dataChannel.send(JSON.stringify(metadata));
                    await sendFileInChunksViaP2P(dataChannel, file, onProgress);
                    dataChannel.send(JSON.stringify({ type: 'file-end' }));
                }
                dataChannel.send(JSON.stringify({ type: 'transfer-complete' }));
                console.log(`[P2P] ✅ 所有文件已通过 P2P 发送完毕（${watcherSocketId}）`);
            } catch (err) {
                console.warn('[P2P] 发送过程中出错，尝试切换到中继：', err);
                socket.emit('request-relay-fallback', shortId, watcherSocketId);
            }
        };

        // --- Plan B: 代理传输逻辑 ---
        const sendAllFilesViaRelay = async (watcherSocketId) => {
            console.log(`[代理] 🚀 开始通过服务器向 ${watcherSocketId} 中转文件...`);
            for (const file of filesToShare) {
                const metadata = { type: 'file-start', name: file.name, size: file.size, fileType: file.type, relativePath: file.webkitRelativePath || file.name };
                socket.emit('relay-control-message', watcherSocketId, metadata);
                await sendFileInChunksViaRelay(watcherSocketId, file);
                socket.emit('relay-control-message', watcherSocketId, { type: 'file-end' });
            }
            socket.emit('relay-control-message', watcherSocketId, { type: 'transfer-complete' });
        };
        const sendFileInChunksViaRelay = (watcherSocketId, file) => {
            return new Promise(resolve => {
                const fileReader = new FileReader();
                let offset = 0;
                fileReader.onload = e => {
                    socket.emit('relay-file-chunk', watcherSocketId, e.target.result);
                    offset += e.target.result.byteLength;
                    if (offset < file.size) readSlice(offset);
                    else resolve();
                };
                const readSlice = o => fileReader.readAsArrayBuffer(file.slice(o, o + CHUNK_SIZE));
                readSlice(0);
            });
        };

        socket.on('watcher-ready', createPeerConnectionForWatcher);
        socket.on('webrtc-answer', async (payload) => {
            const pc = peerConnections.get(payload.watcherSocketId);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        });
        socket.on('webrtc-ice-candidate', (payload) => {
            const pc = peerConnections.get(payload.senderSocketId);
            if (pc && payload.candidate) {
                pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(e => console.warn('addIceCandidate error', e));
            }
        });
    }

    // ================== 下载方逻辑 ==================
    if (path.startsWith('/s/')) {
        let isRelayMode = false, filesMetadata = [], totalFilesSize = 0, totalReceivedSize = 0;
        let currentFileReceivedSize = 0, currentFileInfo = null;
        let zip, multiFileReceiveBuffers = {};

        // --- 统一消息处理器 ---
        const handleDataMessage = (data) => {
            if (data instanceof ArrayBuffer) {
                totalReceivedSize += data.byteLength;
                if (isSingleFileMode) {
                    if (currentFileStreamWriter) {
                        currentFileStreamWriter.write(new Uint8Array(data));
                        currentFileReceivedSize += data.byteLength;
                        statusMessage.textContent = `正在接收: ${currentFileInfo.name} (${formatBytes(currentFileReceivedSize)} / ${formatBytes(currentFileInfo.size)})`;
                    }
                } else {
                    if (currentFileInfo) multiFileReceiveBuffers[currentFileInfo.relativePath].push(data);
                }
                const progress = totalFilesSize > 0 ? Math.round((totalReceivedSize / totalFilesSize) * 100) : 0;
                progressBar.style.width = `${progress}%`;
                progressBar.textContent = `${progress}%`;
                return;
            }

            const message = JSON.parse(typeof data === 'string' ? data : JSON.stringify(data));
            switch (message.type) {
                case 'file-start':
                    currentFileInfo = message;
                    currentFileReceivedSize = 0;
                    if (isSingleFileMode) {
                        const fileStream = streamSaver.createWriteStream(currentFileInfo.name, { size: currentFileInfo.size });
                        currentFileStreamWriter = fileStream.getWriter();
                    } else {
                        multiFileReceiveBuffers[currentFileInfo.relativePath] = [];
                    }
                    break;
                case 'file-end':
                    if (isSingleFileMode) {
                        if (currentFileStreamWriter) currentFileStreamWriter.close();
                    } else {
                        const blob = new Blob(multiFileReceiveBuffers[currentFileInfo.relativePath], { type: currentFileInfo.fileType });
                        zip.file(currentFileInfo.relativePath, blob);
                        delete multiFileReceiveBuffers[currentFileInfo.relativePath];
                    }
                    break;
                case 'transfer-complete':
                    statusMessage.textContent = '所有文件接收完毕！';
                    if (!isSingleFileMode) {
                        statusMessage.textContent = '正在生成 ZIP 包...';
                        zip.generateAsync({ type: "blob" }).then(content => {
                            const link = document.createElement('a');
                            link.href = URL.createObjectURL(content);
                            link.download = `DropShare-${shortId}.zip`;
                            link.click();
                            URL.revokeObjectURL(link.href);
                            statusMessage.textContent = '下载已开始！';
                        });
                    } else {
                        statusMessage.textContent = '文件下载完成！';
                    }
                    break;
            }
        };

        // --- Plan A: 尝试 P2P ---
        const createPeerConnectionForBroadcaster = async (payload) => {
            const pc = new RTCPeerConnection(rtcConfig);
            peerConnections.set(payload.broadcasterSocketId, pc);

            // [MODIFIED] 简化 ondatachannel 处理器
            pc.ondatachannel = (event) => {
                console.log("[P2P] ✅ DataChannel 已连接，准备接收文件...");
                const channel = event.channel;
                channel.binaryType = 'arraybuffer';

                // 直接将所有收到的消息交给统一处理器
                channel.onmessage = (ev) => handleDataMessage(ev.data);
            };

            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            pc.onicecandidate = (event) => {
                if (event.candidate) socket.emit('webrtc-ice-candidate', { targetSocketId: payload.broadcasterSocketId, candidate: event.candidate });
            };
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('webrtc-answer', { broadcasterSocketId: payload.broadcasterSocketId, sdp: answer });
        };
        socket.on('webrtc-offer', (payload) => {
            if (isRelayMode) return;
            createPeerConnectionForBroadcaster(payload);
        });

        // --- Plan B: 监听切换指令 ---
        socket.on('initiate-relay-fallback', () => {
            if (isRelayMode) return;
            isRelayMode = true;
            console.warn("[代理] 🚀 P2P 连接失败，已切换到服务器代理模式");
            statusMessage.textContent = '连接不稳定，切换到代理模式...';
            peerConnections.forEach(pc => pc.close());
            peerConnections.clear();
        });

        // --- 监听代理数据 ---
        socket.on('relay-control-message', (message) => isRelayMode && handleDataMessage(JSON.stringify(message)));
        socket.on('relay-file-chunk', (chunk) => isRelayMode && handleDataMessage(chunk));

        // --- 初始化 ---
        socket.on('files-info', (metadata) => {
            filesMetadata = metadata;
            isSingleFileMode = filesMetadata.length === 1;
            totalFilesSize = filesMetadata.reduce((sum, file) => sum + file.size, 0);
            fileCountSpan.textContent = filesMetadata.length;
            totalSizeSpan.textContent = formatBytes(totalFilesSize);
            incomingFileList.innerHTML = '';
            filesMetadata.forEach(file => {
                const li = document.createElement('li');
                li.textContent = `${file.relativePath} (${formatBytes(file.size)})`;
                incomingFileList.appendChild(li);
            });
            if (!isSingleFileMode) zip = new JSZip();
        });

        shortId = path.substring(3);
        socket.emit('watcher-join', shortId);
    }

    // ================== 通用事件处理 (含网络容错UI) ==================
    // --- 广播方会话恢复 ---
    socket.on('disconnect', () => {
        if (roomToken) {
            statusMessage.textContent = '网络连接已断开，正在尝试重连...';
            statusMessage.style.color = 'orange';
            statusMessage.classList.remove('hidden');
        }
    });
    socket.on('connect', () => {
        if (roomToken) {
            socket.emit('reclaim-broadcast', { shortId, roomToken });
        } else if (watcherView.classList.contains('hidden') === false) {
             statusMessage.textContent = '';
        }
    });
    socket.on('reclaim-successful', () => {
        statusMessage.textContent = '网络已恢复！';
        statusMessage.style.color = 'green';
        setTimeout(() => statusMessage.textContent = '', 2000);
    });
    socket.on('reclaim-failed', () => {
        alert('广播会话恢复失败，可能已超时。');
        window.location.reload();
    });

    // --- 下载方监听广播方状态 ---
    socket.on('broadcaster-disconnected', () => {
        if (watcherView.classList.contains('hidden') === false) {
            statusMessage.textContent = '广播方网络不稳定，正在等待其重连...';
            statusMessage.style.color = 'orange';
        }
    });
    socket.on('broadcaster-reconnected', () => {
        if (watcherView.classList.contains('hidden') === false) {
            statusMessage.textContent = '广播方已重连！';
            statusMessage.style.color = 'green';
            setTimeout(() => statusMessage.textContent = '', 2000);
        }
    });

    // --- 最终失败处理 ---
    socket.on('broadcast-stopped', () => {
        statusMessage.textContent = '广播已中断或结束。';
        statusMessage.style.color = 'red';
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#dc3545';
        progressBar.textContent = '已中断';
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();
        if (isSingleFileMode && currentFileStreamWriter) {
            currentFileStreamWriter.abort().catch(() => {});
        }
    });

    socket.on('error-message', (message) => {
        alert(message);
        window.location.href = '/';
    });
});