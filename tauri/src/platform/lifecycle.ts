import { invoke } from '@tauri-apps/api/core';
import { UserAttentionType, availableMonitors, currentMonitor } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { PlatformLifecycle } from '@/platform/types';

const BROADCAST_OUTPUT_LABEL = 'broadcast-output';
const BROADCAST_OUTPUT_BOUNDS_KEY = 'broadcast.output.bounds';
const BROADCAST_OUTPUT_TITLE = 'Broadcast Output';
const BROADCAST_OUTPUT_LOCATOR_TITLE = 'OUTPUT HERE';
const DEFAULT_BROADCAST_OUTPUT_WIDTH = 900;
const DEFAULT_BROADCAST_OUTPUT_HEIGHT = 900;
const MIN_BROADCAST_OUTPUT_WIDTH = 320;
const MIN_BROADCAST_OUTPUT_HEIGHT = 320;

interface BroadcastWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeBounds(bounds: Partial<BroadcastWindowBounds>): BroadcastWindowBounds | null {
  if (
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height)
  ) {
    return null;
  }

  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_BROADCAST_OUTPUT_WIDTH, Math.round(bounds.width)),
    height: Math.max(MIN_BROADCAST_OUTPUT_HEIGHT, Math.round(bounds.height)),
  };
}

function readStoredBroadcastBounds(): BroadcastWindowBounds | null {
  try {
    const raw = window.localStorage.getItem(BROADCAST_OUTPUT_BOUNDS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<BroadcastWindowBounds>;
    return normalizeBounds(parsed);
  } catch {
    return null;
  }
}

function writeStoredBroadcastBounds(bounds: BroadcastWindowBounds): void {
  window.localStorage.setItem(BROADCAST_OUTPUT_BOUNDS_KEY, JSON.stringify(bounds));
}

function intersects(
  left: BroadcastWindowBounds,
  right: BroadcastWindowBounds,
): boolean {
  const xOverlap = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const yOverlap =
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return xOverlap > 0 && yOverlap > 0;
}

async function resolveDefaultBroadcastBounds(): Promise<BroadcastWindowBounds> {
  const monitor = await currentMonitor();
  if (!monitor) {
    return {
      x: 120,
      y: 120,
      width: DEFAULT_BROADCAST_OUTPUT_WIDTH,
      height: DEFAULT_BROADCAST_OUTPUT_HEIGHT,
    };
  }

  const scaleFactor = monitor.scaleFactor || 1;
  const workArea = {
    x: monitor.workArea.position.x / scaleFactor,
    y: monitor.workArea.position.y / scaleFactor,
    width: monitor.workArea.size.width / scaleFactor,
    height: monitor.workArea.size.height / scaleFactor,
  };
  const width = Math.min(DEFAULT_BROADCAST_OUTPUT_WIDTH, Math.round(workArea.width));
  const height = Math.min(DEFAULT_BROADCAST_OUTPUT_HEIGHT, Math.round(workArea.height));

  return {
    x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
    width: Math.max(MIN_BROADCAST_OUTPUT_WIDTH, width),
    height: Math.max(MIN_BROADCAST_OUTPUT_HEIGHT, height),
  };
}

async function resolveRestoredBroadcastBounds(): Promise<BroadcastWindowBounds> {
  const stored = readStoredBroadcastBounds();
  if (!stored) {
    return resolveDefaultBroadcastBounds();
  }

  const monitors = await availableMonitors();
  if (!monitors.length) {
    return stored;
  }

  const visibleOnMonitor = monitors.some((monitor) => {
    const scaleFactor = monitor.scaleFactor || 1;
    const logicalWorkArea: BroadcastWindowBounds = {
      x: monitor.workArea.position.x / scaleFactor,
      y: monitor.workArea.position.y / scaleFactor,
      width: monitor.workArea.size.width / scaleFactor,
      height: monitor.workArea.size.height / scaleFactor,
    };
    return intersects(stored, logicalWorkArea);
  });

  return visibleOnMonitor ? stored : resolveDefaultBroadcastBounds();
}

async function saveBroadcastWindowBounds(windowRef: WebviewWindow): Promise<void> {
  const [position, size, scaleFactor] = await Promise.all([
    windowRef.outerPosition(),
    windowRef.outerSize(),
    windowRef.scaleFactor(),
  ]);

  writeStoredBroadcastBounds({
    x: Math.round(position.x / scaleFactor),
    y: Math.round(position.y / scaleFactor),
    width: Math.round(size.width / scaleFactor),
    height: Math.round(size.height / scaleFactor),
  });
}

class TauriLifecycle implements PlatformLifecycle {
  onServerReady?: () => void;
  private broadcastOutputLocatorResetTimer: number | null = null;

  async startServer(remote = false): Promise<string> {
    try {
      const result = await invoke<string>('start_server', { remote });
      console.log('Server started:', result);
      this.onServerReady?.();
      return result;
    } catch (error) {
      console.error('Failed to start server:', error);
      throw error;
    }
  }

  async stopServer(): Promise<void> {
    try {
      await invoke('stop_server');
      console.log('Server stopped');
    } catch (error) {
      console.error('Failed to stop server:', error);
      throw error;
    }
  }

  async setKeepServerRunning(keepRunning: boolean): Promise<void> {
    try {
      await invoke('set_keep_server_running', { keepRunning });
    } catch (error) {
      console.error('Failed to set keep server running setting:', error);
    }
  }

  async setupWindowCloseHandler(): Promise<void> {
    try {
      await listen<null>('window-close-requested', async () => {
        const { useServerStore } = await import('@/stores/serverStore');
        const keepRunning = useServerStore.getState().keepServerRunningOnClose;

        // @ts-expect-error - accessing module-level variable from another module
        const serverStartedByApp = window.__vibetubeServerStartedByApp ?? false;

        if (!keepRunning && serverStartedByApp) {
          try {
            await this.stopServer();
          } catch (error) {
            console.error('Failed to stop server on close:', error);
          }
        }

        await emit('window-close-allowed');
      });
    } catch (error) {
      console.error('Failed to setup window close handler:', error);
    }
  }

  async openBroadcastOutputWindow(): Promise<void> {
    const existing = await WebviewWindow.getByLabel(BROADCAST_OUTPUT_LABEL);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }

    const url = `${window.location.origin}/?broadcastOutput=1`;
    const bounds = await resolveRestoredBroadcastBounds();
    const broadcastWindow = new WebviewWindow(BROADCAST_OUTPUT_LABEL, {
      url,
      title: BROADCAST_OUTPUT_TITLE,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_BROADCAST_OUTPUT_WIDTH,
      minHeight: MIN_BROADCAST_OUTPUT_HEIGHT,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      shadow: false,
      resizable: true,
      focus: true,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      void broadcastWindow.once('tauri://created', async () => {
        if (settled) return;
        settled = true;
        try {
          await broadcastWindow.setFocus();
        } catch (error) {
          console.warn('Broadcast output window focus warning:', error);
        }
        resolve();
      });

      void broadcastWindow.once('tauri://error', (event) => {
        if (settled) return;
        settled = true;
        reject(event.payload);
      });
    });
  }

  async focusBroadcastOutputWindow(): Promise<void> {
    const existing = await WebviewWindow.getByLabel(BROADCAST_OUTPUT_LABEL);
    if (!existing) {
      return;
    }

    await existing.unminimize().catch(() => {});
    await existing.show();
    await existing.setDecorations(true).catch(() => {});
    await existing.setShadow(true).catch(() => {});
    await existing.setTitle(BROADCAST_OUTPUT_LOCATOR_TITLE).catch(() => {});
    await existing.requestUserAttention(UserAttentionType.Critical).catch(() => {});

    if (this.broadcastOutputLocatorResetTimer !== null) {
      window.clearTimeout(this.broadcastOutputLocatorResetTimer);
    }

    this.broadcastOutputLocatorResetTimer = window.setTimeout(() => {
      this.broadcastOutputLocatorResetTimer = null;
      void existing.requestUserAttention(null).catch(() => {});
      void existing.setTitle(BROADCAST_OUTPUT_TITLE).catch(() => {});
      void existing.setDecorations(false).catch(() => {});
      void existing.setShadow(false).catch(() => {});
    }, 2200);
  }

  async closeBroadcastOutputWindow(): Promise<void> {
    const existing = await WebviewWindow.getByLabel(BROADCAST_OUTPUT_LABEL);
    if (existing) {
      await saveBroadcastWindowBounds(existing);
    }
    await invoke('destroy_window_by_label', { label: BROADCAST_OUTPUT_LABEL });
  }
}

export const tauriLifecycle = new TauriLifecycle();
