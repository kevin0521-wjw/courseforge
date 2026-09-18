/**
 * 预加载脚本：向页面安全注入桌面环境标识与「教务直连」能力
 * 页面通过 window.CourseForgeDesktop 判断自己运行在桌面端
 *
 * 安全边界：只暴露固定几个动作（打开/读取/关闭/登录/取课表/账号状态），
 * 不接受任意 URL 的 fetch，也不把 ipcRenderer 整个交出去，
 * 避免页面被注入脚本后拿到主进程能力。
 *
 * 关于账号密码：页面把密码交给 login() 之后就不再保留（调用方会立即清空输入框）。
 * 明文只经过这一次 IPC，落到磁盘上的一定是 safeStorage 加密后的密文；
 * 主进程也从不把密码回传给页面 —— credStatus() 只回用户名用于显示。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CourseForgeDesktop', {
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron || '',

  /**
   * 随包 CMap 基地址（cfcmap:// 特权协议，主进程只服务 cmaps/ 目录）。
   * Chromium 禁止 file:// 页面 fetch —— 没有它，桌面端解中文 PDF 必需的
   * .bcmap 只能靠 CDN 兜底，弱网/离线时整页文字解不出。
   * importer.js 会把它排在 CMap 源链最前面；取不到自然回落 CDN。
   */
  cmapBase: 'cfcmap://cmaps/',

  /**
   * 教务系统直连：浏览器里做不了（跨域），由主进程代取页面
   *  open(url)      → 打开一个独立窗口让用户登录教务系统
   *  grab()         → 读取该窗口当前页面的 HTML（含同源 iframe）
   *  close()        → 关闭该窗口
   *  login(payload) → 自动登录（复用学校页面自己的登录逻辑）
   *  courses()      → 已登录状态下取课表（优先结构化接口，退化为抓页面）
   *  credStatus()   → 本机是否已保存账号（只回用户名，绝不回密码）
   *  credClear()    → 清除本机保存的账号
   */
  edu: {
    open: (url) => ipcRenderer.invoke('edu:open', url),
    grab: () => ipcRenderer.invoke('edu:grab'),
    close: () => ipcRenderer.invoke('edu:close'),

    // 入口处就把类型收敛掉：字符串/布尔量之外一律丢弃，
    // 后面主进程的校验因此可以假设「拿到的都是干净类型」
    login: (payload) => ipcRenderer.invoke('edu:login', {
      url: String((payload && payload.url) || ''),
      username: String((payload && payload.username) || ''),
      password: String((payload && payload.password) || ''),
      remember: !!(payload && payload.remember)
    }),
    courses: () => ipcRenderer.invoke('edu:courses'),
    credStatus: () => ipcRenderer.invoke('edu:cred-status'),
    credClear: () => ipcRenderer.invoke('edu:cred-clear')
  },

  /**
   * 桌面外壳：托盘 + 常驻小组件
   *
   * push(workspace) 是这里唯一「把数据送出主进程」的接口，值得说清楚为什么安全：
   * 传出去的是**课表数据本身**，不包含任何凭据；主进程拿到后只用来算「下节课」，
   * 不落盘、不外发。之所以要送，是因为托盘提示与小组件都要在主窗口关闭后仍能工作，
   * 而它们不能去读渲染进程的 localStorage。
   */
  shell: {
    push: (workspace) => ipcRenderer.invoke('shell:push', workspace),
    status: () => ipcRenderer.invoke('shell:status'),
    showWidget: () => ipcRenderer.invoke('shell:widget-show'),
    hideWidget: () => ipcRenderer.invoke('shell:widget-hide'),
    toggleWidget: () => ipcRenderer.invoke('shell:widget-toggle')
  },

  /**
   * WebDAV 云同步（可选功能）：HTTP 由主进程代发（网页版受 CORS 限制）。
   * 密码两条路：页面把密码交一次（saveCred 后立即丢弃），之后 useStored
   * 让主进程用加密存储里的那份 —— 与教务账号同一套「只存密文、不回传」的规矩。
   * 入参在桥上就做类型收敛，主进程拿到的永远是干净类型。
   */
  cloud: {
    upload: (p) => ipcRenderer.invoke('cloud:upload', {
      url: String((p && p.url) || ''),
      username: String((p && p.username) || ''),
      password: String((p && p.password) || ''),
      body: (typeof (p && p.body) === 'string') ? p.body : null,
      useStored: !(p && p.password)
    }),
    download: (p) => ipcRenderer.invoke('cloud:download', {
      url: String((p && p.url) || ''),
      username: String((p && p.username) || ''),
      password: String((p && p.password) || ''),
      useStored: !(p && p.password)
    }),
    saveCred: (p) => ipcRenderer.invoke('cloud:cred-save', {
      username: String((p && p.username) || ''),
      password: String((p && p.password) || '')
    }),
    credStatus: () => ipcRenderer.invoke('cloud:cred-status'),
    credClear: () => ipcRenderer.invoke('cloud:cred-clear')
  },

  /**
   * 检查更新（只读，无参数、无凭据）：主进程查 GitHub Releases 比对版本，
   * 返回 { status, current, latest, downloadUrl, message }。
   * 不做静默下载安装 —— 链接交给页面，用户自己决定何时去下载。
   */
  update: {
    check: () => ipcRenderer.invoke('update:check')
  }
});
