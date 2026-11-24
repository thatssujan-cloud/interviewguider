import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
} from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Prevents the window from stealing focus on macOS when clicked
    type: process.platform === 'darwin' ? 'panel' : 'normal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // CRITICAL: Excludes this window from Zoom, Teams, Meet & OS screenshots
  // Uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows
  // and NSWindow.sharingType = .none on macOS
  mainWindow.setContentProtection(true);

  // Keep overlay visible over full-screen apps on macOS
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Automatically grant system loopback audio when getDisplayMedia is called
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });

  mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
}

app.whenReady().then(() => {
  createWindow();

  // Global Hotkey: Capture screen for coding / OA problem solving
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    if (!mainWindow) return;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    if (sources[0]) {
      const base64Image = sources[0].thumbnail.toDataURL();
      mainWindow.webContents.send('screenshot-captured', base64Image);
    }
  });

  // Toggle click-through mode so you can interact with windows behind the overlay
  ipcMain.on('set-ignore-mouse', (_event, ignore: boolean) => {
    mainWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
