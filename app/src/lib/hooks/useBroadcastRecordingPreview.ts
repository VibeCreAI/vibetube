import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastStageState } from '@/lib/utils/broadcastSession';

export interface BroadcastRecordingFrame {
  timeMs: number;
  state: BroadcastStageState;
}

interface UseBroadcastRecordingPreviewOptions {
  file: File | null;
  frames: BroadcastRecordingFrame[];
  fallbackState: BroadcastStageState;
}

function cloneStageState(state: BroadcastStageState): BroadcastStageState {
  return {
    ...state,
    assets: { ...state.assets },
  };
}

export function useBroadcastRecordingPreview({
  file,
  frames,
  fallbackState,
}: UseBroadcastRecordingPreviewOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewState, setPreviewState] = useState<BroadcastStageState | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const animationRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setIsPlaying(false);
    setPreviewState(null);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const playPause = useCallback(async () => {
    if (!file || frames.length === 0) {
      return;
    }

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
        return;
      }

      await audioRef.current.play().catch(() => {});
      setIsPlaying(true);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio(objectUrl);
    audioRef.current = audio;
    urlRef.current = objectUrl;
    setPreviewState(cloneStageState(frames[0]?.state ?? fallbackState));

    const updateFrame = () => {
      if (!audioRef.current) {
        return;
      }

      const currentTimeMs = Math.max(0, audioRef.current.currentTime * 1000);
      let selectedFrame = frames[0];
      for (const frame of frames) {
        if (frame.timeMs > currentTimeMs) {
          break;
        }
        selectedFrame = frame;
      }

      if (selectedFrame) {
        setPreviewState({
          ...cloneStageState(selectedFrame.state),
          live: false,
          updatedAt: Date.now(),
        });
      }

      if (!audioRef.current.paused && !audioRef.current.ended) {
        animationRef.current = window.requestAnimationFrame(updateFrame);
      }
    };

    audio.addEventListener('play', () => {
      setIsPlaying(true);
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
      }
      animationRef.current = window.requestAnimationFrame(updateFrame);
    });

    audio.addEventListener('pause', () => {
      setIsPlaying(false);
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    });

    audio.addEventListener('ended', cleanup);
    audio.addEventListener('error', cleanup);

    await audio.play().catch(() => {
      cleanup();
    });
  }, [cleanup, fallbackState, file, frames, isPlaying]);

  return {
    isPlaying,
    previewState,
    playPause,
    cleanup,
  };
}
