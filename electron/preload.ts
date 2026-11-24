import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge — the ONLY surface the React renderer may use to talk to the
 * OS. `contextIsolation: true` + `nodeIntegration: false` mean the webpage has
 * zero Node access; we expose a small, whitelisted, typed API instead.
 */
const copilotAPI = {
  /** Fired by main when CommandOrControl+Shift+S is pressed (base64 PNG data URL). */
  onScreenshotCaptured(callback: (imageDataUrl: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on('screenshot-captured', listener);
    return () => ipcRenderer.removeListener('screenshot-captured', listener);
  },

  /** Fired when CommandOrControl+Shift+H toggles the overlay. */
  onOverlayModeChanged(
    callback: (state: { visible: boolean }) => void,
  ): () => void {
    const listener = (_e: Electron.IpcRendererEvent, state: { visible: boolean }) =>
      callback(state);
    ipcRenderer.on('overlay-mode-changed', listener);
    return () => ipcRenderer.removeListener('overlay-mode-changed', listener);
  },

  /** Ask main to capture the screen right now (button equivalent of the hotkey). */
  captureScreen(): Promise<boolean> {
    return ipcRenderer.invoke('capture-screen');
  },

  /** Click-through ("ghost") mode: forwards hover, lets clicks hit windows below. */
  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('set-ignore-mouse', ignore);
  },

  /** Toggle visibility/click-through without the keyboard (UI button). */
  toggleVisibility(): void {
    ipcRenderer.send('toggle-visibility');
  },

  platform: process.platform as string,
};

contextBridge.exposeInMainWorld('copilotAPI', copilotAPI);

export type CopilotAPI = typeof copilotAPI;
