/**
 * CourseForge 课表导入模块
 * 三个来源：粘贴文本 / 照片 OCR（Tesseract.js 懒加载）/ PDF（pdf.js 懒加载）
 * 解析统一走 CourseParser.parseScheduleText，结果在确认表格中可勾选、可修改后入库
 * 依赖：core.js（CF）、parser.js（CP）；通过 mount(bridge) 与 app.js 解耦
 */
(function () {
  'use strict';

  var CF = window.CourseForge;
  var CP = window.CourseParser;

  var PDFJS_VERSION = '3.11.174';
  var TESSERACT_VERSION = '5.1.1';

  /**
   * 引擎脚本源 —— 顺序即优先级，**境内镜像排第一**。
   *
   * 第一版把 jsdelivr 放在首位，那在大陆是错的：jsdelivr 经常整个域名不可达，
   * 备用源 unpkg 同样不稳，两个都挂就只剩「脚本加载失败（检查网络）」。
   * 淘宝 npmmirror 是境内节点，实测 pdf.js / cmaps / tesseract 都能稳定取到，
   * 所以由它打头，境外源退为兜底。
   *
   * 注意两个路径模板不同（npmmirror 用 /<pkg>/<ver>/files/<path>），
   * 不能简单替换域名，必须按各站格式拼。
   */
  function cdnUrls(pkg, version, path) {
    return [
      'https://registry.npmmirror.com/' + pkg + '/' + version + '/files/' + path,
      'https://cdn.jsdelivr.net/npm/' + pkg + '@' + version + '/' + path,
      'https://unpkg.com/' + pkg + '@' + version + '/' + path
    ];
  }

  var TESSERACT_URLS = cdnUrls('tesseract.js', TESSERACT_VERSION, 'dist/tesseract.min.js');
  var PDFJS_URLS = cdnUrls('pdfjs-dist', PDFJS_VERSION, 'build/pdf.min.js');

  /**
   * CMap 源候选 —— 中文 PDF 能不能解出文字，全看这一项。
   *
   * 国内教务系统导出的 PDF 普遍用 Type0 + CMap 编码的非嵌入字体
   * （如 STSong-Light + UniGB-UCS2-H）。pdf.js 必须加载对应的 .bcmap
   * 才能把字符码映射成文字；拿不到就一个字符也读不出来。
   *
   * ⚠️ 这里踩过一个代价很大的坑，别再改回去：
   *    早先的实现是「先探测本地 cmaps/ 是否可用，2 秒没响应就回退到 CDN」。
   *    那个设计在大陆是【主动帮倒忙】——
   *      · 本地 cmaps/ 随包发布、同源、几乎永远可用，只是可能慢；
   *      · 而回退目标 jsdelivr 经常整个域名不可达。
   *    于是网络稍差时，它把本来能用的本地源换成取不到的远端源。
   *    更糟的是 pdf.js 在 CMap 取不到时【只 warn 不抛错】，
   *    getTextContent() 静静地返回空数组，界面上只剩一句
   *    「PDF 中未提取到文字」，完全看不出真实原因（我为此误诊了两轮）。
   *
   * 现在改成【按可靠性排序 + 实试】：拿第一页当探针，谁先解出文字就用谁，
   * 不做任何基于超时的猜测。顺序：本地随包目录 → 境内镜像 → 境外兜底。
   */
  var CMAP_SOURCES = [
    'cmaps/',
    'https://registry.npmmirror.com/pdfjs-dist/' + PDFJS_VERSION + '/files/cmaps/',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/cmaps/'
  ];
  // 会话内记住「这次可用的源」，后续导入直接排到最前面，不重复试错。
  var cmapSourceCache = null;

  var bridge = null;          // { getSettings, apply, toast }
  var parsedItems = [];       // 解析结果（可编辑）
  var ocrWorker = null;       // Tesseract worker 缓存

  // ==================== 工具 ====================

  function $(id) { return document.getElementById(id); }

  /**
   * 依次尝试各镜像加载脚本，resolve 为【实际成功的那个 URL】。
   * 返回 URL 而不是 void：worker 之类的同伴资源必须跟主脚本同源，
   * 否则主脚本从境内镜像下来了、worker 还写死境外域名，引擎仍然是半残。
   */
  function loadScript(urls) {
    return new Promise(function (resolve, reject) {
      var i = 0;
      var tried = 0;
      function tryNext() {
        if (i >= urls.length) {
          reject(new Error('脚本加载失败（已试 ' + tried + ' 个源，请检查网络）'));
          return;
        }
        var url = urls[i++];
        tried++;
        var el = document.createElement('script');
        el.src = url;
        el.onload = function () { resolve(url); };
        el.onerror = function () { el.remove(); tryNext(); };
        document.head.appendChild(el);
      }
      tryNext();
    });
  }

  function setStatus(msg) {
    var el = $('importStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setProgress(pct) {
    var wrap = $('importProgressWrap');
    var bar = $('importProgressBar');
    if (!wrap || !bar) return;
    wrap.hidden = pct == null;
    bar.style.width = Math.round(pct * 100) + '%';
  }

  /** 图片文件 → 压缩到 maxW 宽的 canvas（加快 OCR） */
  function fileToCanvas(file, maxW) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, maxW / (img.naturalWidth || maxW));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /** 确保 Tesseract.js 已加载，并创建中文识别 worker（带进度回调） */
  function ensureOcr() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    return loadScript(TESSERACT_URLS).then(function () {
      if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎加载失败');
      return Tesseract.createWorker('chi_sim', 1, {
        logger: function (m) {
          if (m && typeof m.progress === 'number') setProgress(m.progress);
        }
      });
    }).then(function (w) { ocrWorker = w; return w; });
  }

  /** 确保 pdf.js 已加载，并把 worker 指向与主脚本同一个镜像 */
  function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return loadScript(PDFJS_URLS).then(function (okUrl) {
      if (!window.pdfjsLib) throw new Error('PDF 引擎加载失败');
      // worker 必须跟主脚本同源：pdf.min.js 与 pdf.worker.min.js 在各镜像上都同目录，
      // 换掉文件名即可。写死单一域名的话，主脚本下来了、worker 下不来，引擎照样废。
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        okUrl.replace(/pdf\.min\.js$/, 'pdf.worker.min.js');
      return window.pdfjsLib;
    });
  }

  /**
   * 把一页的 items 还原成文本。
   * 优先用版面引擎还原表格（能保住「哪门课在星期几」），
   * 引擎缺失或判定为非表格时退回朴素的「一行一片段」，至少不会比原来更差。
   */
  function layoutPage(items) {
    var PL = window.CoursePdfLayout;
    if (PL && typeof PL.layoutToText === 'function') {
      try {
        var res = PL.layoutToText(items);
        if (res && typeof res.text === 'string') return res.text;
      } catch (e) { /* 落到下面的兜底 */ }
    }
    return (items || []).map(function (it) { return it.str; }).join(' ');
  }

  // ==================== 解析入口 ====================

  /** 把解析结果统一成待确认结构（补默认周次），feedText / feedEduHtml 共用 */
  function toResultItems(items, total) {
    return (items || []).map(function (it) {
      return {
        selected: true,
        name: it.name || '',
        teacher: it.teacher || '',
        location: it.location || '',
        day: it.day || 1,
        startSection: it.startSection,
        endSection: it.endSection,
        weeks: it.weeks || defaultWeeks(total),
        raw: it.raw || ''
      };
    });
  }

  /** 文本 → parsedItems（补默认周次） */
  function feedText(text) {
    var settings = bridge ? bridge.getSettings() : {};
    var total = (settings && settings.totalWeeks) || 16;
    var r = CP.parseScheduleText(text, {
      sectionTimes: settings && settings.sectionTimes,
      totalWeeks: total
    });
    parsedItems = toResultItems(r.items, total);
    renderResults(r.warnings);
  }

  /**
   * 教务系统页面 HTML → parsedItems
   * 与 feedText 的区别：HTML 解析器已经知道星期/节次（来自表格的行列位置），
   * 这里只负责补默认周次并落到统一的待确认结构，后续勾选/修改/入库完全复用同一条链路。
   */
  function feedEduHtml(html) {
    if (!window.CourseForgeEdu) {
      setStatus('教务解析模块未加载，请刷新页面重试');
      return null;
    }
    var settings = bridge ? bridge.getSettings() : {};
    var total = (settings && settings.totalWeeks) || 16;
    var r = window.CourseForgeEdu.parseEduHtml(html, {
      sectionTimes: settings && settings.sectionTimes,
      totalWeeks: total
    });
    parsedItems = toResultItems(r.items, total);
    renderResults(r.warnings);
    return r;
  }

  // ==================== 教务系统直连（仅桌面端可用） ====================

  var EDU_URL_KEY = 'wb_courseforge_edu_url';

  /** 取桌面端桥；网页版返回 null（浏览器跨域拿不到教务系统页面） */
  function desktopEdu() {
    return (window.CourseForgeDesktop && window.CourseForgeDesktop.edu) || null;
  }

  /** 按运行环境切换「教务直连」面板：桌面端给操作区，网页版给粘贴引导 */
  function syncEduPane() {
    var webHint = $('eduWebHint');
    var deskPane = $('eduDesktopPane');
    if (!webHint || !deskPane) return;
    var d = desktopEdu();
    webHint.hidden = !!d;
    deskPane.hidden = !d;
    if (!d) return;
    var input = $('eduUrl');
    if (input && !input.value) {
      try { input.value = localStorage.getItem(EDU_URL_KEY) || ''; } catch (e) { /* 隐私模式忽略 */ }
    }
    // 账号状态每次切进来都重新问一次主进程：用户可能在别处清除过
    onEduCredStatus();
  }

  function onEduOpen() {
    var d = desktopEdu();
    if (!d) return;
    var input = $('eduUrl');
    var url = (input ? input.value : '').trim();
    if (!url) { setStatus('请先填写教务系统网址'); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { localStorage.setItem(EDU_URL_KEY, url); } catch (e) { /* 忽略 */ }
    setStatus('正在打开教务系统窗口…');
    d.open(url).then(function (ok) {
      setStatus(ok
        ? '教务系统窗口已打开：请在那里登录并进入课表页面，然后回到这里点「读取当前页课表」'
        : '打开教务系统窗口失败，请检查网址是否正确');
    })['catch'](function (err) {
      setStatus('打开失败：' + ((err && err.message) || '未知错误'));
    });
  }

  function onEduGrab() {
    var d = desktopEdu();
    if (!d) return;
    setStatus('正在读取教务系统页面…');
    d.grab().then(function (res) {
      if (!res || !res.ok) {
        if (res && res.reason === 'nowindow') {
          setStatus('还没有打开教务系统窗口，请先点「打开教务系统窗口」');
        } else {
          setStatus('读取失败：' + ((res && res.message) || '未知错误'));
        }
        return;
      }
      if (!res.html) {
        setStatus('读取到的页面是空的，请确认已经登录并打开了课表页面');
        return;
      }
      var r = feedEduHtml(res.html);
      // feedEduHtml 返回 null 表示它已经给出了具体失败原因（如解析模块未加载），
      // 这里必须直接返回，否则会被下面的笼统文案盖掉，用户看到的原因就是错的
      if (!r) return;
      if (!r.items.length) {
        setStatus('没能从当前页面识别出课表，请确认课表已经显示出来（不是登录页/首页）');
        return;
      }
      setStatus('已从教务系统识别出 ' + r.items.length + ' 门课（版面：' + layoutName(r.layout)
        + '），请核对下方表格后点「导入所选」');
    })['catch'](function (err) {
      setStatus('读取失败：' + ((err && err.message) || '未知错误'));
    });
  }

  // ==================== 自动登录与取课表（桌面端） ====================

  /** 当前教务账号的保存状态（主进程只回用户名，密码永不下发） */
  var eduCred = { available: false, saved: false, username: '' };

  /** 刷新「账号状态」这一行的文案 */
  function renderEduCredState() {
    var el = $('eduCredState');
    if (!el) return;
    if (!eduCred.available) {
      el.textContent = '本机没有可用的加密存储，无法保存账号（Windows 一般不会遇到）。不影响手动登录。';
      return;
    }
    el.textContent = eduCred.saved
      ? '已保存账号：' + eduCred.username + '（本机加密存储，密码不下发到页面）。留空密码直接点「一键登录并取课表」即可。'
      : '账号未保存。登录成功后如勾选「记住账号」，下次可以只点一下按钮。';
  }

  function onEduCredStatus() {
    var d = desktopEdu();
    if (!d || typeof d.credStatus !== 'function') return Promise.resolve();
    return d.credStatus().then(function (st) {
      if (st && typeof st === 'object') {
        eduCred = {
          available: !!st.available,
          saved: !!st.saved,
          username: st.username || ''
        };
      }
      // 已保存过就把学号填回去，省得用户再打一遍（密码仍然要用户按需输入）
      var u = $('eduUser');
      if (u && !u.value && eduCred.saved) u.value = eduCred.username;
      var rm = $('eduRemember');
      if (rm && eduCred.saved) rm.checked = true;
      renderEduCredState();
    })['catch'](function () { /* 状态拿不到不影响主流程 */ });
  }

  function currentEduUrl() {
    var input = $('eduUrl');
    var url = (input ? input.value : '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { localStorage.setItem(EDU_URL_KEY, url); } catch (e) { /* 隐私模式忽略 */ }
    return url;
  }

  /** 登录结果 → 状态栏文案。失败原因是给用户看的最关键信息，不要笼统化 */
  function reportLoginResult(res) {
    if (!res || !res.ok) {
      var reason = res && res.reason;
      if (reason === 'nocred') { setStatus((res && res.message) || '请填写账号密码'); return false; }
      if (reason === 'badurl') { setStatus('教务系统网址不正确'); return false; }
      if (reason === 'captcha') {
        setStatus('教务系统要求验证码：请在已打开的窗口里手动登录，完成后回到这里点「重新取课表」');
        return false;
      }
      if (reason === 'fail') { setStatus('登录失败：' + ((res && res.message) || '用户名或密码错误')); return false; }
      setStatus('登录没成功：' + ((res && res.message) || '未知原因'));
      return false;
    }
    if (res.remembered) {
      setStatus('登录成功，账号已加密保存在本机。正在获取课表…');
    } else if (res.rememberError === 'noenc') {
      setStatus('登录成功（本机加密存储不可用，账号未保存）。正在获取课表…');
    } else {
      setStatus('登录成功' + (res.alreadyLoggedIn ? '（用的是上次的登录状态）' : '') + '，正在获取课表…');
    }
    return true;
  }

  /** 把取课表的结果喂进确认表：接口数据走结构化解析，HTML 走版面解析 */
  function feedEduResult(res) {
    if (res.source === 'api') {
      if (!window.CourseForgeEdu || typeof window.CourseForgeEdu.parseZfKbList !== 'function') {
        setStatus('教务解析模块未加载，请刷新页面重试');
        return;
      }
      var settings = bridge ? bridge.getSettings() : {};
      var total = (settings && settings.totalWeeks) || 16;
      var r = window.CourseForgeEdu.parseZfKbList(res.json, {
        sectionTimes: settings && settings.sectionTimes,
        totalWeeks: total
      });
      parsedItems = toResultItems(r.items, total);
      renderResults(r.warnings);
      if (!r.items.length) {
        setStatus('教务接口已连上（' + res.candidate + '），但没解析出课程。可改用手动登录后「读取当前页课表」');
        return;
      }
      setStatus('已从教务接口取到 ' + r.items.length + ' 门课（' + res.candidate
        + '），请核对下方表格后点「导入所选」');
      return;
    }

    // HTML 兜底路径：复用已有的页面解析
    var rh = feedEduHtml(res.html);
    if (!rh) return;
    if (!rh.items.length) {
      setStatus('已打开课表页面（' + res.candidate + '），但没识别出课表结构，请核对页面内容');
      return;
    }
    setStatus('已从课表页面识别出 ' + rh.items.length + ' 门课（版面：' + layoutName(rh.layout)
      + '），请核对下方表格后点「导入所选」');
  }

  function fetchEduCourses() {
    var d = desktopEdu();
    if (!d || typeof d.courses !== 'function') {
      setStatus('当前桌面端版本不支持一键取课表，请用「打开教务系统窗口」+「读取当前页课表」');
      return Promise.resolve();
    }
    return d.courses().then(function (res) {
      if (!res || !res.ok) {
        setStatus('取课表失败：' + ((res && res.message) || '未知原因'));
        return;
      }
      feedEduResult(res);
    })['catch'](function (err) {
      setStatus('取课表失败：' + ((err && err.message) || '未知错误'));
    });
  }

  function onEduAutoLogin() {
    var d = desktopEdu();
    if (!d || typeof d.login !== 'function') {
      setStatus('当前桌面端版本不支持自动登录，请用「打开教务系统窗口」手动登录');
      return;
    }
    var url = currentEduUrl();
    if (!url) { setStatus('请先填写教务系统网址'); return; }

    var uEl = $('eduUser');
    var pEl = $('eduPass');
    var rEl = $('eduRemember');
    var username = uEl ? uEl.value.trim() : '';
    var password = pEl ? pEl.value : '';
    var remember = !!(rEl && rEl.checked);

    if (!username && !eduCred.saved) { setStatus('请填写教务系统用户名（学号）'); return; }
    if (!password && !eduCred.saved) {
      setStatus('请填写密码；想以后免输入，就勾上「记住账号」再登录一次');
      return;
    }

    setStatus('正在自动登录教务系统…（若学校开启验证码，会退回手动登录）');
    d.login({ url: url, username: username, password: password, remember: remember }).then(function (res) {
      // 无论成败都立刻清掉页面上的明文密码：成功时它已经交给主进程了，
      // 失败时也没必要让它留在 DOM 里等着被念出来
      if (pEl) pEl.value = '';
      if (res && res.ok && res.remembered) { eduCred.saved = true; eduCred.username = username; }
      if (!reportLoginResult(res)) { renderEduCredState(); return; }
      renderEduCredState();
      return fetchEduCourses();
    })['catch'](function (err) {
      if (pEl) pEl.value = '';
      setStatus('自动登录失败：' + ((err && err.message) || '未知错误'));
    });
  }

  function onEduForget() {
    var d = desktopEdu();
    if (!d || typeof d.credClear !== 'function') return;
    d.credClear().then(function (res) {
      eduCred = { available: true, saved: false, username: '' };
      var rEl = $('eduRemember');
      if (rEl) rEl.checked = false;
      renderEduCredState();
      setStatus((res && res.ok) ? '已清除本机保存的教务账号' : '清除失败，请手动删除应用数据目录下的账号文件');
    })['catch'](function () {
      setStatus('清除失败');
    });
  }

  function onEduCloseWindow() {
    var d = desktopEdu();
    if (!d) return;
    d.close();
    setStatus('已关闭教务系统窗口');
  }

  function layoutName(l) {
    if (l === 'grid') return '课表网格';
    if (l === 'transposed') return '课表网格（转置）';
    if (l === 'list') return '课程列表';
    if (l === 'api') return '教务接口';
    return '未识别';
  }

  function defaultWeeks(total) {
    var out = [];
    for (var w = 1; w <= Math.min(16, total); w++) out.push(w);
    return out;
  }

  /** OCR 一张图片并解析 */
  function runOcr(file) {
    setStatus('正在加载识别引擎（首次约 15MB，请稍候）…');
    setProgress(0);
    ensureOcr().then(function (worker) {
      setStatus('正在识别图片中的课程表…');
      return fileToCanvas(file, 1600).then(function (canvas) {
        return worker.recognize(canvas);
      });
    }).then(function (res) {
      setProgress(null);
      var text = (res && res.data && res.data.text) || '';
      if (!text.trim()) {
        setStatus('未识别出文字，请确认照片清晰且包含课程信息');
        return;
      }
      setStatus('识别完成，正在解析…');
      feedText(text);
      setStatus('');
    }).catch(function (err) {
      setProgress(null);
      setStatus('识别失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  // ==================== PDF 提取 ====================

  /** 一页的文字量（去掉空白再数，空片段不计） */
  function countChars(items) {
    var n = 0;
    for (var i = 0; i < (items || []).length; i++) {
      n += String(items[i].str || '').replace(/\s/g, '').length;
    }
    return n;
  }

  /** 把一页渲染成图片并 OCR（文字层不可用时的兜底） */
  function ocrPage(page) {
    var viewport = page.getViewport({ scale: 2 });
    var canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise
      .then(function () { return ensureOcr(); })
      .then(function (worker) { return worker.recognize(canvas); })
      .then(function (res) { return (res && res.data && res.data.text) || ''; });
  }

  /**
   * 找第一个「真的能解出文字」的页。
   * 看前 3 页就够：首几页都没文字时，要么整篇是扫描件，要么字体编码特殊，
   * 两种情况下面的逻辑都会走 OCR 兜底。
   */
  function probeTextPage(doc) {
    var limit = Math.min(doc.numPages, 3);
    function at(p) {
      if (p > limit) return Promise.resolve(null);
      return doc.getPage(p).then(function (page) {
        return page.getTextContent().then(function (tc) {
          if (countChars(tc.items) > 0) return { page: p, text: layoutPage(tc.items) };
          return at(p + 1);
        });
      });
    }
    return at(1);
  }

  /**
   * 依次实试各个 CMap 源，返回第一个能解出文字的（连同已打开的文档）。
   *
   * 判据必须是「第一页文字字符数 > 0」，不能靠「有没有报错」——
   * 因为 pdf.js 在 CMap 取不到时【不抛错】，只静默返回空 items。
   * 这也是上两轮误诊的根源：表面症状是「PDF 中未提取到文字」，
   * 看起来像解析器的问题，实际是 CMap 源没取到。
   *
   * 全部源都解不出则返回 null，交给整篇 OCR 兜底。
   */
  function openWithWorkingCMap(buf) {
    var order = cmapSourceCache
      ? [cmapSourceCache].concat(CMAP_SOURCES.filter(function (s) { return s !== cmapSourceCache; }))
      : CMAP_SOURCES.slice();

    function tryAt(i) {
      if (i >= order.length) return Promise.resolve(null);
      var src = order[i];
      return window.pdfjsLib.getDocument({
        // ⚠️ 必须传 buf 的副本：pdf.js 会把 data 转移（detach）给 worker，
        // 同一个 ArrayBuffer 复用第二次只会得到空 buffer。
        data: buf.slice(0),
        cMapUrl: src,
        cMapPacked: true
      }).promise.then(function (doc) {
        return probeTextPage(doc).then(function (hit) {
          if (hit) {
            cmapSourceCache = src; // 记住可用源，后续导入直接优先它
            return { doc: doc, source: src, probe: hit };
          }
          return doc.destroy().then(function () { return tryAt(i + 1); });
        });
      })['catch'](function () {
        // 该源连文档都打不开（例如本地目录不存在、镜像不可达）→ 试下一个
        return tryAt(i + 1);
      });
    }
    return tryAt(0);
  }

  /** 逐页还原：有文字层就用文字层，太薄的页转 OCR（应对混排的扫描件） */
  function collectPages(doc, probe) {
    var total = doc.numPages;
    var texts = [];
    var chain = Promise.resolve();
    for (var p = 1; p <= total; p++) {
      chain = chain.then((function (p) {
        return function () {
          // 探针页已经解过了，直接复用，不重复解析
          if (probe && probe.page === p) {
            texts.push(probe.text);
            setProgress(p / total);
            return null;
          }
          return doc.getPage(p).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var line = layoutPage(tc.items);
              if (line.replace(/\s/g, '').length >= 15) {
                texts.push(line);
                setProgress(p / total);
                return null;
              }
              setStatus('第 ' + p + ' 页没有文字层，正在按图片识别…');
              return ocrPage(page).then(function (t) {
                texts.push(t || '');
                setProgress(p / total);
              });
            });
          });
        };
      })(p));
    }
    return chain.then(function () { return texts.join('\n'); });
  }

  /**
   * 所有 CMap 源都解不出文字时的兜底：整篇当图片识别。
   * 不传 cMapUrl —— 渲染走字形，不需要文字解码表。
   */
  function ocrWholeDocument(buf) {
    return window.pdfjsLib.getDocument({ data: buf.slice(0) }).promise.then(function (doc) {
      var texts = [];
      var chain = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) {
        chain = chain.then((function (p) {
          return function () {
            return doc.getPage(p).then(ocrPage).then(function (t) {
              texts.push(t || '');
              setProgress(p / doc.numPages);
            });
          };
        })(p));
      }
      return chain
        .then(function () { return doc.destroy(); })
        .then(function () { return texts.join('\n'); });
    });
  }

  /** 解析 PDF：优先提取文字层，文字层不可用才转图片走 OCR */
  function runPdf(file) {
    setStatus('正在加载 PDF 引擎…');
    setProgress(0.05);
    ensurePdfJs().then(function () {
      return file.arrayBuffer();
    }).then(function (buf) {
      setStatus('正在解析 PDF…');
      return openWithWorkingCMap(buf).then(function (opened) {
        if (!opened) {
          setStatus('PDF 没有可用的文字层，正在按图片识别（较慢）…');
          return ocrWholeDocument(buf);
        }
        setProgress(0.1);
        return collectPages(opened.doc, opened.probe).then(function (text) {
          return opened.doc.destroy().then(function () { return text; });
        });
      });
    }).then(function (text) {
      setProgress(null);
      if (!text.trim()) {
        setStatus('这个 PDF 读不出文字：既没有文字层，图片识别也没读到内容。若是扫描件，建议直接拍清晰照片用「照片导入」');
        return;
      }
      feedText(text);
      setStatus('');
    })['catch'](function (err) {
      setProgress(null);
      setStatus('PDF 解析失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  // ==================== 结果确认表格 ====================

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderResults(warnings) {
    var box = $('importResult');
    var summary = $('importSummary');
    var applyBtn = $('btnImportApply');
    if (!box) return;

    if (!parsedItems.length) {
      box.innerHTML = '<p class="hint">没有解析出课程。可尝试：粘贴更完整的课表文本、换更清晰的照片，或在下方手动修改后导入。</p>';
      if (applyBtn) applyBtn.disabled = true;
      if (summary) summary.textContent = '';
    } else {
      var dayOptions = '';
      var names = (CF && CF.DAY_NAMES) || ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      for (var d = 0; d < names.length; d++) {
        dayOptions += '<option value="' + (d + 1) + '">' + names[d] + '</option>';
      }
      var rows = '';
      for (var i = 0; i < parsedItems.length; i++) {
        var it = parsedItems[i];
        rows += '<tr data-idx="' + i + '"' + (it.selected ? '' : ' class="row-off"') + '>'
          + '<td><input type="checkbox" data-field="selected"' + (it.selected ? ' checked' : '') + ' aria-label="选择"></td>'
          + '<td><input type="text" data-field="name" value="' + esc(it.name) + '" maxlength="30"></td>'
          + '<td><select data-field="day">' + dayOptions.replace('value="' + it.day + '"', 'value="' + it.day + '" selected') + '</select></td>'
          + '<td><input type="number" data-field="startSection" value="' + (it.startSection == null ? '' : it.startSection) + '" min="1" max="14"></td>'
          + '<td><input type="number" data-field="endSection" value="' + (it.endSection == null ? '' : it.endSection) + '" min="1" max="14"></td>'
          + '<td><input type="text" data-field="weeksSpec" value="' + esc(weeksToSpec(it.weeks)) + '" placeholder="如 1-16"></td>'
          + '<td><input type="text" data-field="location" value="' + esc(it.location) + '" maxlength="30"></td>'
          + '<td><input type="text" data-field="teacher" value="' + esc(it.teacher) + '" maxlength="20"></td>'
          + '</tr>';
      }
      box.innerHTML =
        '<div class="result-scroll"><table class="import-table"><thead><tr>'
        + '<th>导入</th><th>课程名</th><th>星期</th><th>开始节</th><th>结束节</th><th>周次</th><th>地点</th><th>教师</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + (warnings && warnings.length
          ? '<div class="import-warns">' + warnings.map(function (w) { return '⚠ ' + esc(w); }).join('<br>') + '</div>'
          : '');
      if (applyBtn) applyBtn.disabled = false;
      if (summary) summary.textContent = '共解析出 ' + parsedItems.length + ' 条课程';
    }
  }

  /** 周次数组 → 紧凑文本（1-16 / 1-15(单)），便于表格里编辑 */
  function weeksToSpec(weeks) {
    if (!weeks || !weeks.length) return '';
    var allOdd = weeks.length > 1 && weeks.every(function (w) { return w % 2 === 1; });
    var allEven = weeks.length > 1 && weeks.every(function (w) { return w % 2 === 0; });
    var parts = [];
    var s = weeks[0], p = weeks[0];
    for (var i = 1; i <= weeks.length; i++) {
      var w = weeks[i];
      if (w !== p + 1) {
        parts.push(s === p ? String(s) : s + '-' + p);
        s = w;
      }
      p = w;
    }
    var spec = parts.join(',');
    if (allOdd) spec += '(单)';
    if (allEven) spec += '(双)';
    return spec;
  }

  /** 表格编辑 → 更新 parsedItems */
  function onResultEdit(e) {
    var tr = e.target.closest ? e.target.closest('tr[data-idx]') : null;
    if (!tr) return;
    var idx = Number(tr.getAttribute('data-idx'));
    var it = parsedItems[idx];
    if (!it) return;
    var field = e.target.getAttribute('data-field');
    if (!field) return;
    if (field === 'selected') { it.selected = e.target.checked; tr.classList.toggle('row-off', !it.selected); return; }
    var v = e.target.value;
    if (field === 'day') it.day = Number(v) || 1;
    else if (field === 'startSection') it.startSection = v === '' ? null : Number(v);
    else if (field === 'endSection') it.endSection = v === '' ? null : Number(v);
    else if (field === 'weeksSpec') it.weeksSpec = v;
    else it[field] = v;
  }

  // ==================== 导入应用 ====================

  function applySelected() {
    if (!bridge) return;
    var settings = bridge.getSettings();
    var colorNames = (CF && CF.COURSE_COLORS) || [];
    var colorIdx = {};
    var counter = 0;

    var selected = parsedItems.filter(function (it) { return it.selected; });
    var valid = [];
    var skipped = 0;
    for (var i = 0; i < selected.length; i++) {
      var it = selected[i];
      // 周次以表格编辑后的文本为准
      var weeks = CP.parseWeeksSpec(it.weeksSpec != null ? it.weeksSpec : weeksToSpec(it.weeks));
      var c = CF.normalizeCourse({
        name: it.name,
        teacher: it.teacher,
        location: it.location,
        day: it.day,
        startSection: it.startSection || 1,
        endSection: it.endSection || it.startSection || 1,
        weeks: weeks || defaultWeeks(settings.totalWeeks)
      });
      var errs = CF.validateCourse(c, settings, []);
      if (errs.length) { skipped++; continue; }
      // 同名课程同色（按名称哈希分配，冲突少且稳定）
      if (!colorIdx[c.name]) {
        colorIdx[c.name] = colorNames[counter++ % colorNames.length].key;
      }
      c.color = colorIdx[c.name];
      valid.push(c);
    }

    var modeEl = $('importMode');
    var mode = modeEl ? modeEl.value : 'append';
    bridge.apply(valid, mode, skipped);
  }

  // ==================== 弹窗控制 ====================

  function openModal() {
    parsedItems = [];
    renderResults([]);
    setStatus('');
    setProgress(null);
    var ta = $('importText');
    if (ta) ta.value = '';
    switchTab('text');
    syncEduPane(); // 提前判定运行环境，切到该页签时不会有一瞬间的错版
    var modal = $('importModal');
    if (modal) modal.hidden = false;
  }

  function closeModal() {
    var modal = $('importModal');
    if (modal) modal.hidden = true;
  }

  function switchTab(name) {
    var tabs = document.querySelectorAll('#importModal [data-imp-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-imp-tab') === name);
    }
    var panes = document.querySelectorAll('#importModal [data-imp-pane]');
    for (var j = 0; j < panes.length; j++) {
      panes[j].hidden = panes[j].getAttribute('data-imp-pane') !== name;
    }
    // 「教务直连」的内容取决于运行环境（桌面端有桥 / 网页版没有），切进来时重新判定
    if (name === 'edu') syncEduPane();
  }

  // ==================== 事件绑定 ====================

  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var tab = t.closest('[data-imp-tab]');
      if (tab) { switchTab(tab.getAttribute('data-imp-tab')); return; }

      var actionEl = t.closest('[data-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');

      if (action === 'open-import') { openModal(); return; }
      if (action === 'close-import') { closeModal(); return; }
      if (action === 'import-parse-text') {
        var ta = $('importText');
        var text = ta ? ta.value : '';
        if (!text.trim()) { if (bridge) bridge.toast('请先粘贴课表文本'); return; }
        feedText(text);
        return;
      }
      if (action === 'import-pick-image') { var fi = $('importImage'); if (fi) fi.click(); return; }
      if (action === 'import-pick-pdf') { var fp = $('importPdf'); if (fp) fp.click(); return; }
      if (action === 'import-apply') { applySelected(); return; }

      // 教务系统直连（仅桌面端；网页版这些按钮不会渲染出来）
      if (action === 'edu-open') { onEduOpen(); return; }
      if (action === 'edu-grab') { onEduGrab(); return; }
      if (action === 'edu-close-window') { onEduCloseWindow(); return; }
      if (action === 'edu-goto-text') { switchTab('text'); return; }
      if (action === 'edu-autologin') { onEduAutoLogin(); return; }
      if (action === 'edu-fetch') { setStatus('正在从教务系统取课表…'); fetchEduCourses(); return; }
      if (action === 'edu-forget') { onEduForget(); return; }
    });

    // 遮罩点击关闭
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'importModal') closeModal();
    });

    // 文件选择
    var fi = $('importImage');
    if (fi) fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0];
      fi.value = '';
      if (f) runOcr(f);
    });
    var fp = $('importPdf');
    if (fp) fp.addEventListener('change', function () {
      var f = fp.files && fp.files[0];
      fp.value = '';
      if (f) runPdf(f);
    });

    // 结果表格编辑
    var box = $('importResult');
    if (box) {
      box.addEventListener('input', onResultEdit);
      box.addEventListener('change', onResultEdit);
    }
  }

  function mount(b) {
    bridge = b;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }

  // ==================== 导出 ====================

  window.CourseImporter = {
    mount: mount,
    open: openModal,
    close: closeModal,
    // 供测试与桌面端集成使用：把教务系统页面 HTML 直接喂进导入链路
    feedEduHtml: feedEduHtml,
    switchTab: switchTab
  };
})();
