import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('copilotAPI', {
  onScreenshotCaptured: (callback: (imageDataUrl: string) => void) => {
    ipcRenderer.on('screenshot-captured', (_event, data) => callback(data));
  },
  setIgnoreMouse: (ignore: boolean) => {
    ipcRenderer.send('set-ignore-mouse', ignore);
  },
});
