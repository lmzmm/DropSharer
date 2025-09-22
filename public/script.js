// public/script.js (混合模式：STUN P2P + Socket.IO 代理备用)

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
    let filesToShare = [];
    let shortId;
    const peerConnections = new Map();
    const CHUNK_SIZE = 256 * 1024; // 256KB
    const P2P_TIMEOUT = 15000; // P2P连接超时时间 (15秒)
    const rtcConfig = {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }] // 仅使用STUN
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
                    const path = file.webkitRelativePath || file.name;
                    li.textContent = `${path} (${formatBytes(file.size)})`;
                    fileList.appendChild(li);
                });
                fileListContainer.classList.remove('hidden');
            } else {
                fileListContainer.classList.add('hidden');
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

        socket.on('broadcast-started', (newShortId) => {
            shortId = newShortId;
            const link = `${window.location.origin}/s/${shortId}`;
            shareLinkInput.value = link;
            broadcastControls.classList.remove('hidden');
        });

        copyButton.addEventListener('click', () => { shareLinkInput.select(); document.execCommand('copy'); });
        stopBroadcastButton.addEventListener('click', () => { socket.emit('broadcaster-stop', shortId); window.location.reload(); });

        // --- P2P 连接创建与失败检测 ---
        const createPeerConnectionForWatcher = async (watcherSocketId) => {
            const pc = new RTCPeerConnection(rtcConfig);
            peerConnections.set(watcherSocketId, pc);

            let fallbackTimer = setTimeout(() => {
                handleP2PFailure(watcherSocketId, "连接超时");
            }, P2P_TIMEOUT);

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log(`[P2P] ICE state for ${watcherSocketId}: ${state}`);
                if (state === 'connected' || state === 'completed') {
                    clearTimeout(fallbackTimer);
                } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    handleP2PFailure(watcherSocketId, `连接状态变为 ${state}`);
                }
            };

            const dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
            dataChannel.onopen = () => {
                console.log(`[P2P] ✅ 与 ${watcherSocketId} 的 DataChannel 打开，通过 P2P 模式传输`);
                sendAllFilesViaP2P(dataChannel);
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('webrtc-offer', { watcherSocketId: watcherSocketId, sdp: offer });

            function handleP2PFailure(id, reason) {
                if (!peerConnections.has(id)) return;
                console.warn(`[P2P] ❌ 与 ${id} 的 P2P 连接失败 (${reason})，切换到代理模式`);

                clearTimeout(fallbackTimer);
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
        let isRelayMode = false;
        let filesMetadata = [], totalFilesSize = 0, totalReceivedSize = 0;
        let isSingleFileMode = false, currentFileStreamWriter = null, currentFileReceivedSize = 0, currentFileInfo = null;
        let zip, multiFileReceiveBuffers = {};

        // --- 统一消息处理器 (处理 P2P 和代理的数据) ---
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
                console.log("[P2P] ✅ DataChannel 已连接，准备接收 P2P 数据");
                const channel = event.channel;
                channel.binaryType = 'arraybuffer';
                channel.onmessage = (e) => handleDataMessage(e.data);
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
        socket.on('relay-control-message', (message) => handleDataMessage(JSON.stringify(message)));
        socket.on('relay-file-chunk', (chunk) => handleDataMessage(chunk));

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

    // ================== 通用事件处理 ==================
    socket.on('broadcast-stopped', () => {
        statusMessage.textContent = '广播已停止。';
        statusMessage.style.color = 'red';
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#dc3545';
        progressBar.textContent = '已中断';
        peerConnections.forEach(pc => pc.close());
    });

    socket.on('error-message', (message) => {
        alert(message);
        window.location.href = '/';
    });
});