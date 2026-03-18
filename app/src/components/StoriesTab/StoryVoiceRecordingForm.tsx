import { Loader2, Mic, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import type { VoiceProfileResponse } from '@/lib/api/types';
import { SUPPORTED_LANGUAGES, type LanguageCode } from '@/lib/constants/languages';
import { useAudioPlayer } from '@/lib/hooks/useAudioPlayer';
import { useAudioRecording, type AudioProcessingOptions } from '@/lib/hooks/useAudioRecording';
import { useTranscription } from '@/lib/hooks/useTranscription';

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

interface StoryVoiceRecordingFormProps {
  profiles: VoiceProfileResponse[];
  initialProfileId?: string | null;
  initialLanguage?: LanguageCode;
  initialText?: string;
  isSubmitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  resetKey: string;
  onSubmit: (payload: {
    file: File;
    profileId: string;
    language: LanguageCode;
    text: string;
  }) => Promise<void> | void;
}

export function StoryVoiceRecordingForm({
  profiles,
  initialProfileId,
  initialLanguage = 'en',
  initialText = '',
  isSubmitting,
  submitLabel,
  submittingLabel,
  resetKey,
  onSubmit,
}: StoryVoiceRecordingFormProps) {
  const { toast } = useToast();
  const transcribe = useTranscription();
  const { isPlaying, playPause, cleanup } = useAudioPlayer();
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [profileId, setProfileId] = useState<string>(initialProfileId ?? '');
  const [language, setLanguage] = useState<LanguageCode>(initialLanguage);
  const [text, setText] = useState(initialText);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingOptions>({
    autoGainControl: true,
    noiseSuppression: true,
    echoCancellation: true,
  });
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === profileId) ?? null,
    [profileId, profiles],
  );

  const {
    isRecording,
    duration,
    error: recordingError,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording({
    maxDurationSeconds: 120,
    audioProcessing,
    onRecordingComplete: (blob) => {
      const timestamp = Date.now();
      const { extension, mimeType } = getRecordedFileMetadata(blob);
      setRecordedFile(
        new File([blob], `story-recording-${timestamp}.${extension}`, {
          type: mimeType,
        }),
      );
      toast({
        title: 'Recording complete',
        description: 'Your voice clip is ready.',
      });
    },
  });

  useEffect(() => {
    if (!profiles.length) {
      setProfileId('');
      return;
    }
    if (!initialProfileId || !profiles.some((profile) => profile.id === initialProfileId)) {
      setProfileId(profiles[0]?.id ?? '');
      return;
    }
    setProfileId(initialProfileId);
  }, [initialProfileId, profiles, resetKey]);

  useEffect(() => {
    setLanguage(initialLanguage);
    setText(initialText);
    setRecordedFile(null);
    cleanup();
  }, [cleanup, initialLanguage, initialText, resetKey]);

  useEffect(() => {
    if (!selectedProfile?.language) {
      return;
    }
    if (selectedProfile.language in SUPPORTED_LANGUAGES) {
      setLanguage(selectedProfile.language as LanguageCode);
    }
  }, [selectedProfile?.id, selectedProfile?.language]);

  useEffect(() => {
    if (!recordingError) {
      return;
    }
    toast({
      title: 'Recording error',
      description: recordingError,
      variant: 'destructive',
    });
  }, [recordingError, toast]);

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
      setText(result.text);
    } catch (error) {
      toast({
        title: 'Transcription failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleRecordAgain = () => {
    cancelRecording();
    setRecordedFile(null);
    cleanup();
  };

  const handleSubmit = async () => {
    if (!recordedFile || !profileId) {
      return;
    }
    await onSubmit({
      file: recordedFile,
      profileId,
      language,
      text: text.trim(),
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Voice</Label>
          <Select value={profileId} onValueChange={setProfileId} disabled={isSubmitting}>
            <SelectTrigger>
              <SelectValue placeholder="Select a voice" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((profile) => (
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
            onValueChange={(value: LanguageCode) => setLanguage(value)}
            disabled={isSubmitting}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SUPPORTED_LANGUAGES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!recordedFile && !isRecording && (
        <Button type="button" onClick={() => void startRecording()} disabled={isSubmitting || !profileId}>
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
          <Button type="button" onClick={stopRecording} disabled={isSubmitting}>
            <Square className="mr-2 h-4 w-4" />
            Stop Recording
          </Button>
        </div>
      )}

      <AudioProcessingControls
        audioProcessing={audioProcessing}
        onAudioProcessingChange={setAudioProcessing}
        idPrefix="story-record"
      />

      {recordedFile && !isRecording && (
        <div className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <div className="text-sm">
            <div className="font-medium">Recording ready</div>
            <div className="text-muted-foreground">{recordedFile.name}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void playPause(recordedFile)}>
              <Play className="mr-2 h-4 w-4" />
              {isPlaying ? 'Pause Preview' : 'Play Preview'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTranscribe()}
              disabled={transcribe.isPending || isSubmitting}
            >
              {transcribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Transcribe
            </Button>
            <Button type="button" variant="outline" onClick={handleRecordAgain} disabled={isSubmitting}>
              Record Again
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label>Text</Label>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="min-h-[110px]"
          placeholder="Optional transcript or note for this clip..."
          disabled={isSubmitting}
        />
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !recordedFile || !profileId}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {submittingLabel}
            </>
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </div>
  );
}
