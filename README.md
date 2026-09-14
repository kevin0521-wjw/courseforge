# 课表工坊 CourseForge

> 大学生自制课程表平台 · 网页版 + 桌面端 · 零依赖 · 数据完全本地

[![CI](https://github.com/kevin0521-wjw/courseforge/actions/workflows/ci.yml/badge.svg)](https://github.com/kevin0521-wjw/courseforge/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A522-green)

一份属于自己的、不依赖任何教务系统的课程表。**网页版**双击即用，**桌面端**（Electron）一键启动，数据 100% 存在本地，不上传任何服务器。

## ✨ 特性

- 🗓 **周视图课程网格**：周一至周日 × 每日节次，点击空白格子即可添加课程
- 📥 **智能课表导入**：照片 OCR / PDF / 粘贴教务系统文本，自动识别课程、时间、地点、教师，确认后一键入库
- 📍 **今日课程置顶**：打开页面第一眼就是今天的课，自动标注「进行中 / 未开始 / 已结束」
- 🔢 **自动周次计算**：设置学期开始日期，自动算出当前是第几周，支持单双周
- 🏫 **作息预设**：内置上海大学官方 12 节作息（来自教务部文件），也可用通用预设
- ⚠️ **时间冲突检测**：保存时自动检查同一周同一天节次是否重叠，防止排课撞车
- 🎨 **8 色课程卡片**：不同课程不同颜色，一眼区分
- 💾 **数据本地存储**：浏览器 localStorage / 桌面端本地存储，关闭不丢
- 📤 **一键备份恢复**：导出 JSON 备份、导入恢复，换设备迁移只需一个文件
- 📱 **移动端适配**：手机浏览器打开即可使用，可添加到主屏幕当 APP
- 🧪 **自带测试**：`node --test` 单元测试 + DOM 流程测试，CI 自动跑

## 🖼 界面预览

| 桌面端周视图 | 移动端（390px） |
| --- | --- |
| ![周视图](docs/preview-week.png) | ![移动端](docs/preview-mobile.png) |

## 📥 智能课表导入

工具栏「导入课表」支持三种来源，识别结果先进入**确认表格**（可勾选、可修改任一字段），点「导入所选」才入库：

| 来源 | 用法 | 说明 |
| --- | --- | --- |
| 📋 粘贴文本 | 从教务系统网页复制课表粘贴 → 「解析文本」 | 推荐优先使用，识别最准 |
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

> 教务系统网站直连抓取（登录后自动拉取课表）规划于桌面端 v0.3：浏览器跨域限制导致网页版无法直接读取教务网站，请先用「复制文本 → 粘贴解析」。


## 🚀 快速开始

### 方式一：网页版（零依赖，推荐先试这个）

直接双击打开 `web/index.html`，或者用仓库根目录的静态服务器：

```bash
npm run start:web        # 启动本地服务器，浏览器打开 http://localhost:5173
```

不想装 Node？直接打开 `dist/CourseForge-standalone.html`（单文件打包版，可拷贝到任何设备）。

### 方式二：桌面端（Electron）

```bash
cd desktop
npm install              # 安装 Electron（首次较慢）
npm start                # 启动桌面应用
```

### 打包桌面安装包（可选）

```bash
cd desktop
npm install --save-dev electron-builder
npx electron-builder --win    # 生成 Windows 安装包（-mac / -linux 同理）
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
│   ├── css/style.css       # 样式（响应式，PC/移动双端）
│   └── js/
│       ├── core.js         # 业务逻辑：周次计算/冲突检测/校验/作息预设（纯函数，可在 Node 直接测试）
│       ├── storage.js      # 存储层：localStorage 封装 + 内存兜底
│       ├── render.js       # 渲染层：数据 → HTML 字符串（纯函数，无 DOM 操作）
│       ├── parser.js       # 课表文本解析引擎：星期/节次/周次/地点/教师（纯函数，可单测）
│       ├── importer.js     # 导入模块：照片 OCR / PDF / 粘贴文本 → 确认表格 → 入库
│       └── app.js          # 调度层：事件绑定 / 状态管理 / 统一刷新入口 refreshAll()
├── desktop/                # Electron 桌面端（复用 web/ 页面）
│   ├── main.js             # 主进程：窗口创建
│   ├── preload.js          # 预加载：向页面注入桌面环境标识
│   └── package.json
├── tests/                  # 测试（node --test，无需安装任何依赖）
├── tools/                  # 开发脚本：静态服务器 / 单文件打包 / DOM 静态检查
├── docs/PROMPTS.md         # 🤖 AI 开发提示词手册（用 AI 继续迭代本项目必读）
└── .github/workflows/      # CI：push 时自动跑测试
```

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
npm test                 # 运行全部测试（node 内置 test runner，零依赖）
npm run check:dom        # 静态检查：JS 引用的 DOM id 是否都存在于 HTML
npm run build:standalone # 生成 dist/CourseForge-standalone.html 单文件版
```

测试覆盖：跨年/跨月周次计算、单双周生成、节次冲突检测、课程校验、导入数据清洗、渲染字符串安全性（XSS 转义）、localStorage 异常兜底、jsdom 全流程（打开页面 → 切周 → 新增课程）。

## 🗺 路线图

- [ ] **v0.2** 教务系统课表文本粘贴导入（自动解析）
- [ ] **v0.2** 多学期管理（学期切换、历史学期归档）
- [ ] **v0.3** 深色模式 / 主题色自定义
- [ ] **v0.3** PWA 支持（手机添加到主屏幕、离线缓存）
- [ ] **v0.4** 课程表分享图片生成
- [ ] **v0.4** 考试倒计时 & 自定义事件（非课程日程）
- [ ] **v1.0** 可选云同步（WebDAV），桌面端自动更新

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
