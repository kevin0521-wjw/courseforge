/**
 * 预加载脚本：向页面安全注入桌面环境标识与「教务直连」能力
 * 页面通过 window.CourseForgeDesktop 判断自己运行在桌面端
 *
 * 安全边界：只暴露三个固定动作（打开/读取/关闭），不接受任意 URL 的 fetch，
 * 也不把 ipcRenderer 整个交出去，避免页面被注入脚本后拿到主进程能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CourseForgeDesktop', {
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron || '',

  /**
   * 教务系统直连：浏览器里做不了（跨域），由主进程代取页面
   *  open(url)  → 打开一个独立窗口让用户登录教务系统
   *  grab()     → 读取该窗口当前页面的 HTML（含同源 iframe）
   *  close()    → 关闭该窗口
   */
  edu: {
    open: (url) => ipcRenderer.invoke('edu:open', url),
    grab: () => ipcRenderer.invoke('edu:grab'),
    close: () => ipcRenderer.invoke('edu:close')
  }
});
