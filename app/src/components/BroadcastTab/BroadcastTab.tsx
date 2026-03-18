import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BookOpen,
  Clapperboard,
  Download,
  ExternalLink,
  Loader2,
  Mic,
  Play,
  Radio,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BroadcastStage } from '@/components/BroadcastTab/BroadcastStage';
import { ObsGuideDialog } from '@/components/BroadcastTab/ObsGuideDialog';
import { AudioProcessingControls } from '@/components/AudioProcessingControls';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import type { VibeTubeAvatarPackResponse } from '@/lib/api/types';
import { SUPPORTED_LANGUAGES, type LanguageCode } from '@/lib/constants/languages';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { useBroadcastLiveSession } from '@/lib/hooks/useBroadcastLiveSession';
import {
  useBroadcastRecordingPreview,
  type BroadcastRecordingFrame,
} from '@/lib/hooks/useBroadcastRecordingPreview';
import { useProfiles } from '@/lib/hooks/useProfiles';
import { useTranscription } from '@/lib/hooks/useTranscription';
import {
  getPersistedVibeTubeBackgroundImageFileAsync,
  getPersistedVibeTubeRenderSettings,
} from '@/lib/utils/vibetubeSettings';
import { usePlatform } from '@/platform/PlatformContext';
import { useBroadcastStore } from '@/stores/broadcastStore';

function getRecordedFileMetadata(blob: Blob): { extension: string; mimeType: string } {
  const mimeType = blob.type || 'audio/wav';

  if (mimeType.includes('wav')) {
    return { extension: 'wav', mimeType: 'audio/wav' };
  }
  if (mimeType.includes('webm')) {
    return { extension: 'webm', mimeType };
  }
  if (mimeType.includes('ogg')) {
    return { extension: 'ogg', mimeType };
  }
  if (mimeType.includes('mp4') || mimeType.includes('mpeg')) {
    return { extension: 'm4a', mimeType };
  }

  return { extension: 'bin', mimeType };
}

function formatSrtTime(msTotal: number): string {
  const wholeMs = Math.max(0, Math.round(msTotal));
  const ms = wholeMs % 1000;
  const totalSeconds = Math.floor(wholeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${ms
    .toString()
    .padStart(3, '0')}`;
}

function buildSrtFromCaptionText(text: string, durationSeconds: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  const totalMs = Math.max(1000, Math.round(durationSeconds * 1000));
  return ['1', `${formatSrtTime(0)} --> ${formatSrtTime(totalMs)}`, trimmed, ''].join('\n');
}

export function BroadcastTab() {
  const platform = usePlatform();
  const { toast } = useToast();
  const settings = getPersistedVibeTubeRenderSettings();
  const selectedProfileId = useBroadcastStore((state) => state.selectedProfileId);
  const setSelectedProfileId = useBroadcastStore((state) => state.setSelectedProfileId);
  const popoutOpen = useBroadcastStore((state) => state.popoutOpen);
  const setPopoutOpen = useBroadcastStore((state) => state.setPopoutOpen);
  const captionText = useBroadcastStore((state) => state.captionText);
  const setCaptionText = useBroadcastStore((state) => state.setCaptionText);
  const liveAudioProcessing = useBroadcastStore((state) => state.liveAudioProcessing);
  const setLiveAudioProcessing = useBroadcastStore((state) => state.setLiveAudioProcessing);
  const recordAudioProcessing = useBroadcastStore((state) => state.recordAudioProcessing);
  const setRecordAudioProcessing = useBroadcastStore((state) => state.setRecordAudioProcessing);
  const [activeTab, setActiveTab] = useState<'live' | 'record'>('live');
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [recordedDurationSec, setRecordedDurationSec] = useState<number>(0);
  const [isExportingMov, setIsExportingMov] = useState(false);
  const [obsGuideOpen, setObsGuideOpen] = useState(false);
  const [recordingFrames, setRecordingFrames] = useState<BroadcastRecordingFrame[]>([]);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const { data: profiles, isLoading } = useProfiles();
  const transcribe = useTranscription();

  const avatarPacksQuery = useQuery({
    queryKey: ['broadcast-avatar-packs', profiles?.map((profile) => profile.id).join(',')],
    queryFn: async () => {
      if (!profiles?.length) {
        return {} as Record<string, VibeTubeAvatarPackResponse | null>;
      }

      const entries = await Promise.all(
        profiles.map(async (profile) => {
          try {
            const pack = await apiClient.getVibeTubeAvatarPack(profile.id);
            return [profile.id, pack] as const;
          } catch {
            return [profile.id, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, VibeTubeAvatarPackResponse | null>;
    },
    enabled: !!profiles?.length,
  });

  const availableProfiles = useMemo(() => {
    if (!profiles) return [];
    return profiles.filter((profile) => avatarPacksQuery.data?.[profile.id]?.complete);
  }, [avatarPacksQuery.data, profiles]);

  useEffect(() => {
    if (!availableProfiles.length) {
      if (selectedProfileId) {
        setSelectedProfileId(null);
      }
      return;
    }

    if (!selectedProfileId || !availableProfiles.some((profile) => profile.id === selectedProfileId)) {
      setSelectedProfileId(availableProfiles[0]?.id ?? null);
    }
  }, [availableProfiles, selectedProfileId, setSelectedProfileId]);

  const selectedProfile = profiles?.find((profile) => profile.id === selectedProfileId) ?? null;
  const selectedPack = selectedProfileId ? avatarPacksQuery.data?.[selectedProfileId] ?? null : null;
  const selectedProfileLanguage =
    selectedProfile?.language && selectedProfile.language in SUPPORTED_LANGUAGES
      ? SUPPORTED_LANGUAGES[selectedProfile.language as LanguageCode]
      : selectedProfile?.language ?? null;
  const versionTag = encodeURIComponent(selectedProfile?.updated_at ?? '');

  const selectedAssets = useMemo(
    () => ({
      idleUrl:
        selectedProfileId && selectedPack?.idle_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(selectedProfileId, 'idle')}?t=${versionTag}`
          : null,
      talkUrl:
        selectedProfileId && selectedPack?.talk_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(selectedProfileId, 'talk')}?t=${versionTag}`
          : null,
      idleBlinkUrl:
        selectedProfileId && selectedPack?.idle_blink_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(selectedProfileId, 'idle_blink')}?t=${versionTag}`
          : null,
      talkBlinkUrl:
        selectedProfileId && selectedPack?.talk_blink_url
          ? `${apiClient.getVibeTubeAvatarStateUrl(selectedProfileId, 'talk_blink')}?t=${versionTag}`
          : null,
    }),
    [selectedPack, selectedProfileId, versionTag],
  );

  const {
    isRecording,
    duration,
    error: recordingError,
    activeStream,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    maxDurationSeconds: 120,
    audioProcessing: recordAudioProcessing,
    onRecordingComplete: (blob, durationSec, meta) => {
      const timestamp = Date.now();
      const { extension, mimeType } = getRecordedFileMetadata(blob);
      const file = new File([blob], `broadcast-recording-${timestamp}.${extension}`, {
        type: mimeType,
      });
      const previewBlob = meta?.previewBlob ?? blob;
      const previewMeta = getRecordedFileMetadata(previewBlob);
      const nextPreviewFile = new File(
        [previewBlob],
        `broadcast-preview-${timestamp}.${previewMeta.extension}`,
        { type: previewMeta.mimeType },
      );
      setRecordedFile(file);
      setPreviewFile(nextPreviewFile);
      setRecordedDurationSec(durationSec ?? 0);
      toast({
        title: 'Recording complete',
        description: 'Your microphone recording is ready to preview or export.',
      });
    },
  });

  const {
    isLive,
    error: liveError,
    stageState,
    startLive,
    stopLive,
    clearError: clearLiveError,
  } = useBroadcastLiveSession({
    profileId: selectedProfileId,
    profileName: selectedProfile?.name ?? null,
    assets: selectedAssets,
    settings,
    audioProcessing: liveAudioProcessing,
    inputStream: activeStream,
  });
  const {
    isPlaying: isPreviewPlaying,
    previewState,
    playPause: playPausePreview,
    cleanup: cleanupPreview,
  } = useBroadcastRecordingPreview({
    file: previewFile ?? recordedFile,
    frames: recordingFrames,
    fallbackState: stageState,
  });

  useEffect(() => {
    return () => {
      cleanupPreview();
    };
  }, [cleanupPreview]);

  useEffect(() => {
    if (!selectedProfileId && isLive) {
      stopLive();
    }
  }, [isLive, selectedProfileId, stopLive]);

  useEffect(() => {
    if (isRecording) {
      setRecordingFrames([]);
      setRecordingStartedAt(Date.now());
      cleanupPreview();
      return;
    }

    setRecordingStartedAt(null);
  }, [cleanupPreview, isRecording]);

  useEffect(() => {
    if (!isRecording || recordingStartedAt === null) {
      return;
    }

    setRecordingFrames((current) => {
      const nextFrame: BroadcastRecordingFrame = {
        timeMs: Math.max(0, Date.now() - recordingStartedAt),
        state: {
          ...stageState,
          assets: { ...stageState.assets },
        },
      };

      const lastFrame = current[current.length - 1];
      if (
        lastFrame &&
        lastFrame.state.talking === nextFrame.state.talking &&
        lastFrame.state.blinkClosed === nextFrame.state.blinkClosed &&
        Math.abs(lastFrame.state.bounceOffsetPx - nextFrame.state.bounceOffsetPx) < 0.25 &&
        Math.abs(lastFrame.state.headOffsetX - nextFrame.state.headOffsetX) < 0.25 &&
        Math.abs(lastFrame.state.headOffsetY - nextFrame.state.headOffsetY) < 0.25 &&
        nextFrame.timeMs - lastFrame.timeMs < 24
      ) {
        return current;
      }

      return [...current, nextFrame];
    });
  }, [isRecording, recordingStartedAt, stageState]);
  useEffect(() => {
    if (recordingError) {
      toast({
        title: 'Recording error',
        description: recordingError,
        variant: 'destructive',
      });
    }
  }, [recordingError, toast]);

  useEffect(() => {
    if (liveError) {
      toast({
        title: 'Live mode error',
        description: liveError,
        variant: 'destructive',
      });
      clearLiveError();
    }
  }, [clearLiveError, liveError, toast]);

  const handleOpenPopout = async () => {
    try {
      await platform.lifecycle.openBroadcastOutputWindow();
      setPopoutOpen(true);
    } catch (error) {
      toast({
        title: 'Failed to open broadcast output',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleFocusPopout = async () => {
    await platform.lifecycle.focusBroadcastOutputWindow();
  };

  const handleClosePopout = async () => {
    await platform.lifecycle.closeBroadcastOutputWindow();
    setPopoutOpen(false);
  };

  const handleCancelRecordedClip = () => {
    cancelRecording();
    setRecordedFile(null);
    setPreviewFile(null);
    setRecordedDurationSec(0);
    setRecordingFrames([]);
    setCaptionText('');
    cleanupPreview();
  };

  const handleTranscribe = async () => {
    if (!recordedFile) {
      return;
    }
    try {
      const transcriptionLanguage =
        selectedProfile?.language && selectedProfile.language in SUPPORTED_LANGUAGES
          ? (selectedProfile.language as LanguageCode)
          : 'auto';
      const result = await transcribe.mutateAsync({
        file: recordedFile,
        language: transcriptionLanguage,
      });
      setCaptionText(result.text);
      toast({
        title: 'Transcription complete',
        description: `Caption text was filled using ${transcriptionLanguage === 'auto' ? 'auto-detect' : selectedProfileLanguage ?? transcriptionLanguage}.`,
      });
    } catch (error) {
      toast({
        title: 'Transcription failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExportAudio = async () => {
    if (!recordedFile) {
      return;
    }

    try {
      const url = URL.createObjectURL(recordedFile);
      const link = document.createElement('a');
      link.href = url;
      link.download = recordedFile.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({
        title: 'Audio exported',
        description: `Saved ${recordedFile.name}.`,
      });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExportSrt = async () => {
    const srtText = buildSrtFromCaptionText(captionText, recordedDurationSec || duration);
    if (!srtText) {
      toast({
        title: 'No captions to export',
        description: 'Add caption text or transcribe the recording first.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const blob = new Blob([srtText], { type: 'application/x-subrip' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `broadcast-recording-${Date.now()}.srt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({
        title: 'SRT exported',
        description: 'Saved subtitle file.',
      });
    } catch (error) {
      toast({
        title: 'SRT export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExportMov = async () => {
    if (!selectedProfileId || !recordedFile) {
      return;
    }

    setIsExportingMov(true);
    try {
      const backgroundImage = settings.use_background_image
        ? await getPersistedVibeTubeBackgroundImageFileAsync()
        : undefined;
      const trimmedCaption = captionText.trim();
      const render = await apiClient.renderVibeTubeFromAudio({
        profile_id: selectedProfileId,
        audio: recordedFile,
        caption_text: trimmedCaption || undefined,
        fps: settings.fps,
        width: settings.width,
        height: settings.height,
        on_threshold: settings.on_threshold,
        off_threshold: settings.off_threshold,
        smoothing_windows: settings.smoothing_windows,
        min_hold_windows: settings.min_hold_windows,
        blink_min_interval_sec: settings.blink_min_interval_sec,
        blink_max_interval_sec: settings.blink_max_interval_sec,
        blink_duration_frames: settings.blink_duration_frames,
        head_motion_amount_px: settings.head_motion_amount_px,
        head_motion_change_sec: settings.head_motion_change_sec,
        head_motion_smoothness: settings.head_motion_smoothness,
        voice_bounce_amount_px: settings.voice_bounce_amount_px,
        voice_bounce_sensitivity: settings.voice_bounce_sensitivity,
        use_background: settings.use_background,
        use_background_color: settings.use_background_color,
        use_background_image: settings.use_background_image,
        background_color: settings.background_color,
        subtitle_enabled: settings.subtitle_enabled && Boolean(trimmedCaption),
        subtitle_style: settings.subtitle_style,
        subtitle_text_color: settings.subtitle_text_color,
        subtitle_outline_color: settings.subtitle_outline_color,
        subtitle_outline_width: settings.subtitle_outline_width,
        subtitle_font_family: settings.subtitle_font_family,
        subtitle_bold: settings.subtitle_bold,
        subtitle_italic: settings.subtitle_italic,
        show_profile_names: settings.show_profile_names,
        background_image: backgroundImage,
      });

      const blob = await apiClient.exportVibeTubeVideo(render.job_id, 'mov');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `broadcast-${render.job_id}.mov`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({
        title: 'MOV exported',
        description: 'Saved transparent MOV export.',
      });
    } catch (error) {
      toast({
        title: 'MOV export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsExportingMov(false);
    }
  };

  const canUseBroadcast = Boolean(selectedProfileId && selectedPack?.complete);

  return (
    <div className="h-full overflow-y-auto py-6">
      <div className="space-y-6">
        <section className="rounded-2xl border bg-card/50 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold">Broadcast</h1>
              <p className="text-sm text-muted-foreground">
                Record your own voice into VibeTube video or run a live PNG avatar for stream use.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {platform.metadata.isTauri && (
                <>
                  <Button variant="outline" onClick={handleOpenPopout}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Output
                  </Button>
                  <Button variant="outline" onClick={handleFocusPopout} disabled={!popoutOpen}>
                    Show Output
                  </Button>
                  <Button variant="outline" onClick={handleClosePopout} disabled={!popoutOpen}>
                    Close Output
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={() => setObsGuideOpen(true)}>
                <BookOpen className="mr-2 h-4 w-4" />
                OBS Guide
              </Button>
              <Link to="/vibetube" className="inline-flex">
                <Button variant="outline">Render Settings</Button>
              </Link>
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[320px,1fr]">
            <div className="space-y-2">
              <Label>Broadcast Profile</Label>
              <Select
                value={selectedProfileId ?? ''}
                onValueChange={(value) => {
                  if (isLive) {
                    stopLive();
                  }
                  setSelectedProfileId(value || null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  {availableProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Broadcast mode only lists profiles with a complete 4-state VibeTube avatar pack.
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
              {isLoading || avatarPacksQuery.isLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading broadcast profiles...</span>
                </div>
              ) : availableProfiles.length === 0 ? (
                <div className="space-y-2">
                  <p>No complete VibeTube avatar packs are available yet.</p>
                  <Link to="/characters" className="inline-flex">
                    <Button variant="outline" size="sm">
                      Go to Profiles
                    </Button>
                  </Link>
                </div>
              ) : canUseBroadcast ? (
                <div className="space-y-1">
                  <p>
                    Using <span className="font-medium text-foreground">{selectedProfile?.name}</span>{' '}
                    for live animation and recorded renders.
                  </p>
                  {selectedProfileLanguage ? (
                    <p>
                      Language:{' '}
                      <span className="font-medium text-foreground">{selectedProfileLanguage}</span>
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  <p>Select a profile to continue.</p>
                  <Link to="/characters" className="inline-flex">
                    <Button variant="outline" size="sm">
                      Manage Profiles
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'live' | 'record')}>
          <TabsList className="grid w-full max-w-[340px] grid-cols-2">
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="record">Record</TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="mt-4 space-y-4">
            <div className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
              <BroadcastStage
                state={stageState}
                transparent
                checkerboard
                showStatus
                className="min-h-[460px]"
              />
              <section className="rounded-2xl border bg-card/50 p-5 space-y-5">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold">Live Microphone Animation</h2>
                  <p className="text-sm text-muted-foreground">
                    Drive the selected PNG avatar from your microphone and mirror it to the desktop output window.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => void startLive()} disabled={!canUseBroadcast || isLive}>
                    <Radio className="mr-2 h-4 w-4" />
                    Start Live
                  </Button>
                  <Button variant="outline" onClick={stopLive} disabled={!isLive}>
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                </div>

                <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
                  <p>
                    The pop-out is desktop-only. In the web build you still get the in-app live preview, but not the dedicated OBS output window.
                  </p>
                </div>

                {!canUseBroadcast && (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
                    Broadcast mode is disabled until the selected profile has idle, talk, idle blink,
                    and talk blink PNG states.
                  </div>
                )}
              </section>
            </div>
          </TabsContent>

          <TabsContent value="record" className="mt-4 space-y-4">
            <div className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
              <BroadcastStage
                state={previewState ?? stageState}
                transparent
                checkerboard
                className="min-h-[460px]"
              />
              <section className="rounded-2xl border bg-card/50 p-5 space-y-5">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold">Record a Broadcast Clip</h2>
                  <p className="text-sm text-muted-foreground">
                    Capture your microphone, preview the live animation playback, then export audio, MOV, or subtitles.
                  </p>
                </div>

                {!recordedFile && !isRecording && (
                  <Button onClick={() => void startRecording()} disabled={!canUseBroadcast}>
                    <Mic className="mr-2 h-4 w-4" />
                    Start Recording
                  </Button>
                )}

                {isRecording && (
                  <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 rounded-full bg-accent animate-pulse" />
                      Recording {duration.toFixed(1)}s
                    </div>
                    <Button onClick={stopRecording}>
                      <Square className="mr-2 h-4 w-4" />
                      Stop Recording
                    </Button>
                  </div>
                )}

                <AudioProcessingControls
                  audioProcessing={recordAudioProcessing}
                  onAudioProcessingChange={setRecordAudioProcessing}
                  idPrefix="broadcast-record"
                />

                {recordedFile && !isRecording && (
                  <div className="space-y-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
                    <div className="text-sm">
                      <div className="font-medium">Recording ready</div>
                      <div className="text-muted-foreground">{recordedFile.name}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => void playPausePreview()}
                        disabled={recordingFrames.length === 0}
                      >
                        <Play className="mr-2 h-4 w-4" />
                        {isPreviewPlaying ? 'Pause Preview' : 'Play Preview'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void handleTranscribe()}
                        disabled={transcribe.isPending}
                      >
                        {transcribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Transcribe
                      </Button>
                      <Button variant="outline" onClick={handleCancelRecordedClip}>
                        Record Again
                      </Button>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="broadcast-caption-text">Caption Text</Label>
                  <Textarea
                    id="broadcast-caption-text"
                    value={captionText}
                    onChange={(event) => setCaptionText(event.target.value)}
                    placeholder="Optional text for subtitles or SRT output..."
                    className="min-h-[120px]"
                  />
                  <p className="text-xs text-muted-foreground">
                    If this is blank, the render will stay subtitle-free even when subtitles are enabled globally.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void handleExportAudio()} disabled={!recordedFile}>
                    <Download className="mr-2 h-4 w-4" />
                    Export Audio
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleExportMov()}
                    disabled={!canUseBroadcast || !recordedFile || isExportingMov}
                  >
                    {isExportingMov ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Clapperboard className="mr-2 h-4 w-4" />
                    )}
                    {isExportingMov ? 'Exporting MOV...' : 'Export MOV'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleExportSrt()}
                    disabled={!captionText.trim()}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export SRT
                  </Button>
                </div>
              </section>
            </div>
          </TabsContent>
        </Tabs>
      </div>
      <ObsGuideDialog
        open={obsGuideOpen}
        onOpenChange={setObsGuideOpen}
        isDesktopApp={platform.metadata.isTauri}
      />
    </div>
  );
}
