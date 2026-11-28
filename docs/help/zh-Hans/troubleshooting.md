# 故障排查

## 桌面启动问题 {#desktop-launch}

### macOS 隔离 {#macos-quarantine}

CodeNomad 的 macOS 发行版未经 Apple 公证，因此即使是从官方仓库下载并已验证的副本，macOS 也可能阻止其首次启动：可能显示 **"CodeNomad" Not Opened**（Apple 无法验证其不含恶意软件），或提示应用已损坏。

1. 检查下载来源和已安装应用路径。
2. 如果应用安装在以下路径，请移除其隔离属性：

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. 再次启动。对于 **Not Opened** 消息，也可以在启动被阻止后，在 **System Settings → Privacy & Security** 中为 CodeNomad 选择 **Open Anyway**，并用管理员密码确认。

这会更改该应用的 macOS 隔离属性。不会修复损坏下载，也不会使未知二进制变可信。

### Linux 图形与 FUSE {#linux-graphics}

Wayland/NVIDIA 上立即退出的 Tauri AppImage 可能受到 WebKitGTK DMA-BUF/GBM 渲染器影响。使用针对性的环境覆盖运行下载的 AppImage：

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron 使用 Chromium，可作为同一主机上的替代方案。如果 AppImage 因 FUSE 不可用而无法挂载，请使用 `--appimage-extract-and-run`；参阅 [Linux 安装](install.md#linux-install)。这些修复无需禁用 Electron 沙箱。

## Git 与工作区可用性 {#git-and-workspaces}

1. 检查后端账户 `PATH` 中的 Git，而非仅检查智能体 Shell 内的 Git。
2. 缺少时为该主机/账户安装 Git，然后重启 CodeNomad 后端以继承更新环境。
3. 重新打开/刷新工作区并检查仓库状态。

没有 Git 时仍可使用仅目录对话；工作树和 Git 控件不可用。Windows 上只在 WSL 内安装 Git 不足以满足 Windows 后端。没有仓库的已知文件夹可显示**初始化 Git**；缺少 Git 可执行文件是不同情况，必须先修复。参阅[要求](install.md#requirements)和[文件](files.md)。

无法验证所属工作树或对话位置时，请显式打开其物理文件夹，而非尝试任意路径或编辑原生存储。强制移除工作树可能销毁未提交文件；不要用它修复连接。

## OpenCode 运行时与 WSL {#opencode-runtime}

在启动错误对话框中，选择**打开 OpenCode 设置**以检查可执行文件和版本；要检查自定义环境值，请切换到**高级 → 环境变量**。

1. 打开**偏好设置 → OpenCode**，检查 **OpenCode 版本**卡片（已安装版本和运行服务状态），然后检查 **OpenCode 可执行文件**下所选的可执行文件。
2. 缺少必需运行时时，使用受支持安装/更新操作。当前最低版本：**2.4.0**；推荐/已验证版本：**2.4.1**。
3. 已安装 CLI 与运行服务不同时，显式决定是否重启共享服务。

**故障排查**下提供**重启 OpenCode 服务**，需要确认。会中断所有已连接客户端的活动工作，但保留会话历史。重新加载配置是独立操作：保留进程，但重建已加载 Location 并取消待处理问题/权限。两者都不是无害刷新。

对于 WSL 可执行文件，确认目标发行版和 Windows localhost 转发。服务生命周期在 Linux 内运行；CodeNomad 仍须从 Windows 访问其回环端点。切勿从 Windows 编辑服务注册/数据库或向猜测的 Linux 进程 ID 发送信号。

## 登录、TLS 与直接连接 {#login-and-tls}

| 症状 | 安全检查与恢复 |
| --- | --- |
| **重新登录 CodeNomad** | 保持页面打开，输入服务器用户名/密码并选择**登录**。恢复会就地重连以保留草稿；不会重放失败操作。 |
| 服务器不可达 | 确认后端运行，使用打印地址/实际端口。 |
| 证书名称/信任错误 | 检查实际主机名/IP 与证书 SAN 是否匹配，安装预期 CA 信任或有效服务器证书。不要禁用 TLS 验证。 |
| 直接连接被拒绝 | 检查实际 HTTP/HTTPS 绑定、防火墙和路由。 |

运行时密码必须每次后端启动都提供；通过设置保存的密码会持久保留。参阅[安全](security.md)、[TLS/绑定规则](remote-access.md)和[服务器参考](server.md)。

## 远程控制配对 {#pairing}

1. 在主机打开**设置 → 远程访问**，检查远程控制正在运行。
2. 创建新配对链接，在过期前于目标设备打开。
3. 如果客户端显示**重新配对此设备**，从主机配对，然后在客户端选择**检查连接**。

配对链接一次性且短期有效；直接访问密码不能替代。已撤销或因不活动过期的设备凭据需要重新配对。关闭最后一个桌面窗口会停止其后端，因此也停止远程控制；启用的服务会在下次应用启动时恢复。主机专用不可用界面和撤销参阅[远程控制](remote-control.md)。

## 提供商、插件和扩展状态 {#providers-and-addons}

- 添加的插件失败或显示**未确认** — 检查 OpenCode 主机上的软件包名称、版本和注册表访问。用插件提示中的错误编号搜索 OpenCode 日志。停用的插件也会显示**未确认**。
- 已安装扩展缺失 — 在面板自定义中启用它。安装/替换后保持禁用，直到显式激活并批准所需同意。
- **完整时间线暂不可用** — 在 OpenCode 日志中查看 `codenomad-session-pruning` 的加载错误。

参阅[提供商](providers.md)、[集成](integrations.md)和[扩展](extensions.md)。

## 历史、待处理请求和清理 {#history-and-requests}

完整历史搜索不局限于当前已加载的对话行。显示筛选隐藏内容而不删除；请通过[历史](history.md)区分搜索、压缩、技术清理和删除。

取消或部分清理时，开始另一轮删除前先阅读进度/回执。取消不撤销已派发批次。不要通过编辑原生数据库修复历史。

## 日志与安全诊断 {#diagnostics}

1. 打开**设置 → OpenCode → 查看 OpenCode 日志**。通过 `opencode debug paths log` 定位并读取所选执行主机的全局 `opencode.log`。最多显示最后 128 KiB；**刷新**会重新读取文件。
2. 在**偏好设置 → OpenCode**中，仅在需要更多细节时选择目标**日志详细程度**。独立 CodeNomad 日志请使用[服务器 CLI 日志选项](server.md)。CodeNomad 服务器还会在其配置文件旁（默认 `~/.config/codenomad`）的 `logs/server.log` 中保存自己的日志；上一个写满的文件是 `server.previous.log`。
3. 打开**设置 → 信息 → 诊断**，使用**报告错误**、**复制到剪贴板**或**下载 .txt**。

详细日志可能暴露路径、输出和应用数据。共享日志/截图前请脱敏凭据、配对链接、网络地址、私有路径和对话内容。完整诊断报告包含路径/地址；预填错误表单有意排除它们。参阅[报告错误](support.md#report-a-bug)。
