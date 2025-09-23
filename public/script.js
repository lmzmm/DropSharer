// public/script.js (纯服务器代理模式)
document.addEventListener('DOMContentLoaded', () => {
    const socket = io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        transports: ['websocket', 'polling'],
        timeout: 86400000 // 将超时时间改为一天（24小时 = 86400000毫秒）
    });

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
    let roomToken = null;
    let filesToShare = [];
    let shortId;
    const CHUNK_SIZE = 256 * 1024; // 256 KB per chunk
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

        // --- 服务器代理传输逻辑 ---
        const sendAllFilesViaRelay = async (watcherSocketId) => {
            console.log(`[代理] 🚀 开始通过服务器向 ${watcherSocketId} 中转文件...`);
            for (const file of filesToShare) {
                const metadata = { type: 'file-start', name: file.name, size: file.size, fileType: file.type, relativePath: file.webkitRelativePath || file.name };
                socket.emit('relay-control-message', watcherSocketId, metadata);
                await sendFileInChunksViaRelay(watcherSocketId, file);
                socket.emit('relay-control-message', watcherSocketId, { type: 'file-end' });
            }
            socket.emit('relay-control-message', watcherSocketId, { type: 'transfer-complete' });
            console.log(`[代理] ✅ 所有文件已通过服务器发送完毕 (${watcherSocketId})`);
        };

        const sendFileInChunksViaRelay = (watcherSocketId, file) => {
            return new Promise(resolve => {
                const fileReader = new FileReader();
                let offset = 0;
                let chunkCount = 0;
                const HEARTBEAT_INTERVAL = 50; // 每50个块发送一次心跳（更频繁）
                
                // 添加一个变量来跟踪上一次发送心跳的时间
                let lastHeartbeat = Date.now();

                const readSlice = o => {
                    const slice = file.slice(o, o + CHUNK_SIZE);
                    fileReader.readAsArrayBuffer(slice);
                };

                fileReader.onload = e => {
                    socket.emit('relay-file-chunk', watcherSocketId, e.target.result);
                    offset += e.target.result.byteLength;
                    chunkCount++;

                    // 每隔一定数量的块或者每隔一定时间发送一次心跳，避免阻塞Socket.IO心跳
                    const now = Date.now();
                    if (chunkCount % HEARTBEAT_INTERVAL === 0 || (now - lastHeartbeat) > 300) {
                        lastHeartbeat = now;
                        // 强制发送活动信号，防止连接断开
                        socket.emit('activity');
                        // 延迟执行下一次读取，释放事件循环（增加延迟时间）
                        setTimeout(() => readSlice(offset), 50);
                    } else if (offset < file.size) {
                        // 关键修改：使用 setTimeout 将下一次读取操作推迟到下一个事件循环
                        // 这给了浏览器处理其他事件（如网络心跳）的机会
                        setTimeout(() => readSlice(offset), 15);
                    } else {
                        resolve();
                    }
                };

                readSlice(0);
            });
        };

        // 当新的下载方准备好时，立即通过服务器开始传输
        socket.on('watcher-ready', (watcherSocketId) => {
            sendAllFilesViaRelay(watcherSocketId);
        });
    }

    // ================== 下载方逻辑 ==================
    if (path.startsWith('/s/')) {
        let filesMetadata = [], totalFilesSize = 0, totalReceivedSize = 0;
        let currentFileReceivedSize = 0, currentFileInfo = null;
        let zip, multiFileReceiveBuffers = {};

        // --- 统一消息处理器 ---
        const handleDataMessage = (data) => {
            // 处理二进制数据块
            if (data instanceof ArrayBuffer) {
                totalReceivedSize += data.byteLength;
                if (isSingleFileMode) {
                    if (currentFileStreamWriter) {
                        currentFileStreamWriter.write(new Uint8Array(data));
                        currentFileReceivedSize += data.byteLength;
                        statusMessage.textContent = `正在接收: ${currentFileInfo.name} (${formatBytes(currentFileReceivedSize)} / ${formatBytes(currentFileInfo.size)})`;
                    }
                } else {
                    if (currentFileInfo) {
                        multiFileReceiveBuffers[currentFileInfo.relativePath].push(data);
                    }
                }
                const progress = totalFilesSize > 0 ? Math.round((totalReceivedSize / totalFilesSize) * 100) : 0;
                progressBar.style.width = `${progress}%`;
                progressBar.textContent = `${progress}%`;
                return;
            }

            // 处理JSON控制消息
            const message = JSON.parse(data);
            switch (message.type) {
                case 'file-start':
                    currentFileInfo = message;
                    currentFileReceivedSize = 0;
                    statusMessage.textContent = `准备接收: ${currentFileInfo.name}`;
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

        // --- 监听来自服务器的代理数据 ---
        socket.on('relay-control-message', (message) => handleDataMessage(JSON.stringify(message)));
        socket.on('relay-file-chunk', handleDataMessage); // 直接传递 ArrayBuffer

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
    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected, reason:', reason);
        if (roomToken) {
            statusMessage.textContent = '网络连接已断开，正在尝试重连...';
            statusMessage.style.color = 'orange';
            statusMessage.classList.remove('hidden');
        }
    });
    
    socket.on('pong', () => {
        // 心跳响应，可以在这里添加心跳日志
        console.log('Received pong from server');
    });
    
    socket.on('connect', () => {
        console.log('Socket connected, socket id:', socket.id);
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
        if (isSingleFileMode && currentFileStreamWriter) {
            currentFileStreamWriter.abort().catch(() => {});
        }
    });

    socket.on('error-message', (message) => {
        alert(message);
        window.location.href = '/';
    });
});