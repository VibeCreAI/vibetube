import { zodResolver } from '@hookform/resolvers/zod';
import {
  ChevronDown,
  Edit2,
  Loader2,
  Mic,
  Monitor,
  Sparkles,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { ImageModelStatusResponse } from '@/lib/api/types';
import {
  AVATAR_PRESET_OPTIONS,
  loadAvatarPresetFiles,
  type AvatarPresetStateKey,
} from '@/lib/constants/avatarPresets';
import {
  LANGUAGE_CODES,
  LANGUAGE_OPTIONS,
  type LanguageCode,
  type TranscriptionLanguageCode,
} from '@/lib/constants/languages';
import { getVoiceSampleScript, type RecordingPromptMode } from '@/lib/constants/voiceSampleScripts';
import { useAudioPlayer } from '@/lib/hooks/useAudioPlayer';
import type { AudioProcessingOptions } from '@/lib/hooks/useAudioRecording';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import {
  useAddSample,
  useCreateProfile,
  useDeleteAvatar,
  useProfile,
  useUpdateProfile,
  useUploadAvatar,
} from '@/lib/hooks/useProfiles';
import { useSystemAudioCapture } from '@/lib/hooks/useSystemAudioCapture';
import { useTranscription } from '@/lib/hooks/useTranscription';
import {
  applyGainToAudioFile,
  convertToWav,
  formatAudioDuration,
  getAudioDuration,
} from '@/lib/utils/audio';
import { usePlatform } from '@/platform/PlatformContext';
import { useServerStore } from '@/stores/serverStore';
import { type ProfileFormDraft, useUIStore } from '@/stores/uiStore';
import { AudioSampleRecording } from './AudioSampleRecording';
import { AudioSampleSystem } from './AudioSampleSystem';
import { AudioSampleUpload } from './AudioSampleUpload';
import { RecordingPromptField } from './RecordingPromptField';
import { SampleList } from './SampleList';
import { TranscriptionLanguageField } from './TranscriptionLanguageField';

const MAX_AUDIO_DURATION_SECONDS = 30;

const baseProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
  language: z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]),
  sampleFile: z.instanceof(File).optional(),
  referenceText: z.string().max(1000).optional(),
  avatarFile: z.instanceof(File).optional(),
});

const profileSchema = baseProfileSchema.refine(
  (data) => {
    // If sample file is provided, reference text is required
    if (data.sampleFile && (!data.referenceText || data.referenceText.trim().length === 0)) {
      return false;
    }
    return true;
  },
  {
    message: 'Reference text is required when adding a sample',
    path: ['referenceText'],
  },
);

type ProfileFormValues = z.infer<typeof profileSchema>;
type AvatarStateKey = AvatarPresetStateKey;
type AvatarStateFiles = Record<AvatarStateKey, File | null>;
type AvatarStatePreviews = Record<AvatarStateKey, string | null>;
type AvatarQualityPreset = 'fast' | 'balanced' | 'high';

const AVATAR_TEST_MODEL_ID = 'data/models/checkpoints/stylizedpixel_m80.safetensors';
const AVATAR_TEST_MODEL_LABEL = 'StylizedPixel M80';
const AVATAR_TEST_MODEL_NOTE = 'Local SD1.5 checkpoint for cleaner pixel-character portraits.';
const AVATAR_TEST_MODEL_DOWNLOAD_URL =
  'https://civitai.com/api/download/models/153325?type=Model&format=SafeTensor&size=full&fp=fp16';

const AVATAR_STYLE_PRESETS: Record<string, string> = {
  none: '',
  chibi: 'chibi style, cute face',
  hoodie: 'cat hoodie, cozy palette',
  retro_hero: 'retro hero portrait, bold outline',
};

const AVATAR_QUALITY_PRESETS: Record<
  AvatarQualityPreset,
  { steps: number; guidance: number; variation: number; palette: number }
> = {
  fast: { steps: 16, guidance: 6.5, variation: 0.2, palette: 96 },
  balanced: { steps: 24, guidance: 7.0, variation: 0.22, palette: 128 },
  high: { steps: 36, guidance: 7.5, variation: 0.24, palette: 160 },
};

const AVATAR_STATE_DEFS: Array<{
  key: AvatarStateKey;
  label: string;
  helper: string;
}> = [
  {
    key: 'idle',
    label: 'Eyes Open + Mouth Closed (Idle)',
    helper: 'Required',
  },
  {
    key: 'talk',
    label: 'Eyes Open + Mouth Open (Talking)',
    helper: 'Required',
  },
  {
    key: 'idle_blink',
    label: 'Eyes Closed + Mouth Closed (Blink Idle)',
    helper: 'Required',
  },
  {
    key: 'talk_blink',
    label: 'Eyes Closed + Mouth Open (Blink Talking)',
    helper: 'Required',
  },
];

type AvatarUploadMode = 'individual' | 'spritesheet';

const SPRITE_SHEET_PROMPT_GUIDE = `Character expression sheet — 1024x1024 PNG sprite sheet with 4 equal 512x512 quadrants, transparent background (alpha channel).

This is a 4-panel expression reference sheet for a single character. Think of it as one base drawing with only the eyes and mouth digitally edited between panels. Every other element — head position, head angle, hair, body, arms, clothing, lighting, shading, line weight — must be absolutely identical across all 4 quadrants. The character's eyes must be anchored at the exact same pixel coordinates in every quadrant.

Top-left (Idle): Eyes fully open, mouth closed, neutral expression.
Top-right (Talk): Eyes fully open, mouth open in a natural mid-speech position.
Bottom-left (Idle Blink): Eyes fully closed (mid-blink), mouth closed.
Bottom-right (Talk Blink): Eyes fully closed (mid-blink), mouth open.

Hard requirements:
- Canvas: exactly 1024x1024 px, 4 quadrants of exactly 512x512 each, zero padding or gutters between quadrants. Do NOT draw any dividing lines, borders, grid lines, separators, or frames between or around the quadrants — the quadrant boundaries must be completely invisible.
- Treat each quadrant as a fully independent 512x512 image. The character must be perfectly centered within each 512x512 quadrant — equal empty space on the left and right sides, equal empty space on the top and bottom. The character's horizontal midpoint must align with x=256 of its quadrant and the vertical midpoint must align with y=256 of its quadrant.
- The character's bounding box (top, bottom, left, right extents) must be identical in every quadrant — same width, same height, same margins on all sides. Do not scale, shrink, grow, or nudge the character between quadrants.
- ONLY the eyes and mouth shape change between quadrants. Head tilt, hair, body pose, clothing, shadows, character size — all must be pixel-identical.
- Transparent background in all 4 quadrants (no fill, no gradient, no vignette).
- Art style: [describe your desired style, e.g. anime, flat vector, pixel art, semi-realistic]
- Character: [describe your character here]`;

function getContentBounds(
  imageData: ImageData,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { data, width, height } = imageData;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}


async function splitSpriteSheet(file: File): Promise<Record<AvatarStateKey, File>> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const FULL = 1024,
        HALF = 512;
      if (img.naturalWidth !== FULL || img.naturalHeight !== FULL) {
        reject(
          new Error(
            `Sprite sheet must be exactly 1024×1024 px. Got ${img.naturalWidth}×${img.naturalHeight}.`,
          ),
        );
        return;
      }
      const quadrants: Array<{ key: AvatarStateKey; sx: number; sy: number }> = [
        { key: 'idle', sx: 0, sy: 0 },
        { key: 'talk', sx: HALF, sy: 0 },
        { key: 'idle_blink', sx: 0, sy: HALF },
        { key: 'talk_blink', sx: HALF, sy: HALF },
      ];
      const canvas = document.createElement('canvas');
      canvas.width = HALF;
      canvas.height = HALF;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable.'));
        return;
      }
      const result = {} as Record<AvatarStateKey, File>;
      function processNext(i: number) {
        if (i >= quadrants.length) {
          resolve(result);
          return;
        }
        const { key, sx, sy } = quadrants[i];

        // Draw raw quadrant first to find the content bounding box.
        ctx!.clearRect(0, 0, HALF, HALF);
        ctx!.drawImage(img, sx, sy, HALF, HALF, 0, 0, HALF, HALF);
        const bounds = getContentBounds(ctx!.getImageData(0, 0, HALF, HALF));

        // Redraw with centering offset so the character is centred in the frame.
        ctx!.clearRect(0, 0, HALF, HALF);
        if (bounds) {
          const contentW = bounds.maxX - bounds.minX + 1;
          const contentH = bounds.maxY - bounds.minY + 1;
          const offsetX = Math.round((HALF - contentW) / 2) - bounds.minX;
          const offsetY = Math.round((HALF - contentH) / 2) - bounds.minY;
          ctx!.drawImage(img, sx, sy, HALF, HALF, offsetX, offsetY, HALF, HALF);
        } else {
          ctx!.drawImage(img, sx, sy, HALF, HALF, 0, 0, HALF, HALF);
        }

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error(`Failed to extract: ${key}`));
            return;
          }
          result[key] = new File([blob], `${key}.png`, { type: 'image/png' });
          processNext(i + 1);
        }, 'image/png');
      }
      processNext(0);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image.'));
    };
    img.src = url;
  });
}

// Helper to convert File to base64
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Helper to convert base64 to File
function base64ToFile(base64: string, fileName: string, fileType: string): File {
  const arr = base64.split(',');
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], fileName, { type: fileType });
}

export function ProfileForm() {
  const platform = usePlatform();
  const open = useUIStore((state) => state.profileDialogOpen);
  const setOpen = useUIStore((state) => state.setProfileDialogOpen);
  const editingProfileId = useUIStore((state) => state.editingProfileId);
  const setEditingProfileId = useUIStore((state) => state.setEditingProfileId);
  const profileFormDraft = useUIStore((state) => state.profileFormDraft);
  const setProfileFormDraft = useUIStore((state) => state.setProfileFormDraft);
  const { data: editingProfile } = useProfile(editingProfileId || '');
  const createProfile = useCreateProfile();
  const updateProfile = useUpdateProfile();
  const addSample = useAddSample();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();
  const transcribe = useTranscription();
  const { toast } = useToast();
  const [sampleMode, setSampleMode] = useState<'upload' | 'record' | 'system'>('record');
  const [transcriptionLanguage, setTranscriptionLanguage] =
    useState<TranscriptionLanguageCode>('auto');
  const [recordingPromptMode, setRecordingPromptMode] = useState<RecordingPromptMode>('script');
  const [recordGainDb, setRecordGainDb] = useState(0);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingOptions>({
    autoGainControl: true,
    noiseSuppression: true,
    echoCancellation: true,
  });
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [isValidatingAudio, setIsValidatingAudio] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [selectedAvatarPresetId, setSelectedAvatarPresetId] = useState<string | null>(null);
  const [isApplyingAvatarPreset, setIsApplyingAvatarPreset] = useState(false);
  const [avatarStateFiles, setAvatarStateFiles] = useState<AvatarStateFiles>({
    idle: null,
    talk: null,
    idle_blink: null,
    talk_blink: null,
  });
  const [avatarStatePreviews, setAvatarStatePreviews] = useState<AvatarStatePreviews>({
    idle: null,
    talk: null,
    idle_blink: null,
    talk_blink: null,
  });
  const [generatedStatePreviews, setGeneratedStatePreviews] = useState<AvatarStatePreviews>({
    idle: null,
    talk: null,
    idle_blink: null,
    talk_blink: null,
  });
  const [hasSavedVibeTubePack, setHasSavedVibeTubePack] = useState(false);
  const [isPackLoading, setIsPackLoading] = useState(false);
  const [avatarUploadMode, setAvatarUploadMode] = useState<AvatarUploadMode>('spritesheet');
  const [spriteSheetPreview, setSpriteSheetPreview] = useState<string | null>(null);
  const [isSplittingSpriteSheet, setIsSplittingSpriteSheet] = useState(false);
  const [avatarGeneratePrompt, setAvatarGeneratePrompt] = useState('');
  const [avatarGenerateSeed, setAvatarGenerateSeed] = useState<string>('');
  const [avatarModelId, setAvatarModelId] = useState<string>(AVATAR_TEST_MODEL_ID);
  const [avatarStylePreset, setAvatarStylePreset] = useState<string>('none');
  const [avatarQualityPreset, setAvatarQualityPreset] = useState<AvatarQualityPreset>('balanced');
  const [isGeneratingAvatarPack, setIsGeneratingAvatarPack] = useState(false);
  const [isApplyingGeneratedAvatarPack, setIsApplyingGeneratedAvatarPack] = useState(false);
  const [hasPendingGeneratedPreview, setHasPendingGeneratedPreview] = useState(false);
  const [isAvatarGenPanelOpen, setIsAvatarGenPanelOpen] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState<ImageModelStatusResponse | null>(null);
  const [isImageModelStatusLoading, setIsImageModelStatusLoading] = useState(false);
  const [isImageModelDownloadStarting, setIsImageModelDownloadStarting] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const { isPlaying, playPause, cleanup: cleanupAudio } = useAudioPlayer();
  const isCreating = !editingProfileId;
  const serverUrl = useServerStore((state) => state.serverUrl);

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: '',
      description: '',
      language: 'en',
      sampleFile: undefined,
      referenceText: '',
      avatarFile: undefined,
    },
  });

  const selectedFile = form.watch('sampleFile');
  const selectedAvatarFile = form.watch('avatarFile');
  const selectedLanguage = form.watch('language');
  const selectedAvatarPreset = selectedAvatarPresetId
    ? AVATAR_PRESET_OPTIONS.find((preset) => preset.id === selectedAvatarPresetId) ?? null
    : null;
  const parsedAvatarSeed = avatarGenerateSeed.trim() ? Number(avatarGenerateSeed) : undefined;
  const hasAnyGeneratedPreview = Object.values(generatedStatePreviews).some(Boolean);
  const isImageModelReady = Boolean(imageModelStatus?.downloaded);
  const isImageModelDownloading =
    Boolean(imageModelStatus?.downloading) || isImageModelDownloadStarting;
  const shouldShowReferenceTextField =
    sampleMode !== 'record' || recordingPromptMode !== 'script';
  const shouldShowTranscriptionControls =
    sampleMode !== 'record' || recordingPromptMode === 'custom';

  // Validate audio duration when file is selected
  useEffect(() => {
    if (selectedFile && selectedFile instanceof File) {
      setIsValidatingAudio(true);
      getAudioDuration(selectedFile as File & { recordedDuration?: number })
        .then((duration) => {
          setAudioDuration(duration);
          if (duration > MAX_AUDIO_DURATION_SECONDS) {
            form.setError('sampleFile', {
              type: 'manual',
              message: `Audio is too long (${formatAudioDuration(duration)}). Maximum duration is ${formatAudioDuration(MAX_AUDIO_DURATION_SECONDS)}.`,
            });
          } else {
            form.clearErrors('sampleFile');
          }
        })
        .catch((error) => {
          console.error('Failed to get audio duration:', error);
          setAudioDuration(null);
          // For recordings, we auto-stop at max duration, so we can skip validation errors
          const isRecordedFile =
            selectedFile.name.startsWith('recording-') ||
            selectedFile.name.startsWith('system-audio-');
          if (!isRecordedFile) {
            form.setError('sampleFile', {
              type: 'manual',
              message: 'Failed to validate audio file. Please try a different file.',
            });
          } else {
            // Clear any existing errors for recorded files
            form.clearErrors('sampleFile');
          }
        })
        .finally(() => {
          setIsValidatingAudio(false);
        });
    } else {
      setAudioDuration(null);
      form.clearErrors('sampleFile');
    }
  }, [selectedFile, form]);

  const {
    isRecording,
    duration,
    error: recordingError,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    maxDurationSeconds: 29,
    audioProcessing,
    onRecordingComplete: (blob, recordedDuration) => {
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('sampleFile', file, { shouldValidate: true });
      toast({
        title: 'Recording complete',
        description: 'Audio has been recorded successfully.',
      });
    },
  });

  const {
    isRecording: isSystemRecording,
    duration: systemDuration,
    error: systemRecordingError,
    isSupported: isSystemAudioSupported,
    startRecording: startSystemRecording,
    stopRecording: stopSystemRecording,
    cancelRecording: cancelSystemRecording,
  } = useSystemAudioCapture({
    maxDurationSeconds: 29,
    onRecordingComplete: (blob, recordedDuration) => {
      const file = new File([blob], `system-audio-${Date.now()}.wav`, {
        type: blob.type || 'audio/wav',
      }) as File & { recordedDuration?: number };
      // Store the actual recorded duration to bypass metadata reading issues on Windows
      if (recordedDuration !== undefined) {
        file.recordedDuration = recordedDuration;
      }
      form.setValue('sampleFile', file, { shouldValidate: true });
      toast({
        title: 'System audio captured',
        description: 'Audio has been captured successfully.',
      });
    },
  });

  // Show recording errors
  useEffect(() => {
    if (recordingError) {
      toast({
        title: 'Recording error',
        description: recordingError,
        variant: 'destructive',
      });
    }
  }, [recordingError, toast]);

  // Show system audio recording errors
  useEffect(() => {
    if (systemRecordingError) {
      toast({
        title: 'System audio capture error',
        description: systemRecordingError,
        variant: 'destructive',
      });
    }
  }, [systemRecordingError, toast]);

  // Handle avatar preview
  useEffect(() => {
    if (selectedAvatarFile instanceof File) {
      const url = URL.createObjectURL(selectedAvatarFile);
      setAvatarPreview(url);
      return () => URL.revokeObjectURL(url);
    } else if (editingProfile?.avatar_path) {
      setAvatarPreview(`${serverUrl}/profiles/${editingProfile.id}/avatar`);
    } else {
      setAvatarPreview(null);
    }
  }, [selectedAvatarFile, editingProfile, serverUrl]);

  const setAvatarStateFile = (key: AvatarStateKey, file: File | null) => {
    setAvatarStateFiles((prev) => ({ ...prev, [key]: file }));
    setAvatarStatePreviews((prev) => {
      const old = prev[key];
      if (old?.startsWith('blob:')) {
        URL.revokeObjectURL(old);
      }
      return {
        ...prev,
        [key]: file ? URL.createObjectURL(file) : null,
      };
    });
  };

  async function handleSpriteSheetUpload(file: File) {
    if (file.type !== 'image/png') {
      toast({
        title: 'Invalid file type',
        description: 'Sprite sheet must be a PNG.',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast({
        title: 'File too large',
        description: 'Sprite sheet must be less than 20 MB.',
        variant: 'destructive',
      });
      return;
    }
    setSpriteSheetPreview((old) => {
      if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setIsSplittingSpriteSheet(true);
    setSelectedAvatarPresetId(null);
    try {
      const splitFiles = await splitSpriteSheet(file);
      Object.entries(splitFiles).forEach(([k, f]) => setAvatarStateFile(k as AvatarStateKey, f));
      form.setValue('avatarFile', splitFiles.idle, { shouldValidate: true });
      toast({ title: 'Sprite sheet split', description: 'All 4 states extracted successfully.' });
    } catch (err) {
      toast({
        title: 'Split failed',
        description: err instanceof Error ? err.message : 'Could not split the sprite sheet.',
        variant: 'destructive',
      });
      setSpriteSheetPreview((old) => {
        if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
        return null;
      });
    } finally {
      setIsSplittingSpriteSheet(false);
    }
  }

  const setAvatarPresetFiles = (files: Record<AvatarStateKey, File>) => {
    (Object.entries(files) as Array<[AvatarStateKey, File]>).forEach(([key, file]) => {
      setAvatarStateFile(key, file);
    });
  };

  function clearPresetLoadedImages() {
    setSelectedAvatarPresetId(null);
    setAvatarStateFiles({
      idle: null,
      talk: null,
      idle_blink: null,
      talk_blink: null,
    });
    setAvatarStatePreviews({
      idle: null,
      talk: null,
      idle_blink: null,
      talk_blink: null,
    });
    form.setValue('avatarFile', undefined, { shouldValidate: true });
    if (avatarInputRef.current) {
      avatarInputRef.current.value = '';
    }
  }

  async function handleApplyAvatarPreset(presetId: string) {
    const preset = AVATAR_PRESET_OPTIONS.find((option) => option.id === presetId);
    if (!preset) {
      return;
    }

    setIsApplyingAvatarPreset(true);
    try {
      const presetFiles = await loadAvatarPresetFiles(preset);
      form.setValue('avatarFile', presetFiles.idle, { shouldValidate: true });
      setAvatarPresetFiles(presetFiles);
      setSelectedAvatarPresetId(preset.id);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      }
      toast({
        title: 'Avatar preset applied',
        description: `${preset.name} is now loaded for the profile avatar and all 4 VibeTube states.`,
      });
    } catch (error) {
      toast({
        title: 'Preset load failed',
        description:
          error instanceof Error ? error.message : 'Failed to load the bundled avatar preset.',
        variant: 'destructive',
      });
    } finally {
      setIsApplyingAvatarPreset(false);
    }
  }

  useEffect(() => {
    return () => {
      Object.values(avatarStatePreviews).forEach((url) => {
        if (url?.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, [avatarStatePreviews]);

  useEffect(() => {
    return () => {
      if (spriteSheetPreview?.startsWith('blob:')) URL.revokeObjectURL(spriteSheetPreview);
    };
  }, [spriteSheetPreview]);

  // Restore form state from draft or editing profile
  useEffect(() => {
    if (editingProfile) {
      form.reset({
        name: editingProfile.name,
        description: editingProfile.description || '',
        language: editingProfile.language as LanguageCode,
        sampleFile: undefined,
        referenceText: undefined,
        avatarFile: undefined,
      });
      setTranscriptionLanguage('auto');
      setRecordingPromptMode('script');
      setSelectedAvatarPresetId(null);
    } else if (profileFormDraft && open) {
      // Restore from draft when opening in create mode
      form.reset({
        name: profileFormDraft.name,
        description: profileFormDraft.description,
        language: profileFormDraft.language as LanguageCode,
        referenceText: profileFormDraft.referenceText,
        sampleFile: undefined,
        avatarFile: undefined,
      });
      setSampleMode(profileFormDraft.sampleMode);
      setTranscriptionLanguage(profileFormDraft.transcriptionLanguage || 'auto');
      setRecordingPromptMode(profileFormDraft.recordingPromptMode || 'script');
      setSelectedAvatarPresetId(null);
      // Restore the file if we have it saved
      if (
        profileFormDraft.sampleFileData &&
        profileFormDraft.sampleFileName &&
        profileFormDraft.sampleFileType
      ) {
        const file = base64ToFile(
          profileFormDraft.sampleFileData,
          profileFormDraft.sampleFileName,
          profileFormDraft.sampleFileType,
        );
        form.setValue('sampleFile', file);
      }
    } else if (!open) {
      // Only reset to defaults when modal is closed and no draft
      form.reset({
        name: '',
        description: '',
        language: 'en',
        sampleFile: undefined,
        referenceText: undefined,
        avatarFile: undefined,
      });
      setSampleMode('record');
      setTranscriptionLanguage('auto');
      setRecordingPromptMode('script');
      setRecordGainDb(0);
      setAvatarPreview(null);
      setAvatarGeneratePrompt('');
      setAvatarGenerateSeed('');
      setAvatarModelId(AVATAR_TEST_MODEL_ID);
      setAvatarStylePreset('none');
      setAvatarQualityPreset('balanced');
      setHasPendingGeneratedPreview(false);
      setSelectedAvatarPresetId(null);
      setGeneratedStatePreviews({
        idle: null,
        talk: null,
        idle_blink: null,
        talk_blink: null,
      });
    }
  }, [editingProfile, profileFormDraft, open, form]);

  useEffect(() => {
    if (sampleMode !== 'record' || recordingPromptMode !== 'script') {
      return;
    }

    form.setValue('referenceText', getVoiceSampleScript(selectedLanguage), {
      shouldValidate: true,
    });
    form.clearErrors('referenceText');
  }, [form, recordingPromptMode, sampleMode, selectedLanguage]);

  useEffect(() => {
    if (sampleMode === 'record' && recordingPromptMode === 'script') {
      return;
    }

    const scriptText = getVoiceSampleScript(selectedLanguage).trim();
    const currentText = (form.getValues('referenceText') || '').trim();

    // When switching away from script mode, clear the auto-filled script so
    // transcription starts blank in custom/upload/system flows.
    if (currentText && currentText === scriptText) {
      form.setValue('referenceText', '', { shouldValidate: false, shouldDirty: false });
      form.clearErrors('referenceText');
    }
  }, [form, recordingPromptMode, sampleMode, selectedLanguage]);

  useEffect(() => {
    if (!open || !editingProfileId) {
      setHasSavedVibeTubePack(false);
      setHasPendingGeneratedPreview(false);
      if (!open) {
        setAvatarStateFiles({
          idle: null,
          talk: null,
          idle_blink: null,
          talk_blink: null,
        });
        setAvatarStatePreviews({
          idle: null,
          talk: null,
          idle_blink: null,
          talk_blink: null,
        });
        setGeneratedStatePreviews({
          idle: null,
          talk: null,
          idle_blink: null,
          talk_blink: null,
        });
        setAvatarUploadMode('spritesheet');
        setSpriteSheetPreview((old) => {
          if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
          return null;
        });
        setIsSplittingSpriteSheet(false);
      }
      return;
    }

    let cancelled = false;
    setIsPackLoading(true);
    apiClient
      .getVibeTubeAvatarPack(editingProfileId)
      .then((pack) => {
        if (cancelled) return;
        setHasSavedVibeTubePack(pack.complete);
        const t = Date.now();
        const stateUrls = {
          idle: pack.idle_url
            ? `${apiClient.getVibeTubeAvatarStateUrl(editingProfileId, 'idle')}?t=${t}`
            : null,
          talk: pack.talk_url
            ? `${apiClient.getVibeTubeAvatarStateUrl(editingProfileId, 'talk')}?t=${t}`
            : null,
          idle_blink: pack.idle_blink_url
            ? `${apiClient.getVibeTubeAvatarStateUrl(editingProfileId, 'idle_blink')}?t=${t}`
            : null,
          talk_blink: pack.talk_blink_url
            ? `${apiClient.getVibeTubeAvatarStateUrl(editingProfileId, 'talk_blink')}?t=${t}`
            : null,
        };
        setAvatarStatePreviews((prev) => ({
          idle: prev.idle?.startsWith('blob:') ? prev.idle : stateUrls.idle,
          talk: prev.talk?.startsWith('blob:') ? prev.talk : stateUrls.talk,
          idle_blink: prev.idle_blink?.startsWith('blob:') ? prev.idle_blink : stateUrls.idle_blink,
          talk_blink: prev.talk_blink?.startsWith('blob:') ? prev.talk_blink : stateUrls.talk_blink,
        }));
        return apiClient.getVibeTubeAvatarPreview(editingProfileId).catch(() => null);
      })
      .then((preview) => {
        if (cancelled || !preview) return;
        const t = Date.now();
        setGeneratedStatePreviews({
          idle: preview.idle_url
            ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(editingProfileId, 'idle')}?t=${t}`
            : null,
          talk: preview.talk_url
            ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(editingProfileId, 'talk')}?t=${t}`
            : null,
          idle_blink: preview.idle_blink_url
            ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(editingProfileId, 'idle_blink')}?t=${t}`
            : null,
          talk_blink: preview.talk_blink_url
            ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(editingProfileId, 'talk_blink')}?t=${t}`
            : null,
        });
        setHasPendingGeneratedPreview(preview.complete);
      })
      .catch(() => {
        if (!cancelled) {
          setHasSavedVibeTubePack(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsPackLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, editingProfileId]);

  useEffect(() => {
    if (!open || !isAvatarGenPanelOpen) {
      return;
    }

    let cancelled = false;

    const fetchImageModelStatus = async (showLoading = false) => {
      if (showLoading) {
        setIsImageModelStatusLoading(true);
      }
      try {
        const status = await apiClient.getStylizedPixelImageModelStatus();
        if (!cancelled) {
          setImageModelStatus(status);
          if (!status.downloading) {
            setIsImageModelDownloadStarting(false);
          }
        }
      } catch (_error) {
        if (!cancelled) {
          setImageModelStatus(null);
        }
      } finally {
        if (!cancelled && showLoading) {
          setIsImageModelStatusLoading(false);
        }
      }
    };

    fetchImageModelStatus(true);
    const interval = window.setInterval(() => {
      void fetchImageModelStatus(false);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, isAvatarGenPanelOpen]);

  async function handleTranscribe() {
    const file = form.getValues('sampleFile');
    if (!file) {
      toast({
        title: 'No file selected',
        description: 'Please select an audio file first.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const result = await transcribe.mutateAsync({ file, language: transcriptionLanguage });

      form.setValue('referenceText', result.text, { shouldValidate: true });
    } catch (error) {
      toast({
        title: 'Transcription failed',
        description: error instanceof Error ? error.message : 'Failed to transcribe audio',
        variant: 'destructive',
      });
    }
  }

  function handleCancelRecording() {
    if (sampleMode === 'record') {
      cancelRecording();
    } else if (sampleMode === 'system') {
      cancelSystemRecording();
    }
    form.resetField('sampleFile');
    cleanupAudio();
  }

  function handlePlayPause() {
    const file = form.getValues('sampleFile');
    playPause(file);
  }

  function handleAvatarFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: 'Invalid file type',
          description: 'Please select an image file (PNG, JPG, or WebP)',
          variant: 'destructive',
        });
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: 'File too large',
          description: 'Image must be less than 5MB',
          variant: 'destructive',
        });
        return;
      }
      setSelectedAvatarPresetId(null);
      form.setValue('avatarFile', file);
    }
  }

  async function handleRemoveAvatar() {
    if (editingProfileId && editingProfile?.avatar_path) {
      try {
        await deleteAvatar.mutateAsync(editingProfileId);
        toast({
          title: 'Avatar removed',
          description: 'Avatar image has been removed successfully.',
        });
      } catch (error) {
        toast({
          title: 'Failed to remove avatar',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    }
    setSelectedAvatarPresetId(null);
    form.setValue('avatarFile', undefined);
    setAvatarPreview(null);
    if (avatarInputRef.current) {
      avatarInputRef.current.value = '';
    }
  }

  async function refreshAvatarPackPreviews(profileId: string) {
    const pack = await apiClient.getVibeTubeAvatarPack(profileId);
    setHasSavedVibeTubePack(pack.complete);
    const t = Date.now();
    setAvatarStatePreviews((prev) => ({
      idle: prev.idle?.startsWith('blob:')
        ? prev.idle
        : pack.idle_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'idle')}?t=${t}`
          : null,
      talk: prev.talk?.startsWith('blob:')
        ? prev.talk
        : pack.talk_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'talk')}?t=${t}`
          : null,
      idle_blink: prev.idle_blink?.startsWith('blob:')
        ? prev.idle_blink
        : pack.idle_blink_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'idle_blink')}?t=${t}`
          : null,
      talk_blink: prev.talk_blink?.startsWith('blob:')
        ? prev.talk_blink
        : pack.talk_blink_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'talk_blink')}?t=${t}`
          : null,
    }));
  }

  function buildAvatarGenerateRequest(spritesheet = false) {
    const resolvedModelId = avatarModelId.trim();
    if (!resolvedModelId) {
      throw new Error('Select a model or enter a custom model ID.');
    }
    const styleSuffix = AVATAR_STYLE_PRESETS[avatarStylePreset] || '';
    const finalPrompt = styleSuffix
      ? `${avatarGeneratePrompt.trim()}, ${styleSuffix}`
      : avatarGeneratePrompt.trim();
    const quality = AVATAR_QUALITY_PRESETS[avatarQualityPreset];
    return {
      prompt: finalPrompt,
      model_id: resolvedModelId,
      seed: parsedAvatarSeed,
      size: spritesheet ? 1024 : 512,
      output_size: 512,
      palette_colors: quality.palette,
      num_inference_steps: quality.steps,
      guidance_scale: quality.guidance,
      variation_strength: quality.variation,
      match_existing_style: false,
      reference_strength: 0.18,
    };
  }

  function applyGeneratedPreviewUrls(
    profileId: string,
    preview: {
      idle_url?: string;
      idle_ready?: boolean;
      talk_url?: string;
      idle_blink_url?: string;
      talk_blink_url?: string;
      complete: boolean;
    },
  ) {
    const t = Date.now();
    setGeneratedStatePreviews({
      idle: preview.idle_url
        ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(profileId, 'idle')}?t=${t}`
        : null,
      talk: preview.talk_url
        ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(profileId, 'talk')}?t=${t}`
        : null,
      idle_blink: preview.idle_blink_url
        ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(profileId, 'idle_blink')}?t=${t}`
        : null,
      talk_blink: preview.talk_blink_url
        ? `${apiClient.getVibeTubeAvatarPreviewStateUrl(profileId, 'talk_blink')}?t=${t}`
        : null,
    });
    setHasPendingGeneratedPreview(preview.complete);
  }

  async function generateSpritesheetPreviewForProfile(profileId: string) {
    if (!isImageModelReady) {
      toast({
        title: 'Model required',
        description: 'Download StylizedPixel M80 before using this feature.',
        variant: 'destructive',
      });
      return;
    }
    if (!avatarGeneratePrompt.trim()) {
      toast({
        title: 'Prompt required',
        description: 'Add a character prompt before generating.',
        variant: 'destructive',
      });
      return;
    }
    if (avatarGenerateSeed.trim() && Number.isNaN(parsedAvatarSeed)) {
      toast({
        title: 'Invalid seed',
        description: 'Seed must be a valid integer.',
        variant: 'destructive',
      });
      return;
    }
    setHasPendingGeneratedPreview(false);
    setGeneratedStatePreviews({ idle: null, talk: null, idle_blink: null, talk_blink: null });
    setIsGeneratingAvatarPack(true);
    try {
      const preview = await apiClient.generateVibeTubeAvatarSpritesheetPreview(
        profileId,
        buildAvatarGenerateRequest(true),
      );
      applyGeneratedPreviewUrls(profileId, preview);
      toast({
        title: 'Sprite sheet generated',
        description: 'All 4 states ready. Review the previews, then click Apply.',
      });
    } catch (error) {
      setHasPendingGeneratedPreview(false);
      toast({
        title: 'Generation failed',
        description: error instanceof Error ? error.message : 'Failed to generate sprite sheet.',
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingAvatarPack(false);
    }
  }

  async function applyGeneratedAvatarPack(profileId: string) {
    setIsApplyingGeneratedAvatarPack(true);
    try {
      await apiClient.applyVibeTubeAvatarPreview(profileId);
      await refreshAvatarPackPreviews(profileId);
      setHasPendingGeneratedPreview(false);
      setGeneratedStatePreviews({
        idle: null,
        talk: null,
        idle_blink: null,
        talk_blink: null,
      });
      toast({
        title: 'Avatar preview applied',
        description: 'Generated preview states are now saved as the active avatar pack.',
      });
    } catch (error) {
      toast({
        title: 'Apply failed',
        description:
          error instanceof Error ? error.message : 'Failed to apply generated preview states.',
        variant: 'destructive',
      });
    } finally {
      setIsApplyingGeneratedAvatarPack(false);
    }
  }

  async function downloadImageTestModel() {
    setIsImageModelDownloadStarting(true);
    try {
      const response = await apiClient.downloadStylizedPixelImageModel();
      toast({
        title: 'Model download started',
        description: response.message,
      });
      const status = await apiClient.getStylizedPixelImageModelStatus();
      setImageModelStatus(status);
      if (!status.downloading) {
        setIsImageModelDownloadStarting(false);
      }
    } catch (error) {
      setIsImageModelDownloadStarting(false);
      toast({
        title: 'Model download failed',
        description: error instanceof Error ? error.message : 'Failed to start model download.',
        variant: 'destructive',
      });
    }
  }

  async function onSubmit(data: ProfileFormValues) {
    const selectedAvatarStateEntries = Object.entries(avatarStateFiles).filter(
      ([, file]) => file instanceof File,
    ) as Array<[AvatarStateKey, File]>;
    const hasAnyAvatarStateFile = selectedAvatarStateEntries.length > 0;
    const hasAllAvatarStateFiles = selectedAvatarStateEntries.length === 4;

    if (hasAnyAvatarStateFile && !hasAllAvatarStateFiles) {
      toast({
        title: 'Incomplete Avatar State Pack',
        description:
          'Upload all 4 state images (idle, talk, idle blink, talk blink) to save VibeTube avatar states.',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (editingProfileId) {
        await updateProfile.mutateAsync({
          profileId: editingProfileId,
          data: {
            name: data.name,
            description: data.description,
            language: data.language,
          },
        });

        if (data.avatarFile) {
          try {
            await uploadAvatar.mutateAsync({
              profileId: editingProfileId,
              file: data.avatarFile,
            });
          } catch (avatarError) {
            toast({
              title: 'Avatar upload failed',
              description:
                avatarError instanceof Error ? avatarError.message : 'Failed to upload avatar',
              variant: 'destructive',
            });
          }
        }

        if (hasAllAvatarStateFiles) {
          try {
            await apiClient.saveVibeTubeAvatarPack({
              profileId: editingProfileId,
              idle: avatarStateFiles.idle as File,
              talk: avatarStateFiles.talk as File,
              idleBlink: avatarStateFiles.idle_blink as File,
              talkBlink: avatarStateFiles.talk_blink as File,
            });
            await refreshAvatarPackPreviews(editingProfileId);
          } catch (packError) {
            toast({
              title: 'VibeTube avatar states upload failed',
              description:
                packError instanceof Error
                  ? packError.message
                  : 'Failed to save 4-state avatar pack.',
              variant: 'destructive',
            });
          }
        }

        toast({
          title: 'Voice updated',
          description: `"${data.name}" has been updated successfully.`,
        });
      } else {
        const sampleFile = form.getValues('sampleFile');
        const referenceText = form.getValues('referenceText');

        if (!sampleFile) {
          form.setError('sampleFile', {
            type: 'manual',
            message: 'Audio sample is required',
          });
          toast({
            title: 'Audio sample required',
            description: 'Please provide an audio sample to create the voice profile.',
            variant: 'destructive',
          });
          return;
        }

        if (!referenceText || referenceText.trim().length === 0) {
          form.setError('referenceText', {
            type: 'manual',
            message: 'Reference text is required',
          });
          toast({
            title: 'Reference text required',
            description: 'Please provide the transcription for the audio sample.',
            variant: 'destructive',
          });
          return;
        }

        try {
          const duration = await getAudioDuration(sampleFile);
          if (duration > MAX_AUDIO_DURATION_SECONDS) {
            form.setError('sampleFile', {
              type: 'manual',
              message: `Audio is too long (${formatAudioDuration(duration)}). Maximum duration is ${formatAudioDuration(MAX_AUDIO_DURATION_SECONDS)}.`,
            });
            toast({
              title: 'Invalid audio file',
              description: `Audio duration is ${formatAudioDuration(duration)}, but maximum is ${formatAudioDuration(MAX_AUDIO_DURATION_SECONDS)}.`,
              variant: 'destructive',
            });
            return;
          }
        } catch (error) {
          form.setError('sampleFile', {
            type: 'manual',
            message: 'Failed to validate audio file. Please try a different file.',
          });
          toast({
            title: 'Validation error',
            description: error instanceof Error ? error.message : 'Failed to validate audio file',
            variant: 'destructive',
          });
          return;
        }

        const profile = await createProfile.mutateAsync({
          name: data.name,
          description: data.description,
          language: data.language,
        });

        let fileToUpload: File = sampleFile;
        if (sampleMode === 'record' && Math.abs(recordGainDb) > 0.001) {
          try {
            fileToUpload = await applyGainToAudioFile(fileToUpload, recordGainDb);
          } catch {
            // Keep original if gain processing fails.
          }
        }
        if (
          !fileToUpload.type.includes('wav') &&
          !fileToUpload.name.toLowerCase().endsWith('.wav')
        ) {
          try {
            const wavBlob = await convertToWav(fileToUpload);
            const wavName = fileToUpload.name.replace(/\.[^.]+$/, '.wav');
            fileToUpload = new File([wavBlob], wavName, { type: 'audio/wav' });
          } catch {
            // If browser can't decode the format, send the original and let the backend try.
          }
        }

        try {
          await addSample.mutateAsync({
            profileId: profile.id,
            file: fileToUpload,
            referenceText: referenceText,
          });

          if (data.avatarFile) {
            try {
              await uploadAvatar.mutateAsync({
                profileId: profile.id,
                file: data.avatarFile,
              });
            } catch (avatarError) {
              toast({
                title: 'Avatar upload failed',
                description:
                  avatarError instanceof Error ? avatarError.message : 'Failed to upload avatar',
                variant: 'destructive',
              });
            }
          }

          if (hasAllAvatarStateFiles) {
            try {
              await apiClient.saveVibeTubeAvatarPack({
                profileId: profile.id,
                idle: avatarStateFiles.idle as File,
                talk: avatarStateFiles.talk as File,
                idleBlink: avatarStateFiles.idle_blink as File,
                talkBlink: avatarStateFiles.talk_blink as File,
              });
              await refreshAvatarPackPreviews(profile.id);
            } catch (packError) {
              toast({
                title: 'VibeTube avatar states upload failed',
                description:
                  packError instanceof Error
                    ? packError.message
                    : 'Failed to save 4-state avatar pack.',
                variant: 'destructive',
              });
            }
          }

          toast({
            title: 'Profile created',
            description: `"${data.name}" has been created with a sample.`,
          });
        } catch (sampleError) {
          toast({
            title: 'Failed to add sample',
            description: `Profile "${data.name}" was created, but failed to add sample: ${sampleError instanceof Error ? sampleError.message : 'Unknown error'}`,
            variant: 'destructive',
          });
        }
      }

      setProfileFormDraft(null);
      form.reset();
      setEditingProfileId(null);
      setOpen(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save profile',
        variant: 'destructive',
      });
    }
  }

  async function handleOpenChange(newOpen: boolean) {
    if (!newOpen && isCreating) {
      // Save draft when closing the create modal
      const values = form.getValues();
      const hasContent =
        values.name ||
        values.description ||
        values.referenceText ||
        values.sampleFile ||
        transcriptionLanguage !== 'auto' ||
        recordingPromptMode !== 'script';

      if (hasContent) {
        const draft: ProfileFormDraft = {
          name: values.name || '',
          description: values.description || '',
          language: values.language || 'en',
          transcriptionLanguage,
          recordingPromptMode,
          referenceText: values.referenceText || '',
          sampleMode,
        };

        // Save file as base64 if present
        if (values.sampleFile) {
          try {
            draft.sampleFileName = values.sampleFile.name;
            draft.sampleFileType = values.sampleFile.type;
            draft.sampleFileData = await fileToBase64(values.sampleFile);
          } catch {
            // If file conversion fails, just don't save the file
          }
        }

        setProfileFormDraft(draft);
      }
    }

    setOpen(newOpen);
    if (!newOpen) {
      setEditingProfileId(null);
      // Don't reset form here - let the effect handle it based on draft state
      if (isRecording) {
        cancelRecording();
      }
      if (isSystemRecording) {
        cancelSystemRecording();
      }
      cleanupAudio();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-none w-screen h-screen left-0 top-0 translate-x-0 translate-y-0 rounded-none p-6 overflow-y-auto">
        <div className="max-w-5xl max-h-[85vh] mx-auto my-auto w-full flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-2xl">
              {editingProfileId ? 'Edit Profile' : 'Create Profile'}
            </DialogTitle>
            <DialogDescription>
              {editingProfileId
                ? 'Update your profile details and manage samples.'
                : 'Create a new profile with an audio sample to clone the voice.'}
            </DialogDescription>
            {isCreating && profileFormDraft && (
              <div className="flex items-center gap-2 pt-2">
                <span className="text-xs text-muted-foreground">Draft restored</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setProfileFormDraft(null);
                    form.reset({
                      name: '',
                      description: '',
                      language: 'en',
                      sampleFile: undefined,
                      referenceText: '',
                    });
                    setSampleMode('record');
                    setTranscriptionLanguage('auto');
                    setRecordingPromptMode('script');
                  }}
                >
                  <X className="h-3 w-3 mr-1" />
                  Discard
                </Button>
              </div>
            )}
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 min-h-0 flex flex-col">
              <div className="grid gap-6 grid-cols-2 pb-4">
                <div className="border-r pr-6">
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold">Voice</h3>
                    <p className="text-sm text-muted-foreground">
                      Add or manage the sample audio used to clone the voice.
                    </p>
                  </div>
                </div>
                <div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold">Profile</h3>
                    <p className="text-sm text-muted-foreground">
                      Set the profile details first, then add avatar assets below.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-6 grid-cols-2 flex-1 overflow-y-auto min-h-0">
                {/* Left column: Sample management */}
                <div className="space-y-4 border-r pr-6">
                  {isCreating ? (
                    <>
                      <Tabs
                        className="pt-4"
                        value={sampleMode}
                        onValueChange={(v) => {
                          const newMode = v as 'upload' | 'record' | 'system';
                          // Cancel any active recordings when switching modes
                          if (isRecording && newMode !== 'record') {
                            cancelRecording();
                          }
                          if (isSystemRecording && newMode !== 'system') {
                            cancelSystemRecording();
                          }
                          setSampleMode(newMode);
                        }}
                      >
                        <TabsList
                          className={`grid w-full ${platform.metadata.isTauri && isSystemAudioSupported ? 'grid-cols-3' : 'grid-cols-2'}`}
                        >
                          <TabsTrigger value="upload" className="flex items-center gap-2">
                            <Upload className="h-4 w-4 shrink-0" />
                            Upload
                          </TabsTrigger>
                          <TabsTrigger value="record" className="flex items-center gap-2">
                            <Mic className="h-4 w-4 shrink-0" />
                            Record
                          </TabsTrigger>
                          {platform.metadata.isTauri && isSystemAudioSupported && (
                            <TabsTrigger value="system" className="flex items-center gap-2">
                              <Monitor className="h-4 w-4 shrink-0" />
                              System Audio
                            </TabsTrigger>
                          )}
                        </TabsList>

                        <TabsContent value="upload" className="space-y-4">
                          <FormField
                            control={form.control}
                            name="sampleFile"
                            render={({ field: { onChange, name } }) => (
                              <AudioSampleUpload
                                file={selectedFile}
                                onFileChange={onChange}
                                onTranscribe={handleTranscribe}
                                onPlayPause={handlePlayPause}
                                isPlaying={isPlaying}
                                isValidating={isValidatingAudio}
                                isTranscribing={transcribe.isPending}
                                isDisabled={
                                  audioDuration !== null &&
                                  audioDuration > MAX_AUDIO_DURATION_SECONDS
                                }
                                fieldName={name}
                              />
                            )}
                          />
                        </TabsContent>

                        <TabsContent value="record" className="space-y-4">
                          <RecordingPromptField
                            language={selectedLanguage}
                            mode={recordingPromptMode}
                            onModeChange={setRecordingPromptMode}
                          />
                          <FormField
                            control={form.control}
                            name="sampleFile"
                            render={() => (
                              <AudioSampleRecording
                                file={selectedFile}
                                isRecording={isRecording}
                                duration={duration}
                                audioProcessing={audioProcessing}
                                onAudioProcessingChange={setAudioProcessing}
                                onStart={startRecording}
                                onStop={stopRecording}
                                onCancel={handleCancelRecording}
                                onTranscribe={handleTranscribe}
                                onPlayPause={handlePlayPause}
                                isPlaying={isPlaying}
                                isTranscribing={transcribe.isPending}
                                showTranscribeButton={recordingPromptMode === 'custom'}
                              />
                            )}
                          />
                          {selectedFile && !isRecording && (
                            <FormItem>
                              <FormLabel>Recorded Sample Gain (dB)</FormLabel>
                              <div className="flex items-center gap-3">
                                <Input
                                  type="range"
                                  min={-12}
                                  max={24}
                                  step={1}
                                  value={recordGainDb}
                                  onChange={(e) => setRecordGainDb(Number(e.target.value))}
                                />
                                <Input
                                  type="number"
                                  min={-12}
                                  max={24}
                                  step={1}
                                  value={recordGainDb}
                                  onChange={(e) => setRecordGainDb(Number(e.target.value))}
                                  className="w-20"
                                />
                              </div>
                            </FormItem>
                          )}
                        </TabsContent>

                        {platform.metadata.isTauri && isSystemAudioSupported && (
                          <TabsContent value="system" className="space-y-4">
                            <FormField
                              control={form.control}
                              name="sampleFile"
                              render={() => (
                                <AudioSampleSystem
                                  file={selectedFile}
                                  isRecording={isSystemRecording}
                                  duration={systemDuration}
                                  onStart={startSystemRecording}
                                  onStop={stopSystemRecording}
                                  onCancel={handleCancelRecording}
                                  onTranscribe={handleTranscribe}
                                  onPlayPause={handlePlayPause}
                                  isPlaying={isPlaying}
                                  isTranscribing={transcribe.isPending}
                                />
                              )}
                            />
                          </TabsContent>
                        )}
                      </Tabs>

                      {shouldShowTranscriptionControls ? (
                        <TranscriptionLanguageField
                          value={transcriptionLanguage}
                          onChange={setTranscriptionLanguage}
                          disabled={transcribe.isPending}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Sample script mode fills the transcription automatically, so
                          transcription is not needed.
                        </p>
                      )}

                      {shouldShowReferenceTextField && (
                        <FormField
                          control={form.control}
                          name="referenceText"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Transcription</FormLabel>
                              <FormControl>
                                <Textarea
                                  placeholder="Enter the exact text spoken in the audio..."
                                  className="min-h-[100px]"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </>
                  ) : (
                    // Show sample list when editing
                    editingProfileId && (
                      <div>
                        <SampleList profileId={editingProfileId} />
                      </div>
                    )
                  )}
                </div>

                {/* Right column: Profile info */}
                <div className="space-y-4">
                  {/* Avatar Upload */}
                  <FormField
                    control={form.control}
                    name="avatarFile"
                    render={() => (
                      <FormItem>
                        <FormControl>
                          <div className="pt-4 pb-2">
                            <div className="flex justify-center">
                              <div className="relative group">
                                <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden border-2 border-border">
                                  {avatarPreview ? (
                                    <img
                                      src={avatarPreview}
                                      alt="Avatar preview"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <UserRound className="h-10 w-10 text-muted-foreground" />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => avatarInputRef.current?.click()}
                                  className="absolute inset-0 rounded-full bg-accent/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                                >
                                  <Edit2 className="h-6 w-6 text-accent-foreground" />
                                </button>
                                {(avatarPreview || editingProfile?.avatar_path) && (
                                  <button
                                    type="button"
                                    onClick={handleRemoveAvatar}
                                    disabled={deleteAvatar.isPending}
                                    className="absolute bottom-0 right-0 h-6 w-6 rounded-full bg-background/60 backdrop-blur-sm text-muted-foreground flex items-center justify-center hover:bg-background/80 hover:text-foreground transition-colors shadow-sm border border-border/50"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                              <input
                                ref={avatarInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={handleAvatarFileChange}
                                className="hidden"
                              />
                            </div>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input placeholder="My Profile" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description (Optional)</FormLabel>
                        <FormControl>
                          <Textarea placeholder="Describe this profile..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="language"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Language</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {LANGUAGE_OPTIONS.map((lang) => (
                              <SelectItem key={lang.value} value={lang.value}>
                                {lang.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="rounded-lg border bg-card/40 p-3 flex flex-col gap-3">
                    <div>
                      <p className="text-sm font-medium">VibeTube Avatar State Images</p>
                      <p className="text-xs text-muted-foreground">
                        Upload 4 PNGs, or auto-generate states from a character prompt.
                      </p>
                    </div>
                    <div className="rounded-md border bg-background/60 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium">Sample Avatar Presets</p>
                        {isApplyingAvatarPreset && (
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Applying...
                          </div>
                        )}
                      </div>
                      <Select
                        value={selectedAvatarPresetId ?? 'none'}
                        onValueChange={(value) => {
                          if (value === 'none') {
                            clearPresetLoadedImages();
                            return;
                          }
                          handleApplyAvatarPreset(value);
                        }}
                        disabled={isApplyingAvatarPreset}
                      >
                        <SelectTrigger className="h-auto px-3 py-2">
                          {selectedAvatarPreset ? (
                            <div className="flex w-full items-center gap-2">
                              {AVATAR_STATE_DEFS.map((def) => (
                                <div
                                  key={`selected-${def.key}`}
                                  className="h-12 w-12 overflow-hidden rounded-md border bg-muted/40 shrink-0"
                                >
                                  <img
                                    src={selectedAvatarPreset.states[def.key]}
                                    alt={`${selectedAvatarPreset.name} ${def.label}`}
                                    className="h-full w-full object-cover"
                                  />
                                </div>
                              ))}
                              <span className="sr-only">{selectedAvatarPreset.name}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </SelectTrigger>
                        <SelectContent position="popper" className="w-[var(--radix-select-trigger-width)]">
                          <SelectItem value="none" textValue="None">
                            <span className="text-sm text-muted-foreground">None</span>
                          </SelectItem>
                          {AVATAR_PRESET_OPTIONS.map((preset) => (
                            <SelectItem
                              key={preset.id}
                              value={preset.id}
                              textValue={preset.name}
                              className="py-2"
                            >
                              <div
                                className="flex w-full items-center gap-2"
                                aria-label={`Apply ${preset.name} avatar preset`}
                              >
                                {AVATAR_STATE_DEFS.map((def) => (
                                  <div
                                    key={`${preset.id}-${def.key}`}
                                    className="h-12 w-12 overflow-hidden rounded-md border bg-muted/40 shrink-0"
                                  >
                                    <img
                                      src={preset.states[def.key]}
                                      alt={`${preset.name} ${def.label}`}
                                      className="h-full w-full object-cover"
                                    />
                                  </div>
                                ))}
                                <span className="sr-only">{preset.name}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        Selecting a preset loads the round avatar and all 4 VibeTube state images.
                      </p>
                    </div>
                    {/* Generate From Prompt panel intentionally hidden — backend code preserved for future API-based generation (e.g. fal.ai) */}
                    {false && <div className="order-3 rounded-md border bg-background/60 p-3 space-y-2">
                      <button
                        type="button"
                        className="w-full flex items-center justify-between text-xs font-medium"
                        onClick={() => setIsAvatarGenPanelOpen((v) => !v)}
                      >
                        <span>Generate From Prompt (Local Model — Experimental)</span>
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${isAvatarGenPanelOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {!isAvatarGenPanelOpen && (
                        <p className="text-[11px] text-muted-foreground">
                          Collapsed by default. Click to expand this experimental generator.
                        </p>
                      )}
                      {isAvatarGenPanelOpen && (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <p className="text-[11px] text-muted-foreground">Model</p>
                              <div className="rounded-md border bg-background/70 px-3 py-2 text-sm">
                                {AVATAR_TEST_MODEL_LABEL}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <p className="text-[11px] text-muted-foreground">Quality</p>
                              <Select
                                value={avatarQualityPreset}
                                onValueChange={(v) =>
                                  setAvatarQualityPreset(v as AvatarQualityPreset)
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="fast">Fast</SelectItem>
                                  <SelectItem value="balanced">Balanced</SelectItem>
                                  <SelectItem value="high">High</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {AVATAR_TEST_MODEL_NOTE} This model is not bundled with the app.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                isImageModelReady ||
                                isImageModelDownloading ||
                                isImageModelStatusLoading
                              }
                              onClick={downloadImageTestModel}
                            >
                              {isImageModelDownloading ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  Downloading...
                                </>
                              ) : isImageModelReady ? (
                                'Model Ready'
                              ) : (
                                'Download Model'
                              )}
                            </Button>
                            <a
                              href={AVATAR_TEST_MODEL_DOWNLOAD_URL}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex text-[11px] text-cyan-400 hover:text-cyan-300 underline underline-offset-4"
                            >
                              Direct download link
                            </a>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {isImageModelStatusLoading
                              ? 'Checking local model status...'
                              : isImageModelReady
                                ? `Model downloaded to ${imageModelStatus?.file_path ?? AVATAR_TEST_MODEL_ID}`
                                : isImageModelDownloading
                                  ? `Downloading to ${AVATAR_TEST_MODEL_ID}...`
                                  : `If you test this feature, the app downloads the model to ${AVATAR_TEST_MODEL_ID}.`}
                          </p>
                          <div className="space-y-1">
                            <p className="text-[11px] text-muted-foreground">Style Preset</p>
                            <Select value={avatarStylePreset} onValueChange={setAvatarStylePreset}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">None</SelectItem>
                                <SelectItem value="chibi">Chibi Portrait</SelectItem>
                                <SelectItem value="hoodie">Cozy Hoodie</SelectItem>
                                <SelectItem value="retro_hero">Retro Hero</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <Textarea
                            value={avatarGeneratePrompt}
                            onChange={(e) => setAvatarGeneratePrompt(e.target.value)}
                            placeholder="Describe how the character should look (added to the system style prompt)."
                            className="min-h-[84px]"
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Keep prompt short (about 5-20 words) for SD1.x models to avoid CLIP
                            truncation.
                          </p>
                          <div className="flex items-center gap-2">
                            <Input
                              value={avatarGenerateSeed}
                              onChange={(e) => setAvatarGenerateSeed(e.target.value)}
                              placeholder="Seed (optional)"
                              inputMode="numeric"
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={
                                !editingProfileId ||
                                !isImageModelReady ||
                                isGeneratingAvatarPack ||
                                isApplyingGeneratedAvatarPack
                              }
                              onClick={() =>
                                editingProfileId &&
                                generateSpritesheetPreviewForProfile(editingProfileId)
                              }
                            >
                              {isGeneratingAvatarPack ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Sparkles className="h-4 w-4 mr-2" />
                              )}
                              {isGeneratingAvatarPack ? 'Generating...' : 'Generate Sprite Sheet'}
                            </Button>
                            <Button
                              type="button"
                              variant="default"
                              disabled={
                                !editingProfileId ||
                                !hasPendingGeneratedPreview ||
                                isGeneratingAvatarPack ||
                                isApplyingGeneratedAvatarPack
                              }
                              onClick={() =>
                                editingProfileId && applyGeneratedAvatarPack(editingProfileId)
                              }
                            >
                              {isApplyingGeneratedAvatarPack ? 'Applying...' : 'Apply'}
                            </Button>
                          </div>
                          {isGeneratingAvatarPack && (
                            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Generating 1024×1024 sprite sheet — all 4 states in one pass...
                            </div>
                          )}
                          <p className="text-[11px] text-muted-foreground">
                            Generates all 4 states as a single 1024×1024 sprite sheet, then splits
                            into individual files. One-shot generation produces more consistent
                            character appearance across states.
                          </p>
                          {!editingProfileId && (
                            <p className="text-[11px] text-muted-foreground">
                              Save the profile first to use one-click generation.
                            </p>
                          )}
                          {hasAnyGeneratedPreview && (
                            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-2">
                              <p className="text-xs font-medium">
                                Generated Preview{' '}
                                {!hasPendingGeneratedPreview
                                  ? '(Idle Only / In Progress)'
                                  : '(Not Applied Yet)'}
                              </p>
                              <div className="grid grid-cols-4 gap-2">
                                {AVATAR_STATE_DEFS.map((def) => (
                                  <div key={`preview-${def.key}`} className="text-center space-y-1">
                                    <div
                                      className="h-16 w-16 mx-auto rounded border overflow-hidden"
                                      style={{
                                        backgroundImage:
                                          'linear-gradient(45deg, #1a1a1a 25%, transparent 25%), linear-gradient(-45deg, #1a1a1a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a1a1a 75%), linear-gradient(-45deg, transparent 75%, #1a1a1a 75%)',
                                        backgroundSize: '10px 10px',
                                        backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0px',
                                        backgroundColor: '#111',
                                      }}
                                    >
                                      {generatedStatePreviews[def.key] ? (
                                        <img
                                          src={generatedStatePreviews[def.key] ?? undefined}
                                          alt={`${def.label} preview`}
                                          className="h-full w-full object-contain"
                                        />
                                      ) : (
                                        <div className="h-full w-full flex items-center justify-center text-[9px] text-muted-foreground">
                                          No preview
                                        </div>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">{def.key}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>}
                    <div className="flex rounded-md border overflow-hidden text-xs">
                      {(['spritesheet', 'individual'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`flex-1 px-3 py-1.5 transition-colors ${mode !== 'spritesheet' ? 'border-l' : ''} ${
                            avatarUploadMode === mode
                              ? 'bg-accent text-accent-foreground font-medium'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                          onClick={() => setAvatarUploadMode(mode)}
                        >
                          {mode === 'individual' ? '4 Individual Images' : 'Sprite Sheet'}
                        </button>
                      ))}
                    </div>

                    {avatarUploadMode === 'individual' && (
                      <div className="order-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {AVATAR_STATE_DEFS.map((def) => (
                          <div
                            key={def.key}
                            className="rounded-md border bg-background/60 p-2 space-y-2"
                          >
                            <div className="text-xs">
                              <p className="font-medium leading-tight">{def.label}</p>
                              <p className="text-muted-foreground">{def.helper}</p>
                            </div>
                            <Input
                              type="file"
                              accept="image/png"
                              onChange={(e) => {
                                const file = e.target.files?.[0] ?? null;
                                setSelectedAvatarPresetId(null);
                                if (!file) {
                                  setAvatarStateFile(def.key, null);
                                  return;
                                }
                                if (file.type !== 'image/png') {
                                  toast({
                                    title: 'Invalid file type',
                                    description: 'Please select a PNG image for avatar states.',
                                    variant: 'destructive',
                                  });
                                  return;
                                }
                                if (file.size > 5 * 1024 * 1024) {
                                  toast({
                                    title: 'File too large',
                                    description: 'Avatar state image must be less than 5MB.',
                                    variant: 'destructive',
                                  });
                                  return;
                                }
                                setAvatarStateFile(def.key, file);
                                if (def.key === 'idle') {
                                  form.setValue('avatarFile', file, { shouldValidate: true });
                                }
                              }}
                            />
                            <div className="h-20 w-20 rounded border bg-black/40 overflow-hidden">
                              {avatarStatePreviews[def.key] ? (
                                <img
                                  src={avatarStatePreviews[def.key] ?? undefined}
                                  alt={def.label}
                                  className="h-full w-full object-contain"
                                />
                              ) : (
                                <div className="h-full w-full flex items-center justify-center text-[10px] text-muted-foreground">
                                  No image
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {avatarUploadMode === 'spritesheet' && (
                      <div className="space-y-3">
                        {Object.values(avatarStatePreviews).some(Boolean) && (
                          <div className="rounded-md border bg-background/60 p-3 space-y-2">
                            <p className="text-xs font-medium">Sprite Sheet Preview</p>
                            <div className="grid grid-cols-2 gap-0.5 max-w-[256px] mx-auto rounded border overflow-hidden bg-black/40">
                              {([
                                { key: 'idle', label: 'Idle' },
                                { key: 'talk', label: 'Talk' },
                                { key: 'idle_blink', label: 'Blink Idle' },
                                { key: 'talk_blink', label: 'Blink Talk' },
                              ] as const).map(({ key, label }) => (
                                <div key={key} className="relative aspect-square bg-black/40">
                                  {avatarStatePreviews[key] ? (
                                    <img
                                      src={avatarStatePreviews[key]!}
                                      alt={label}
                                      className="w-full h-full object-contain"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[9px] text-muted-foreground">
                                      —
                                    </div>
                                  )}
                                  <span className="absolute bottom-0.5 left-1 text-[8px] text-white/50 leading-none">
                                    {label}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="rounded-md border bg-background/60 p-3 space-y-2">
                          <p className="text-xs font-medium">AI Prompt Guide</p>
                          <p className="text-[11px] text-muted-foreground">
                            Paste this into any AI image generation service. Replace the Art style
                            and Character placeholders with your own description before generating.
                          </p>
                          <Textarea
                            readOnly
                            className="min-h-[120px] text-[11px] font-mono resize-none"
                            value={SPRITE_SHEET_PROMPT_GUIDE}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(SPRITE_SHEET_PROMPT_GUIDE);
                              toast({ title: 'Copied to clipboard' });
                            }}
                          >
                            Copy Prompt
                          </Button>
                        </div>

                        <div className="rounded-md border bg-background/60 p-3 space-y-2">
                          <div className="text-xs">
                            <p className="font-medium leading-tight">
                              Upload 1024×1024 Sprite Sheet PNG
                            </p>
                            <p className="text-muted-foreground">
                              Top-left: Idle · Top-right: Talk · Bottom-left: Blink Idle ·
                              Bottom-right: Blink Talking
                            </p>
                          </div>
                          <Input
                            type="file"
                            accept="image/png"
                            disabled={isSplittingSpriteSheet}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleSpriteSheetUpload(f);
                            }}
                          />
                          {isSplittingSpriteSheet && (
                            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Splitting sprite sheet…
                            </div>
                          )}
                          {spriteSheetPreview && !isSplittingSpriteSheet && (
                            <div className="space-y-1">
                              <p className="text-[11px] text-muted-foreground">Split preview</p>
                              <div className="grid grid-cols-4 gap-2">
                                {AVATAR_STATE_DEFS.map((def) => (
                                  <div key={`sp-${def.key}`} className="text-center space-y-1">
                                    <div className="h-16 w-16 rounded border bg-black/40 overflow-hidden">
                                      {avatarStatePreviews[def.key] ? (
                                        <img
                                          src={avatarStatePreviews[def.key]!}
                                          alt={def.label}
                                          className="h-full w-full object-contain"
                                        />
                                      ) : (
                                        <div className="h-full w-full flex items-center justify-center text-[9px] text-muted-foreground">
                                          —
                                        </div>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">{def.key}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <p className="order-2 text-xs text-muted-foreground">
                      {isPackLoading
                        ? 'Checking saved VibeTube pack...'
                        : hasSavedVibeTubePack
                          ? 'Saved 4-state pack already exists for this voice profile.'
                          : 'No saved 4-state pack for this profile yet.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    createProfile.isPending ||
                    updateProfile.isPending ||
                    addSample.isPending ||
                    isGeneratingAvatarPack ||
                    isApplyingGeneratedAvatarPack
                  }
                >
                  {createProfile.isPending ||
                  updateProfile.isPending ||
                  addSample.isPending ||
                  isGeneratingAvatarPack ||
                  isApplyingGeneratedAvatarPack
                    ? 'Saving...'
                    : editingProfileId
                      ? 'Save Changes'
                      : 'Create Profile'}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
