import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getPersistedVibeTubeBackgroundImageData,
  loadPersistedVibeTubeBackgroundImageData,
  setPersistedVibeTubeBackgroundImageData,
  VIBETUBE_SETTING_KEYS,
} from '@/lib/utils/vibetubeSettings';
import { useUIStore } from '@/stores/uiStore';

const RESOLUTION_PRESETS = [
  { value: 'square-512', label: 'Square 512', width: 512, height: 512 },
  { value: 'portrait-720', label: '720p Portrait', width: 720, height: 1280 },
  { value: 'landscape-720', label: '720p Landscape', width: 1280, height: 720 },
  { value: 'portrait-1080', label: '1080p Portrait', width: 1080, height: 1920 },
  { value: 'landscape-1080', label: '1080p Landscape', width: 1920, height: 1080 },
  { value: 'square-1080', label: 'Square 1080', width: 1080, height: 1080 },
  { value: 'custom', label: 'Custom', width: 0, height: 0 },
] as const;

export function VibeTubeTab() {
  const [fps, setFps] = usePersistedNumber(VIBETUBE_SETTING_KEYS.fps, 30);
  const [resolutionPreset, setResolutionPreset] = usePersistedString(
    VIBETUBE_SETTING_KEYS.resolutionPreset,
    'square-512',
  );
  const [width, setWidth] = usePersistedNumber(VIBETUBE_SETTING_KEYS.width, 512);
  const [height, setHeight] = usePersistedNumber(VIBETUBE_SETTING_KEYS.height, 512);
  const [onThreshold, setOnThreshold] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.onThreshold,
    0.024,
  );
  const [offThreshold, setOffThreshold] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.offThreshold,
    0.016,
  );
  const [smoothingWindows, setSmoothingWindows] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.smoothingWindows,
    3,
  );
  const [minHoldWindows, setMinHoldWindows] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.minHoldWindows,
    1,
  );
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
  const [subtitleEnabled, setSubtitleEnabled] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.subtitleEnabled,
    false,
  );
  const [subtitleStyle, setSubtitleStyle] = usePersistedString(
    VIBETUBE_SETTING_KEYS.subtitleStyle,
    'minimal',
  );
  const [subtitleTextColor, setSubtitleTextColor] = usePersistedString(
    VIBETUBE_SETTING_KEYS.subtitleTextColor,
    '#FFFFFF',
  );
  const [subtitleOutlineColor, setSubtitleOutlineColor] = usePersistedString(
    VIBETUBE_SETTING_KEYS.subtitleOutlineColor,
    '#000000',
  );
  const [subtitleOutlineWidth, setSubtitleOutlineWidth] = usePersistedNumber(
    VIBETUBE_SETTING_KEYS.subtitleOutlineWidth,
    2,
  );
  const [subtitleFontFamily, setSubtitleFontFamily] = usePersistedString(
    VIBETUBE_SETTING_KEYS.subtitleFontFamily,
    'sans',
  );
  const [subtitleBold, setSubtitleBold] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.subtitleBold,
    true,
  );
  const [subtitleItalic, setSubtitleItalic] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.subtitleItalic,
    false,
  );
  const [storyLayoutStyle, setStoryLayoutStyle] = usePersistedString(
    VIBETUBE_SETTING_KEYS.storyLayoutStyle,
    'balanced',
  );
  const [showProfileNames, setShowProfileNames] = usePersistedBoolean(
    VIBETUBE_SETTING_KEYS.showProfileNames,
    true,
  );
  const [, setBackgroundImageFile] = useState<File | null>(null);
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

  useEffect(() => {
    const preset = RESOLUTION_PRESETS.find((option) => option.value === resolutionPreset);
    if (!preset || preset.value === 'custom') {
      return;
    }
    if (width !== preset.width) {
      setWidth(preset.width);
    }
    if (height !== preset.height) {
      setHeight(preset.height);
    }
  }, [height, resolutionPreset, setHeight, setWidth, width]);

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
            <div className="space-y-1.5 md:col-span-2">
              <Label className="flex items-center gap-1.5">
                <span>Resolution</span>
                <span
                  title="Pick a common output size or switch to custom dimensions."
                  className="inline-flex text-muted-foreground cursor-help"
                >
                  <Info className="h-3.5 w-3.5" />
                </span>
              </Label>
              <div className="grid gap-3 md:grid-cols-[220px,1fr]">
                <Select value={resolutionPreset} onValueChange={setResolutionPreset}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a resolution" />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTION_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Width"
                    description="Output video width in pixels."
                    value={width}
                    min={128}
                    max={4096}
                    onChange={(value) => {
                      setWidth(value);
                      setResolutionPreset('custom');
                    }}
                    disabled={resolutionPreset !== 'custom'}
                  />
                  <NumberField
                    label="Height"
                    description="Output video height in pixels."
                    value={height}
                    min={128}
                    max={4096}
                    onChange={(value) => {
                      setHeight(value);
                      setResolutionPreset('custom');
                    }}
                    disabled={resolutionPreset !== 'custom'}
                  />
                </div>
              </div>
            </div>
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
            <div className="space-y-1.5 col-span-1 md:col-span-2 lg:col-span-3 rounded-lg border border-border/60 bg-background/40 p-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5">
                  <span>Story Layout Style</span>
                  <span
                    title="Choose how multiple characters are arranged in story renders."
                    className="inline-flex text-muted-foreground cursor-help"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  Applies to story renders and bulk auto-render. Single-avatar renders are not
                  affected.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-[240px,1fr]">
                <div className="space-y-1.5">
                  <Select value={storyLayoutStyle} onValueChange={setStoryLayoutStyle}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a story layout" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="balanced">Balanced</SelectItem>
                      <SelectItem value="stage">Stage</SelectItem>
                      <SelectItem value="compact">Compact</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                  <p>
                    `Balanced` spreads characters evenly. `Stage` favors a wider cast lineup and a
                    lead centered composition. `Compact` keeps avatars smaller and tighter to
                    preserve more background.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-3">
                <Checkbox
                  id="vibetube-show-profile-names"
                  checked={showProfileNames}
                  onCheckedChange={(checked) => setShowProfileNames(checked === true)}
                />
                <label htmlFor="vibetube-show-profile-names" className="text-sm cursor-pointer">
                  Show profile names under avatars
                </label>
              </div>
            </div>
            <div className="space-y-1.5 col-span-1 md:col-span-2 lg:col-span-3 rounded-lg border border-border/60 bg-background/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5">
                    <span>Burned-In Subtitles</span>
                    <span
                      title="Draw subtitles into the rendered video while still keeping SRT export available."
                      className="inline-flex text-muted-foreground cursor-help"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Applies to single renders, story renders, and bulk auto-render.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="vibetube-subtitle-enabled"
                    checked={subtitleEnabled}
                    onCheckedChange={(checked) => setSubtitleEnabled(checked === true)}
                  />
                  <label htmlFor="vibetube-subtitle-enabled" className="text-sm cursor-pointer">
                    Show subtitles in video
                  </label>
                </div>
              </div>
              <div className="grid gap-4 pt-3 lg:grid-cols-[320px,1fr]">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>Subtitle Style</Label>
                    <Select
                      value={subtitleStyle}
                      onValueChange={setSubtitleStyle}
                      disabled={!subtitleEnabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a subtitle style" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minimal">Minimal</SelectItem>
                        <SelectItem value="cinema">Cinema</SelectItem>
                        <SelectItem value="glass">Glass</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Font</Label>
                    <Select
                      value={subtitleFontFamily}
                      onValueChange={setSubtitleFontFamily}
                      disabled={!subtitleEnabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a subtitle font" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sans">Sans</SelectItem>
                        <SelectItem value="serif">Serif</SelectItem>
                        <SelectItem value="mono">Mono</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ColorField
                      label="Text Color"
                      value={subtitleTextColor}
                      onChange={setSubtitleTextColor}
                      disabled={!subtitleEnabled}
                    />
                    <ColorField
                      label="Outline Color"
                      value={subtitleOutlineColor}
                      onChange={setSubtitleOutlineColor}
                      disabled={!subtitleEnabled}
                    />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="vibetube-subtitle-bold"
                        checked={subtitleBold}
                        onCheckedChange={(checked) => setSubtitleBold(checked === true)}
                        disabled={!subtitleEnabled}
                      />
                      <label htmlFor="vibetube-subtitle-bold" className="text-sm cursor-pointer">
                        Bold
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="vibetube-subtitle-italic"
                        checked={subtitleItalic}
                        onCheckedChange={(checked) => setSubtitleItalic(checked === true)}
                        disabled={!subtitleEnabled}
                      />
                      <label htmlFor="vibetube-subtitle-italic" className="text-sm cursor-pointer">
                        Italic
                      </label>
                    </div>
                  </div>
                  <NumberField
                    label="Outline Width"
                    description="Thickness of the subtitle outline in pixels."
                    value={subtitleOutlineWidth}
                    min={0}
                    max={12}
                    onChange={setSubtitleOutlineWidth}
                    disabled={!subtitleEnabled}
                  />
                </div>
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                    <p>
                      `Minimal` keeps only outlined text. `Cinema` adds a dark lower-third pill.
                      `Glass` uses a translucent panel with a brighter caption look.
                    </p>
                  </div>
                  <SubtitlePreview
                    width={width}
                    height={height}
                    subtitleEnabled={subtitleEnabled}
                    subtitleStyle={subtitleStyle as 'minimal' | 'cinema' | 'glass'}
                    subtitleTextColor={subtitleTextColor}
                    subtitleOutlineColor={subtitleOutlineColor}
                    subtitleOutlineWidth={subtitleOutlineWidth}
                    subtitleFontFamily={subtitleFontFamily as 'sans' | 'serif' | 'mono'}
                    subtitleBold={subtitleBold}
                    subtitleItalic={subtitleItalic}
                  />
                </div>
              </div>
            </div>
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
            Lower ON/OFF thresholds make mouth opening more sensitive. Lower blink intervals
            increase blink frequency. Lower head change/smooth settings create slower, subtler
            motion. Increase bounce amount/sensitivity for more reactive PNGtuber motion.
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
  disabled = false,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
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
        disabled={disabled}
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

function ColorField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-16 p-1"
          disabled={disabled}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    </div>
  );
}

function SubtitlePreview({
  width,
  height,
  subtitleEnabled,
  subtitleStyle,
  subtitleTextColor,
  subtitleOutlineColor,
  subtitleOutlineWidth,
  subtitleFontFamily,
  subtitleBold,
  subtitleItalic,
}: {
  width: number;
  height: number;
  subtitleEnabled: boolean;
  subtitleStyle: 'minimal' | 'cinema' | 'glass';
  subtitleTextColor: string;
  subtitleOutlineColor: string;
  subtitleOutlineWidth: number;
  subtitleFontFamily: 'sans' | 'serif' | 'mono';
  subtitleBold: boolean;
  subtitleItalic: boolean;
}) {
  const boxClass =
    subtitleStyle === 'cinema'
      ? 'bg-black/75 rounded-2xl px-5 py-3'
      : subtitleStyle === 'glass'
        ? 'bg-slate-900/70 border border-white/25 rounded-2xl px-5 py-3 backdrop-blur-sm'
        : '';
  const fontClass =
    subtitleFontFamily === 'serif'
      ? 'font-serif'
      : subtitleFontFamily === 'mono'
        ? 'font-mono'
        : 'font-sans';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Live preview</span>
        <span>
          {width} x {height}
        </span>
      </div>
      <div className="rounded-xl border border-border/60 bg-muted/20 p-6">
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 p-5">
          {subtitleEnabled ? (
            <div className={`mx-auto max-w-[720px] ${boxClass}`}>
              <p
                className={`text-center text-[clamp(14px,3vw,28px)] leading-tight ${fontClass}`}
                style={{
                  color: subtitleTextColor,
                  fontWeight: subtitleBold ? 700 : 400,
                  fontStyle: subtitleItalic ? 'italic' : 'normal',
                  WebkitTextStroke: `${subtitleOutlineWidth}px ${subtitleOutlineColor}`,
                  textShadow:
                    subtitleOutlineWidth > 0
                      ? `0 1px 0 ${subtitleOutlineColor}, 0 0 8px ${subtitleOutlineColor}`
                      : 'none',
                }}
              >
                Okay team, imagine this. Suddenly there is a tiny dragon in the room.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-white/20 bg-black/20 px-4 py-2 text-xs text-white/70">
              Subtitle preview disabled
            </div>
          )}
        </div>
      </div>
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
