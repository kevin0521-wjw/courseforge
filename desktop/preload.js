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
  }
});
