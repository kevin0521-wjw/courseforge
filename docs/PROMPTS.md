# 🤖 CourseForge AI 开发提示词手册

本项目按「AI 协作开发」模式维护。无论你用的是 WorkBuddy、GitHub Copilot 还是其他 AI 编码助手，把下面的提示词连同相关代码文件一起投喂，即可高质量地继续迭代。

**使用方法**：选一条模板 → 替换 `{{占位符}}` → 把「通用约束块」附加在提示词末尾 → 发给 AI。

---

## 0. 通用约束块（每次必带）

```text
【项目约束 - 必须遵守】
- 技术栈：纯 HTML/CSS/JS，零外部依赖，禁止引入任何 CDN、框架、字体库、图标库
- 架构分四层：core.js（纯逻辑）→ render.js（数据转 HTML 字符串，禁止直接操作 DOM）→ app.js（事件与状态调度）→ storage.js（存储）
- 函数调用链必须是有向无环图：渲染函数之间严禁互相调用，所有联动刷新只能通过 app.js 的 refreshAll() 统一调度
- 用户数据进入状态前必须经过 normalizeCourse()/normalizeSettings() 清洗；渲染输出用户数据必须经过 esc() 转义
- 新增业务逻辑必须放进 core.js 作为纯函数，并同步在 tests/ 补充测试（node --test，零依赖）
- 移动端适配是硬性要求：按钮点击区 ≥ 44px，输入框字号 ≥ 16px，窄屏允许横向滚动
- 代码注释使用中文
- 完成后运行 npm test 与 npm run check:dom，确保全部通过
```

---

## 1. 初始化提示词（从零复刻本项目）

```text
请帮我从零搭建一个「大学生课程表平台」，以 GitHub 仓库格式交付，支持网页版和 Electron 桌面端。

【功能需求】
1. 周视图课程网格：周一至周日 × 每日节次（默认 12 节，可配置），课程卡片显示名称/教室/老师
2. 今日课程置顶区域：自动列出今天的课，标注「进行中 / 未开始 / 已结束」状态
3. 周次系统：设置学期开始日期（建议周一），自动计算当前第几周，支持按周翻页查看、回到本周
4. 课程管理：添加/编辑/删除课程，字段含名称、老师、教室、星期、起止节次、上课周次（支持单双周和任意周勾选）、备注、8 种颜色
5. 冲突检测：同一周同一天节次重叠的课程对，保存前提示确认
6. 数据：localStorage 持久化 + JSON 导出备份 + 导入恢复 + 清空（二次确认）
7. 首次打开预置 5 门示例课程，提供「清空示例」按钮

【交付结构】
web/（index.html + css/style.css + js/{core,storage,render,app}.js）
desktop/（Electron：main.js + preload.js + package.json，复用 web 页面）
tests/（node --test 单元测试 + jsdom 全流程测试）
tools/（serve.mjs 静态服务器、build-standalone.mjs 单文件打包、check-dom.mjs DOM 静态检查）
README.md、docs/PROMPTS.md、LICENSE(MIT)、.gitignore、.github/workflows/ci.yml

【质量要求】
核心逻辑（周次计算、冲突检测、数据清洗、渲染字符串）必须能在 Node 中脱离浏览器测试；
写完后自查：函数调用无环、DOMContentLoaded 初始化链完整、空数据不崩、跨年周次计算正确。
```

---

## 2. 功能迭代模板

```text
我正在开发 CourseForge（大学生课程表平台，纯 HTML/CSS/JS 零依赖）。
项目结构：web/js/{core,storage,render,app}.js 分层架构，调用链必须是 DAG。

【新功能】{{功能名称}}
【需求描述】{{一段话说清楚要什么，例如：在工具栏新增"深色模式"开关，跟随系统偏好，手动选择后记忆到 localStorage，key 沿用现有 wb_courseforge_v1 数据结构中的 settings.theme 字段}}
【交互细节】{{入口在哪、点完发生什么、边界情况}}
【验收标准】
- {{可验证的标准 1，例如：切换后刷新页面主题保持}}
- {{标准 2，例如：core/render 层新增函数有对应测试}}
- 移动端可用（按钮 ≥ 44px）
- npm test 与 npm run check:dom 全部通过
```

## 3. Bug 修复模板

```text
CourseForge（纯 HTML/CSS/JS 课程表）出现 bug，请按以下信息定位并修复：

【现象】{{看到什么，例如：点击"下一周"后表头日期没有更新}}
【复现步骤】1. ... 2. ... 3. ...
【期望】{{应该是什么样}}
【实际】{{实际是什么样}}
【控制台报错】{{有就贴，没有写"无"}}
【已排查】{{已经确认过什么，例如：state.displayWeek 的值是对的}}
【修复要求】先说根因再改代码；修复必须同步补一条能复现该 bug 的测试；运行 npm test 全绿后交付。
```

## 4. 代码审查模板

```text
请对 CourseForge 的以下代码做一次严格审查（纯 HTML/CSS/JS，零依赖，分层架构 core→render→app→storage）：

{{粘贴代码或给出文件}}

重点检查：
1. 调用链是否形成环（渲染函数互调 = 高危）
2. XSS：所有渲染输出的用户数据是否经过 esc()
3. 数据边界：空数据、越界节次、损坏的导入 JSON 是否能兜底
4. 事件绑定时机：是否在对应 DOM 存在后绑定
5. 移动端：点击区、字号、横向滚动
6. 测试缺口：哪些分支没有测试覆盖
按【必须修】【建议改】【可保留】三档输出，不要改需求本身。
```

## 5. 测试补充模板

```text
请为 CourseForge 补充测试。测试环境：node --test（零依赖），核心逻辑在 web/js/core.js（UMD 导出，可在 Node 直接 import），渲染字符串在 web/js/render.js，DOM 流程测试在 tests/app.dom.test.cjs（jsdom，可选依赖，缺失时跳过）。

【本次重点】{{模块或函数，例如：周次计算 getWeekNumber}}
【要求】
- 覆盖边界：跨年（12月末→1月初）、学期开始前（返回 ≤0）、非法输入（null/字符串/NaN）
- 冲突检测：跨周不冲突、同周重叠才冲突、单双周交错
- 数据清洗：导入脏数据（缺字段/类型错误/weeks 重复乱序）后 normalize 输出合法
- 每条测试只测一件事，失败信息可读
```

## 6. 打包发布模板

```text
请帮我把 CourseForge 打包发布：
【桌面端】用 electron-builder 打 Windows 安装包（nsis），应用名「课表工坊」，图标可后补；输出目录 desktop/release/（已加入 .gitignore）
【网页版】用 tools/build-standalone.mjs 生成单文件 HTML，部署到 {{GitHub Pages / 其他静态托管}}
【发布流程】版本号统一升级（根 package.json 与 desktop/package.json）→ 补 CHANGELOG → git tag vX.Y.Z → 提示我执行 push 命令
```

---

## 7. 完整示例：新增「深色模式」提示词

```text
我正在开发 CourseForge（大学生课程表平台，纯 HTML/CSS/JS 零依赖）。
项目结构：web/js/{core,storage,render,app}.js 分层架构，调用链必须是 DAG，所有刷新经 app.js 的 refreshAll()。

【新功能】深色模式
【需求描述】在顶栏设置抽屉新增主题选择（跟随系统 / 浅色 / 深色），默认跟随系统；选择结果存入 settings.theme，随现有数据一起持久化。
【交互细节】切换后立即生效无需刷新；深色模式下课程卡片背景/文字自动用对应暗色变量；今日课程状态色保持可读。
【验收标准】
- CSS 全部改用 CSS 变量（--bg/--panel/--text 等），不允许出现硬编码颜色散落各处
- normalizeSettings 兼容旧数据（无 theme 字段时默认 'system'）
- core 层新增 resolveTheme() 纯函数并补充测试
- npm test 与 npm run check:dom 全部通过
```

---

## 8. 调试与验证节奏建议

与 AI 协作开发时，建议按下面的循环推进（本项目自身也是按这个循环验证的）：

1. `npm test` — 核心逻辑回归
2. `npm run check:dom` — DOM id 与事件绑定静态检查
3. `npm run build:standalone` — 生成单文件版
4. 浏览器打开实际点一遍：添加课程 → 切周 → 导出 → 清空 → 导入
5. 手机或 DevTools 移动视口再过一遍
6. 发现问题 → 回到第 3 条模板报 bug → 循环
