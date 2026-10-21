# 键盘快捷键

## 发现命令并打开帮助 {#discover-commands}

1. Windows/Linux 使用 `Ctrl+Shift+P`，macOS 使用 `Cmd+Shift+P` 打开**命令面板**，或使用可见按钮/菜单项。
2. 输入操作名。面板包括应用操作和当前 Location 自定义命令；可用性取决于活动视图。
3. 运行**打开帮助**，在外部浏览器上下文以当前界面语言打开本指南。原生 **帮助 → CodeNomad 帮助** 打开同一指南。

帮助不改变应用视图和草稿。打开失败时，直接访问 [CodeNomad 帮助](https://neuralnomadsai.github.io/CodeNomad/)。命令可发现不代表可自定义快捷键：快捷键管理器覆盖固定目录中的 74 项渲染器操作，而非所有命令面板或原生菜单操作。其中包括**压缩会话**、**撤销上一条消息**或**打开帮助**等初始为**未设置快捷键**的命令面板命令；项目文件夹、终端和编辑器操作只在本地桌面窗口中运行。

## 录制、禁用和重置 {#customize}

1. 打开**设置 → 键盘快捷键**，使用**筛选快捷键**查找操作或组合键。
2. 选择**编辑**，然后在**请按下组合键**中按目标组合。录制会保存绑定。
3. 使用**清除快捷键**（×）移除该操作的渲染器绑定，**重置**恢复默认值，或**全部重置**恢复所有渲染器绑定。
4. 解决每一行冲突警告；冲突会被报告，不会静默禁用。

绑定保存在 CodeNomad 界面配置中，影响共享配置的客户端。不会编辑 OpenCode CLI/TUI 绑定或原生菜单快捷键。录制抑制应用渲染器快捷键，但无法抑制操作系统或原生菜单。**取消**、失焦、关闭部分或离开窗口都会结束录制。单独修饰键和输入法组合输入会忽略；普通 Tab/Shift+Tab 移动焦点。

保存失败时，请保留旧快捷键可用，检查显示的绑定后重试。误分配时，重置是安全恢复方式。

## 渲染器默认值 {#renderer-defaults}

`Mod` 在 Windows/Linux 表示 `Ctrl`，在 macOS 表示 `Cmd`。这些是默认值，不保证操作系统/原生宿主会传递按键。作用域很重要：同一键在主页、输入框或搜索中可能执行不同操作。

| 操作 | 默认值 |
| --- | --- |
| 打开命令面板 | `Mod+Shift+P` |
| 新建实例 / 在主页浏览文件夹 | `Mod+N` |
| 关闭应用标签页 | `Mod+W` |
| 上一个 / 下一个应用标签页 | `Mod+[` / `Mod+]` |
| 应用标签页 1-9 | `Mod+1` 至 `Mod+9` |
| 重命名实例（标签页上下文） | `F2` |
| 新建会话 | `Mod+Shift+N` |
| 关闭会话 | `Mod+Shift+W` |
| 上一个 / 下一个会话 | `Mod+Shift+[` / `Mod+Shift+]` |
| 会话标签页 1-9 | `Mod+Shift+1` 至 `Mod+Shift+9` |
| 实例信息 | `Mod+Shift+L` |
| 搜索会话历史 | `Mod+F` |
| 上一条 / 下一条用户消息 | `Alt+ArrowUp` / `Alt+ArrowDown` (Windows, Linux) 或 `Mod+Alt+ArrowUp` / `Mod+Alt+ArrowDown` (macOS) |
| 下一个 / 上一个搜索结果（搜索获得焦点） | `Enter` / `Shift+Enter` |
| 聚焦输入框 / 清空输入框 | `Mod+P` / `Mod+K` |
| 打开模型 / 智能体选择器 | `Mod+Shift+M` / `Mod+Shift+A` |
| 选择模型变体 | `Mod+Shift+T` |
| 将阻塞工具转为后台（输入框） | `Mod+B` |
| 发送输入 | `Enter` |
| 使用另一种后续行为发送 | `Alt+Enter` (Windows, Linux) 或 `Mod+Shift+Enter` |
| 插入换行 | `Shift+Enter` 或 `Mod+Enter` |
| 上一条 / 下一条提示词（输入框） | `ArrowUp` / `ArrowDown` |
| 取消输入框焦点 / 退出 Shell 模式 | `Escape`，取决于输入框上下文 |
| 停止会话 | 按两次 `Escape`；第一次显示确认 |
| 发送旁支问题（`/btw` 窗口） | `Mod+Enter` |
| 保存文件（工作区编辑器） | `Mod+S` |

禁用 Enter 提交的配置中，**发送输入**默认为 `Mod+Enter`，**插入换行**默认为 `Enter` 或 `Shift+Enter`。显式快捷键覆盖会替换该默认值。使用管理器查看实际绑定。在 macOS 上，`Option+Return` 仍是换行，因此只有 `Cmd+Shift+Return` 会以另一种行为发送；会话工作时，输入框的**更多操作**菜单也提供同样的选择（**将消息加入队列**或**立即插入**）。**清空输入**会运行输入框自身的清除操作，包括在新对话的首个草稿中。上一个/下一个会话循环切换会话列表；不同于侧栏浏览器式的**后退**/**前进**历史，后者没有快捷键。

## 原生按键与平台拦截 {#native-keys}

原生按键固定，在更改或禁用对应渲染器绑定后仍有效。尤其是原生 **New Window** 使用 `Mod+Shift+N`，也是渲染器新建会话的默认值。原生菜单拦截时，请使用可见的新建会话控件，或重新绑定渲染器操作。同样，原生 `Mod+W` 可能关闭窗口，而非仅应用标签页。

| 原生操作 | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | View 菜单控件及平台 WebView 缩放输入 |
| Full Screen | Windows/Linux 为 `F11`；macOS 为 `Ctrl+Cmd+F` | macOS 菜单快捷键 `Ctrl+Cmd+F`；其他平台使用菜单 |
| Developer Tools | Windows/Linux 为 `Ctrl+Shift+I`；macOS 为 `Alt+Cmd+I` | `Alt+Mod+I` |

普通浏览器窗口也保留浏览器快捷键。绑定始终无法传到 CodeNomad 时，请选择其他组合，而非禁用安全功能或更改操作系统全局按键。

## 键盘布局与文本输入 {#layouts-ime}

数字行和方括号快捷键在录制、执行和冲突检查中使用物理键位，包括 AZERTY/QWERTZ 布局。其他键使用逻辑值。请在打算使用的键盘上录制，再检查显示结果。

输入法组合输入期间，文字输入优先。提示词历史和 Escape 操作也取决于焦点、选择器/Shell 状态及当前操作；不要假定所有 ArrowUp 或 Escape 都是无条件全局操作。在桌面端，发送后焦点会移到对话上，因此可用方向键、翻页键和空格键滚动对话；输入一个字符会带着该字符返回输入框，使用提示词历史前可用**聚焦输入框**返回那里。命令面板、搜索、新建会话、信息和输入框选择器等控件的工具提示会写明其当前快捷键；它们与快捷键管理器一起显示各项分配，无需常驻键盘帮助条。
