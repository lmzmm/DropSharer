// public/script.js (最终版：混合模式 + 智能测速 + 断线处理)

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
    let filesToShare = []
    let shortId;
    const peerConnections = new Map();
    const CHUNK_SIZE = 256 * 1024;
    const P2P_TIMEOUT = 15000;
    const SPEED_THRESHOLD = 10 * 1024 * 1024 / 8; // 10 Mbps in Bytes/sec (1.25 MB/s)
    const TEST_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB for speed test
    const rtcConfig = {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    };

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

        // --- 开始广播 ---
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
            roomToken = data.roomToken; // 保存令牌！
            shareLinkInput.value = `${window.location.origin}/s/${shortId}`;
            broadcastControls.classList.remove('hidden');
        });

        // 处理断线
        socket.on('disconnect', () => {
            if (roomToken) { // 只有广播开始后才显示
                statusMessage.textContent = '网络连接已断开，正在尝试重连...';
                statusMessage.style.color = 'orange';
                statusMessage.classList.remove('hidden'); // 确保状态可见
            }
        });

        socket.on('connect', () => {
            if (roomToken) {
                console.log('已重新连接到服务器，尝试恢复广播...');
                socket.emit('reclaim-broadcast', { shortId, roomToken });
            }
            // 隐藏可能存在的断线提示
            if (!watcherView.classList.contains('hidden')) {
                 statusMessage.classList.add('hidden');
                 statusMessage.style.color = '';
            }
        });

        socket.on('reclaim-successful', () => {
            console.log('广播会话已成功恢复！');
            statusMessage.textContent = '网络已恢复！';
            setTimeout(() => statusMessage.classList.add('hidden'), 2000);
        });

        socket.on('reclaim-failed', () => {
            alert('广播会话恢复失败，可能已超时。请重新发起分享。');
            window.location.reload();
        });

        copyButton.addEventListener('click', () => { shareLinkInput.select(); document.execCommand('copy'); });
        stopBroadcastButton.addEventListener('click', () => { socket.emit('broadcaster-stop', shortId); window.location.reload(); });

        // --- P2P 连接创建与智能测速 ---
        const createPeerConnectionForWatcher = async (watcherSocketId) => {
            const pc = new RTCPeerConnection(rtcConfig);
            peerConnections.set(watcherSocketId, pc);

            let initialFallbackTimer = setTimeout(() => handleP2PFailure(watcherSocketId, "初始连接超时"), P2P_TIMEOUT);
            let disconnectionTimer = null; // 用于处理短暂断线的计时器

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log(`[P2P] ICE state for ${watcherSocketId}: ${state}`);

                switch (state) {
                    case 'connected':
                    case 'completed':
                        // 连接成功或从抖动中恢复
                        clearTimeout(initialFallbackTimer);
                        if (disconnectionTimer) {
                            console.log("[P2P] ✅ 连接已从'disconnected'状态自动恢复！");
                            clearTimeout(disconnectionTimer);
                            disconnectionTimer = null;
                        }
                        break;

                    case 'disconnected':
                        // 连接暂时中断，启动“抖动”缓冲计时器
                        console.warn("[P2P] ⚠️ 连接暂时中断，进入5秒观察期...");
                        if (!disconnectionTimer) {
                            disconnectionTimer = setTimeout(() => {
                                handleP2PFailure(watcherSocketId, "短暂断线后未能恢复");
                            }, 5000); // 5秒缓冲期
                        }
                        break;

                    case 'failed':
                    case 'closed':
                        // 连接彻底失败，立即切换
                        handleP2PFailure(watcherSocketId, `连接状态变为 ${state}`);
                        break;
                }
            };

            const dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
            dataChannel.onopen = async () => {
                // onopen 内部的测速逻辑完全不变
                console.log(`[P2P] ✅ DataChannel 打开，准备进行速度测试...`);
                const speed = await performSpeedTest(dataChannel);
                console.log(`[P2P] 速度测试结果: ${(speed * 8 / 1024 / 1024).toFixed(2)} Mbps`);
                if (speed >= SPEED_THRESHOLD) {
                    console.log(`[P2P] 速度达标，将通过 P2P 模式传输`);
                    dataChannel.send(JSON.stringify({ type: 'p2p-speed-ok' }));
                    sendAllFilesViaP2P(dataChannel);
                } else {
                    console.warn(`[P2P] 速度不达标，主动切换到代理模式`);
                    dataChannel.send(JSON.stringify({ type: 'p2p-speed-low' }));
                    setTimeout(() => handleP2PFailure(watcherSocketId, "速度不达标"), 500);
                }
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('webrtc-offer', { watcherSocketId: watcherSocketId, sdp: offer });

            function handleP2PFailure(id, reason) {
                if (!peerConnections.has(id)) return; // 防止重复触发
                console.warn(`[P2P] ❌ 与 ${id} 的连接失败 (${reason})，切换到代理模式`);

                // 确保所有相关的计时器都被清除
                clearTimeout(initialFallbackTimer);
                if (disconnectionTimer) {
                    clearTimeout(disconnectionTimer);
                    disconnectionTimer = null;
                }

                pc.close();
                peerConnections.delete(id);
                socket.emit('request-relay-fallback', shortId, id);
                sendAllFilesViaRelay(id);
            }
        };

        // --- Plan A: P2P 传输逻辑 ---
        const sendAllFilesViaP2P = async (dataChannel) => {
            for (const file of filesToShare) {
                const metadata = { type: 'file-start', name: file.name, size: file.size, fileType: file.type, relativePath: file.webkitRelativePath || file.name };
                dataChannel.send(JSON.stringify(metadata));
                await sendFileInChunksViaP2P(dataChannel, file);
                dataChannel.send(JSON.stringify({ type: 'file-end' }));
            }
            dataChannel.send(JSON.stringify({ type: 'transfer-complete' }));
        };
        const sendFileInChunksViaP2P = (dataChannel, file) => {
            return new Promise((resolve, reject) => {
                const fileReader = new FileReader();
                let offset = 0;
                dataChannel.bufferedAmountLowThreshold = 8 * 1024 * 1024;
                const readSlice = (o) => {
                    if (dataChannel.readyState !== 'open') return reject(new Error('Data channel closed.'));
                    fileReader.readAsArrayBuffer(file.slice(o, o + CHUNK_SIZE));
                };
                const send = () => {
                    while (offset < file.size && dataChannel.bufferedAmount < 16 * 1024 * 1024) {
                        dataChannel.send(fileReader.result);
                        offset += fileReader.result.byteLength;
                        if (offset < file.size) readSlice(offset);
                        else return resolve();
                    }
                };
                dataChannel.onbufferedamountlow = send;
                fileReader.onload = send;
                fileReader.onerror = (err) => reject(err);
                readSlice(0);
            });
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
            if (pc) pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        });
    }

    // ================== 下载方逻辑 ==================
    if (path.startsWith('/s/')) {
        let isRelayMode = false, filesMetadata = [], totalFilesSize = 0, totalReceivedSize = 0;
        let isSingleFileMode = false, currentFileStreamWriter = null, currentFileReceivedSize = 0, currentFileInfo = null;
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

            const message = JSON.parse(data);
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
            pc.ondatachannel = (event) => {
                console.log("[P2P] ✅ DataChannel 已连接，准备进行速度测试");
                const channel = event.channel;
                channel.binaryType = 'arraybuffer';
                let testBytesReceived = 0;
                channel.onmessage = (e) => {
                    if (e.data instanceof ArrayBuffer) {
                        testBytesReceived += e.data.byteLength;
                        if (testBytesReceived >= TEST_CHUNK_SIZE) {
                            channel.send(JSON.stringify({ type: 'speed-test-ack' }));
                            testBytesReceived = 0;
                        }
                        return;
                    }
                    const message = JSON.parse(e.data);
                    if (message.type === 'speed-test-start') testBytesReceived = 0;
                    else if (message.type === 'p2p-speed-ok') {
                        console.log("[P2P] 速度测试通过，切换到P2P文件接收模式");
                        channel.onmessage = (ev) => handleDataMessage(ev.data);
                    } else if (message.type === 'p2p-speed-low') {
                        console.log("[P2P] 速度测试不达标，等待服务器切换指令...");
                    } else {
                        handleDataMessage(e.data);
                    }
                };
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

    // ================== 监听广播方断线重连 ==================
    socket.on('broadcaster-disconnected', () => {
            console.warn("广播方连接暂时中断...");
            statusMessage.textContent = '广播方网络不稳定，正在等待其重连...';
            statusMessage.style.color = 'orange';
        });

        socket.on('broadcaster-reconnected', () => {
            console.log("广播方已重新连接！");
            statusMessage.textContent = '广播方已重连，即将恢复传输...';
            statusMessage.style.color = 'green';
            setTimeout(() => {
                statusMessage.textContent = '正在连接广播方...'; // 恢复默认状态
                statusMessage.style.color = '';
            }, 2000);
        });

    // ================== 通用事件处理 ==================
    socket.on('broadcast-stopped', () => {
        statusMessage.textContent = '广播已中断或结束。';
        statusMessage.style.color = 'red';
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#dc3545';
        progressBar.textContent = '已中断';
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();
        const writer = window.currentFileStreamWriter; // A bit of a hack to get the writer
        if (writer) writer.abort().catch(() => {});
    });

    socket.on('error-message', (message) => {
        alert(message);
        window.location.href = '/';
    });
});