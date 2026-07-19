const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let lastFolderPath = null;

// ── Folder bridge: finds BOTH LMU (.svm) and Kunos (.carsetup/.setup/.json) files ──
contextBridge.exposeInMainWorld('SetupRippleDir', {
  pick: async function () {
    const dirPath = await ipcRenderer.invoke('show-directory-picker');
    if (dirPath === null) throw new DOMException('The user aborted a request.', 'AbortError');
    lastFolderPath = dirPath;
    const files = [];
    function walk(dir, prefix, depth) {
      if (depth > 4) return;
      let items;
      try { items = fs.readdirSync(dir); } catch (e) { return; }
      for (const name of items) {
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.isDirectory()) {
          walk(full, prefix ? prefix + ' / ' + name : name, depth + 1);
          continue;
        }
        const isSvm  = /\.svm$/i.test(name);                 // LMU
        const isEvo  = /\.(carsetup|setup)$/i.test(name);    // AC Evo binary
        const isJson = name.toLowerCase().endsWith('.json'); // ACC
        if (!isSvm && !isEvo && !isJson) continue;
        const relPath = (prefix ? prefix + ' / ' : '') + name;
        let text = null, buffer = null;
        try {
          if (isEvo) {
            const b = fs.readFileSync(full);
            buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          } else {
            // .svm and .json are text
            text = fs.readFileSync(full, 'utf-8');
          }
        } catch (e) { continue; }
        files.push({ name, relPath, isEvo, text, buffer, fullPath: full });
      }
    }
    walk(dirPath, '', 0);
    return files;
  },
  save: async function (sourcePath, newFileName, data, isEvo) {
    return ipcRenderer.invoke('save-setup-file', sourcePath, newFileName, data, isEvo);
  }
});

// ── Bono AI bridge — uses cross-spawn so Claude Code's `claude.cmd` shim launches
//    correctly on Windows (Node's built-in spawn can't run a .cmd without shell:true,
//    which breaks pipes; cross-spawn is what npm/npx/yarn use to solve exactly this). ──
const crossSpawn = require('cross-spawn');
contextBridge.exposeInMainWorld('SetupRippleAI', {
  available() {
    return new Promise(resolve => {
      const proc = crossSpawn('claude', ['--version'], { windowsHide: true });
      let out = '';
      proc.stdout && proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, reason: "Claude Code not found - install it at claude.ai/code and run 'claude' once to sign in." });
      });
      proc.on('error', () => {
        resolve({ ok: false, reason: "Claude Code not found - install it at claude.ai/code and run 'claude' once to sign in." });
      });
    });
  },
  send(prompt, opts) {
    const { allowWrite = false, onChunk, onDone, onError } = opts || {};
    const os = require('os');
    const cwd = lastFolderPath || os.homedir();
    const fullPrompt = allowWrite ? prompt : '[READ ONLY - do not modify any files]\n\n' + prompt;
    // cross-spawn resolves claude.cmd on Windows while keeping shell:false semantics, so the
    // prompt stays a single safe argument (no shell parsing / injection) and pipes work.
    const proc = crossSpawn('claude', ['-p', fullPrompt], { cwd, windowsHide: true });
    let full = '';
    proc.stdout.on('data', chunk => { const text = chunk.toString(); full += text; onChunk && onChunk(text); });
    proc.stderr.on('data', () => {});
    proc.on('close', code => { if (code === 0) onDone && onDone(full); else onError && onError('Claude Code exited with code ' + code + '.'); });
    proc.on('error', err => { onError && onError(err.message); });
  }
});

// ── Inject the shell switch-bar into each app page (not the launcher) ──
// Built directly here in the preload's isolated world (which has DOM access),
// so neither app's HTML is modified.
function injectShellBar(){
  try {
    const path0 = location.pathname.toLowerCase();
    if (path0.endsWith('launcher.html')) return;           // no bar on the chooser
    const isLMU = path0.endsWith('setup-ripple-lmu.html');
    const BAR_H = 44;
    const style = document.createElement('style');
    style.textContent = `
      .sr-shellbar{position:fixed;top:0;left:0;right:0;height:${BAR_H}px;z-index:99999;
        display:flex;align-items:center;gap:14px;padding:0 14px;background:#111;
        border-bottom:1px solid #303030;font-family:'JetBrains Mono',ui-monospace,monospace;}
      .sr-shellbar .sr-home{background:none;border:1px solid #303030;color:#8a8a8a;border-radius:6px;
        width:30px;height:28px;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;
        align-items:center;justify-content:center;flex:0 0 auto;}
      .sr-shellbar .sr-home:hover{border-color:#e8112d;color:#e8112d}
      .sr-shellbar .sr-brand{font-weight:700;font-size:13px;color:#f4f6f5;letter-spacing:.02em;flex:0 0 auto}
      .sr-shellbar .sr-brand .r{color:#e8112d}
      .sr-shellbar .sr-switch{display:flex;gap:6px;margin-left:auto;flex:0 0 auto}
      .sr-shellbar .sr-tab{background:none;border:1px solid #303030;color:#8a8a8a;border-radius:99px;
        padding:5px 14px;cursor:pointer;font-size:11px;letter-spacing:.05em;text-transform:uppercase;}
      .sr-shellbar .sr-tab:hover{border-color:#e8112d;color:#f4f6f5}
      .sr-shellbar .sr-tab.on{background:#e8112d;color:#fff;border-color:#e8112d;cursor:default}
      body{padding-top:${BAR_H}px !important;}
    `;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'sr-shellbar';
    bar.innerHTML =
      `<button class="sr-home" title="Back to sim chooser">\u2302</button>`+
      `<span class="sr-brand">SETUP <span class="r">RIPPLE</span></span>`+
      `<span class="sr-switch">`+
        `<button class="sr-tab ${isLMU?'':'on'}" data-go="setup-ripple.html">ACC / AC Evo</button>`+
        `<button class="sr-tab ${isLMU?'on':''}" data-go="setup-ripple-lmu.html">LMU</button>`+
      `</span>`;
    document.body.insertBefore(bar, document.body.firstChild);
    bar.querySelector('.sr-home').addEventListener('click', ()=>{ location.href='launcher.html'; });
    bar.querySelectorAll('.sr-tab[data-go]').forEach(b=>{
      b.addEventListener('click', ()=>{ if(!b.classList.contains('on')) location.href = b.dataset.go; });
    });
  } catch (e) { /* no-op */ }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectShellBar);
} else {
  injectShellBar();
}

