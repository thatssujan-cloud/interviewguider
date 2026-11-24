import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from 'electron';
import path from 'path';

/**
 * Interview & OA Copilot — Electron main process.
 *
 * Responsibilities:
 *  1. Own the frameless, transparent, always-on-top "stealth" overlay window.
 *  2. Keep that window invisible to Zoom / Teams / Meet screen-share and OS
 *     screenshots via setContentProtection(true).
 *  3. Register global hotkeys (screenshot capture + visibility/click-through).
 *  4. Auto-approve getDisplayMedia() so system loopback audio can be captured
 *     without ever showing a browser-style picker.
 */

let mainWindow: BrowserWindow | null = null;

// Overlay geometry: a narrow panel pinned to the right edge of the primary
// display so it never covers the interview video or the OA code editor.
const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 680;

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const preloadPath = path.join(__dirname, 'preload.js');

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: workArea.x + workArea.width - OVERLAY_WIDTH - 16,
    y: workArea.y + 16,
    minWidth: 360,
    minHeight: 420,
    show: false,
    frame: false, // borderless
    transparent: true, // lets the CSS glassmorphic panel be the only opaque paint
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true, // no taskbar / dock entry
    hasShadow: false,
    alwaysOnTop: true,
    // macOS: 'panel' => NSPanel non-activating style. The overlay can receive
    // mouse/keyboard input WITHOUT making our app the active application, so
    // the meeting window keeps its title-bar focus and the user's typing goes
    // to the interview tool, not to us.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  // Raise above fullscreen apps / screen-share bars.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setMenuBarVisibility(false);

  // CRITICAL STEALTH SETTING -------------------------------------------------
  // Windows: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
  // macOS:   NSWindow.sharingType = NSWindowSharingNone
  // The window renders normally on the physical monitor but is EXCLUDED from
  // every screen-capture API: Zoom/Teams/Meet/OBS share, Snip & Sketch,
  // Cmd+Shift+4, and remote-desktop mirrors.
  mainWindow.setContentProtection(true);

  // macOS: float over every Space AND over other apps' native fullscreen
  // (e.g. a fullscreen Zoom call), again without stealing key focus.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.showInactive());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Capture the primary display and hand a base64 PNG to the renderer. */
async function captureScreenAndSend(): Promise<void> {
  if (!mainWindow) return;

  const [primary] = screen.getAllDisplays();
  const bounds = primary?.bounds ?? { width: 1920, height: 1080, x: 0, y: 0 };

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(bounds.width * (primary?.scaleFactor ?? 1)),
      height: Math.round(bounds.height * (primary?.scaleFactor ?? 1)),
    },
  });

  const source =
    sources.find((s) => s.display_id === String(primary?.id ?? '')) ?? sources[0];

  if (!source) return;

  // data:image/png;base64,...  -> sent straight to Gemini as inlineData.
  const dataUrl = source.thumbnail.toDataURL();
  mainWindow.webContents.send('screenshot-captured', dataUrl);
}

/** Toggle between interactive mode and "click-through ghost" mode. */
function toggleOverlayMode(): void {
  if (!mainWindow) return;

  const nextVisible = !mainWindow.isVisible();

  if (nextVisible) {
    mainWindow.showInactive();
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    // Fully hidden fallback for users who want the overlay gone entirely.
    mainWindow.hide();
    return;
  }

  // Tell the renderer so it can update its UI state / opacity hint.
  mainWindow.webContents.send('overlay-mode-changed', { visible: nextVisible });
}

function registerShortcuts(): void {
  // ⌘/Ctrl + Shift + S  -> screenshot the screen, solve the OA problem.
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    void captureScreenAndSend();
  });

  // ⌘/Ctrl + Shift + H  -> show/hide + click-through toggle.
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleOverlayMode();
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance lock: re-launching focuses/reshows the existing overlay.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.showInactive();
      mainWindow.webContents.send('overlay-mode-changed', { visible: true });
    }
  });

  app.whenReady().then(() => {
    // Automatically grant getDisplayMedia() with the primary screen + SYSTEM
    // LOOPBACK AUDIO, so React can capture the interviewer's voice with zero
    // picker dialogs. Stopping the video track client-side leaves audio only.
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      },
      { useSystemPicker: false },
    );

    createWindow();
    registerShortcuts();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---------------------------------------------------------------------------
// IPC surface used by the renderer (exposed through the preload bridge)
// ---------------------------------------------------------------------------

ipcMain.handle('capture-screen', async () => {
  await captureScreenAndSend();
  return true;
});

ipcMain.handle('get-platform', () => process.platform);

ipcMain.on('set-ignore-mouse', (_event, ignore: boolean) => {
  // `forward: true` keeps hover effects alive on the windows underneath while
  // clicks pass through to them — the classic "ghost overlay" behaviour.
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('toggle-visibility', () => toggleOverlayMode());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
