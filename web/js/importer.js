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

  // CDN 源（主源失败自动换备源；首次使用需联网，之后浏览器有缓存）
  var TESSERACT_URLS = [
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
  ];
  var PDFJS_URLS = [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js'
  ];
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  /**
   * CMap 目录 —— 中文 PDF 能不能解出文字，全看这一项。
   *
   * 国内教务系统导出的 PDF 普遍用 Type0 + CMap 编码的非嵌入字体
   * （如 STSong-Light + UniGB-UCS2-H）。pdf.js 必须加载对应的 .bcmap
   * 才能把字符码映射成文字；缺了它 getTextContent() 会返回 **0 个 item**
   * ——不是乱码，是彻底空白，最终表现为「PDF 中未提取到文字」。
   * pdf.js 内部会抛 "The CMap baseUrl parameter must be specified"。
   *
   * 优先用随包发布的本地 cmaps/ 目录：无外部依赖、离线可用、
   * Electron 断网也能导入中文课表。若本地目录不可用（例如单文件版
   * 只有一个 html、或部署时漏传了 cmaps/），自动回退到同版本 CDN。
   * 探测结果缓存，一次会话只探一次。
   */
  var CMAP_BASE = 'cmaps/';
  var CMAP_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/';
  // 用 UniGB-UCS2-H 当探针：任何 pdfjs-dist 发行版都带它，
  // 而且它正是中文 PDF 最需要的那一个，探到即说明本地目录可用。
  var CMAP_PROBE = 'UniGB-UCS2-H.bcmap';

  var cmapBasePromise = null;
  function resolveCMapBase() {
    if (cmapBasePromise) return cmapBasePromise;
    cmapBasePromise = new Promise(function (resolve) {
      var done = false;
      var finish = function (base) { if (!done) { done = true; resolve(base); } };
      try {
        fetch(CMAP_BASE + CMAP_PROBE)
          .then(function (res) { finish(res && res.ok ? CMAP_BASE : CMAP_CDN); })
          .catch(function () { finish(CMAP_CDN); });
        // 探测请求不该拖慢导入：2 秒内没结果就直接用 CDN
        setTimeout(function () { finish(CMAP_CDN); }, 2000);
      } catch (e) {
        finish(CMAP_CDN);
      }
    });
    return cmapBasePromise;
  }

  var bridge = null;          // { getSettings, apply, toast }
  var parsedItems = [];       // 解析结果（可编辑）
  var ocrWorker = null;       // Tesseract worker 缓存

  // ==================== 工具 ====================

  function $(id) { return document.getElementById(id); }

  function loadScript(urls) {
    return new Promise(function (resolve, reject) {
      var i = 0;
      function tryNext() {
        if (i >= urls.length) { reject(new Error('脚本加载失败（检查网络）')); return; }
        var el = document.createElement('script');
        el.src = urls[i++];
        el.onload = function () { resolve(); };
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

  /** 确保 pdf.js 已加载 */
  function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return loadScript(PDFJS_URLS).then(function () {
      if (!window.pdfjsLib) throw new Error('PDF 引擎加载失败');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
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
          setStatus('还没有打开教务系统窗口，请先点「打开教务系统并登录」');
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

  /** 解析 PDF：优先提取文字层，文字太少（扫描版）的页转图片走 OCR */
  function runPdf(file) {
    setStatus('正在加载 PDF 引擎…');
    setProgress(0.05);
    var cmapBase = CMAP_CDN;
    Promise.all([ensurePdfJs(), resolveCMapBase()]).then(function (r) {
      cmapBase = r[1];
      return file.arrayBuffer();
    }).then(function (buf) {
      setStatus('正在解析 PDF…');
      // cMapUrl + cMapPacked 必须传：中文课表用的 Type0/CMap 字体
      // 全靠它才能解码，缺了会一个字符都读不出来（详见文件顶部说明）。
      return window.pdfjsLib.getDocument({
        data: buf,
        cMapUrl: cmapBase,
        cMapPacked: true
      }).promise;
    }).then(function (doc) {
      var texts = [];
      var pages = [];
      for (var p = 1; p <= doc.numPages; p++) pages.push(p);
      return pages.reduce(function (chain, p) {
        return chain.then(function () {
          return doc.getPage(p).then(function (page) {
            return page.getTextContent().then(function (tc) {
              // 关键：不能把 items 直接 join(' ') —— 那样会丢掉全部坐标，
              // 而课表「哪门课属于星期几」的信息只存在于坐标里（详见 pdf-layout.js 的说明）。
              // 这里先用坐标把页面还原成制表符分列的表格文本，再交给文本解析引擎。
              var line = layoutPage(tc.items);
              if (line.replace(/\s/g, '').length >= 15) {
                texts.push(line);
                setProgress(p / doc.numPages);
                return null;
              }
              // 文字层太薄 → 渲染成图片走 OCR
              setStatus('第 ' + p + ' 页是扫描图，正在 OCR…');
              var scale = 2;
              var viewport = page.getViewport({ scale: scale });
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise
                .then(function () { return ensureOcr(); })
                .then(function (worker) { return worker.recognize(canvas); })
                .then(function (res) {
                  texts.push(res.data.text || '');
                  setProgress(p / doc.numPages);
                });
            });
          });
        });
      }, Promise.resolve()).then(function () { return texts.join('\n'); });
    }).then(function (text) {
      setProgress(null);
      if (!text.trim()) {
        setStatus('PDF 中未提取到文字');
        return;
      }
      feedText(text);
      setStatus('');
    }).catch(function (err) {
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
