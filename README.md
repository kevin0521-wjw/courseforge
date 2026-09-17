# 课表工坊 CourseForge

> 大学生自制课程表平台 · 网页版 + 桌面端 · 零依赖 · 数据完全本地

[![CI](https://github.com/kevin0521-wjw/courseforge/actions/workflows/ci.yml/badge.svg)](https://github.com/kevin0521-wjw/courseforge/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A522-green)

一份属于自己的、不依赖任何教务系统的课程表。**网页版**双击即用，**桌面端**（Electron）一键启动，数据 100% 存在本地，不上传任何服务器。

## ✨ 特性

- 🗓 **周视图课程网格**：周一至周日 × 每日节次，点击空白格子即可添加课程；可一键切换只看周一至周五
- 📥 **智能课表导入**：教务系统直连（桌面端）/ 照片 OCR / PDF / 粘贴教务系统文本，自动识别课程、时间、地点、教师，确认后一键入库
- 📍 **今日课程置顶**：打开页面第一眼就是今天的课，自动标注「进行中 / 未开始 / 已结束」
- ⏱ **上课进度与倒计时**：今日课程显示实时进度条、剩余时间、下一节开课倒计时（每分钟刷新，页面隐藏时暂停）
- 🔢 **自动周次计算**：设置学期开始日期，自动算出当前是第几周，支持单双周
- 🏫 **作息预设**：内置上海大学官方 12 节作息（来自教务部文件），也可用通用预设
- ⚠️ **时间冲突检测**：保存时自动检查同一周同一天节次是否重叠，防止排课撞车
- 🎨 **8 色课程卡片**：不同课程不同颜色，一眼区分，深色模式下自动切换配色
- 🌗 **深色模式**：跟随系统 / 浅色 / 深色 三态可切，首屏渲染前应用主题，不闪白
- 🗓 **导出系统日历**：一键导出 `.ics`，双击导入 iOS / 安卓 / Google / Outlook 日历，带 10 分钟上课提醒
- 🖨 **打印课表**：A4 横向打印样式，隐藏所有界面元素、保留课程配色，可直接打印贴墙
- 📚 **多学期管理**：一个工作台管理全部学期，新建 / 切换 / 重命名 / 删除，各学期课程与作息互相独立；旧数据自动迁移
- 💾 **数据本地存储**：浏览器 localStorage / 桌面端本地存储，关闭不丢
- 📤 **一键备份恢复**：导出 JSON 备份、导入恢复，换设备迁移只需一个文件
- 📱 **移动端适配**：手机浏览器打开即可使用；触屏点击区 ≥ 44px、输入字号 ≥ 16px
- 📲 **PWA**：可添加到手机主屏幕当 App 用，Service Worker 离线缓存，断网可打开
- 🧪 **自带测试**：346 项 `node --test` 测试（含 jsdom 全流程），CI 自动跑

## 🖼 界面预览

| 桌面端 · 周视图 | 桌面端 · 列表视图 |
| --- | --- |
| ![周视图](docs/preview-week.png) | ![列表视图](docs/preview-list.png) |

| 深色模式 | 打印课表（A4 横向） |
| --- | --- |
| ![深色模式](docs/preview-dark.png) | ![打印](docs/preview-print.png) |

| 移动端 · 周视图（390px） | 移动端 · 列表视图 |
| --- | --- |
| ![移动端](docs/preview-mobile.png) | ![移动端列表](docs/preview-mobile-list.png) |

| 智能导入 · 识别结果确认表 |
| --- |
| ![导入](docs/preview-import.png) |

## 📥 智能课表导入

工具栏「导入课表」支持四种来源，识别结果先进入**确认表格**（可勾选、可修改任一字段），点「导入所选」才入库：

| 来源 | 用法 | 说明 |
| --- | --- | --- |
| 🏫 教务直连 | 桌面端：填教务系统网址 + 账号密码 → 「一键登录并取课表」 | 自动登录后**优先走教务系统的数据接口**（字段明确、识别最准），接口不可用才退回解析课表页面；**仅桌面端**（网页版受同源策略限制） |
| 📋 粘贴文本 | 从教务系统网页复制课表粘贴 → 「解析文本」 | 网页版推荐，识别最准 |
| 📷 照片识别 | 课表拍照 / 截图 | Tesseract.js 中文 OCR，首次需联网加载约 15MB 引擎 |
| 📄 PDF 导入 | 课表 PDF 文件 | 文字版直接提取；扫描版自动转图片走 OCR |

解析器支持的写法（每行一门课，一行可写多个星期）：

```
高等数学A1 周一 3-4节 第1-16周 D楼202 张三
数据结构 周三 5,6节 1-16周(单) BJ102 李四
线性代数 周二,周四 1-2节 1-16周 教学楼B105 钱七
大学体育 周五 18:00-19:40 体育馆 赵六        ← 时间段自动映射节次
```

支持：`周一/星期一/礼拜一`、`第3-4节/3,4节/5-6节`、`1-16周/单周/双周/1-8,10-16周`、`18:00-19:40`（按作息表映射节次）、全角字符自动归一化。

> **关于教务直连**：浏览器里 JS 受同源策略限制，拿不到教务系统页面，所以这项能力只做在桌面端 ——
> 由 Electron 主进程开一个独立窗口完成登录与取数。课表放在 iframe 里也能读到（同源 iframe 会一并取回）。
> 网页版请用「粘贴文本 → 解析」，识别效果完全相同。
>
> **自动登录是怎么做的**：不自己实现教务系统的 RSA 加密，而是**复用学校页面自己的登录逻辑** ——
> 主进程在专用窗口里填好 `#yhm` / `#mm`，然后点页面上的登录按钮，剩下交给学校自己的 JS。
> 这样做的理由很实际：自己拼加密参数出错时，服务端只会回「用户名或密码错误」，
> 和真输错密码**完全无法区分**，调试时会被带偏，还可能因为连续失败触发账号锁定。
> 代价只是登录页改版时要跟着改选择器 —— 而选择器一坏就是「找不到表单」的明确报错，不会伪装成密码错误。
>
> **账号放在哪里**：勾选「记住账号」后，用户名与密码用 Electron `safeStorage` 加密后存在本机
> （Windows 走 DPAPI，密钥绑定当前 Windows 账户 —— 文件被拷到别的机器/别的账户都解不开）。
> 密码**只经过一次 IPC**，既不进网页的 localStorage，也不回传给页面（状态查询只回用户名）。
> 本机加密能力不可用时会**拒绝保存**，绝不降级成明文。随时可以点「忘记账号」清除。
>
> **学校开了验证码怎么办**：会自动停下并提示你到窗口里手动登录，之后点「重新取课表」——
> 不猜验证码，也不反复重试（重试只会白送失败次数）。


## 🚀 快速开始

### 方式一：网页版（零依赖，推荐先试这个）

直接双击打开 `web/index.html`，或者用仓库根目录的静态服务器：

```bash
npm run start:web        # 启动本地服务器，浏览器打开 http://localhost:5173
```

不想装 Node？直接打开 `dist/CourseForge-standalone.html`（单文件打包版，可拷贝到任何设备）。

#### 用手机真机测（内网穿透）

手机上访问不到电脑的 `127.0.0.1`；而「添加到主屏幕」这类 PWA 能力**必须走 HTTPS**，
用局域网 IP 也不行。`npm run tunnel` 一条命令就能把本地服务暴露成公网 HTTPS 地址：

```bash
npm run tunnel                 # 自动拉起本地服务 + 建立隧道
npm run tunnel -- --no-server  # 本地服务已在跑时，只建隧道
PORT=8080 npm run tunnel       # 换端口（默认 5173）
```

运行后输出里会给出形如 `https://xxxx.r16.vip.cpolar.cn` 的地址，**手机直接打开即可，不需要连同一个 WiFi**。
改完代码手机刷新就能看到，比每次重新部署快得多。

需要本机装好 [cpolar](https://www.cpolar.com/) 并登录（`cpolar authtoken <你的token>`）；
换路径可用 `CPOLAR_PATH` 环境变量指定。Ctrl+C 停止隧道。注意免费版分到的域名**每次启动都可能变**，以输出为准。

### 方式二：桌面端（Electron）

```bash
cd desktop
npm install              # 安装 Electron（首次较慢）
npm start                # 启动桌面应用
```

**启动不起来时（安全模式）**：如果应用在无显卡 / 容器 / 受限沙箱环境里闪退（典型报错
是 `GPU process isn't usable. Goodbye.`），用安全模式启动 —— 它会禁用硬件加速并关掉
Chromium 自带沙箱：

```bash
cd desktop
npx electron . --safe-mode            # 或设环境变量 COURSEFORGE_SAFE_MODE=1
```

> ⚠️ 安全模式会关掉 Chromium 的沙箱隔离。它只在「本机加载本地 `file://` 页面、不访问
> 外部网页内容」这个前提下可接受，**普通桌面环境请不要用**，保持默认即可。

### 打包桌面安装包（可选）

```bash
cd desktop
npm install            # 依赖里已含 electron-builder
npm run pack           # 快速验证：只出免安装目录 release/win-unpacked（不下载 NSIS）
npm run dist           # 出安装包 release/CourseForge-<版本>-setup.exe
```

打完**必须回来验产物** —— 「构建成功」这句话本身没有信息量：

```bash
npm run check:package  # 解开 app.asar 核对模块是否齐全、resources/web 是否带上
```

> **`--dir` 成功 ≠ 安装包能装。** `files` 白名单漏一个模块时，构建照样成功、exe 照样生成、
> 体积也正常，但用户装完双击就是 `Cannot find module`。`check:package` 就是拦这个的，
> 它还会核对产物的 `js/` 清单与源码是否一致，避免拿到旧产物误判成成功。

> **复用本地 Electron**：配置里设了 `electronDist`，直接拿 `node_modules/electron/dist` 打包，
> 不再去 GitHub 下载一份 100MB+ 的 Electron。

**下载 NSIS 组件超时**：electron-builder 要从 GitHub 取 NSIS / 7-Zip 组件，国内常见
`connect ETIMEDOUT`（`github.com` 被阻断时尤其明显）。换国内镜像即可：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \
  npm run dist
```

**受限沙箱里重复打包失败**：electron-builder 每次会清空输出目录，文件数超过 50 时
会被沙箱的批量删除策略拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。换个输出目录绕开：

```bash
npm run dist -- -c.directories.output=release-2
```

## 📦 数据与备份

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 自动保存 | 浏览器 localStorage | 每次修改立即写入，刷新/关闭不丢 |
| 导出备份 | 工具栏「导出备份」 | 生成 `courseforge-backup-日期.json` |
| 导入恢复 | 工具栏「导入恢复」 | 选择备份文件，确认后整库替换 |
| 清空数据 | 工具栏「清空数据」 | 二次确认后清空，请先导出备份 |

> 首次打开会预置 5 门示例课程，点「清空示例」一键移除。

## 🧱 项目结构

```
courseforge/
├── web/                    # 网页版（纯前端，零依赖）
│   ├── index.html          # 页面骨架
│   ├── manifest.webmanifest# PWA 清单（添加到主屏幕）
│   ├── sw.js               # Service Worker：离线缓存
│   ├── icon.svg            # 图标（内联 SVG，无外部图片依赖）
│   ├── css/style.css       # 样式（浅/深双主题、响应式、打印样式）
│   └── js/
│       ├── core.js         # 业务逻辑：周次计算/冲突检测/校验/作息预设（纯函数，可在 Node 直接测试）
│       ├── storage.js      # 存储层：localStorage 封装 + 内存兜底
│       ├── render.js       # 渲染层：数据 → HTML 字符串（纯函数，无 DOM 操作）
│       ├── parser.js       # 课表文本解析引擎：星期/节次/周次/地点/教师（纯函数，可单测）
│       ├── edu-html.js     # 教务课表解析：HTML 网格/转置/列表三种版面 + 正方接口 kbList（纯函数，可单测）
│       ├── importer.js     # 导入模块：教务直连 / 照片 OCR / PDF / 粘贴文本 → 确认表格 → 入库
│       ├── ics.js          # 日历导出：RFC 5545 生成（纯函数，可单测）
│       └── app.js          # 调度层：事件绑定 / 状态管理 / 统一刷新入口 refreshAll()
├── desktop/                # Electron 桌面端（复用 web/ 页面）
│   ├── main.js             # 主进程：窗口创建 + 教务自动登录 / 取课表 / 凭据 IPC
│   ├── edu-login.js        # 自动登录脚本与状态判定（纯函数，可单测；用户名密码走 JSON 转义防注入）
│   ├── cred-store.js       # 教务账号本机加密存储（safeStorage；加密不可用时拒绝保存而非降级明文）
│   ├── preload.js          # 预加载：向页面注入桌面环境标识与教务直连能力
│   └── package.json
├── tests/                  # 测试（node --test，无需安装任何依赖）
│   └── fixtures/           #   PDF / 教务文本夹具（真实来源，姓名与学号已化名）
├── tools/                  # 开发脚本
│   ├── serve.mjs           #   本地静态服务器（npm run start:web）
│   ├── tunnel.mjs          #   内网穿透：把本地服务暴露成公网 HTTPS（npm run tunnel）
│   ├── build-standalone.mjs#   单文件打包
│   ├── check-dom.mjs       #   DOM / data-action / CSS 静态检查
│   ├── mutation-check.mjs  #   变异测试：故意改坏代码，确认断言真的会变红
│   ├── browser-selftest.mjs#   真机自检：headless 浏览器 + CDP 跑真实 PDF 导入链路
│   ├── desktop-selftest.mjs#   桌面端自检：真启动 Electron，用 CDP 验证 preload / IPC / 安全边界
│   └── verify-package.mjs  #   打包产物校验：解 asar 头核对模块齐全、resources/web 与源码一致
├── docs/PROMPTS.md         # 🤖 AI 开发提示词手册（用 AI 继续迭代本项目必读）
├── docs/COMPARISON.md      # 📊 竞品对比与优化清单（功能矩阵 / 差异化定位 / 缺口优先级）
└── .github/workflows/      # CI：push 时跑测试 + 静态检查 + 变异测试 + 打包冒烟（不含出安装包，太重）
```

## 🖨 打印与日历导出

| 能力 | 说明 |
| --- | --- |
| 🖨 打印课表 | 工具栏「打印」→ A4 横向；自动隐藏工具栏/今日面板/弹窗，保留课程配色与周次标签 |
| 🗓 导出日历 | 工具栏「导出日历」→ `courseforge-YYYYMMDD.ics`；按周展开为独立日程，含 10 分钟提醒 |

> 日历导出按**周次展开**而非 RRULE 重复规则：单双周、跳周等不规则周次也能精确表达，且 iOS / 安卓 / Google 日历 / Outlook 全兼容。

## 🏗 架构设计

四层单向依赖，调用链必须是**有向无环图**（DAG），从架构上杜绝渲染函数互相调用导致的栈溢出：

```
app.js（调度层：事件 → 改数据 → refreshAll() 统一刷新）
  ├→ storage.js（存储层：读写 localStorage）
  ├→ render.js（渲染层：state → HTML 字符串，禁止直接写 DOM）
  │     └→ core.js（逻辑层：周次/冲突/校验，纯函数）
  └→ core.js
```

- 渲染函数之间**严禁互调**，所有联动刷新只经 `app.js` 的 `refreshAll()` 按固定顺序调度
- `core.js` / `render.js` 采用 UMD 导出，浏览器与 Node 环境通用，因此核心逻辑可以在没有浏览器的情况下被完整测试
- 用户数据永远先经过 `normalizeCourse() / normalizeSettings()` 清洗，再进入状态

## 🧪 测试

```bash
npm install              # 只为装 jsdom（可选，用于 DOM 全流程测试）；不装也能跑其余测试
npm test                 # 运行全部测试（node 内置 test runner）
npm run check:dom        # 静态检查：DOM id / data-action 接线 / CSS 结构 / 桌面端 IPC 通道
npm run check:mutation   # 变异测试：故意改坏被测代码，确认断言真的会变红
npm run check:browser    # 真机自检：headless Edge + CDP 跑一遍真实 PDF 导入链路
npm run check:desktop    # 桌面端自检：真启动 Electron，验证 preload 注入 / IPC 往返 / 安全边界
npm run check:package    # 打包产物校验：解 asar 核对模块与 resources/web（未打包时自动跳过）
npm run build:standalone # 生成 dist/CourseForge-standalone.html 单文件版
npm run pack:desktop     # 打包桌面端（免安装目录）
npm run dist:desktop     # 打包桌面端（NSIS 安装包）
npm run verify           # 测试 + 静态检查 + 变异测试 + 打包冒烟 + 产物校验，一条命令跑完
```

> `check:browser` / `check:desktop` 不在 `verify` 里：它们要真实网络与图形环境
> （会拉起浏览器 / Electron），不适合当默认门禁，按需手动跑。
> `check:package` 在 `verify` 里，但**未打包时只打印一行提示并跳过**，不会在 CI 里造假失败。
> `check:browser` 补的是 Node 测试覆盖不到的那一段 —— 同源相对路径取 CMap、
> pdf.js worker 加载、各镜像在真实网络下的可达性（缺浏览器可用 `EDGE_PATH` 指定）；
> `check:desktop` 则验证静态检查做不到的部分 —— preload 是否真的注入了
> `window.CourseForgeDesktop`、`edu:*` IPC 是否真的能往返、以及 `sanitizeUrl`
> 在真实调用链上是否真的拦得住 `javascript:` / `file://` 这类协议（21 项断言；
> 需先在 `desktop/` 里 `npm install`）。它默认用**产品默认配置**启动（即用户双击
> 时的真实路径）；无 GPU / 容器等受限环境起不来时，加 `SAFE_MODE=1` 走安全模式重试：
> `SAFE_MODE=1 npm run check:desktop`。
>
> 自检还能直接验**打包产物**（打包版走的是 `app.isPackaged` + `resources/web` +
> asar 内 preload，与开发态完全是两条路径，只验一条推不出另一条）：
> `PACKAGED_APP=desktop/release/win-unpacked/课表工坊.exe npm run check:desktop`。

> **运行时零依赖，依赖只在测试层**：`jsdom` 仅用于驱动真实 `index.html` 跑全流程测试，未安装时这些用例自动跳过（不阻断）。交付产物（网页版 / 单文件版 / 桌面端）不依赖任何 npm 包。

测试覆盖：跨年/跨月周次计算、单双周生成、节次冲突检测、课程校验、导入数据清洗、渲染字符串安全性（XSS 转义）、localStorage 异常兜底、课表文本解析（16 项）、ICS 日历生成（RFC 5545 折行/转义/跨年）、深色主题变量完整性、显示周末联动、移动端触屏硬指标（44px 点击区 / 16px 输入字号）、多学期工作区（v1→v2 迁移、增删改语义、切换不串台）、教务系统解析（HTML 网格/转置/列表三种版面 + rowspan 合并 + 一格多课 + script/注释干扰 + 降级提示；正方接口 kbList 字段别名/单双周/缺星期跳过/外层壳变体）、自动登录（用户名密码 JSON 转义防注入 + 验证码收手 + 失败文案回读）、账号本机加密存储（读写往返 + 磁盘无明文 + 无加密能力时拒绝保存 + 文件损坏兜底）、学期 UI 回归护栏（class 有样式 / 复合选择器点击区 / 动作已注册 / 改动必落盘）、jsdom 全流程（打开页面 → 切周 → 新增课程 → 刷新持久化 → 新建/切换/重命名/删除学期 → 教务直连读回并入库）。

> 当前 **341 项测试全部通过**。

## 🗺 路线图

- [x] **v0.2** 教务系统课表文本粘贴导入（自动解析）
- [x] **v0.2** 照片 OCR / PDF 导入
- [x] **v0.3** 深色模式（跟随系统 / 浅色 / 深色）
- [x] **v0.3** PWA 支持（添加到主屏幕、离线缓存）
- [x] **v0.3** 导出 `.ics` 系统日历
- [x] **v0.3** 今日课程实时进度与下一节倒计时
- [x] **v0.3** 打印课表（A4 横向）
- [x] **v0.3** 显示周末开关（周一到周五视图）
- [x] **v0.4** 多学期管理（新建 / 切换 / 重命名 / 删除，v1 数据自动迁移）
- [x] **v0.4** 教务系统直连导入（桌面端主进程代取页面，绕开浏览器跨域；支持网格/转置/列表三种版面）
- [x] **v0.5** 教务一键自动登录（复用学校页面自身登录逻辑）+ 结构化接口取课表 + 账号本机加密存储
- [ ] **v0.5** 课程表分享图片生成（Canvas 手绘，不引图表库）
- [ ] **v0.5** 考试倒计时 & 自定义事件（非课程日程）
- [ ] **v0.5** 桌面托盘小组件 / 常驻提醒
- [ ] **v1.0** 可选云同步（WebDAV），桌面端自动更新

> 路线图的取舍依据见 [docs/COMPARISON.md](docs/COMPARISON.md)（含 10 个同类开源项目的功能矩阵与缺口优先级）。

## 🤖 用 AI 继续开发

本项目按「AI 协作开发」规范搭建，[docs/PROMPTS.md](docs/PROMPTS.md) 收录了完整的提示词手册：功能迭代、Bug 修复、代码审查、测试补充、打包发布等模板，开箱即用。

## 🛠 二次开发约定

- 全部代码**零外部依赖**：不引 CDN、不引框架、不引字体库，图标全部内联 SVG
- 代码注释使用中文
- 新增逻辑优先放进 `core.js`（纯函数）并补充测试
- 移动端适配是硬性要求：按钮点击区 ≥ 44px，输入框字号 ≥ 16px
- 渲染层输出用户数据必须经过 `esc()` 转义

## 📄 协议

[MIT](LICENSE) © 2026 kevin0521-wjw
