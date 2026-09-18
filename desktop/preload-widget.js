/**
 * 小组件窗口的预加载脚本
 *
 * 与主窗口的 preload 刻意分开：小组件**不需要**任何教务系统能力，
 * 给它一份只有「取数据 / 隐藏自己 / 打开主窗口」的极简接口就够了。
 * 界面越简单、能力越少，被注入脚本后能干的事就越少。
 *
 * 注意这里**没有**暴露 ipcRenderer 本身，也不接受自定义通道名 ——
 * 页面只能调这三个具名方法。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CourseForgeWidget', {
  /** 拉取一次当前视图（页面首次加载时用；之后靠 onUpdate 被动接收） */
  getView: () => ipcRenderer.invoke('widget:view'),

  /** 隐藏小组件（不是关闭 —— 还能从托盘唤回） */
  hide: () => ipcRenderer.invoke('widget:hide'),

  /** 打开主窗口 */
  openMain: () => ipcRenderer.invoke('widget:open-main'),

  /**
   * 订阅主进程推送。回调里只传视图数据，不透传 IpcRendererEvent ——
   * 那个对象上挂着 sender，等于把主进程的引用递给了页面。
   * 返回取消订阅的函数，页面卸载时能干净地退订。
   */
  onUpdate: (cb) => {
    if (typeof cb !== 'function') return function () {};
    const handler = (event, view) => cb(view);
    ipcRenderer.on('widget:update', handler);
    return function () { ipcRenderer.removeListener('widget:update', handler); };
  }
});
