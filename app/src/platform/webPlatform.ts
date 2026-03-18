import type {
  AudioDevice,
  FileFilter,
  Platform,
  PlatformAudio,
  PlatformFilesystem,
  PlatformLifecycle,
  PlatformMetadata,
  PlatformUpdater,
  UpdateStatus,
} from '@/platform/types';

const webFilesystem: PlatformFilesystem = {
  async saveFile(filename: string, blob: Blob, _filters?: FileFilter[]) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(link);
  },
};

class WebUpdater implements PlatformUpdater {
  private status: UpdateStatus = {
    checking: false,
    available: false,
    downloading: false,
    installing: false,
    readyToInstall: false,
  };

  private subscribers = new Set<(status: UpdateStatus) => void>();

  private notify() {
    this.subscribers.forEach((callback) => callback(this.status));
  }

  subscribe(callback: (status: UpdateStatus) => void): () => void {
    this.subscribers.add(callback);
    callback(this.status);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async checkForUpdates(): Promise<void> {
    this.notify();
  }

  async downloadAndInstall(): Promise<void> {}

  async restartAndInstall(): Promise<void> {}
}

const webAudio: PlatformAudio = {
  isSystemAudioSupported(): boolean {
    return false;
  },
  async startSystemAudioCapture(_maxDurationSecs: number): Promise<void> {
    throw new Error('System audio capture is only available in the desktop app.');
  },
  async stopSystemAudioCapture(): Promise<Blob> {
    throw new Error('System audio capture is only available in the desktop app.');
  },
  async listOutputDevices(): Promise<AudioDevice[]> {
    return [];
  },
  async playToDevices(_audioData: Uint8Array, _deviceIds: string[]): Promise<void> {
    throw new Error('Native audio device routing is only available in the desktop app.');
  },
  stopPlayback(): void {},
};

class WebLifecycle implements PlatformLifecycle {
  onServerReady?: () => void;

  async startServer(_remote = false): Promise<string> {
    const url = import.meta.env.VITE_SERVER_URL || 'http://127.0.0.1:17493';
    this.onServerReady?.();
    return url;
  }

  async stopServer(): Promise<void> {}

  async setKeepServerRunning(_keep: boolean): Promise<void> {}

  async setupWindowCloseHandler(): Promise<void> {}

  async openBroadcastOutputWindow(): Promise<void> {}

  async focusBroadcastOutputWindow(): Promise<void> {}

  async closeBroadcastOutputWindow(): Promise<void> {}
}

const webMetadata: PlatformMetadata = {
  async getVersion(): Promise<string> {
    return import.meta.env.VITE_APP_VERSION || '0.1.0';
  },
  isTauri: false,
};

export const webPlatform: Platform = {
  filesystem: webFilesystem,
  updater: new WebUpdater(),
  audio: webAudio,
  lifecycle: new WebLifecycle(),
  metadata: webMetadata,
};

