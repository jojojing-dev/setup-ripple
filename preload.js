const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let lastFolderPath = null;

// Shared folder walk — used by both pick() (with a dialog) and rescan() (silent).
function scanFolder(dirPath) {
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
}

// ── Folder bridge: finds BOTH LMU (.svm) and Kunos (.carsetup/.setup/.json) files ──
contextBridge.exposeInMainWorld('SetupRippleDir', {
  pick: async function () {
    const dirPath = await ipcRenderer.invoke('show-directory-picker');
    if (dirPath === null) throw new DOMException('The user aborted a request.', 'AbortError');
    lastFolderPath = dirPath;
    return scanFolder(dirPath);
  },
  // Re-read the folder the user already chose, with NO dialog. Powers the refresh button
  // and the automatic refresh after saving a setup.
  rescan: async function () {
    if (!lastFolderPath) return null;   // nothing chosen yet — caller should fall back to pick()
    return scanFolder(lastFolderPath);
  },
  canRescan: function () { return !!lastFolderPath; },
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
        display:flex;align-items:center;gap:14px;padding:0 12px;background:#0c0c0c;
        border-bottom:1px solid #2a2a2a;box-shadow:inset 0 -2px 6px rgba(0,0,0,.6);
        font-family:'Chakra Petch',sans-serif;font-weight:600;letter-spacing:.08em;text-transform:uppercase;}
      .sr-shellbar .sr-home{background:linear-gradient(#2b2b2b,#1c1c1c);border:1px solid #3a3a3a;color:#d6d8dc;border-radius:5px;
        width:32px;height:28px;cursor:pointer;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center;
        flex:0 0 auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 2px 0 #000;transition:transform .06s,box-shadow .06s;}
      .sr-shellbar .sr-home:hover{border-color:#0458A3;color:#fff}
      .sr-shellbar .sr-home:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 0 0 #000}
      .sr-shellbar .sr-brand{background:#e8112d;color:#fff;font-weight:700;font-size:13px;padding:5px 10px;border-radius:4px;flex:0 0 auto}
      .sr-shellbar .sr-switch{display:inline-flex;margin-left:auto;flex:0 0 auto;background:linear-gradient(#2b2b2b,#1c1c1c);
        border:1px solid #3a3a3a;border-radius:5px;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 2px 0 #000;overflow:hidden}
      .sr-shellbar .sr-tab{background:none;border:0;border-right:1px solid #000;color:#9a9a9a;padding:6px 13px;cursor:pointer;
        font-family:inherit;font-weight:600;font-size:12px;letter-spacing:.08em;text-transform:uppercase;line-height:1.4}
      .sr-shellbar .sr-tab:last-child{border-right:0}
      .sr-shellbar .sr-tab:hover{color:#fff}
      .sr-shellbar .sr-tab.on{color:#fff;background:#0c0c0c;box-shadow:inset 0 2px 6px rgba(0,0,0,.8),inset 0 -2px 0 #e8112d;cursor:default}
      body{padding-top:${BAR_H}px !important;}
      @media (prefers-reduced-motion:reduce){.sr-shellbar .sr-home{transition:none}}
    `;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'sr-shellbar';
    bar.innerHTML =
      `<button class="sr-home" title="Back to sim chooser">\u2302</button>`+
      `<span class="sr-brand">Setup Ripple</span>`+
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

