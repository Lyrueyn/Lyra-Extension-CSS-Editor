/* CSS 编辑器：源码、补全、折叠、预览、保存、Ctrl+/ 注释。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const SHELL = params.get("shell") === "1";
  const pathParam = params.get("projectEntry") || params.get("path") || "";
  const host = window.chrome && window.chrome.webview;
  const shellPending = new Map();
  const state = { path: pathParam, dirty: false, statusTimer: 0, theme: "lyra", errorMarks: [], errorLines: [], autoTimer: 0, lastSaved: "", saving: false, split: 38, lintSeq: 0, inspect: false, selected: null, selectedSelector: "", inspectBound: false, rule: null, matchCount: 0, colorTarget: null, pickerColor: null, colorChipTimer: 0, varsTimer: 0, varFilter: "" };
  const THEMES = new Set(["lyra", "violet", "emerald", "sunset", "sakura", "light"]);
  let cm = null;

  function applyTheme(name) {
    const theme = THEMES.has(name) ? name : "lyra";
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("lyra.css.theme", theme); } catch { }
    if ($("theme")) $("theme").value = theme;
  }
  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function setStatus(text, error) {
    const el = $("status");
    if (el) { el.textContent = text || ""; el.style.color = error ? "#ff8a8a" : "#8b94a6"; }
  }
  function hostCall(type, payload) {
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error("宿主不可用")); return; }
      const requestId = "css-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const onMessage = (ev) => {
        const d = ev.data || {};
        if (d.requestId !== requestId) return;
        try { host.removeEventListener("message", onMessage); } catch { }
        if (d.ok === false) reject(new Error(d.error || "宿主操作失败")); else resolve(d);
      };
      host.addEventListener("message", onMessage);
      host.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
      setTimeout(() => { try { host.removeEventListener("message", onMessage); } catch { } reject(new Error("宿主响应超时")); }, 20000);
    });
  }
  function shellHostCall(type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = "css-shell-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      shellPending.set(requestId, { resolve, reject });
      window.parent.postMessage({ type: "shell-host-request", requestId: requestId, method: type, payload: payload || {} }, "*");
      setTimeout(() => { if (shellPending.has(requestId)) { shellPending.delete(requestId); reject(new Error("编辑器外壳响应超时")); } }, 20000);
    });
  }
  function callHost(type, payload) { return SHELL ? shellHostCall(type, payload) : hostCall(type, payload); }

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    setStatus("已修改，Ctrl+S 保存");
  }
  async function loadFile() {
    try {
      setStatus("正在读取 CSS…");
      const res = await callHost("host.workspace.load", state.path ? { path: state.path } : {});
      if (!res) throw new Error("没有读到文件");
      const text = typeof res.data === "string" && !res.base64 ? (() => { try { return atob(res.data); } catch { return res.data; } })() : res.data || "";
      const decoded = text && /[^\x00-\x7F]/.test(text) ? text : (() => { try { return decodeURIComponent(escape(atob(res.data || ""))); } catch { return text; } })();
      // 宿主 workspace.load 返回 base64；优先按 UTF-8 解码。
      let content = decoded;
      try {
        if (res.data && /^[A-Za-z0-9+/=\s]+$/.test(res.data)) content = new TextDecoder().decode(Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0)));
      } catch { }
      cm.setValue(content || "");
      cm.clearHistory();
      state.lastSaved = content || "";
      state.dirty = false;
      state.path = res.path || res.rel || state.path;
      $("file").textContent = (res.path || res.rel || state.path || res.name || "CSS");
      if ($("tabName")) $("tabName").textContent = (res.name || String(res.path || res.rel || state.path || "style.css").split(/[\\/]/).pop());
      state.dirty = false;
      setStatus("已加载");
      updatePreview();
      setTimeout(refreshLint, 50);
    } catch (e) {
      setStatus("打开失败：" + (e && e.message ? e.message : e), true);
    }
  }
  async function saveFile(auto) {
    if (state.saving) return;
    if (!state.dirty && !auto) { setStatus("没有需要保存的修改"); return; }
    const text = cm.getValue();
    if (text === state.lastSaved) { state.dirty = false; return; }
    state.saving = true;
    clearTimeout(state.autoTimer);
    if (!auto) setStatus("正在保存…");
    try {
      const payload = { data: encodeBase64(text) };
      if (state.path) payload.path = state.path;
      const res = await callHost("host.workspace.save", payload);
      if (!res || res.ok === false) throw new Error((res && res.error) || "保存失败");
      state.lastSaved = text;
      state.dirty = cm.getValue() !== text;
      const time = new Date().toTimeString().slice(0, 8);
      setStatus(auto ? "已自动保存 · " + time : "已保存");
      if (state.dirty) scheduleAutoSave();
    } catch (e) {
      setStatus("保存失败：" + (e && e.message ? e.message : e), true);
    } finally {
      state.saving = false;
    }
  }
  function scheduleAutoSave() {
    clearTimeout(state.autoTimer);
    if (!state.dirty) return;
    state.autoTimer = setTimeout(() => { saveFile(true); }, 1000);
  }
  function previewDocument(cssText) {
    const base = "html,body{margin:0}body{padding:34px 38px;font:15px/1.75 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:#243447;background:linear-gradient(180deg,#ffffff,#f4f8fd);min-height:100vh}.container{max-width:760px;margin:0 auto}h1{font-size:30px;line-height:1.25;margin:0 0 10px;letter-spacing:-.02em;color:#12263a}h2{font-size:18px;margin:0 0 6px;color:#173a57}p{margin:10px 0;color:#465b70}a{color:#1976d2}code{background:#eef4fb;padding:1px 6px;border-radius:5px;font:12px Consolas,monospace;color:#205a86}.box.card{border:1px solid #dbe7f3;background:#fff;border-radius:12px;padding:18px 20px;margin-top:18px;box-shadow:0 6px 20px rgba(30,80,140,.08)}ul{margin:14px 0;padding-left:22px}li{margin:4px 0}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e3edf6}th{background:#f2f7fd;color:#35526a;font-weight:600}button{font:inherit;padding:5px 12px;border:1px solid #c9dced;border-radius:7px;background:#fff;color:#1b5e8c}.row{display:flex;gap:12px;margin-top:16px}.col{flex:1;padding:14px;border:1px dashed #c7d9e9;border-radius:10px;background:#f9fcff;color:#5b7388}";
    const user = String(cssText || "").replace(/<\/style/gi, "<\\/style");
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style id="lyra-base-style">' + base + '</style><style id="lyra-user-style">' + user + '</style></head><body><div class="container"><h1>CSS 预览</h1><p>这是示例段落，用来观察颜色、字号、间距和布局。</p><p><a href="#">链接</a> · <button>按钮</button> · <code>code</code></p><div class="box card"><h2>卡片标题</h2><p>Common classes: container, box, card, row, col</p></div><div class="row"><div class="col">col 1</div><div class="col">col 2</div></div><ul><li>列表项 1</li><li>列表项 2</li></ul><table><tr><th>表头</th><th>表头</th></tr><tr><td>内容</td><td>内容</td></tr></table></div></body></html>';
  }
  function formatCss(text) {
    const src = String(text || "").replace(/\r\n?/g, "\n");
    let out = "", depth = 0, quote = "";
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) { out += ch; if (ch === quote && src[i - 1] !== "\\") quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
      if (ch === "{") { depth += 1; out = out.replace(/\s+$/, "") + " {\n"; continue; }
      if (ch === "}") { depth = Math.max(0, depth - 1); out = out.replace(/\s+$/, "") + "\n" + "  ".repeat(depth) + "}\n"; continue; }
      if (ch === ";") { out = out.replace(/\s+$/, "") + ";\n" + "  ".repeat(depth); continue; }
      if (ch === "\n") { out = out.replace(/\s+$/, "") + "\n" + "  ".repeat(depth); continue; }
      if (/[ \t]/.test(ch) && /\s$/.test(out)) continue;
      out += ch;
    }
    return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  function toggleCssComment() {
    const sel = cm.getSelection();
    if (sel) {
      const start = sel.trim();
      if (start.startsWith("/*") && start.endsWith("*/")) {
        const core = start.slice(2, -2).trim();
        cm.replaceSelection(core);
      } else cm.replaceSelection("/* " + sel + " */");
      return;
    }
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    if (!line.trim()) return;
    const indent = (line.match(/^\s*/) || [""])[0];
    const body = line.slice(indent.length);
    if (/^\s*\/\*.*\*\/\s*$/.test(body)) cm.replaceRange(body.replace(/^\s*\/\*\s?/, "").replace(/\s?\*\/\s*$/, ""), { line: cursor.line, ch: indent.length }, { line: cursor.line, ch: line.length });
    else cm.replaceRange("/* " + body + " */", { line: cursor.line, ch: indent.length }, { line: cursor.line, ch: line.length });
  }
  function collectLocalCssIssues(includeSemantic) {
    const text = cm.getValue();
    const lines = text.split("\n");
    const stack = [];
    const issues = [];
    let quote = null;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      for (let ci = 0; ci < line.length; ci += 1) {
        const ch = line[ci];
        if (quote) {
          if (ch === "\\") { ci += 1; continue; }
          if (ch === quote.ch) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = { ch: ch, line: li, chPos: ci }; continue; }
        if (ch === "{" || ch === "(" || ch === "[") { stack.push({ ch: ch, line: li, chPos: ci }); continue; }
        if (ch === "}" || ch === ")" || ch === "]") {
          const open = stack.pop();
          const want = open ? (open.ch === "{" ? "}" : open.ch === "(" ? ")" : "]") : "";
          if (!open || ch !== want) issues.push({ line: li, chPos: ci, message: "括号不匹配：多余的 " + ch, source: "结构" });
        }
      }
    }
    for (const item of stack) issues.push({ line: item.line, chPos: item.chPos, message: "括号未闭合：" + item.ch, source: "结构" });
    if (quote) issues.push({ line: quote.line, chPos: quote.chPos, message: "引号未闭合：" + quote.ch, source: "结构" });

    // 逐行做轻量语义检查：选择器、属性名、属性值（stylelint 可用时跳过）。
    let depth = 0;
    if (includeSemantic) {
    for (let li = 0; li < lines.length; li += 1) {
      const raw = lines[li];
      const code = raw.replace(/\/\*.*?\*\//g, " ").trim();
      if (!code) continue;
      if (depth === 0 && code.includes("{")) {
        const selector = code.split("{")[0].trim();
        if (selector && !selector.startsWith("@") && !/^(?:from|to|\d+(?:\.\d+)?%)$/.test(selector)) {
          try { document.querySelector(selector); }
          catch { issues.push({ line: li, chPos: 0, message: "选择器无效：" + selector, source: "选择器" }); }
        }
      }
      if (depth > 0 && !code.startsWith("@")) {
        const m = code.match(/^([-\w]+)\s*:\s*(.+?)\s*(;|$)/);
        if (m) {
          const prop = m[1], value = m[2].replace(/!important\s*$/i, "").trim();
          if (!prop.startsWith("--") && value && !value.startsWith("{") && !/^[;}]/.test(value)) {
            try {
              if (!CSS.supports(prop, value)) issues.push({ line: li, chPos: Math.max(0, raw.indexOf(prop)), message: "属性值无效：" + prop + ": " + value, source: "属性" });
            } catch { }
          }
        }
      }
      let clean = raw.replace(/\/\*.*?\*\//g, " ").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
      const opens = (clean.match(/\{/g) || []).length;
      const closes = (clean.match(/\}/g) || []).length;
      depth = Math.max(0, depth + opens - closes);
    }
    }
    const seen = new Set();
    const out = [];
    for (const it of issues) {
      const key = it.line + ":" + it.chPos + ":" + it.message;
      if (seen.has(key)) continue;
      seen.add(key); out.push(it);
    }
    return out.sort((a, b) => a.line - b.line || a.chPos - b.chPos).slice(0, 100);
  }
  async function fetchStylelint(code) {
    try {
      const res = await callHost("editor.validate-css", { code: code });
      if (!res || res.ok === false) throw new Error((res && res.error) || "stylelint 宿主调用失败");
      const raw = typeof res.json === "string" ? res.json : res.json;
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!data || data.ok === false) throw new Error((data && data.error) || "stylelint 返回错误");
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      return {
        error: "",
        issues: warnings.map((w) => ({
          line: Math.max(0, (Number(w.line) || 1) - 1),
          chPos: Math.max(0, (Number(w.column) || 1) - 1),
          message: String(w.text || w.rule || "stylelint"),
          source: w.rule ? "stylelint:" + w.rule : "stylelint",
          severity: w.severity || "error",
        })),
      };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e), issues: [] };
    }
  }

  function renderProblems(issues, note) {
    const panel = $("problemsPanel");
    if (!panel) return;
    panel.hidden = false;
    $("problemCount").textContent = String(issues.length);
    $("problemSummary").textContent = issues.length ? ("在 1 个文件中发现 " + issues.length + " 个问题" + (note ? " · " + note : "")) : (note || "未检测到问题");
    const list = $("problemsList");
    list.innerHTML = "";
    if (!issues.length) {
      const empty = document.createElement("div");
      empty.className = "problem-empty";
      empty.textContent = "没有检测到 CSS 问题。";
      list.appendChild(empty);
      return;
    }
    for (const issue of issues) {
      const row = document.createElement("div");
      row.className = "problem-row";
      row.title = issue.message;
      row.innerHTML = '<span class="problem-sev">●</span><span class="problem-msg"></span><span class="problem-pos"></span><span class="problem-source"></span>';
      row.querySelector(".problem-msg").textContent = issue.message;
      row.querySelector(".problem-pos").textContent = (state.path || "CSS") + ":" + (issue.line + 1) + ":" + (issue.chPos + 1);
      row.querySelector(".problem-source").textContent = issue.source || "CSS";
      row.addEventListener("click", () => {
        cm.setCursor({ line: issue.line, ch: issue.chPos });
        cm.focus();
        cm.scrollIntoView({ line: issue.line, ch: issue.chPos }, 120);
      });
      list.appendChild(row);
    }
  }

  async function refreshLint() {
    if (!cm) return;
    const token = ++state.lintSeq;
    for (const mark of state.errorMarks) { try { mark.clear(); } catch { } }
    state.errorMarks = [];
    for (const line of state.errorLines) { try { cm.removeLineClass(line, "background", "cm-css-error-line"); } catch { } }
    state.errorLines = [];
    try { cm.clearGutter("css-errors"); } catch { }
    const code = cm.getValue();
    const lint = await fetchStylelint(code);
    if (token !== state.lintSeq) return;
    const useStylelint = !lint.error;
    // stylelint 可用时以它为准，避免同一处语法错误重复报两遍；只有 stylelint 不可用时才用内置检查。
    let issues = useStylelint ? lint.issues.slice() : collectLocalCssIssues(true);
    const seen = new Set();
    issues = issues.filter((it) => {
      const key = it.line + ":" + it.chPos + ":" + it.message;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).sort((a, b) => a.line - b.line || a.chPos - b.chPos).slice(0, 200);
    const markedLines = new Set();
    for (const issue of issues) {
      const line = Math.max(0, Math.min(issue.line, cm.lineCount() - 1));
      const lineText = cm.getLine(line) || "";
      const ch = Math.max(0, Math.min(issue.chPos, Math.max(0, lineText.length - 1)));
      const mark = cm.markText({ line: line, ch: ch }, { line: line, ch: Math.min(lineText.length, ch + 1) }, {
        className: "cm-css-error",
        title: issue.message,
      });
      state.errorMarks.push(mark);
      if (!markedLines.has(line)) {
        markedLines.add(line);
        cm.addLineClass(line, "background", "cm-css-error-line");
        state.errorLines.push(line);
        const gutter = document.createElement("div");
        gutter.className = "cm-css-error-gutter";
        gutter.textContent = "!";
        gutter.title = issue.message;
        cm.setGutterMarker(line, "css-errors", gutter);
      }
    }
    const note = useStylelint ? "" : "stylelint 不可用，使用基础检查";
    renderProblems(issues, note);
    setStatus(issues.length ? issues.length + " 个问题" : "就绪", false);
  }

  function injectInspectorStyle(doc) {
    if (!doc || doc.getElementById("lyra-inspect-style")) return;
    const st = doc.createElement("style");
    st.id = "lyra-inspect-style";
    st.textContent = ".__lyra-hover{outline:1px solid #66ccff !important;outline-offset:-1px;cursor:crosshair}.__lyra-selected{outline:2px solid #2f86f6 !important;outline-offset:-1px}";
    (doc.head || doc.documentElement).appendChild(st);
  }
  function selectorFor(el) {
    if (!el) return "";
    let out = el.localName || "*";
    if (el.id) out += "#" + CSS.escape(el.id);
    for (const c of Array.from(el.classList || [])) if (!c.startsWith("__lyra")) out += "." + CSS.escape(c);
    return out;
  }
  function setupPreviewDoc(doc) {
    if (!doc || doc.__lyraInspectorBound) return;
    doc.__lyraInspectorBound = true;
      injectInspectorStyle(doc);
      let hovered = null;
      doc.addEventListener("mouseover", (event) => {
        if (!state.inspect || !event.target || event.target.nodeType !== 1) return;
        if (hovered) hovered.classList.remove("__lyra-hover");
        hovered = event.target;
        hovered.classList.add("__lyra-hover");
      }, true);
      doc.addEventListener("mouseleave", () => {
        if (hovered) hovered.classList.remove("__lyra-hover");
        hovered = null;
      }, true);
    doc.addEventListener("click", (event) => {
      if (!state.inspect || !event.target || event.target.nodeType !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      selectInspectElement(event.target);
    }, true);
  }
  function bindPreviewInspector() {
    const frame = $("preview");
    if (!frame) return;
    frame.addEventListener("load", () => {
      if (!state.inspect) return;
      setupPreviewDoc(frame.contentDocument);
    });
  }
  function selectInspectElement(el) {
    if (!el || el.nodeType !== 1) return;
    clearPreviewHighlights();
    state.selected = el;
    state.selectedSelector = selectorFor(el);
    state.rule = null;
    el.classList.add("__lyra-selected");
    $("devSelector").textContent = state.selectedSelector;
    renderInspector();
  }
  function collectMatchedRules(el) {
    const out = [];
    const doc = $("preview").contentDocument;
    if (!doc || !el) return out;
    const visit = (rules) => {
      for (const rule of Array.from(rules || [])) {
        try {
          if (rule.type === CSSRule.STYLE_RULE) {
            let matched = false;
            try { matched = el.matches(rule.selectorText); } catch { }
            if (matched) out.push(rule);
          } else if (rule.cssRules) visit(rule.cssRules);
        } catch { }
      }
    };
    for (const sheet of Array.from(doc.styleSheets)) {
      if (sheet.ownerNode && (sheet.ownerNode.id === "lyra-base-style" || sheet.ownerNode.id === "lyra-inspect-style")) continue;
      try { visit(sheet.cssRules); } catch { }
    }
    return out;
  }
  function computedRows(el) {
    if (!el) return [];
    const cs = $("preview").contentWindow.getComputedStyle(el);
    const props = ["display", "position", "width", "height", "margin", "padding", "border", "border-radius", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align", "flex", "gap", "grid-template-columns", "opacity", "transform", "box-shadow", "transition", "z-index"];
    return props.map((p) => [p, cs.getPropertyValue(p)]);
  }
  function clearPreviewHighlights() {
    const doc = $("preview") && $("preview").contentDocument;
    if (!doc) return;
    for (const el of Array.from(doc.querySelectorAll(".__lyra-selected"))) el.classList.remove("__lyra-selected");
  }
  function highlightSelector(selector) {
    const doc = $("preview") && $("preview").contentDocument;
    if (!doc) return [];
    clearPreviewHighlights();
    let els = [];
    try { els = Array.from(doc.querySelectorAll(selector)); } catch { return []; }
    for (const el of els) el.classList.add("__lyra-selected");
    return els;
  }

  // ---------- CSS 变量面板 ----------
  function findVarDefs() {
    if (!cm) return [];
    const text = cm.getValue();
    const re = /(--[-\w]+)\s*:\s*([^;{}]*)/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const value = m[2];
      const valueStart = m.index + m[0].length - value.length;
      out.push({ name: m[1], value: value.trim(), start: m.index, valueStart, valueEnd: m.index + m[0].length, line: cm.posFromIndex(m.index).line });
    }
    return out;
  }
  function scheduleVarsRender() {
    clearTimeout(state.varsTimer);
    state.varsTimer = setTimeout(() => { if (!$("devVars").hidden) renderVars(); }, 250);
  }
  function renderVars() {
    if (!cm) return;
    const host = $("devVars");
    if (!host) return;
    const defs = findVarDefs();
    const text = cm.getValue();
    const usage = new Map();
    const reUse = /var\(\s*(--[-\w]+)/g;
    let um;
    while ((um = reUse.exec(text))) usage.set(um[1], (usage.get(um[1]) || 0) + 1);
    const query = state.varFilter || "";
    const shown = defs;
    host.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "dev-vars-toolbar";
    toolbar.innerHTML = '<input id="varFilter" placeholder="搜索变量…" spellcheck="false"><span id="varStat"></span>';
    host.appendChild(toolbar);
    $("varFilter").value = query;
    $("varFilter").addEventListener("input", () => {
      state.varFilter = $("varFilter").value.trim().toLowerCase();
      applyVarsFilter();
    });
    function applyVarsFilter() {
      let n = 0;
      for (const row of Array.from(host.querySelectorAll(".dev-var-row"))) {
        const hit = !state.varFilter || row.dataset.search.includes(state.varFilter);
        row.hidden = !hit; if (hit) n++;
      }
      const stat = $("varStat"); if (stat) stat.textContent = n + " / " + defs.length + " 个变量";
    }
    if (!defs.length) { const empty = document.createElement("div"); empty.className = "dev-empty"; empty.textContent = "还没有 CSS 变量。在 :root { --name: value; } 里定义。"; host.appendChild(empty); }
    for (const def of shown) {
      const row = document.createElement("div"); row.className = "dev-var-row"; row.dataset.search = (def.name + " " + def.value).toLowerCase();
      const sw = document.createElement("span"); sw.className = "dev-var-swatch";
      const c = parseColor(def.value);
      if (c) { sw.style.background = colorCss(c); sw.title = def.value + " · 点击修改"; sw.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); const co = sw.getBoundingClientRect(); openColorPicker(sw, { from: def.valueStart, to: def.valueEnd, raw: def.value, color: c }, co); }); }
      else { sw.style.visibility = "hidden"; }
      row.appendChild(sw);
      const main = document.createElement("div"); main.className = "dev-var-main";
      const name = document.createElement("span"); name.className = "dev-var-name"; name.textContent = def.name;
      name.title = "跳到定义";
      name.addEventListener("click", () => { const pos = cm.posFromIndex(def.start); cm.setCursor(pos); cm.scrollIntoView(pos, 80); cm.focus(); });
      const val = document.createElement("input"); val.className = "dev-var-value"; val.value = def.value; val.spellcheck = false;
      val.addEventListener("change", () => {
        const v = val.value.trim();
        cm.replaceRange(v, cm.posFromIndex(def.valueStart), cm.posFromIndex(def.valueEnd));
        markDirty(); scheduleAutoSave(); updatePreview(); scheduleVarsRender();
      });
      main.appendChild(name); main.appendChild(val); row.appendChild(main);
      const count = document.createElement("span"); count.className = "dev-var-count"; count.textContent = (usage.get(def.name) || 0) + "×"; count.title = "被 var() 引用次数";
      row.appendChild(count);
      host.appendChild(row);
    }
    const add = document.createElement("div"); add.className = "dev-var-new";
    add.innerHTML = '<input placeholder="--new-var" spellcheck="false"><input placeholder="值" spellcheck="false"><button type="button">+ 新建</button>';
    const [ni, vi] = add.querySelectorAll("input");
    add.querySelector("button").addEventListener("click", () => {
      let nm = ni.value.trim(); if (!nm) return;
      if (!nm.startsWith("--")) nm = "--" + nm.replace(/^-+/, "");
      const value = vi.value.trim() || "0";
      const span = cssRuleSpan(":root");
      if (span) {
        const closePos = cm.posFromIndex(span.close);
        cm.replaceRange("\n  " + nm + ": " + value + ";", closePos, closePos);
      } else {
        cm.replaceRange(":root {\n  " + nm + ": " + value + ";\n}\n\n", CodeMirror.Pos(0, 0));
      }
      markDirty(); scheduleAutoSave(); updatePreview();
      setTimeout(renderVars, 120);
    });
    host.appendChild(add);
    applyVarsFilter();
  }

  function cssRuleSpan(selector) {
    const text = cm.getValue();
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{", "g");
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      let i = text.indexOf("{", start);
      let depth = 0;
      for (; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") { depth -= 1; if (depth === 0) return { start: start, open: m.index + m[0].length, end: i, close: i }; }
      }
    }
    return null;
  }
  function updateCssDeclaration(selector, prop, value) {
    const span = cssRuleSpan(selector);
    if (!span) return false;
    let block = cm.getRange(cm.posFromIndex(span.open), cm.posFromIndex(span.close));
    const propRe = new RegExp("(^|[;{]\\s*)" + prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:[^;}]*", "m");
    if (propRe.test(block)) block = block.replace(propRe, (all, lead) => lead + prop + ": " + value);
    else block = block.replace(/\s*$/, "") + "\n  " + prop + ": " + value + ";\n";
    cm.replaceRange(block, cm.posFromIndex(span.open), cm.posFromIndex(span.close));
    return true;
  }
  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function parseRuleAtCursor() {
    if (!cm) return null;
    const text = cm.getValue();
    const pos = cm.indexFromPos(cm.getCursor());
    if (pos == null) return null;
    const open = text.lastIndexOf("{", pos);
    if (open < 0) return null;
    if (text.lastIndexOf("}", pos) > open) return null;
    const close = text.indexOf("}", open);
    if (close < 0) return null;
    let start = Math.max(text.lastIndexOf("}", open - 1), text.lastIndexOf(";", open - 1)) + 1;
    let selector = text.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector || selector.startsWith("@")) return null;
    const block = text.slice(open + 1, close);
    const declarations = [];
    for (const part of block.split(";")) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      const prop = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (prop) declarations.push({ prop, value });
    }
    return { selector, start, open, close, declarations };
  }
  function cssPosToCm(index) { return cm.posFromIndex(Math.max(0, Math.min(index, cm.getValue().length))); }
  function updateRuleDeclarationAt(rule, prop, value) {
    const span = cssRuleSpan(rule.selector);
    if (!span) return false;
    let block = cm.getRange(cssPosToCm(span.open), cssPosToCm(span.close));
    const re = new RegExp("(^|[;{]\\s*)" + prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:[^;}]*", "m");
    if (re.test(block)) block = block.replace(re, (all, lead) => lead + prop + ": " + value);
    else if (value !== "") block = block.replace(/\s*$/, "") + "\n  " + prop + ": " + value + ";\n";
    cm.replaceRange(block, cssPosToCm(span.open), cssPosToCm(span.close));
    return true;
  }
  function previewElementFor(selector) {
    try { return $("preview").contentDocument.querySelector(selector); } catch { return null; }
  }
  function syncCursorRule() {
    if (!cm) return;
    const rule = parseRuleAtCursor();
    if (!rule) return;
    state.rule = rule;
    state.selectedSelector = rule.selector;
    const els = highlightSelector(rule.selector);
    state.matchCount = els.length;
    state.selected = els[0] || null;
    renderInspector();
  }
  function addRuleDeclRow(host, rule, prop, value) {
    const row = document.createElement("div"); row.className = "dev-decl";
    row.innerHTML = '<span class="prop"></span><input type="text"><span class="del">×</span>';
    row.querySelector(".prop").textContent = prop;
    const inp = row.querySelector("input"); inp.value = value;
    inp.addEventListener("change", () => {
      if (updateRuleDeclarationAt(rule, prop, inp.value)) {
        state.dirty = true; scheduleAutoSave(); updatePreview();
      }
    });
    row.querySelector(".del").addEventListener("click", () => {
      if (updateRuleDeclarationAt(rule, prop, "")) { state.dirty = true; scheduleAutoSave(); updatePreview(); }
    });
    host.appendChild(row);
  }
  function renderCurrentRule(rule, el) {
    $("devSelector").textContent = rule.selector + (el ? "  ·  预览匹配 " + (state.matchCount || 1) + " 个" : "  ·  预览无匹配元素");
    const styleBox = $("devStyle");
    styleBox.innerHTML = "";
    const box = document.createElement("div"); box.className = "dev-rule";
    const head = document.createElement("div"); head.className = "dev-rule-head";
    head.innerHTML = '<span class="sel"></span><span class="jump">光标所在规则</span>';
    head.querySelector(".sel").textContent = rule.selector;
    head.addEventListener("click", () => { const pos = cm.posFromIndex(rule.start); cm.setCursor(pos); cm.scrollIntoView(pos, 100); cm.focus(); });
    box.appendChild(head);
    if (!rule.declarations.length) box.innerHTML += '<div class="dev-empty">这个规则块还没有声明</div>';
    for (const decl of rule.declarations) addRuleDeclRow(box, rule, decl.prop, decl.value);
    const add = document.createElement("div"); add.className = "dev-add";
    add.innerHTML = '<input placeholder="属性，如 color"><input placeholder="值，如 #fff"><button type="button" class="dev-add-btn">+ 添加</button>';
    const [pi, vi] = add.querySelectorAll("input");
    add.querySelector("button").addEventListener("click", () => {
      if (!pi.value.trim()) return;
      if (updateRuleDeclarationAt(rule, pi.value.trim(), vi.value.trim())) { state.dirty = true; scheduleAutoSave(); updatePreview(); }
    });
    box.appendChild(add);
    const hint = document.createElement("div");
    hint.className = "dev-add-hint";
    hint.textContent = "按 + 添加后写入当前规则，并自动保存";
    box.appendChild(hint);
    styleBox.appendChild(box);
    if (el && el.style.length) {
      const inlineWrap = document.createElement("div");
      inlineWrap.className = "dev-inline";
      inlineWrap.innerHTML = '<div class="dev-section-title">element.style</div>';
      for (const decl of Array.from(el.style)) {
        const row = document.createElement("div"); row.className = "dev-decl";
        row.innerHTML = '<span class="prop"></span><input type="text"><span class="del">×</span>';
        row.querySelector(".prop").textContent = decl;
        const inp = row.querySelector("input"); inp.value = el.style.getPropertyValue(decl);
        inp.addEventListener("change", () => { el.style.setProperty(decl, inp.value); });
        row.querySelector(".del").addEventListener("click", () => { el.style.removeProperty(decl); renderInspector(); });
        inlineWrap.appendChild(row);
      }
      styleBox.appendChild(inlineWrap);
    }
    const computed = $("devComputed");
    computed.innerHTML = el ? computedRows(el).map(([k, v]) => '<div class="dev-computed-row"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(v) + '</span></div>').join("") : '<div class="dev-empty">预览中没有匹配这个选择器的元素</div>';
  }
  function renderElementInspector(el) {
    if (!el) {
      $("devSelector").textContent = "未选择元素";
      $("devStyle").innerHTML = '<div class="dev-empty">把光标放在左侧 CSS 规则块里，或点「检查样式」选择预览元素。</div>';
      $("devComputed").innerHTML = "";
      return;
    }
    $("devSelector").textContent = state.selectedSelector;
    const styleBox = $("devStyle");
    styleBox.innerHTML = "";
    const inline = el.getAttribute("style") || "";
    const inlineWrap = document.createElement("div");
    inlineWrap.className = "dev-inline";
    inlineWrap.innerHTML = '<div class="dev-section-title">element.style</div>';
    for (const decl of Array.from(el.style)) {
      const row = document.createElement("div"); row.className = "dev-decl";
      row.innerHTML = '<span class="prop"></span><input type="text"><span class="del">×</span>';
      row.querySelector(".prop").textContent = decl;
      const inp = row.querySelector("input"); inp.value = el.style.getPropertyValue(decl);
      inp.addEventListener("change", () => { el.style.setProperty(decl, inp.value); });
      row.querySelector(".del").addEventListener("click", () => { el.style.removeProperty(decl); renderInspector(); });
      inlineWrap.appendChild(row);
    }
    const add = document.createElement("div"); add.className = "dev-add";
    add.innerHTML = '<input placeholder="属性，如 color"><input placeholder="值，如 #fff"><button type="button" class="dev-add-btn">+ 添加</button>';
    const [pi, vi] = add.querySelectorAll("input");
    add.querySelector("button").addEventListener("click", () => {
      const p = pi.value.trim(), v = vi.value.trim();
      if (!p) return;
      el.style.setProperty(p, v);
      renderInspector();
    });
    inlineWrap.appendChild(add);
    styleBox.appendChild(inlineWrap);
    const rules = collectMatchedRules(el);
    const rulesWrap = document.createElement("div");
    rulesWrap.className = "dev-section";
    rulesWrap.innerHTML = '<div class="dev-section-title">匹配的 CSS 规则</div>';
    if (!rules.length) rulesWrap.innerHTML += '<div class="dev-empty">没有匹配规则</div>';
    for (const rule of rules) {
      const box = document.createElement("div"); box.className = "dev-rule";
      const head = document.createElement("div"); head.className = "dev-rule-head";
      head.innerHTML = '<span class="sel"></span><span class="jump">跳转</span>';
      head.querySelector(".sel").textContent = rule.selectorText;
      head.addEventListener("click", () => {
        const span = cssRuleSpan(rule.selectorText);
        if (span) { const pos = cm.posFromIndex(span.start); cm.setCursor(pos); cm.scrollIntoView(pos, 100); cm.focus(); }
      });
      box.appendChild(head);
      for (let i = 0; i < rule.style.length; i += 1) {
        const prop = rule.style[i];
        const val = rule.style.getPropertyValue(prop);
        const row = document.createElement("div"); row.className = "dev-decl";
        row.innerHTML = '<span class="prop"></span><input type="text"><span class="del">×</span>';
        row.querySelector(".prop").textContent = prop;
        const inp = row.querySelector("input"); inp.value = val;
        inp.addEventListener("change", () => {
          if (updateCssDeclaration(rule.selectorText, prop, inp.value)) {
            state.dirty = true; scheduleAutoSave(); updatePreview();
          }
        });
        row.querySelector(".del").addEventListener("click", () => {
          if (updateCssDeclaration(rule.selectorText, prop, "")) { state.dirty = true; scheduleAutoSave(); updatePreview(); }
        });
        box.appendChild(row);
      }
      rulesWrap.appendChild(box);
    }
    styleBox.appendChild(rulesWrap);
    const computed = $("devComputed");
    computed.innerHTML = computedRows(el).map(([k, v]) => '<div class="dev-computed-row"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(v) + '</span></div>').join("");
  }
  function renderInspector() {
    if (state.rule) { renderCurrentRule(state.rule, state.selected); return; }
    renderElementInspector(state.selected);
  }
  function updatePreview() {
    try {
      const frame = $("preview");
      frame.srcdoc = previewDocument(cm.getValue());
      setTimeout(() => {
        const doc = frame.contentDocument;
        if (!doc) return;
        if (state.inspect) setupPreviewDoc(doc);
        const rule = parseRuleAtCursor();
        if (rule) {
          state.rule = rule;
          const els = highlightSelector(rule.selector);
          state.matchCount = els.length;
          state.selected = els[0] || null;
        }
        renderInspector();
      }, 80);
    } catch { }
  }

  function toggleInspect(force) {
    state.inspect = typeof force === "boolean" ? force : !state.inspect;
    $("inspectBtn").classList.toggle("active", state.inspect);
    if (!state.inspect) {
      clearPreviewHighlights();
      state.selected = null; state.selectedSelector = ""; state.matchCount = 0;
      setStatus("就绪");
      syncCursorRule();
    } else {
      bindPreviewInspector();
      setupPreviewDoc($("preview").contentDocument);
      setStatus("检查模式：点击预览中的元素");
    }
  }
  // ================= CSS 自动补全 =================
  const CSS_DATA = window.LYRA_CSS_DATA || { props: {}, syntaxes: {} };
  const TYPE_VALUES = {
    color: ["var(--color-primary)", "#fff", "#000", "transparent", "currentColor", "rgba(0,0,0,.5)"],
    length: ["0", "1px", "2px", "4px", "8px", "12px", "16px", ".5rem", "1rem", "100%", "100vw", "100vh"],
    percentage: ["0%", "50%", "100%"],
    number: ["0", "1", "2", "3", "0.5"],
    integer: ["0", "1", "2", "3"],
    angle: ["0deg", "45deg", "90deg", "180deg", "360deg", "0.25turn"],
    time: ["0s", ".1s", ".2s", ".3s", "1s"],
    url: ["url()", "none"],
    image: ["none", "url()", "linear-gradient()", "radial-gradient()"],
    position: ["center", "top", "bottom", "left", "right", "50% 50%"],
    lineStyle: ["solid", "dashed", "dotted", "double", "none"],
    display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none", "contents", "flow-root"],
    overflow: ["visible", "hidden", "auto", "scroll", "clip"],
    visibility: ["visible", "hidden", "collapse"],
  };
  const VALUE_MAP = {
    display: TYPE_VALUES.display,
    position: ["static", "relative", "absolute", "fixed", "sticky"],
    "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
    "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
    "justify-content": ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end"],
    "align-items": ["stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"],
    "align-content": ["stretch", "flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end"],
    "text-align": ["left", "right", "center", "justify", "start", "end"],
    "font-weight": ["100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold"],
    "text-decoration": ["none", "underline", "overline", "line-through", "wavy"],
    "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
    "box-sizing": ["border-box", "content-box"],
    "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
    "pointer-events": ["auto", "none"],
    "cursor": ["auto", "default", "pointer", "text", "move", "grab", "grabbing", "not-allowed", "wait", "help", "zoom-in", "zoom-out"],
    "background-repeat": ["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"],
    "background-size": ["auto", "cover", "contain", "100% 100%"],
    "background-position": TYPE_VALUES.position,
    "border-style": TYPE_VALUES.lineStyle,
    "outline-style": TYPE_VALUES.lineStyle,
    "overflow-x": TYPE_VALUES.overflow,
    "overflow-y": TYPE_VALUES.overflow,
    "visibility": TYPE_VALUES.visibility,
    "transition-timing-function": ["ease", "linear", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "cubic-bezier()"],
    "animation-direction": ["normal", "reverse", "alternate", "alternate-reverse"],
    "animation-fill-mode": ["none", "forwards", "backwards", "both"],
    "mix-blend-mode": ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "difference", "exclusion"],
  };
  const COLOR_KEYWORDS = ["transparent", "currentColor", "white", "black", "red", "orange", "yellow", "green", "blue", "purple", "pink", "gray", "grey", "brown", "cyan", "magenta", "navy", "teal", "olive", "maroon", "gold", "silver", "violet", "indigo", "crimson", "tomato", "salmon", "khaki", "beige", "ivory", "lavender", "plum", "orchid", "skyblue", "steelblue", "slategray", "dimgray", "lightgray", "darkgray"];

  function cssVariables() {
    const names = [];
    const text = cm ? cm.getValue() : "";
    const re = /--([-\w]+)\s*:/g;
    let m;
    while ((m = re.exec(text)) && names.length < 160) if (!names.includes("--" + m[1])) names.push("--" + m[1]);
    return names;
  }
  function varColorPairs() {
    const out = [];
    const text = cm ? cm.getValue() : "";
    const re = /--([-\w]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/g;
    let m;
    while ((m = re.exec(text)) && out.length < 80) {
      const c = parseColor(m[2]);
      if (c) out.push({ name: "--" + m[1], color: c });
    }
    return out;
  }
  function expandSyntax(syntax, depth) {
    if (!syntax || depth > 3) return [];
    const out = [];
    for (const raw of String(syntax).split("|")) {
      const alt = raw.trim();
      if (!alt) continue;
      if (alt.startsWith("<") && alt.endsWith(">")) {
        const type = alt.slice(1, -1);
        if (TYPE_VALUES[type]) out.push(...TYPE_VALUES[type]);
        else if (CSS_DATA.syntaxes && CSS_DATA.syntaxes[type]) out.push(...expandSyntax(CSS_DATA.syntaxes[type], depth + 1));
        else if (type === "color") out.push(...COLOR_KEYWORDS);
      } else if (/^[a-zA-Z][-\w]*$/.test(alt)) out.push(alt);
    }
    return out;
  }
  function valuesForProperty(prop) {
    const list = [];
    const meta = CSS_DATA.props[prop];
    if (meta && meta.syntax) list.push(...expandSyntax(meta.syntax, 0));
    if (VALUE_MAP[prop]) list.push(...VALUE_MAP[prop]);
    if (/color|background|border|outline|fill|stroke/.test(prop)) list.push(...COLOR_KEYWORDS);
    if (/margin|padding|width|height|top|left|right|bottom|gap|radius|size|position/.test(prop)) list.push(...TYPE_VALUES.length);
    if (/transition|animation/.test(prop)) list.push(...TYPE_VALUES.time, "ease", "linear", "infinite", "alternate");
    if (meta && meta.initial && meta.initial !== "seeProse") list.push(meta.initial);
    list.push(...cssVariables().map((v) => "var(" + v + ")"));
    return [...new Set(list.filter(Boolean))];
  }
  function inCommentAt(text, index) {
    const open = text.lastIndexOf("/*", index);
    const close = text.lastIndexOf("*/", index);
    return open > close;
  }
  function lyraCssHint(editor) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const token = editor.getTokenAt(cursor);
    if (token.type && (token.type.includes("comment") || token.type.includes("string"))) return null;
    const decl = before.match(/([-\w]+)\s*:\s*([^;{}]*)$/);
    if (decl) {
      const prop = decl[1].toLowerCase();
      const valuePart = decl[2];
      if (/var\(\s*--[-\w]*$/.test(valuePart)) {
        const start = before.lastIndexOf("--", before.length);
        return { list: cssVariables().map((v) => "var(" + v + ")").filter((v) => v.startsWith("var(--")), from: editor.posFromIndex(editor.indexFromPos(cursor) - (before.length - start)), to: cursor };
      }
      const startMatch = valuePart.match(/([-\w#.%]*)$/);
      const prefix = startMatch ? startMatch[1] : "";
      let list = valuesForProperty(prop);
      if (/^#/.test(prefix)) list = ["#fff", "#000", "#66ccff", ...COLOR_KEYWORDS];
      if (prefix && !/^#/.test(prefix)) list = list.filter((v) => v.toLowerCase().startsWith(prefix.toLowerCase()));
      if (!list.length) list = valuesForProperty(prop).slice(0, 40);
      const fromCh = Math.max(0, cursor.ch - prefix.length);
      return { list: [...new Set(list)].slice(0, 300), from: CodeMirror.Pos(cursor.line, fromCh), to: cursor };
    }
    const word = (before.match(/([-\w]*)$/) || ["", ""])[1];
    if (/^\s*\/\//.test(before) && !before.includes("{")) return null;
    const props = Object.keys(CSS_DATA.props || {}).filter((p) => !word || p.startsWith(word));
    const vars = cssVariables().filter((v) => !word || v.startsWith(word));
    const common = ["display", "position", "margin", "padding", "color", "background", "border", "font-size", "width", "height", "flex", "gap", "grid-template-columns", "transition", "transform", "opacity"];
    const list = [...new Set([...props, ...vars, ...(word ? [] : common)])].slice(0, 400);
    return { list, from: CodeMirror.Pos(cursor.line, cursor.ch - word.length), to: cursor };
  }
  let autoHintTimer = 0;
  function scheduleAutoHint() {
    clearTimeout(autoHintTimer);
    autoHintTimer = setTimeout(() => {
      if (!cm || cm.state.completionActive) return;
      const cur = cm.getCursor();
      const line = cm.getLine(cur.line);
      const before = line.slice(0, cur.ch);
      if (!/[-\w#]$/.test(before)) return;
      const token = cm.getTokenAt(cur);
      if (token.type && (token.type.includes("comment") || token.type.includes("string"))) return;
      if (!/[^\s]/.test(before)) return;
      cm.showHint({ hint: lyraCssHint, completeSingle: false });
    }, 120);
  }

  // ================= 颜色解析 / 格式化 =================
  function parseColor(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    let m = s.match(/^#([0-9a-fA-F]+)$/);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
      if (h.length === 6 || h.length === 8) {
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
      }
      return null;
    }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const val = (x) => x.endsWith("%") ? parseFloat(x) * 2.55 : parseFloat(x);
        const a = parts[3] == null ? 1 : (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
        return { r: Math.max(0, Math.min(255, Math.round(val(parts[0])))), g: Math.max(0, Math.min(255, Math.round(val(parts[1])))), b: Math.max(0, Math.min(255, Math.round(val(parts[2])))), a: isNaN(a) ? 1 : Math.max(0, Math.min(1, a)) };
      }
      return null;
    }
    m = s.match(/^hsla?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const h = ((parseFloat(parts[0]) % 360) + 360) % 360;
        const sat = Math.max(0, Math.min(100, parseFloat(parts[1]))) / 100;
        const light = Math.max(0, Math.min(100, parseFloat(parts[2]))) / 100;
        const a = parts[3] == null ? 1 : (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
        return { ...hslToRgb(h, sat, light), a: isNaN(a) ? 1 : Math.max(0, Math.min(1, a)) };
      }
      return null;
    }
    const el = document.createElement("span");
    el.style.color = "";
    el.style.color = s;
    if (!el.style.color) return null;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color;
    el.remove();
    return parseColor(rgb);
  }
  function hslToRgb(h, s, l) {
    h /= 360;
    const hue = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r, g, b;
    if (s === 0) r = g = b = l;
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }
  function rgbToHsl(c) {
    let r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function toHex(c) { return "#" + [c.r, c.g, c.b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""); }
  function formatColor(c, format) {
    if (!c) return "";
    if (format === "rgb") return c.a >= 0.999 ? "rgb(" + c.r + ", " + c.g + ", " + c.b + ")" : "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + Number(c.a.toFixed(3)) + ")";
    if (format === "hsl") {
      const h = rgbToHsl(c);
      return c.a >= 0.999 ? "hsl(" + h.h + ", " + h.s + "%, " + h.l + "%)" : "hsla(" + h.h + ", " + h.s + "%, " + h.l + "%, " + Number(c.a.toFixed(3)) + ")";
    }
    if (c.a >= 0.999) return toHex(c);
    return toHex(c) + Math.round(c.a * 255).toString(16).padStart(2, "0");
  }
  function colorCss(c) { return "rgba(" + c.r + "," + c.g + "," + c.b + "," + Number(c.a.toFixed(3)) + ")"; }

  // ================= 颜色色块（行号左侧 gutter：一行多个按顺序排列，不遮挡代码） =================
  function clearColorChips() {
    if (cm) cm.clearGutter("css-colors");
  }
  function rebuildColorChips() {
    if (!cm) return;
    clearColorChips();
    const text = cm.getValue();
    const re = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgb|hsl)a?\([^)]*\)/g;
    const byLine = new Map();
    let m; let count = 0;
    while ((m = re.exec(text)) && count < 300) {
      if (inCommentAt(text, m.index)) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEndIdx = text.indexOf("\n", m.index);
      const lineText = text.slice(lineStart, lineEndIdx < 0 ? text.length : lineEndIdx);
      const col = m.index - lineStart;
      const beforeToken = lineText.slice(Math.max(0, col - 24), col);
      if (/url\([^)]*$/i.test(beforeToken)) continue;
      const c = parseColor(m[0]);
      if (!c) continue;
      const ctx = { from: m.index, to: m.index + m[0].length, raw: m[0], color: c };
      const lineNo = cm.posFromIndex(m.index).line;
      if (!byLine.has(lineNo)) byLine.set(lineNo, []);
      byLine.get(lineNo).push(ctx);
      count++;
    }
    for (const [lineNo, list] of byLine) {
      const wrap = document.createElement("div");
      wrap.className = "css-color-gutter";
      wrap.title = list.map((x) => x.raw).join("  ");
      for (const ctx of list.slice(0, 4)) {
        const s = document.createElement("span");
        s.className = "css-line-swatch";
        s.style.background = colorCss(ctx.color);
        s.title = ctx.raw + " · 点击修改";
        s.addEventListener("mousedown", (event) => {
          event.preventDefault(); event.stopPropagation();
          openColorPicker(s, ctx, s.getBoundingClientRect());
        });
        wrap.appendChild(s);
      }
      if (list.length > 4) {
        const more = document.createElement("span");
        more.className = "css-gutter-more";
        more.textContent = "+" + (list.length - 4);
        wrap.appendChild(more);
      }
      cm.setGutterMarker(lineNo, "css-colors", wrap);
    }
  }
  function scheduleColorChips() {
    clearTimeout(state.colorChipTimer);
    state.colorChipTimer = setTimeout(rebuildColorChips, 220);
  }
  function colorTokenAtCursor() {
    if (!cm) return null;
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line) || "";
    const re = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgb|hsl)a?\([^)]*\)/g;
    let m;
    while ((m = re.exec(line))) {
      if (cur.ch >= m.index && cur.ch <= m.index + m[0].length) {
        const c = parseColor(m[0]);
        if (!c) return null;
        const start = cm.indexFromPos({ line: cur.line, ch: m.index });
        return { from: start, to: start + m[0].length, raw: m[0], color: c };
      }
    }
    return null;
  }
  function openColorPicker(chip, ctx, rectOverride) {
    state.colorTarget = ctx;
    state.pickerColor = { ...ctx.color };
    const pop = $("colorPopover");
    pop.hidden = false;
    $("cpNative").value = toHex(ctx.color);
    $("cpAlpha").value = String(Math.round(ctx.color.a * 100));
    $("cpAlphaText").textContent = Math.round(ctx.color.a * 100) + "%";
    $("cpFormat").value = /^#/.test(ctx.raw) ? "hex" : /^rgb/i.test(ctx.raw) ? "rgb" : "hsl";
    $("cpText").value = ctx.raw;
    updatePickerPreview();
    const rect = rectOverride || chip.getBoundingClientRect();
    let left = rect.left, top = rect.bottom + 7;
    if (left + 260 > window.innerWidth) left = window.innerWidth - 266;
    if (top + 360 > window.innerHeight) top = Math.max(8, rect.top - 360);
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = Math.max(8, top) + "px";
    renderColorPresets();
  }
  function closeColorPicker() { $("colorPopover").hidden = true; state.colorTarget = null; }
  function updatePickerPreview() {
    const c = state.pickerColor;
    if (!c) return;
    const pv = $("cpPreview"); pv.innerHTML = "";
    const inner = document.createElement("i");
    inner.style.background = colorCss(c);
    pv.appendChild(inner);
    $("cpText").value = formatColor(c, $("cpFormat").value);
  }
  function renderColorPresets() {
    const host = $("cpPresets"); host.innerHTML = "";
    const seen = new Set();
    const add = (name, c) => {
      const key = toHex(c) + ":" + c.a;
      if (seen.has(key)) return; seen.add(key);
      const b = document.createElement("button");
      b.type = "button"; b.className = "cp-swatch"; b.title = name + " " + colorCss(c);
      b.style.background = colorCss(c);
      b.addEventListener("click", () => {
        state.pickerColor = { ...c };
        $("cpNative").value = toHex(c); $("cpAlpha").value = String(Math.round(c.a * 100)); $("cpAlphaText").textContent = Math.round(c.a * 100) + "%";
        updatePickerPreview();
      });
      host.appendChild(b);
    };
    for (const { name, color } of varColorPairs()) add(name, color);
    for (const [name, val] of [["天依蓝", "#66ccff"], ["白", "#ffffff"], ["黑", "#000000"], ["红", "#ff3b30"], ["绿", "#34c759"], ["黄", "#ffcc00"], ["紫", "#af52de"], ["灰", "#8e8e93"]]) add(name, parseColor(val));
  }
  function applyPickedColor() {
    const ctx = state.colorTarget; if (!ctx || !cm) return;
    const c = state.pickerColor; if (!c) return;
    const next = formatColor(c, $("cpFormat").value);
    const from = cm.posFromIndex(ctx.from), to = cm.posFromIndex(ctx.to);
    cm.replaceRange(next, from, to);
    markDirty(); scheduleAutoSave(); updatePreview();
    closeColorPicker();
  }

  function showDevTab(name) {
    document.querySelectorAll(".dev-tab").forEach((t) => t.classList.toggle("active", t.dataset.dev === name));
    $("devStyle").hidden = name !== "style";
    $("devComputed").hidden = name !== "computed";
    $("devVars").hidden = name !== "vars";
    if (name === "vars") renderVars();
  }

  function bind() {
    $("save").addEventListener("click", () => saveFile(false));
    $("format").addEventListener("click", () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); setStatus("已格式化"); });
    $("theme").addEventListener("change", () => applyTheme($("theme").value));

    $("cpNative").addEventListener("input", () => {
      const c = parseColor($("cpNative").value);
      if (c) { c.a = state.pickerColor ? state.pickerColor.a : 1; state.pickerColor = c; updatePickerPreview(); }
    });
    $("cpAlpha").addEventListener("input", () => {
      if (!state.pickerColor) return;
      state.pickerColor.a = Math.max(0, Math.min(1, Number($("cpAlpha").value) / 100));
      $("cpAlphaText").textContent = $("cpAlpha").value + "%";
      updatePickerPreview();
    });
    $("cpFormat").addEventListener("change", () => updatePickerPreview());
    $("cpText").addEventListener("input", () => {
      const c = parseColor($("cpText").value);
      if (c) { state.pickerColor = c; $("cpNative").value = toHex(c); $("cpAlpha").value = String(Math.round(c.a * 100)); $("cpAlphaText").textContent = Math.round(c.a * 100) + "%"; const pv = $("cpPreview"); if (pv.firstChild) pv.firstChild.style.background = colorCss(c); }
    });
    $("cpApply").addEventListener("click", applyPickedColor);
    $("cpCancel").addEventListener("click", closeColorPicker);
    $("cpClose").addEventListener("click", closeColorPicker);
    document.addEventListener("mousedown", (event) => {
      const pop = $("colorPopover");
      if (!pop.hidden && !pop.contains(event.target) && !event.target.closest(".lyra-color-chip")) closeColorPicker();
    });
    $("previewRefresh").addEventListener("click", () => updatePreview());
    $("inspectBtn").addEventListener("click", () => toggleInspect());
    $("devClose").addEventListener("click", () => {
      state.inspect = false; state.selected = null; state.rule = null; state.selectedSelector = "";
      $("inspectBtn").classList.remove("active");
      renderInspector();
    });
    document.querySelectorAll(".dev-tab").forEach((tab) => tab.addEventListener("click", () => showDevTab(tab.dataset.dev)));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("colorPopover").hidden) { closeColorPicker(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        clearTimeout(state.autoTimer);
        state.dirty = cm.getValue() !== state.lastSaved;
        saveFile(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === " " || event.code === "Space" || event.key.toLowerCase() === "h")) {
        event.preventDefault();
        if (cm && !cm.state.completionActive) cm.showHint({ hint: lyraCssHint, completeSingle: false });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault(); showDevTab("vars"); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const ctx = colorTokenAtCursor();
        if (ctx) {
          const co = cm.cursorCoords(true, "window");
          openColorPicker(null, ctx, { left: co.left, top: co.bottom, width: 0, height: 0, right: co.left, bottom: co.bottom });
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        toggleInspect();
      }
    });
    window.addEventListener("message", (event) => {
      const d = event.data || {};
      if (d.type === "theme" && typeof d.theme === "string") applyTheme(d.theme);
      if (d.type === "shell-host-result") {
        const p = shellPending.get(d.requestId);
        if (!p) return;
        shellPending.delete(d.requestId); d.ok === false ? p.reject(new Error(d.error || "外壳操作失败")) : p.resolve(d);
      }
    });
  }
  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      mode: "css", theme: "lyra", lineNumbers: true, matchBrackets: true, autoCloseBrackets: true,
      foldGutter: true, gutters: ["css-colors", "CodeMirror-linenumbers", "CodeMirror-foldgutter", "css-errors"],
      styleActiveLine: true, indentUnit: 2, tabSize: 2, lineWrapping: false,
      extraKeys: {
        "Ctrl-S": () => saveFile(), "Cmd-S": () => saveFile(),
        "Ctrl-/": toggleCssComment, "Cmd-/": toggleCssComment,
        "Ctrl-Space": (ed) => ed.showHint({ hint: CodeMirror.hint.css, completeSingle: false }),
        "Shift-Alt-F": () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); },
        "Ctrl-G": () => { const n = prompt("跳转到行"); if (n) cm.setCursor({ line: Math.max(0, parseInt(n, 10) - 1), ch: 0 }); },
      },
    });
    cm.on("change", (cm, change) => {
      markDirty(); scheduleAutoSave(); scheduleColorChips(); scheduleVarsRender();
      // ★ 只有用户输入才自动弹补全：程序化修改（取色器写回/格式化/加载）不应弹提示
      if (change && change.origin === "+input") scheduleAutoHint();
      clearTimeout(state.statusTimer); state.statusTimer = setTimeout(refreshLint, 600); updatePreview();
    });
    cm.setSize("100%", "100%");
    try {
      const savedSplit = parseFloat(localStorage.getItem("lyra.css.split2") || "");
      if (savedSplit >= 30 && savedSplit <= 78) state.split = savedSplit;
    } catch { }
    const applySplit = (n) => {
      state.split = Math.max(30, Math.min(78, n));
      document.documentElement.style.setProperty("--split", state.split + "%");
      try { localStorage.setItem("lyra.css.split2", String(state.split)); } catch { }
    };
    applySplit(state.split);
    try {
      const savedPanel = parseFloat(localStorage.getItem("lyra.css.panelHeight") || "");
      if (savedPanel >= 100 && savedPanel <= window.innerHeight * 0.65) document.documentElement.style.setProperty("--problems-height", savedPanel + "px");
    } catch { }
    const panelSplitter = $("panelSplitter");
    let panelDragging = false;
    panelSplitter.addEventListener("mousedown", (event) => {
      panelDragging = true;
      event.preventDefault();
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (event) => {
      if (!panelDragging) return;
      const h = Math.max(100, Math.min(window.innerHeight * 0.65, window.innerHeight - event.clientY - 7));
      document.documentElement.style.setProperty("--problems-height", Math.round(h) + "px");
    });
    window.addEventListener("mouseup", () => {
      if (!panelDragging) return;
      panelDragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("lyra.css.panelHeight", getComputedStyle(document.getElementById("problemsPanel")).flexBasis); } catch { }
    });
    const splitter = $("splitter");
    let dragging = false;
    splitter.addEventListener("mousedown", (event) => {
      dragging = true;
      event.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const main = $("main");
      const r = main.getBoundingClientRect();
      applySplit(((event.clientX - r.left) / r.width) * 100);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
    const updateCursor = () => {
      const pos = cm.getCursor();
      const el = $("cursorPos");
      if (el) el.textContent = "Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1);
    };
    let cursorRuleTimer = 0;
    cm.on("cursorActivity", () => {
      updateCursor();
      clearTimeout(cursorRuleTimer);
      cursorRuleTimer = setTimeout(syncCursorRule, 90);
    });
    updateCursor();
    setTimeout(syncCursorRule, 300);
    setTimeout(rebuildColorChips, 500);
  }
  bind();
  try { applyTheme(localStorage.getItem("lyra.css.theme") || "lyra"); } catch { applyTheme("lyra"); }
  initEditor(); loadFile();
})();
