const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile('launcher.html');
  win.webContents.on('did-finish-load', () => {
    win.setTitle('Setup Ripple');
  });
}

// Only use a remembered folder as a starting point if it still exists.
function startDir(p) {
  try { return (typeof p === 'string' && p && fs.existsSync(p)) ? p : undefined; } catch (e) { return undefined; }
}

ipcMain.handle('show-directory-picker', async (event, defaultPath) => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Select your setups folder',
    defaultPath: startDir(defaultPath),
    properties: ['openDirectory']
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// Native multi-file picker, so the app knows where each added file lives and can save beside it.
ipcMain.handle('show-file-picker', async (event, defaultPath, exts) => {
  const allowed = ['svm', 'json', 'carsetup', 'setup'];
  const list = (Array.isArray(exts) ? exts : []).filter(e => allowed.includes(e));
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Add setup files',
    defaultPath: startDir(defaultPath),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Setup files', extensions: list.length ? list : allowed }]
  });
  return canceled ? [] : filePaths;
});

// Save a setup file beside its source. isEvo=true for binary (.carsetup); else text (.svm/.json).
// Pick a file name that doesn't exist yet in dir. Only the last path segment of the requested name is used.
function freeTarget(dir, requested) {
  const safe = path.basename(String(requested || 'setup'));
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length).replace(/_SR\d*$/i, '');
  let name = safe, n = 1;
  while (fs.existsSync(path.join(dir, name))) { n++; name = stem + '_SR' + n + ext; }
  return { target: path.join(dir, name), name };
}

ipcMain.handle('save-setup-file', async (event, sourcePath, newFileName, data, isEvo, defaultPath) => {
  try {
    let dir;
    if (sourcePath) {
      dir = path.dirname(sourcePath);
    } else {
      const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Choose where to save the setup',
        defaultPath: startDir(defaultPath),
        properties: ['openDirectory']
      });
      if (canceled || !filePaths.length) return { ok: false, error: 'cancelled' };
      dir = filePaths[0];
    }
    // Stay inside the folder, and never overwrite: if the name is taken on disk (even by a file the
    // app hasn't loaded), use the next free _SR number. Report the real name back.
    const { target, name } = freeTarget(dir, newFileName);
    if (isEvo) {
      fs.writeFileSync(target, Buffer.from(data), { flag: 'wx' });
    } else {
      fs.writeFileSync(target, data, { encoding: 'utf-8', flag: 'wx' });
    }
    return { ok: true, path: target, name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
