/* CSS 编辑器：源码、补全、折叠、预览、保存、Ctrl+/ 注释。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const SHELL = params.get("shell") === "1";
  const pathParam = params.get("projectEntry") || params.get("path") || "";
  const host = window.chrome && window.chrome.webview;
  const shellPending = new Map();
  const state = { path: pathParam, dirty: false, statusTimer: 0 };
  let cm = null;

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
      state.path = res.path || res.rel || state.path;
      $("file").textContent = (res.path || res.rel || state.path || res.name || "CSS") + (res.name ? "  ·  " + res.name : "");
      state.dirty = false;
      setStatus("已加载");
      updatePreview();
    } catch (e) {
      setStatus("打开失败：" + (e && e.message ? e.message : e), true);
    }
  }
  async function saveFile() {
    try {
      setStatus("正在保存…");
      const payload = { data: cm.getValue() };
      if (state.path) payload.path = state.path;
      const res = await callHost("host.workspace.save", payload);
      if (!res || res.ok === false) throw new Error((res && res.error) || "保存失败");
      state.dirty = false;
      setStatus("已保存");
    } catch (e) { setStatus("保存失败：" + (e && e.message ? e.message : e), true); }
  }
  function previewDocument(cssText) {
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + String(cssText || "").replace(/<\/style/gi, "<\\/style") + '</style></head><body><div class="container"><h1>CSS 预览</h1><p>这是示例段落，用来观察颜色、字号、间距和布局。</p><p><a href="#">链接</a> · <button>按钮</button> · <code>code</code></p><div class="box card"><h2>卡片标题</h2><p>Common classes: container, box, card, row, col</p></div><ul><li>列表项 1</li><li>列表项 2</li></ul><table><tr><th>表头</th><th>表头</th></tr><tr><td>内容</td><td>内容</td></tr></table></div></body></html>';
  }
  function updatePreview() {
    try { $("preview").srcdoc = previewDocument(cm.getValue()); } catch { }
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
  function basicLint() {
    const text = cm.getValue();
    let depth = 0, quote = "", errors = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== "\\") quote = ""; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth < 0) { errors += 1; depth = 0; } }
    }
    if (depth !== 0) errors += 1;
    if (quote) errors += 1;
    return errors;
  }
  function bind() {
    $("save").addEventListener("click", saveFile);
    $("format").addEventListener("click", () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); setStatus("已格式化"); });
    $("comment").addEventListener("click", toggleCssComment);
    document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveFile(); } });
    window.addEventListener("message", (event) => {
      const d = event.data || {};
      if (d.type === "theme" && typeof d.theme === "string") document.documentElement.dataset.theme = d.theme;
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
      foldGutter: true, gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
      styleActiveLine: true, indentUnit: 2, tabSize: 2, lineWrapping: false,
      extraKeys: {
        "Ctrl-S": () => saveFile(), "Cmd-S": () => saveFile(),
        "Ctrl-/": toggleCssComment, "Cmd-/": toggleCssComment,
        "Ctrl-Space": (ed) => ed.showHint({ hint: CodeMirror.hint.css, completeSingle: false }),
        "Shift-Alt-F": () => { cm.setValue(formatCss(cm.getValue())); markDirty(); updatePreview(); },
        "Ctrl-G": () => { const n = prompt("跳转到行"); if (n) cm.setCursor({ line: Math.max(0, parseInt(n, 10) - 1), ch: 0 }); },
      },
    });
    cm.on("change", () => { markDirty(); clearTimeout(state.statusTimer); state.statusTimer = setTimeout(() => { const errs = basicLint(); if (errs) setStatus("括号/引号可能不匹配", true); else setStatus("就绪"); }, 400); updatePreview(); });
    cm.setSize("100%", "100%");
  }
  bind(); initEditor(); loadFile();
})();
