import { useCallback, useRef, useState } from 'react';
import { useToast } from '@/components/ui/use-toast';

export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const fileKeyRef = useRef<string | null>(null);
  const tearingDownRef = useRef(false);
  const { toast } = useToast();

  const cleanup = useCallback(() => {
    tearingDownRef.current = true;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }

    fileKeyRef.current = null;
    setIsPlaying(false);

    queueMicrotask(() => {
      tearingDownRef.current = false;
    });
  }, []);

  const playPause = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;

      const nextFileKey = `${file.name}:${file.size}:${file.lastModified}`;
      const isSameFile = fileKeyRef.current === nextFileKey;

      if (audioRef.current && isSameFile) {
        if (isPlaying) {
          audioRef.current.pause();
          setIsPlaying(false);
          return;
        }

        try {
          await audioRef.current.play();
          setIsPlaying(true);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            toast({
              title: 'Playback error',
              description: 'Failed to play audio file',
              variant: 'destructive',
            });
          }
          setIsPlaying(false);
        }
        return;
      }

      cleanup();

      const objectUrl = URL.createObjectURL(file);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      urlRef.current = objectUrl;
      fileKeyRef.current = nextFileKey;

      audio.addEventListener('ended', () => {
        cleanup();
      });

      audio.addEventListener('error', () => {
        if (tearingDownRef.current) {
          cleanup();
          return;
        }

        toast({
          title: 'Playback error',
          description: 'Failed to play audio file',
          variant: 'destructive',
        });
        cleanup();
      });

      try {
        await audio.play();
        setIsPlaying(true);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          toast({
            title: 'Playback error',
            description: 'Failed to play audio file',
            variant: 'destructive',
          });
        }
        cleanup();
      }
    },
    [cleanup, isPlaying, toast],
  );

  return {
    isPlaying,
    playPause,
    cleanup,
  };
}
