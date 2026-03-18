import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/platform/PlatformContext';
import { convertToWav } from '@/lib/utils/audio';

interface UseAudioRecordingOptions {
  maxDurationSeconds?: number;
  onRecordingComplete?: (
    blob: Blob,
    duration?: number,
    meta?: { previewBlob: Blob; convertedToWav: boolean },
  ) => void;
  audioProcessing?: AudioProcessingOptions;
}

export interface AudioProcessingOptions {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export function useAudioRecording({
  maxDurationSeconds = 29,
  onRecordingComplete,
  audioProcessing = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}: UseAudioRecordingOptions = {}) {
  const platform = usePlatform();
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const cancelledRef = useRef<boolean>(false);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      chunksRef.current = [];
      cancelledRef.current = false;
      setDuration(0);

      // Check if getUserMedia is available
      // In Tauri, navigator.mediaDevices might not be available immediately
      if (typeof navigator === 'undefined') {
        const errorMsg =
          'Navigator API is not available. This might be a Tauri configuration issue.';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // Try waiting a bit for Tauri webview to initialize
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          console.error('MediaDevices check:', {
            hasNavigator: typeof navigator !== 'undefined',
            hasMediaDevices: !!navigator?.mediaDevices,
            hasGetUserMedia: !!navigator?.mediaDevices?.getUserMedia,
            isTauri: platform.metadata.isTauri,
          });

          const errorMsg = platform.metadata.isTauri
            ? 'Microphone access is not available. Please ensure:\n1. The app has microphone permissions in System Settings (macOS: System Settings > Privacy & Security > Microphone)\n2. You restart the app after granting permissions\n3. You are using Tauri v2 with a webview that supports getUserMedia'
            : 'Microphone access is not available. Please ensure you are using a secure context (HTTPS or localhost) and that your browser has microphone permissions enabled.';
          setError(errorMsg);
          throw new Error(errorMsg);
        }
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: audioProcessing.echoCancellation,
          noiseSuppression: audioProcessing.noiseSuppression,
          autoGainControl: audioProcessing.autoGainControl,
        },
      });

      streamRef.current = stream;
      setActiveStream(stream);

      // Create MediaRecorder with preferred MIME type
      const options: MediaRecorderOptions = {
        mimeType: 'audio/webm;codecs=opus',
      };

      // Fallback to default if webm not supported
      if (!MediaRecorder.isTypeSupported(options.mimeType!)) {
        delete options.mimeType;
      }

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Snapshot the cancellation flag and recorded duration immediately —
        // cancelRecording() clears chunks and sets cancelledRef synchronously
        // before this async handler runs, so we must check it first.
        const wasCancelled = cancelledRef.current;
        const recordedDuration = startTimeRef.current
          ? (Date.now() - startTimeRef.current) / 1000
          : undefined;

        const recordedMimeType =
          mediaRecorder.mimeType || chunksRef.current[0]?.type || 'audio/webm;codecs=opus';
        const recordedBlob = new Blob(chunksRef.current, { type: recordedMimeType });

        // Stop all tracks now that we have the data
        streamRef.current?.getTracks().forEach((track) => {
          track.stop();
        });
        streamRef.current = null;
        setActiveStream(null);

        // Don't fire completion callback if the recording was cancelled
        if (wasCancelled) return;

        // Convert to WAV format to avoid needing ffmpeg on backend
        try {
          const wavBlob = await convertToWav(recordedBlob);
          onRecordingComplete?.(wavBlob, recordedDuration, {
            previewBlob: recordedBlob,
            convertedToWav: true,
          });
        } catch (err) {
          console.error('Error converting audio to WAV:', err);
          // Fallback to original blob if conversion fails
          onRecordingComplete?.(recordedBlob, recordedDuration, {
            previewBlob: recordedBlob,
            convertedToWav: false,
          });
        }
      };

      mediaRecorder.onerror = (event) => {
        setError('Recording error occurred');
        console.error('MediaRecorder error:', event);
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      startTimeRef.current = Date.now();

      // Start timer
      timerRef.current = window.setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          setDuration(elapsed);

          // Auto-stop at max duration
          if (elapsed >= maxDurationSeconds) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              mediaRecorderRef.current.stop();
              setIsRecording(false);
              if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
            }
          }
        }
      }, 100);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : 'Failed to access microphone. Please check permissions.';
      setError(errorMessage);
      setIsRecording(false);
    }
  }, [audioProcessing, maxDurationSeconds, onRecordingComplete]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);

      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [isRecording]);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      cancelledRef.current = true; // Must be set before stop() triggers onstop
      chunksRef.current = [];
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setDuration(0);
    }

    // Stop all tracks
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
    setActiveStream(null);

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      setActiveStream(null);
    };
  }, []);

  return {
    isRecording,
    duration,
    error,
    activeStream,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
