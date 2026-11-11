/* CSS 编辑器：源码、补全、折叠、预览、保存、Ctrl+/ 注释。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const SHELL = params.get("shell") === "1";
  const pathParam = params.get("projectEntry") || params.get("path") || "";
  const host = window.chrome && window.chrome.webview;
  const shellPending = new Map();
  const state = { path: pathParam, dirty: false, statusTimer: 0, theme: "lyra", errorMarks: [], errorLines: [], autoTimer: 0, lastSaved: "", saving: false, split: 38, lintSeq: 0, inspect: false, selected: null, selectedSelector: "", inspectBound: false, rule: null };
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
    if (state.selected && state.selected.classList) state.selected.classList.remove("__lyra-selected");
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
    const el = previewElementFor(rule.selector);
    if (state.selected && state.selected !== el && state.selected.classList) state.selected.classList.remove("__lyra-selected");
    state.selected = el;
    if (el) el.classList.add("__lyra-selected");
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
    $("devSelector").textContent = rule.selector + (el ? "  ·  预览已匹配" : "  ·  预览无匹配元素");
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
    add.innerHTML = '<input placeholder="property"><input placeholder="value"><button type="button">+</button>';
    const [pi, vi] = add.querySelectorAll("input");
    add.querySelector("button").addEventListener("click", () => {
      if (!pi.value.trim()) return;
      if (updateRuleDeclarationAt(rule, pi.value.trim(), vi.value.trim())) { state.dirty = true; scheduleAutoSave(); updatePreview(); }
    });
    box.appendChild(add);
    styleBox.appendChild(box);
    if (el) {
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
    add.innerHTML = '<input placeholder="property"><input placeholder="value"><button type="button">+</button>';
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
          const el = previewElementFor(rule.selector);
          state.selected = el;
          if (el) el.classList.add("__lyra-selected");
        }
        renderInspector();
      }, 80);
    } catch { }
  }

  function toggleInspect(force) {
    state.inspect = typeof force === "boolean" ? force : !state.inspect;
    $("inspectBtn").classList.toggle("active", state.inspect);
    if (!state.inspect) {
      if (state.selected) state.selected.classList.remove("__lyra-selected");
      state.selected = null; state.selectedSelector = "";
      setStatus("就绪");
      syncCursorRule();
    } else {
      bindPreviewInspector();
      setupPreviewDoc($("preview").contentDocument);
      setStatus("检查模式：点击预览中的元素");
    }
  }
  function bind() {
    $("save").addEventListener("click", () => saveFile(false));
    $("format").addEventListener("click", () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); setStatus("已格式化"); });
    $("theme").addEventListener("change", () => applyTheme($("theme").value));
    $("previewRefresh").addEventListener("click", () => updatePreview());
    $("inspectBtn").addEventListener("click", () => toggleInspect());
    $("devClose").addEventListener("click", () => {
      state.inspect = false; state.selected = null; state.rule = null; state.selectedSelector = "";
      $("inspectBtn").classList.remove("active");
      renderInspector();
    });
    document.querySelectorAll(".dev-tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".dev-tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("devStyle").hidden = tab.dataset.dev !== "style";
      $("devComputed").hidden = tab.dataset.dev !== "computed";
    }));
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        clearTimeout(state.autoTimer);
        state.dirty = cm.getValue() !== state.lastSaved;
        saveFile(false);
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
      foldGutter: true, gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter", "css-errors"],
      styleActiveLine: true, indentUnit: 2, tabSize: 2, lineWrapping: false,
      extraKeys: {
        "Ctrl-S": () => saveFile(), "Cmd-S": () => saveFile(),
        "Ctrl-/": toggleCssComment, "Cmd-/": toggleCssComment,
        "Ctrl-Space": (ed) => ed.showHint({ hint: CodeMirror.hint.css, completeSingle: false }),
        "Shift-Alt-F": () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); },
        "Ctrl-G": () => { const n = prompt("跳转到行"); if (n) cm.setCursor({ line: Math.max(0, parseInt(n, 10) - 1), ch: 0 }); },
      },
    });
    cm.on("change", () => { markDirty(); scheduleAutoSave(); clearTimeout(state.statusTimer); state.statusTimer = setTimeout(refreshLint, 600); updatePreview(); });
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
  }
  bind();
  try { applyTheme(localStorage.getItem("lyra.css.theme") || "lyra"); } catch { applyTheme("lyra"); }
  initEditor(); loadFile();
})();
