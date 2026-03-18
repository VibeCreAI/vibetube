import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioProcessingOptions } from '@/lib/hooks/useAudioRecording';
import type { VibeTubeRenderSettings } from '@/lib/utils/vibetubeSettings';
import {
  BROADCAST_CHANNEL_NAME,
  createIdleBroadcastStageState,
  writeBroadcastSnapshot,
  type BroadcastAvatarAssets,
  type BroadcastStageState,
} from '@/lib/utils/broadcastSession';

interface UseBroadcastLiveSessionOptions {
  profileId: string | null;
  profileName: string | null;
  assets: BroadcastAvatarAssets;
  settings: VibeTubeRenderSettings;
  audioProcessing: AudioProcessingOptions;
  inputStream?: MediaStream | null;
}

type AnalysisAudioContext = AudioContext & {
  setSinkId?: (sinkId: { type: 'none' }) => Promise<void>;
  sinkId?: '' | string | { type: 'none' };
};

type AnalysisAudioContextOptions = AudioContextOptions & {
  sinkId?: { type: 'none' };
};

function buildLiveAudioConstraints(
  audioProcessing: AudioProcessingOptions,
): MediaTrackConstraints & Record<string, unknown> {
  return {
    echoCancellation: audioProcessing.echoCancellation,
    noiseSuppression: audioProcessing.noiseSuppression,
    autoGainControl: audioProcessing.autoGainControl,
    channelCount: 1,
    ...(audioProcessing.echoCancellation
      ? {}
      : {
          googEchoCancellation: false,
          googEchoCancellation2: false,
          googDAEchoCancellation: false,
          googHighpassFilter: false,
        }),
    ...(audioProcessing.noiseSuppression
      ? {}
      : {
          googNoiseSuppression: false,
          googNoiseSuppression2: false,
          googTypingNoiseDetection: false,
        }),
    ...(audioProcessing.autoGainControl
      ? {}
      : {
          googAutoGainControl: false,
          googAutoGainControl2: false,
      }),
  };
}

async function createAnalysisAudioContext(): Promise<AudioContext> {
  const AudioContextCtor = window.AudioContext;

  try {
    const context = new AudioContextCtor({
      latencyHint: 'interactive',
      sinkId: { type: 'none' },
    } as AnalysisAudioContextOptions);
    return context;
  } catch (constructorError) {
    const context = new AudioContextCtor({
      latencyHint: 'interactive',
    }) as AnalysisAudioContext;

    if (typeof context.setSinkId === 'function') {
      try {
        await context.setSinkId({ type: 'none' });
      } catch (sinkError) {
        console.info(
          '[BroadcastLive] Outputless AudioContext sink is not available in this runtime.',
          sinkError,
        );
      }
    } else {
      console.info(
        '[BroadcastLive] AudioContext sink selection is not available in this runtime.',
        constructorError,
      );
    }

    return context;
  }
}

export function useBroadcastLiveSession({
  profileId,
  profileName,
  assets,
  settings,
  audioProcessing,
  inputStream = null,
}: UseBroadcastLiveSessionOptions) {
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageState, setStageState] = useState<BroadcastStageState>(() =>
    createIdleBroadcastStageState(assets, profileId, profileName, settings.show_profile_names),
  );
  const channelRef = useRef<BroadcastChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const levelHistoryRef = useRef<number[]>([]);
  const talkingRef = useRef(false);
  const blinkUntilRef = useRef(0);
  const nextBlinkAtRef = useRef(0);
  const headTargetRef = useRef({ x: 0, y: 0, nextChangeAt: 0 });
  const headCurrentRef = useRef({ x: 0, y: 0 });
  const ownsStreamRef = useRef(false);

  const publishState = useCallback((nextState: BroadcastStageState) => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!channelRef.current) {
      channelRef.current = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    }

    channelRef.current.postMessage(nextState);
    writeBroadcastSnapshot(nextState);
  }, []);

  useEffect(() => {
    const idleState = createIdleBroadcastStageState(
      assets,
      profileId,
      profileName,
      settings.show_profile_names,
    );
    setStageState((current) => {
      if (current.live) {
        return {
          ...current,
          profileId,
          profileName,
          assets,
          showProfileName: settings.show_profile_names,
        };
      }
      return idleState;
    });

    if (!isLive) {
      publishState(idleState);
    }
  }, [assets, isLive, profileId, profileName, publishState, settings.show_profile_names]);

  const stopLive = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    ownsStreamRef.current = false;

    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {
        // Ignore close failures during teardown.
      });
      audioContextRef.current = null;
    }

    levelHistoryRef.current = [];
    talkingRef.current = false;
    blinkUntilRef.current = 0;
    nextBlinkAtRef.current = 0;
    headTargetRef.current = { x: 0, y: 0, nextChangeAt: 0 };
    headCurrentRef.current = { x: 0, y: 0 };

    setIsLive(false);

    const idleState = createIdleBroadcastStageState(
      assets,
      profileId,
      profileName,
      settings.show_profile_names,
    );
    setStageState(idleState);
    publishState(idleState);
  }, [assets, profileId, profileName, publishState, settings.show_profile_names]);

  const startAnalysis = useCallback(
    async (stream: MediaStream, ownsStream: boolean) => {
      if (!profileId) {
        setError('Select a profile before starting live mode.');
        if (ownsStream) {
          stream.getTracks().forEach((track) => track.stop());
        }
        return;
      }

      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }

      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => {});
      }

      const audioContext = (await createAnalysisAudioContext()) as AnalysisAudioContext;
      if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => {});
      }
      console.info('[BroadcastLive] Analysis AudioContext sink:', audioContext.sinkId ?? 'unknown');
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.18;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      streamRef.current = stream;
      ownsStreamRef.current = ownsStream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      sourceRef.current = source;
      levelHistoryRef.current = [];
      talkingRef.current = false;
      nextBlinkAtRef.current = performance.now() + settings.blink_min_interval_sec * 1000;
      headTargetRef.current = { x: 0, y: 0, nextChangeAt: performance.now() };
      headCurrentRef.current = { x: 0, y: 0 };

      const timeData = new Uint8Array(analyser.fftSize);
      setIsLive(true);

      const tick = () => {
        const now = performance.now();
        analyser.getByteTimeDomainData(timeData);

        let sum = 0;
        for (let i = 0; i < timeData.length; i += 1) {
          const value = (timeData[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / timeData.length);

        const history = levelHistoryRef.current;
        history.push(rms);
        const maxHistory = Math.max(1, settings.smoothing_windows);
        while (history.length > maxHistory) {
          history.shift();
        }

        const averagedLevel = history.reduce((total, value) => total + value, 0) / history.length;
        const talking = talkingRef.current
          ? averagedLevel >= settings.off_threshold
          : averagedLevel >= settings.on_threshold;
        talkingRef.current = talking;

        if (now >= nextBlinkAtRef.current) {
          blinkUntilRef.current =
            now + Math.max(16, (settings.blink_duration_frames / settings.fps) * 1000);
          const blinkRangeMs =
            Math.max(0.1, settings.blink_max_interval_sec - settings.blink_min_interval_sec) *
            1000;
          nextBlinkAtRef.current =
            now + settings.blink_min_interval_sec * 1000 + Math.random() * blinkRangeMs;
        }
        const blinkClosed = now < blinkUntilRef.current;

        if (now >= headTargetRef.current.nextChangeAt) {
          headTargetRef.current = {
            x: (Math.random() * 2 - 1) * settings.head_motion_amount_px,
            y: (Math.random() * 2 - 1) * settings.head_motion_amount_px,
            nextChangeAt: now + settings.head_motion_change_sec * 1000,
          };
        }

        const smoothness = Math.min(1, Math.max(0.001, settings.head_motion_smoothness));
        headCurrentRef.current.x += (headTargetRef.current.x - headCurrentRef.current.x) * smoothness;
        headCurrentRef.current.y += (headTargetRef.current.y - headCurrentRef.current.y) * smoothness;

        const normalizedLevel =
          settings.on_threshold > 0 ? averagedLevel / settings.on_threshold : averagedLevel;
        const bounceOffsetPx = talking
          ? Math.min(
              settings.voice_bounce_amount_px,
              settings.voice_bounce_amount_px * normalizedLevel * settings.voice_bounce_sensitivity,
            )
          : 0;

        const nextState: BroadcastStageState = {
          live: true,
          profileId,
          profileName,
          talking,
          blinkClosed,
          level: averagedLevel,
          bounceOffsetPx,
          headOffsetX: headCurrentRef.current.x,
          headOffsetY: headCurrentRef.current.y,
          showProfileName: settings.show_profile_names,
          assets,
          updatedAt: Date.now(),
        };

        setStageState(nextState);
        publishState(nextState);
        animationRef.current = window.requestAnimationFrame(tick);
      };

      animationRef.current = window.requestAnimationFrame(tick);
    },
    [
      assets,
      profileId,
      profileName,
      publishState,
      settings.blink_duration_frames,
      settings.blink_max_interval_sec,
      settings.blink_min_interval_sec,
      settings.fps,
      settings.head_motion_amount_px,
      settings.head_motion_change_sec,
      settings.head_motion_smoothness,
      settings.off_threshold,
      settings.on_threshold,
      settings.show_profile_names,
      settings.smoothing_windows,
      settings.voice_bounce_amount_px,
      settings.voice_bounce_sensitivity,
    ],
  );

  useEffect(() => {
    return () => {
      stopLive();
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [stopLive]);

  useEffect(() => {
    if (!inputStream) {
      if (!ownsStreamRef.current && streamRef.current) {
        stopLive();
      }
      return;
    }

    setError(null);
    void startAnalysis(inputStream, false);

    return () => {
      if (!ownsStreamRef.current && streamRef.current === inputStream) {
        stopLive();
      }
    };
  }, [inputStream, startAnalysis, stopLive]);

  const startLive = useCallback(async () => {
    if (isLive) {
      return;
    }
    if (!profileId) {
      setError('Select a profile before starting live mode.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access is not available in this environment.');
      return;
    }

    try {
      setError(null);
      const requestedAudioConstraints = buildLiveAudioConstraints(audioProcessing);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: requestedAudioConstraints,
        video: false,
      });

      const [track] = stream.getAudioTracks();
      if (track) {
        try {
          await track.applyConstraints(requestedAudioConstraints);
        } catch (error) {
          console.warn('[BroadcastLive] Failed to re-apply audio constraints:', error);
        }

        console.info('[BroadcastLive] Requested mic constraints:', requestedAudioConstraints);
        console.info('[BroadcastLive] Active mic constraints:', track.getConstraints());
        console.info('[BroadcastLive] Active mic settings:', track.getSettings());
      }

      await startAnalysis(stream, true);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to access the microphone for live broadcast mode.';
      setError(message);
      stopLive();
    }
  }, [
    assets,
    audioProcessing.autoGainControl,
    audioProcessing.echoCancellation,
    audioProcessing.noiseSuppression,
    isLive,
    profileId,
    profileName,
    startAnalysis,
    stopLive,
  ]);

  return {
    isLive,
    error,
    stageState,
    startLive,
    stopLive,
    clearError: () => setError(null),
  };
}
