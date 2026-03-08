import { useUIStore } from '@/stores/uiStore';

export interface VibeTubeRenderSettings {
  fps: number;
  resolution_preset: string;
  width: number;
  height: number;
  on_threshold: number;
  off_threshold: number;
  smoothing_windows: number;
  min_hold_windows: number;
  blink_min_interval_sec: number;
  blink_max_interval_sec: number;
  blink_duration_frames: number;
  head_motion_amount_px: number;
  head_motion_change_sec: number;
  head_motion_smoothness: number;
  voice_bounce_amount_px: number;
  voice_bounce_sensitivity: number;
  use_background_color: boolean;
  use_background_image: boolean;
  use_background: boolean;
  background_color: string;
  background_image_data: string;
  subtitle_enabled: boolean;
  subtitle_style: 'minimal' | 'cinema' | 'glass';
  subtitle_text_color: string;
  subtitle_outline_color: string;
  subtitle_outline_width: number;
  subtitle_font_family: 'sans' | 'serif' | 'mono';
  subtitle_bold: boolean;
  subtitle_italic: boolean;
  story_layout_style: 'balanced' | 'stage' | 'compact';
  show_profile_names: boolean;
}

export const VIBETUBE_SETTING_KEYS = {
  fps: 'vibetube.settings.fps',
  resolutionPreset: 'vibetube.settings.resolutionPreset',
  width: 'vibetube.settings.width',
  height: 'vibetube.settings.height',
  onThreshold: 'vibetube.settings.onThreshold',
  offThreshold: 'vibetube.settings.offThreshold',
  smoothingWindows: 'vibetube.settings.smoothingWindows',
  minHoldWindows: 'vibetube.settings.minHoldWindows',
  blinkMinIntervalSec: 'vibetube.settings.blinkMinIntervalSec',
  blinkMaxIntervalSec: 'vibetube.settings.blinkMaxIntervalSec',
  blinkDurationFrames: 'vibetube.settings.blinkDurationFrames',
  headMotionAmountPx: 'vibetube.settings.headMotionAmountPx',
  headMotionChangeSec: 'vibetube.settings.headMotionChangeSec',
  headMotionSmoothness: 'vibetube.settings.headMotionSmoothness',
  voiceBounceAmountPx: 'vibetube.settings.voiceBounceAmountPx',
  voiceBounceSensitivity: 'vibetube.settings.voiceBounceSensitivity',
  useBackgroundColor: 'vibetube.settings.useBackgroundColor',
  useBackgroundImage: 'vibetube.settings.useBackgroundImage',
  useBackground: 'vibetube.settings.useBackground',
  backgroundColor: 'vibetube.settings.backgroundColor',
  backgroundImageData: 'vibetube.settings.backgroundImageData',
  subtitleEnabled: 'vibetube.settings.subtitleEnabled',
  subtitleStyle: 'vibetube.settings.subtitleStyle',
  subtitleTextColor: 'vibetube.settings.subtitleTextColor',
  subtitleOutlineColor: 'vibetube.settings.subtitleOutlineColor',
  subtitleOutlineWidth: 'vibetube.settings.subtitleOutlineWidth',
  subtitleFontFamily: 'vibetube.settings.subtitleFontFamily',
  subtitleBold: 'vibetube.settings.subtitleBold',
  subtitleItalic: 'vibetube.settings.subtitleItalic',
  storyLayoutStyle: 'vibetube.settings.storyLayoutStyle',
  showProfileNames: 'vibetube.settings.showProfileNames',
} as const;

const BG_IMAGE_DB_NAME = 'vibetube-bg-db';
const BG_IMAGE_STORE = 'kv';
const BG_IMAGE_KEY = 'backgroundImageData';

export const DEFAULT_VIBETUBE_RENDER_SETTINGS: VibeTubeRenderSettings = {
  fps: 30,
  resolution_preset: 'square-512',
  width: 512,
  height: 512,
  on_threshold: 0.024,
  off_threshold: 0.016,
  smoothing_windows: 3,
  min_hold_windows: 1,
  blink_min_interval_sec: 3.5,
  blink_max_interval_sec: 5.5,
  blink_duration_frames: 3,
  head_motion_amount_px: 3.0,
  head_motion_change_sec: 2.8,
  head_motion_smoothness: 0.04,
  voice_bounce_amount_px: 4.0,
  voice_bounce_sensitivity: 1.0,
  use_background_color: false,
  use_background_image: false,
  use_background: false,
  background_color: '#101820',
  background_image_data: '',
  subtitle_enabled: false,
  subtitle_style: 'minimal',
  subtitle_text_color: '#FFFFFF',
  subtitle_outline_color: '#000000',
  subtitle_outline_width: 2,
  subtitle_font_family: 'sans',
  subtitle_bold: true,
  subtitle_italic: false,
  story_layout_style: 'balanced',
  show_profile_names: true,
};

function readNumber(storageKey: string, fallback: number): number {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const raw = window.localStorage.getItem(storageKey);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(storageKey: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const raw = window.localStorage.getItem(storageKey);
  if (raw == null) {
    return fallback;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function readString(storageKey: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const raw = window.localStorage.getItem(storageKey);
  return raw == null ? fallback : raw;
}

function openBackgroundDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = window.indexedDB.open(BG_IMAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BG_IMAGE_STORE)) {
        db.createObjectStore(BG_IMAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function idbSetBackgroundImageData(value: string): Promise<void> {
  try {
    const db = await openBackgroundDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BG_IMAGE_STORE, 'readwrite');
      const store = tx.objectStore(BG_IMAGE_STORE);
      store.put(value, BG_IMAGE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Failed to write background image to IndexedDB'));
    });
    db.close();
  } catch {
    // Ignore IndexedDB failures; app can still work with in-memory state.
  }
}

async function idbGetBackgroundImageData(): Promise<string> {
  try {
    const db = await openBackgroundDb();
    const result = await new Promise<string>((resolve, reject) => {
      const tx = db.transaction(BG_IMAGE_STORE, 'readonly');
      const store = tx.objectStore(BG_IMAGE_STORE);
      const req = store.get(BG_IMAGE_KEY);
      req.onsuccess = () => resolve((req.result as string) ?? '');
      req.onerror = () =>
        reject(req.error ?? new Error('Failed to read background image from IndexedDB'));
    });
    db.close();
    return result;
  } catch {
    return '';
  }
}

export function getPersistedVibeTubeRenderSettings(): VibeTubeRenderSettings {
  const useBackgroundColor = readBoolean(
    VIBETUBE_SETTING_KEYS.useBackgroundColor,
    DEFAULT_VIBETUBE_RENDER_SETTINGS.use_background_color,
  );
  const useBackgroundImage = readBoolean(
    VIBETUBE_SETTING_KEYS.useBackgroundImage,
    DEFAULT_VIBETUBE_RENDER_SETTINGS.use_background_image,
  );

  return {
    fps: readNumber(VIBETUBE_SETTING_KEYS.fps, DEFAULT_VIBETUBE_RENDER_SETTINGS.fps),
    resolution_preset: readString(
      VIBETUBE_SETTING_KEYS.resolutionPreset,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.resolution_preset,
    ),
    width: readNumber(VIBETUBE_SETTING_KEYS.width, DEFAULT_VIBETUBE_RENDER_SETTINGS.width),
    height: readNumber(VIBETUBE_SETTING_KEYS.height, DEFAULT_VIBETUBE_RENDER_SETTINGS.height),
    on_threshold: readNumber(
      VIBETUBE_SETTING_KEYS.onThreshold,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.on_threshold,
    ),
    off_threshold: readNumber(
      VIBETUBE_SETTING_KEYS.offThreshold,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.off_threshold,
    ),
    smoothing_windows: readNumber(
      VIBETUBE_SETTING_KEYS.smoothingWindows,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.smoothing_windows,
    ),
    min_hold_windows: readNumber(
      VIBETUBE_SETTING_KEYS.minHoldWindows,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.min_hold_windows,
    ),
    blink_min_interval_sec: readNumber(
      VIBETUBE_SETTING_KEYS.blinkMinIntervalSec,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.blink_min_interval_sec,
    ),
    blink_max_interval_sec: readNumber(
      VIBETUBE_SETTING_KEYS.blinkMaxIntervalSec,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.blink_max_interval_sec,
    ),
    blink_duration_frames: readNumber(
      VIBETUBE_SETTING_KEYS.blinkDurationFrames,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.blink_duration_frames,
    ),
    head_motion_amount_px: readNumber(
      VIBETUBE_SETTING_KEYS.headMotionAmountPx,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.head_motion_amount_px,
    ),
    head_motion_change_sec: readNumber(
      VIBETUBE_SETTING_KEYS.headMotionChangeSec,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.head_motion_change_sec,
    ),
    head_motion_smoothness: readNumber(
      VIBETUBE_SETTING_KEYS.headMotionSmoothness,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.head_motion_smoothness,
    ),
    voice_bounce_amount_px: readNumber(
      VIBETUBE_SETTING_KEYS.voiceBounceAmountPx,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.voice_bounce_amount_px,
    ),
    voice_bounce_sensitivity: readNumber(
      VIBETUBE_SETTING_KEYS.voiceBounceSensitivity,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.voice_bounce_sensitivity,
    ),
    use_background_color: useBackgroundColor,
    use_background_image: useBackgroundImage,
    use_background: useBackgroundColor || useBackgroundImage,
    background_color: readString(
      VIBETUBE_SETTING_KEYS.backgroundColor,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.background_color,
    ),
    background_image_data: getPersistedVibeTubeBackgroundImageData(),
    subtitle_enabled: readBoolean(
      VIBETUBE_SETTING_KEYS.subtitleEnabled,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_enabled,
    ),
    subtitle_style: readString(
      VIBETUBE_SETTING_KEYS.subtitleStyle,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_style,
    ) as VibeTubeRenderSettings['subtitle_style'],
    subtitle_text_color: readString(
      VIBETUBE_SETTING_KEYS.subtitleTextColor,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_text_color,
    ),
    subtitle_outline_color: readString(
      VIBETUBE_SETTING_KEYS.subtitleOutlineColor,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_outline_color,
    ),
    subtitle_outline_width: readNumber(
      VIBETUBE_SETTING_KEYS.subtitleOutlineWidth,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_outline_width,
    ),
    subtitle_font_family: readString(
      VIBETUBE_SETTING_KEYS.subtitleFontFamily,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_font_family,
    ) as VibeTubeRenderSettings['subtitle_font_family'],
    subtitle_bold: readBoolean(
      VIBETUBE_SETTING_KEYS.subtitleBold,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_bold,
    ),
    subtitle_italic: readBoolean(
      VIBETUBE_SETTING_KEYS.subtitleItalic,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.subtitle_italic,
    ),
    story_layout_style: readString(
      VIBETUBE_SETTING_KEYS.storyLayoutStyle,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.story_layout_style,
    ) as VibeTubeRenderSettings['story_layout_style'],
    show_profile_names: readBoolean(
      VIBETUBE_SETTING_KEYS.showProfileNames,
      DEFAULT_VIBETUBE_RENDER_SETTINGS.show_profile_names,
    ),
  };
}

export function setPersistedVibeTubeBackgroundImageData(value: string): void {
  useUIStore.getState().setVibetubeBackgroundImageData(value);
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(VIBETUBE_SETTING_KEYS.backgroundImageData, value);
  } catch {
    // Ignore storage quota failures; in-memory store still preserves it for this app session.
  }
  void idbSetBackgroundImageData(value);
}

export function getPersistedVibeTubeBackgroundImageData(): string {
  const inMemory = useUIStore.getState().vibetubeBackgroundImageData;
  if (inMemory) {
    return inMemory;
  }
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(VIBETUBE_SETTING_KEYS.backgroundImageData) ?? '';
}

export async function loadPersistedVibeTubeBackgroundImageData(): Promise<string> {
  const inMemory = useUIStore.getState().vibetubeBackgroundImageData;
  if (inMemory) {
    return inMemory;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const fromLocalStorage =
    window.localStorage.getItem(VIBETUBE_SETTING_KEYS.backgroundImageData) ?? '';
  if (fromLocalStorage) {
    useUIStore.getState().setVibetubeBackgroundImageData(fromLocalStorage);
    return fromLocalStorage;
  }

  const fromIndexedDb = await idbGetBackgroundImageData();
  if (fromIndexedDb) {
    useUIStore.getState().setVibetubeBackgroundImageData(fromIndexedDb);
    try {
      window.localStorage.setItem(VIBETUBE_SETTING_KEYS.backgroundImageData, fromIndexedDb);
    } catch {
      // Ignore localStorage write failure.
    }
  }
  return fromIndexedDb;
}

export function getPersistedVibeTubeBackgroundImageFile(
  fileName = 'vibetube-background.png',
): File | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const dataUrl = getPersistedVibeTubeBackgroundImageData();
  if (!dataUrl) {
    return undefined;
  }
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }
  try {
    const mime = match[1];
    const b64 = match[2];
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], fileName, { type: mime });
  } catch {
    return undefined;
  }
}

export async function getPersistedVibeTubeBackgroundImageFileAsync(
  fileName = 'vibetube-background.png',
): Promise<File | undefined> {
  const dataUrl = await loadPersistedVibeTubeBackgroundImageData();
  if (!dataUrl) {
    return undefined;
  }
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }
  try {
    const mime = match[1];
    const b64 = match[2];
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], fileName, { type: mime });
  } catch {
    return undefined;
  }
}
