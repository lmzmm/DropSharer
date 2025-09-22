# P2P 文件共享 (P2P File Share)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Technology: Node.js](https://img.shields.io/badge/Technology-Node.js-green)
![Frontend: WebRTC](https://img.shields.io/badge/Frontend-WebRTC-orange)

一个基于 WebRTC 和 Socket.IO 的实时、私密、无服务存储的点对点文件共享应用。它优先尝试最高效的 P2P 直连进行文件传输，并在 P2P 失败时自动、无缝地切换到服务器代理模式，以保证传输的最终成功率。

### ✨ 核心特性

*   **混合传输模式**: 智能结合 WebRTC (P2P) 和 Socket.IO (服务器代理)，兼顾速度、成本与可靠性。
*   **隐私与安全**: 文件在用户浏览器之间直接传输，服务器不存储任何文件内容，仅作信令协调和备用中转。
*   **无上限文件大小**: 对于单个文件传输，采用流式写入 (`StreamSaver.js`)，理论上没有文件大小限制，不会耗尽浏览器内存。
*   **多文件与文件夹支持**: 支持一次性拖拽或选择多个文件甚至整个文件夹进行分享。
*   **自动打包**: 当分享多个文件时，接收方会自动将所有文件打包成一个 `.zip` 压缩包进行下载。
*   **现代化用户体验**: 简洁的拖拽式 UI，通过一个简单的短链接即可分享。

### 🚀 架构解析

本应用采用了一种健壮的混合传输架构，以应对真实世界复杂的网络环境。

```mermaid
%% 混合模式文件传输架构图
graph TD
    subgraph "云服务器 (Your Cloud Server)"
        A[Signaling & Relay Server <br> (Node.js, Express, Socket.IO)]
    end
    subgraph "用户 A (广播方)"
        UA[Browser]
    end
    subgraph "用户 B (下载方)"
        UB[Browser]
    end
    subgraph "外部服务"
        S[STUN Server]
    end
    UA -- 1. 连接并创建房间 --> A
    UB -- 2. 使用短链接加入房间 --> A
    A -- 3. 协调双方信息 --> UA & UB
    UA -- 4a. 查询公网IP --> S
    UB -- 4b. 查询公网IP --> S
    UA <== P2P 数据流 (Plan A: 高速直连) ==> UB
    UA -- P2P失败后, 切换到Plan B --> A
    A -- 通知 B 切换 --> UB
    UA -- 代理数据流 (Plan B: 备用方案) --> A -- 代理数据流 --> UB
    linkStyle 5 stroke-width:4px,stroke:green,stroke-dasharray: 5 5;
    linkStyle 8 stroke-width:4px,stroke:orange,stroke-dasharray: 5 5;
```

*   **Plan A (首选)**: 客户端通过 STUN 服务器尝试建立 WebRTC P2P 直连。这是最高效的路径，约 80%-90% 的情况会走此模式。
*   **Plan B (备用)**: 如果 P2P 连接在 15 秒内无法建立（例如因为对称型NAT），系统会自动放弃 P2P，无缝切换到通过 Socket.IO 经由服务器代理转发数据的模式。这牺牲了服务器带宽，但保证了 100% 的连接成功率。

### 🛠️ 技术栈

*   **后端**:
    *   **Node.js**: JavaScript 运行时环境。
    *   **Express**: Web 框架，用于提供静态页面。
    *   **Socket.IO**: 用于实现信令交换和备用的数据代理通道。
    *   **nanoid**: 用于生成唯一的短链接 ID。

*   **前端**:
    *   **HTML5 / CSS3 / JavaScript (ES6+)**: 应用基础。
    *   **WebRTC**: 实现点对点数据通信的核心技术。
    *   **Socket.IO Client**: 与后端进行实时通信。
    *   **JSZip**: 用于在客户端打包多个文件为 `.zip`。
    *   **StreamSaver.js**: 实现大文件流式写入，避免浏览器内存崩溃。

### 🏁 开始使用

#### 先决条件

*   Node.js (v16 或更高版本)
*   npm

#### 安装与运行

1.  **克隆仓库**

2.  **安装依赖**
    > **注意**: `nanoid` 包需要安装 v3 版本以兼容 CommonJS 的 `require` 语法。
    ```bash
    npm install express socket.io nanoid@3
    ```

3.  **启动服务器**
    ```bash
    node server.js
    ```

4.  **访问应用**
    在您的浏览器中打开 `http://localhost:3000` 即可开始使用。

### 部署到服务器

1.  将项目文件上传到您的云服务器。
2.  按照上述步骤安装依赖并启动服务。
3.  **关键**: 确保您的服务器**防火墙/安全组**已开放以下端口：
    *   `TCP 3000` (或您在 `server.js` 中指定的其他端口)
4.  使用 `pm2` 或其他进程管理工具来保持 Node.js 应用在后台持续运行。
5.  通过服务器的公网 IP 地址访问您的应用：`http://[你的服务器公网IP]:3000`

### 📜 开源许可

本项目采用 [MIT License](LICENSE) 开源许可。
