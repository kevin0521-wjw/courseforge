/**
 * 预加载脚本：向页面安全注入桌面环境标识
 * 页面通过 window.CourseForgeDesktop 判断自己运行在桌面端
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('CourseForgeDesktop', {
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron || ''
});
