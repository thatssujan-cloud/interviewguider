/** Ambient typing for the API exposed by electron/preload.ts. */
export interface OverlayState {
  visible: boolean;
}

declare global {
  interface Window {
    copilotAPI?: {
      onScreenshotCaptured: (cb: (imageDataUrl: string) => void) => () => void;
      onOverlayModeChanged: (cb: (state: OverlayState) => void) => () => void;
      captureScreen: () => Promise<boolean>;
      setIgnoreMouse: (ignore: boolean) => void;
      toggleVisibility: () => void;
      platform: string;
    };
  }
}

export {};
