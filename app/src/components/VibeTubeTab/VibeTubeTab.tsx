import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clapperboard,
  Download,
  Eye,
  Film,
  Info,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { VibeTubeJobResponse, VibeTubeRenderResponse } from '@/lib/api/types';
import { useHistory } from '@/lib/hooks/useHistory';
import { useProfiles } from '@/lib/hooks/useProfiles';

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'ru', label: 'Russian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
] as const;

type RenderSourceMode = 'history' | 'text';
type AvatarStateKey = 'idle' | 'talk' | 'idle_blink' | 'talk_blink';

interface AvatarStateDef {
  key: AvatarStateKey;
  title: string;
  helper: string;
  required: boolean;
}

const AVATAR_STATE_DEFS: AvatarStateDef[] = [
  {
    key: 'idle',
    title: 'Eyes Open + Mouth Closed (Idle)',
    helper: 'Default resting face. Transparent PNG recommended.',
    required: true,
  },
  {
    key: 'talk',
    title: 'Eyes Open + Mouth Open (Talking)',
    helper: 'Speaking state shown during detected voice activity.',
    required: true,
  },
  {
    key: 'idle_blink',
    title: 'Eyes Closed + Mouth Closed (Blink Idle)',
    helper: 'Optional blink variation while idle.',
    required: false,
  },
  {
    key: 'talk_blink',
    title: 'Eyes Closed + Mouth Open (Blink Talking)',
    helper: 'Optional blink variation while talking.',
    required: false,
  },
];

interface AvatarFiles {
  idle: File | null;
  talk: File | null;
  idle_blink: File | null;
  talk_blink: File | null;
}

interface AvatarPreviewUrls {
  idle: string | null;
  talk: string | null;
  idle_blink: string | null;
  talk_blink: string | null;
}

function clipText(value: string, max = 88): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max).trimEnd()}...` : value;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(seconds?: number): string {
  if (seconds == null || Number.isNaN(seconds)) return '--';
  return `${seconds.toFixed(1)}s`;
}

function buildPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function VibeTubeTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profiles } = useProfiles();
  const { data: historyData } = useHistory({ limit: 1000 });

  const jobsQuery = useQuery({
    queryKey: ['vibetube-jobs'],
    queryFn: () => apiClient.listVibeTubeJobs(),
  });

  const [profileId, setProfileId] = useState('');
  const [language, setLanguage] = useState<(typeof LANGUAGE_OPTIONS)[number]['value']>('en');
  const [sourceMode, setSourceMode] = useState<RenderSourceMode>('history');
  const [generationId, setGenerationId] = useState('');
  const [text, setText] = useState('');

  const [fps, setFps] = usePersistedNumber('vibetube.settings.fps', 30);
  const [width, setWidth] = usePersistedNumber('vibetube.settings.width', 512);
  const [height, setHeight] = usePersistedNumber('vibetube.settings.height', 512);
  const [onThreshold, setOnThreshold] = usePersistedNumber('vibetube.settings.onThreshold', 0.024);
  const [offThreshold, setOffThreshold] = usePersistedNumber('vibetube.settings.offThreshold', 0.016);
  const [smoothingWindows, setSmoothingWindows] = usePersistedNumber('vibetube.settings.smoothingWindows', 3);
  const [minHoldWindows, setMinHoldWindows] = usePersistedNumber('vibetube.settings.minHoldWindows', 1);
  const [blinkMinIntervalSec, setBlinkMinIntervalSec] = usePersistedNumber('vibetube.settings.blinkMinIntervalSec', 3.5);
  const [blinkMaxIntervalSec, setBlinkMaxIntervalSec] = usePersistedNumber('vibetube.settings.blinkMaxIntervalSec', 5.5);
  const [blinkDurationFrames, setBlinkDurationFrames] = usePersistedNumber('vibetube.settings.blinkDurationFrames', 3);
  const [headMotionAmountPx, setHeadMotionAmountPx] = usePersistedNumber('vibetube.settings.headMotionAmountPx', 3.0);
  const [headMotionChangeSec, setHeadMotionChangeSec] = usePersistedNumber('vibetube.settings.headMotionChangeSec', 2.8);
  const [headMotionSmoothness, setHeadMotionSmoothness] = usePersistedNumber('vibetube.settings.headMotionSmoothness', 0.04);

  const [avatarFiles, setAvatarFiles] = useState<AvatarFiles>({
    idle: null,
    talk: null,
    idle_blink: null,
    talk_blink: null,
  });
  const [avatarPreviews, setAvatarPreviews] = useState<AvatarPreviewUrls>({
    idle: null,
    talk: null,
    idle_blink: null,
    talk_blink: null,
  });

  const [hasSavedPack, setHasSavedPack] = useState(false);
  const [isPackLoading, setIsPackLoading] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [result, setResult] = useState<VibeTubeRenderResponse | null>(null);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());

  const deleteJobMutation = useMutation({
    mutationFn: (jobId: string) => apiClient.deleteVibeTubeJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] });
      toast({ title: 'Render deleted', description: 'Removed this VibeTube render from history.' });
    },
    onError: (error) => {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const savePackMutation = useMutation({
    mutationFn: async () => {
      if (!profileId) throw new Error('Select a voice profile first.');
      if (!avatarFiles.idle || !avatarFiles.talk || !avatarFiles.idle_blink || !avatarFiles.talk_blink) {
        throw new Error('All 4 avatar states are required to save a reusable pack.');
      }
      return apiClient.saveVibeTubeAvatarPack({
        profileId,
        idle: avatarFiles.idle,
        talk: avatarFiles.talk,
        idleBlink: avatarFiles.idle_blink,
        talkBlink: avatarFiles.talk_blink,
      });
    },
    onSuccess: () => {
      setHasSavedPack(true);
      toast({ title: 'Avatar pack saved', description: 'Saved 4-state avatar pack for this voice profile.' });
    },
    onError: (error) => {
      toast({
        title: 'Could not save avatar pack',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const historyItems = useMemo(() => {
    const items = historyData?.items ?? [];
    if (!profileId) return items;
    return items.filter((item) => item.profile_id === profileId);
  }, [historyData?.items, profileId]);

  useEffect(() => {
    const currentIds = new Set((jobsQuery.data ?? []).map((job) => job.job_id));
    setSelectedJobIds((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (currentIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [jobsQuery.data]);

  useEffect(() => {
    if (!historyItems.length) {
      setGenerationId('');
      return;
    }
    const currentStillValid = historyItems.some((item) => item.id === generationId);
    if (!currentStillValid) {
      setGenerationId(historyItems[0].id);
    }
  }, [generationId, historyItems]);

  useEffect(() => {
    return () => {
      Object.values(avatarPreviews).forEach((url) => {
        if (url?.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, [avatarPreviews]);

  useEffect(() => {
    if (!profileId) {
      setHasSavedPack(false);
      setAvatarPreviews((prev) => ({
        idle: prev.idle?.startsWith('blob:') ? prev.idle : null,
        talk: prev.talk?.startsWith('blob:') ? prev.talk : null,
        idle_blink: prev.idle_blink?.startsWith('blob:') ? prev.idle_blink : null,
        talk_blink: prev.talk_blink?.startsWith('blob:') ? prev.talk_blink : null,
      }));
      return;
    }

    let cancelled = false;
    setIsPackLoading(true);

    apiClient
      .getVibeTubeAvatarPack(profileId)
      .then((pack) => {
        if (cancelled) return;

        const fromFile = (key: AvatarStateKey) => {
          const existing = avatarPreviews[key];
          if (avatarFiles[key] && existing?.startsWith('blob:')) {
            return existing;
          }
          return null;
        };

        setHasSavedPack(pack.complete);
        setAvatarPreviews((prev) => ({
          idle: fromFile('idle') || (pack.idle_url ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'idle')}?t=${Date.now()}` : null),
          talk: fromFile('talk') || (pack.talk_url ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'talk')}?t=${Date.now()}` : null),
          idle_blink:
            fromFile('idle_blink') ||
            (pack.idle_blink_url
              ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'idle_blink')}?t=${Date.now()}`
              : null),
          talk_blink:
            fromFile('talk_blink') ||
            (pack.talk_blink_url
              ? `${apiClient.getVibeTubeAvatarStateUrl(profileId, 'talk_blink')}?t=${Date.now()}`
              : null),
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setHasSavedPack(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const setAvatarFile = (key: AvatarStateKey, file: File | null) => {
    setAvatarFiles((prev) => ({ ...prev, [key]: file }));
    setAvatarPreviews((prev) => {
      const previousUrl = prev[key];
      if (previousUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(previousUrl);
      }
      return {
        ...prev,
        [key]: file ? buildPreviewUrl(file) : null,
      };
    });
  };

  const onRender = async () => {
    if (!profileId) {
      toast({ title: 'Select a voice', description: 'Choose a voice profile first.', variant: 'destructive' });
      return;
    }

    if (sourceMode === 'history' && !generationId) {
      toast({ title: 'Select source audio', description: 'Pick a generated audio from history.', variant: 'destructive' });
      return;
    }

    if (sourceMode === 'text' && !text.trim()) {
      toast({ title: 'Missing text', description: 'Enter text when using text mode.', variant: 'destructive' });
      return;
    }

    const hasUploadedRequiredStates = Boolean(avatarFiles.idle && avatarFiles.talk);
    if (!hasUploadedRequiredStates && !hasSavedPack) {
      toast({
        title: 'Avatar states missing',
        description: 'Upload idle + talk images or save/load a 4-state pack for this profile.',
        variant: 'destructive',
      });
      return;
    }

    setIsRendering(true);
    try {
      const response = await apiClient.renderVibeTube({
        profile_id: profileId,
        language,
        text: sourceMode === 'text' ? text.trim() : undefined,
        generation_id: sourceMode === 'history' ? generationId : undefined,
        fps,
        width,
        height,
        on_threshold: onThreshold,
        off_threshold: offThreshold,
        smoothing_windows: smoothingWindows,
        min_hold_windows: minHoldWindows,
        blink_min_interval_sec: blinkMinIntervalSec,
        blink_max_interval_sec: blinkMaxIntervalSec,
        blink_duration_frames: blinkDurationFrames,
        head_motion_amount_px: headMotionAmountPx,
        head_motion_change_sec: headMotionChangeSec,
        head_motion_smoothness: headMotionSmoothness,
        idle: avatarFiles.idle || undefined,
        talk: avatarFiles.talk || undefined,
        idle_blink: avatarFiles.idle_blink || undefined,
        talk_blink: avatarFiles.talk_blink || undefined,
      });

      setResult(response);
      queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] });

      toast({
        title: 'Render complete',
        description: `Job ${response.job_id.slice(0, 8)} is ready in preview and render history.`,
      });
    } catch (error) {
      toast({
        title: 'Render failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsRendering(false);
    }
  };

  const onSelectJob = (job: VibeTubeJobResponse) => {
    setResult({
      job_id: job.job_id,
      output_dir: '',
      video_path: job.video_path || '',
      timeline_path: '',
      meta_path: '',
      captions_path: undefined,
      duration: job.duration_sec || 0,
      source_generation_id: undefined,
    });
  };

  const onDeleteJob = async (job: VibeTubeJobResponse) => {
    const confirmed = await confirm(
      `Delete VibeTube render ${job.job_id.slice(0, 8)}? This removes all files for this render.`,
    );
    if (!confirmed) return;

    deleteJobMutation.mutate(job.job_id, {
      onSuccess: () => {
        if (result?.job_id === job.job_id) {
          setResult(null);
        }
      },
    });
  };

  const toggleJobSelection = (jobId: string, checked: boolean) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(jobId);
      } else {
        next.delete(jobId);
      }
      return next;
    });
  };

  const toggleSelectAllJobs = (checked: boolean) => {
    if (!jobsQuery.data?.length) {
      setSelectedJobIds(new Set());
      return;
    }
    if (!checked) {
      setSelectedJobIds(new Set());
      return;
    }
    setSelectedJobIds(new Set(jobsQuery.data.map((job) => job.job_id)));
  };

  const onDeleteSelectedJobs = async () => {
    if (!selectedJobIds.size) {
      return;
    }
    const confirmed = await confirm(
      `Delete ${selectedJobIds.size} selected VibeTube render(s)? This removes all files for those renders.`,
    );
    if (!confirmed) return;

    setIsBatchDeleting(true);
    try {
      const ids = Array.from(selectedJobIds);
      const results = await Promise.allSettled(ids.map((jobId) => apiClient.deleteVibeTubeJob(jobId)));
      const deletedCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - deletedCount;

      if (result && selectedJobIds.has(result.job_id)) {
        setResult(null);
      }

      setSelectedJobIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] });

      if (failedCount === 0) {
        toast({
          title: 'Renders deleted',
          description: `Deleted ${deletedCount} render(s).`,
        });
      } else {
        toast({
          title: 'Partial delete',
          description: `Deleted ${deletedCount}, failed ${failedCount}.`,
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: 'Batch delete failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const onExportMp4 = async (jobId: string) => {
    try {
      const blob = await apiClient.exportVibeTubeMp4(jobId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vibetube-${jobId}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast({ title: 'MP4 exported', description: 'Saved MP4 copy from this render job.' });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const previewUrl = result ? apiClient.getVibeTubePreviewUrl(result.job_id) : null;
  const jobs = jobsQuery.data ?? [];
  const allJobsSelected = jobs.length > 0 && jobs.every((job) => selectedJobIds.has(job.job_id));

  return (
    <div className="h-full min-h-0 overflow-y-auto xl:overflow-hidden">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_440px] gap-6 min-h-full xl:h-full xl:min-h-0">
        <div className="pr-1 pb-8 space-y-6 xl:overflow-y-auto">
          <section className="space-y-2">
            <h2 className="text-2xl font-bold">VibeTube</h2>
            <p className="text-sm text-muted-foreground">
              Build avatar videos from generated voice history or from new script text.
            </p>
          </section>

          <section className="rounded-xl border bg-card/40 p-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Voice Profile</Label>
                <Select value={profileId} onValueChange={setProfileId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select voice profile..." />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles?.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Language</Label>
                <Select
                  value={language}
                  onValueChange={(value) => setLanguage(value as (typeof LANGUAGE_OPTIONS)[number]['value'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <SelectItem key={lang.value} value={lang.value}>
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Audio Source</Label>
              <Select value={sourceMode} onValueChange={(value) => setSourceMode(value as RenderSourceMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="history">Use Existing Generated Audio</SelectItem>
                  <SelectItem value="text">Generate New Audio from Text</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {sourceMode === 'history' ? (
              <div className="space-y-2">
                <Label>Previously Generated Audio</Label>
                <Select value={generationId} onValueChange={setGenerationId}>
                  <SelectTrigger>
                    <SelectValue placeholder={historyItems.length ? 'Select generated audio...' : 'No generated audio available'} />
                  </SelectTrigger>
                  <SelectContent>
                    {historyItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.profile_name} | {formatDuration(item.duration)} | {clipText(item.text, 54)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Script Text</Label>
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={7}
                  placeholder="Paste the script to generate voice and render avatar..."
                />
              </div>
            )}
          </section>

          <section className="rounded-xl border bg-card/40 p-4 space-y-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Avatar State Images</h3>
              <p className="text-sm text-muted-foreground">
                Upload transparent PNG images for each state. Save all 4 states as a reusable pack for this voice profile.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {AVATAR_STATE_DEFS.map((def) => (
                <div key={def.key} className="rounded-lg border bg-background/60 p-3 space-y-3">
                  <div className="space-y-1">
                    <h4 className="font-medium leading-tight">{def.title}</h4>
                    <p className="text-xs text-muted-foreground">{def.helper}</p>
                  </div>

                  <Input
                    type="file"
                    accept=".png,image/png"
                    onChange={(e) => setAvatarFile(def.key, e.target.files?.[0] ?? null)}
                  />

                  <div className="h-28 w-28 rounded border bg-black/40 flex items-center justify-center overflow-hidden">
                    {avatarPreviews[def.key] ? (
                      <img
                        src={avatarPreviews[def.key] ?? undefined}
                        alt={def.title}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-[11px] text-muted-foreground text-center px-2">
                        {def.required ? 'Required' : 'Optional'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => savePackMutation.mutate()}
                disabled={savePackMutation.isPending || !profileId}
              >
                {savePackMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save 4-State Pack to Voice Profile
              </Button>
              <span className="text-sm text-muted-foreground">
                {isPackLoading
                  ? 'Checking saved pack...'
                  : hasSavedPack
                    ? 'Saved pack detected for this profile. Render works without re-uploading.'
                    : 'No saved pack yet for this profile.'}
              </span>
            </div>
          </section>

          <section className="rounded-xl border bg-card/40 p-4 space-y-4">
            <h3 className="text-base font-semibold">Render Settings</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <NumberField
                label="FPS"
                description="Frames per second. Higher looks smoother but increases render work."
                value={fps}
                min={10}
                max={60}
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
            </div>
            <p className="text-xs text-muted-foreground">
              Lower ON/OFF thresholds make mouth opening more sensitive. Lower blink intervals increase blink frequency.
              Lower head change/smooth settings create slower, subtler motion.
            </p>
          </section>

          <Button size="lg" onClick={onRender} disabled={isRendering}>
            {isRendering ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {isRendering ? 'Rendering VibeTube...' : 'Render VibeTube'}
          </Button>
        </div>

        <aside className="flex flex-col gap-4 pb-8 xl:min-h-0 xl:pb-0">
          <section className="rounded-xl border bg-card/50 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Film className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold">Preview</h3>
            </div>

            {previewUrl ? (
              <div className="space-y-3">
                <video
                  key={result?.job_id}
                  controls
                  className="w-full rounded-md border bg-black"
                  src={previewUrl}
                />
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Job: {result?.job_id.slice(0, 8)}</span>
                  <span>Duration: {formatDuration(result?.duration)}</span>
                </div>
                <Button variant="outline" onClick={() => result && onExportMp4(result.job_id)}>
                  <Download className="h-4 w-4 mr-2" />
                  Export MP4
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Render a job or pick one from history to preview here.</p>
            )}
          </section>

          <section className="rounded-xl border bg-card/50 p-4 xl:flex-1 xl:min-h-0 xl:overflow-hidden">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <Clapperboard className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold">VibeTube Renders</h3>
              </div>
              {jobs.length > 0 && (
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <Checkbox checked={allJobsSelected} onCheckedChange={toggleSelectAllJobs} />
                    Select all
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={onDeleteSelectedJobs}
                    disabled={!selectedJobIds.size || isBatchDeleting}
                  >
                    {isBatchDeleting ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Delete selected{selectedJobIds.size ? ` (${selectedJobIds.size})` : ''}
                  </Button>
                </div>
              )}
            </div>

            {jobsQuery.isLoading ? (
              <div className="py-8 xl:h-full flex items-center justify-center text-sm text-muted-foreground">Loading render history...</div>
            ) : jobs.length ? (
              <div className="space-y-2 pr-1 xl:overflow-y-auto xl:h-full">
                {jobs.map((job) => {
                  const isActive = result?.job_id === job.job_id;
                  return (
                    <div
                      key={job.job_id}
                      className={`rounded-lg border p-3 space-y-2 ${isActive ? 'ring-1 ring-primary border-primary/60 bg-primary/5' : 'bg-background/40'}`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={selectedJobIds.has(job.job_id)}
                          onCheckedChange={(checked) => toggleJobSelection(job.job_id, checked)}
                        />
                        <div className="space-y-1">
                          <p className="text-sm font-medium">{job.job_id.slice(0, 8)}</p>
                          <p className="text-xs text-muted-foreground">{formatTimestamp(job.created_at)}</p>
                          <p className="text-xs text-muted-foreground">Duration: {formatDuration(job.duration_sec)}</p>
                          {(job.source_profile_name || job.source_text_preview || job.source_generation_id) && (
                            <p className="text-xs text-muted-foreground">
                              {job.source_profile_name || 'Unknown voice'} | {formatDuration(job.duration_sec)} |{' '}
                              {clipText(job.source_text_preview || 'No transcript preview', 54)}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => onSelectJob(job)}>
                          <Eye className="h-3.5 w-3.5 mr-1.5" />
                          Preview
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => onExportMp4(job.job_id)}>
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          MP4
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          onClick={() => onDeleteJob(job)}
                          disabled={deleteJobMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 xl:h-full flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
                <Upload className="h-8 w-8 opacity-70" />
                <p className="text-sm">No VibeTube renders yet.</p>
              </div>
            )}
          </section>
        </aside>
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
