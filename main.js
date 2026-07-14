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

ipcMain.handle('show-directory-picker', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Select your setups folder',
    properties: ['openDirectory']
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// Save a setup file beside its source. isEvo=true for binary (.carsetup); else text (.svm/.json).
ipcMain.handle('save-setup-file', async (event, sourcePath, newFileName, data, isEvo) => {
  try {
    let dir;
    if (sourcePath) {
      dir = path.dirname(sourcePath);
    } else {
      const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Choose where to save the setup',
        properties: ['openDirectory']
      });
      if (canceled || !filePaths.length) return { ok: false, error: 'cancelled' };
      dir = filePaths[0];
    }
    const target = path.join(dir, newFileName);
    if (isEvo) {
      fs.writeFileSync(target, Buffer.from(data));
    } else {
      fs.writeFileSync(target, data, 'utf-8');
    }
    return { ok: true, path: target };
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
