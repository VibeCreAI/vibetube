import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getPersistedVibeTubeBackgroundImageData,
  loadPersistedVibeTubeBackgroundImageData,
  setPersistedVibeTubeBackgroundImageData,
  VIBETUBE_SETTING_KEYS,
} from '@/lib/utils/vibetubeSettings';
import { useUIStore } from '@/stores/uiStore';

export function VibeTubeTab() {
  const [fps, setFps] = usePersistedNumber(VIBETUBE_SETTING_KEYS.fps, 30);
  const [width, setWidth] = usePersistedNumber(VIBETUBE_SETTING_KEYS.width, 512);
  const [height, setHeight] = usePersistedNumber(VIBETUBE_SETTING_KEYS.height, 512);
  const [onThreshold, setOnThreshold] = usePersistedNumber(VIBETUBE_SETTING_KEYS.onThreshold, 0.024);
  const [offThreshold, setOffThreshold] = usePersistedNumber(VIBETUBE_SETTING_KEYS.offThreshold, 0.016);
  const [smoothingWindows, setSmoothingWindows] = usePersistedNumber(VIBETUBE_SETTING_KEYS.smoothingWindows, 3);
  const [minHoldWindows, setMinHoldWindows] = usePersistedNumber(VIBETUBE_SETTING_KEYS.minHoldWindows, 1);
  const [blinkMinIntervalSec, setBlinkMinIntervalSec] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.blinkMinIntervalSec,
    3.5,
  );
  const [blinkMaxIntervalSec, setBlinkMaxIntervalSec] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.blinkMaxIntervalSec,
    5.5,
  );
  const [blinkDurationFrames, setBlinkDurationFrames] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.blinkDurationFrames,
    3,
  );
  const [headMotionAmountPx, setHeadMotionAmountPx] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.headMotionAmountPx,
    3.0,
  );
  const [headMotionChangeSec, setHeadMotionChangeSec] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.headMotionChangeSec,
    2.8,
  );
  const [headMotionSmoothness, setHeadMotionSmoothness] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.headMotionSmoothness,
    0.04,
  );
  const [voiceBounceAmountPx, setVoiceBounceAmountPx] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.voiceBounceAmountPx,
    4.0,
  );
  const [voiceBounceSensitivity, setVoiceBounceSensitivity] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.voiceBounceSensitivity,
    1.0,
  );
  const [useBackgroundColor, setUseBackgroundColor] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.useBackgroundColor,
    false,
  );
  const [useBackgroundImage, setUseBackgroundImage] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.useBackgroundImage,
    false,
  );
  const [backgroundColor, setBackgroundColor] = usePersistedString(
    VIBETUBE_SETTING_KEYS.backgroundColor,
    '#101820',
  );
  const [backgroundImageFile, setBackgroundImageFile] = useState<File | null>(null);
  const [backgroundImagePreview, setBackgroundImagePreview] = useState<string | null>(null);
  const sharedBackgroundImageData = useUIStore((state) => state.vibetubeBackgroundImageData);
  const setSharedBackgroundImageData = useUIStore((state) => state.setVibetubeBackgroundImageData);

  useEffect(() => {
    let cancelled = false;
    const loadBackground = async () => {
      const persistedBg =
        sharedBackgroundImageData ||
        getPersistedVibeTubeBackgroundImageData() ||
        (await loadPersistedVibeTubeBackgroundImageData());
      if (cancelled || !persistedBg) return;
      setBackgroundImagePreview(persistedBg);
      try {
        setBackgroundImageFile(dataUrlToFile(persistedBg, 'vibetube-background.png'));
      } catch {
        setBackgroundImageFile(null);
      }
    };
    void loadBackground();
    return () => {
      cancelled = true;
    };
  }, [sharedBackgroundImageData]);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <section className="rounded-xl border bg-card/50 p-4 lg:p-6 space-y-3">
          <h2 className="text-xl font-semibold">VibeTube Render Settings</h2>
          <p className="text-sm text-muted-foreground">
            Global render settings used by Generate and Stories video rendering.
          </p>
        </section>

        <section className="rounded-xl border bg-card/50 p-4 lg:p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <NumberField
              label="FPS"
              description="Frames per second. Higher looks smoother but increases render work."
              value={fps}
              min={1}
              max={120}
              onChange={setFps}
            />
            <NumberField
              label="Width"
              description="Output video width in pixels."
              value={width}
              min={128}
              max={2048}
              onChange={setWidth}
            />
            <NumberField
              label="Height"
              description="Output video height in pixels."
              value={height}
              min={128}
              max={2048}
              onChange={setHeight}
            />
            <NumberField
              label="Smoothing"
              description="Moving-average window for mouth detection. Higher = steadier, slower mouth transitions."
              value={smoothingWindows}
              min={1}
              max={20}
              onChange={setSmoothingWindows}
            />
            <NumberField
              label="Min Hold"
              description="Minimum consecutive analysis windows required before state changes."
              value={minHoldWindows}
              min={1}
              max={20}
              onChange={setMinHoldWindows}
            />
            <NumberField
              label="Blink Frames"
              description="How many video frames each blink remains closed."
              value={blinkDurationFrames}
              min={1}
              max={12}
              onChange={setBlinkDurationFrames}
            />
            <DecimalField
              label="Talk ON"
              description="RMS threshold to switch mouth from idle to talking. Lower = more sensitive."
              value={onThreshold}
              min={0.001}
              max={0.5}
              step={0.001}
              onChange={setOnThreshold}
            />
            <DecimalField
              label="Talk OFF"
              description="RMS threshold to switch mouth from talking back to idle."
              value={offThreshold}
              min={0.001}
              max={0.5}
              step={0.001}
              onChange={setOffThreshold}
            />
            <DecimalField
              label="Blink Min (s)"
              description="Minimum seconds between blinks."
              value={blinkMinIntervalSec}
              min={0.2}
              max={20}
              step={0.1}
              onChange={setBlinkMinIntervalSec}
            />
            <DecimalField
              label="Blink Max (s)"
              description="Maximum seconds between blinks."
              value={blinkMaxIntervalSec}
              min={0.2}
              max={20}
              step={0.1}
              onChange={setBlinkMaxIntervalSec}
            />
            <DecimalField
              label="Head Move (px)"
              description="Maximum random head drift in pixels."
              value={headMotionAmountPx}
              min={0}
              max={24}
              step={0.5}
              onChange={setHeadMotionAmountPx}
            />
            <DecimalField
              label="Head Change (s)"
              description="How often a new head movement target is chosen."
              value={headMotionChangeSec}
              min={0.25}
              max={20}
              step={0.1}
              onChange={setHeadMotionChangeSec}
            />
            <DecimalField
              label="Head Smooth"
              description="How quickly movement approaches the target. Lower = slower, smoother drift."
              value={headMotionSmoothness}
              min={0.001}
              max={1}
              step={0.005}
              onChange={setHeadMotionSmoothness}
            />
            <DecimalField
              label="Voice Bounce (px)"
              description="Maximum up/down bounce amount driven by speech energy."
              value={voiceBounceAmountPx}
              min={0}
              max={40}
              step={0.25}
              onChange={setVoiceBounceAmountPx}
            />
            <DecimalField
              label="Bounce Sensitivity"
              description="How strongly speech energy drives bounce. Higher values react more."
              value={voiceBounceSensitivity}
              min={0.05}
              max={8}
              step={0.05}
              onChange={setVoiceBounceSensitivity}
            />
            <div className="space-y-1.5 col-span-1 md:col-span-2 lg:col-span-3">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="vibetube-use-background-color"
                    checked={useBackgroundColor}
                    onCheckedChange={(checked) => {
                      const isOn = checked === true;
                      setUseBackgroundColor(isOn);
                      if (isOn) {
                        setUseBackgroundImage(false);
                      }
                    }}
                  />
                  <label htmlFor="vibetube-use-background-color" className="text-sm cursor-pointer">
                    Add Background Color
                  </label>
                  <span
                    title="Enable a solid color background."
                    className="inline-flex text-muted-foreground cursor-help"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="vibetube-use-background-image"
                    checked={useBackgroundImage}
                    onCheckedChange={(checked) => {
                      const isOn = checked === true;
                      setUseBackgroundImage(isOn);
                      if (isOn) {
                        setUseBackgroundColor(false);
                      }
                    }}
                  />
                  <label htmlFor="vibetube-use-background-image" className="text-sm cursor-pointer">
                    Add Background Image
                  </label>
                  <span
                    title="Enable uploaded image/GIF background."
                    className="inline-flex text-muted-foreground cursor-help"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  className="h-10 w-16 p-1"
                  disabled={!useBackgroundColor}
                />
                <Input
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  placeholder="#101820"
                  disabled={!useBackgroundColor}
                  className="max-w-[140px]"
                />
              </div>
              <div className="space-y-2 pt-1">
                <Label className="text-xs text-muted-foreground">Background Image</Label>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={async (e) => {
                    const file = e.target.files?.[0] ?? null;
                    setBackgroundImageFile(file);
                    if (file) {
                      const dataUrl = await fileToDataUrl(file);
                      setBackgroundImagePreview(dataUrl);
                      setSharedBackgroundImageData(dataUrl);
                      setPersistedVibeTubeBackgroundImageData(dataUrl);
                    } else {
                      setBackgroundImagePreview(null);
                      setSharedBackgroundImageData('');
                      setPersistedVibeTubeBackgroundImageData('');
                    }
                  }}
                  disabled={!useBackgroundImage}
                />
                {backgroundImagePreview ? (
                  <div className="flex items-center gap-2">
                    <div className="h-16 w-24 rounded border bg-black/30 overflow-hidden">
                      <img
                        src={backgroundImagePreview}
                        alt="Background preview"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBackgroundImageFile(null);
                        setBackgroundImagePreview(null);
                        setSharedBackgroundImageData('');
                        setPersistedVibeTubeBackgroundImageData('');
                      }}
                      disabled={!useBackgroundImage}
                    >
                      Clear
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Lower ON/OFF thresholds make mouth opening more sensitive. Lower blink intervals increase blink frequency.
            Lower head change/smooth settings create slower, subtler motion. Increase bounce amount/sensitivity for more
            reactive PNGtuber motion.
          </p>
        </section>
      </div>
    </div>
  );
}

function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <span>{label}</span>
        <span title={description} className="inline-flex text-muted-foreground cursor-help">
          <Info className="h-3.5 w-3.5" />
        </span>
      </Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function DecimalField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <span>{label}</span>
        <span title={description} className="inline-flex text-muted-foreground cursor-help">
          <Info className="h-3.5 w-3.5" />
        </span>
      </Label>
      <Input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function usePersistedNumber(storageKey: string, defaultValue: number) {
  const [value, setValue] = useState<number>(() => {
    if (typeof window === 'undefined') {
      return defaultValue;
    }
    const raw = window.localStorage.getItem(storageKey);
    if (raw == null) {
      return defaultValue;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(value));
  }, [storageKey, value]);

  return [value, setValue] as const;
}

function usePersistedBoolean(storageKey: string, defaultValue: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return defaultValue;
    }
    const raw = window.localStorage.getItem(storageKey);
    if (raw == null) {
      return defaultValue;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return defaultValue;
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(value));
  }, [storageKey, value]);

  return [value, setValue] as const;
}

function usePersistedString(storageKey: string, defaultValue: string) {
  const [value, setValue] = useState<string>(() => {
    if (typeof window === 'undefined') {
      return defaultValue;
    }
    return window.localStorage.getItem(storageKey) ?? defaultValue;
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, value);
  }, [storageKey, value]);

  return [value, setValue] as const;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string): File {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL');
  }
  const mime = match[1];
  const b64 = match[2];
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: mime });
}
