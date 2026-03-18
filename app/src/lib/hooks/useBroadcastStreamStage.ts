import { useEffect, useRef, useState } from 'react';
import type { VibeTubeRenderSettings } from '@/lib/utils/vibetubeSettings';
import {
  createIdleBroadcastStageState,
  type BroadcastAvatarAssets,
  type BroadcastStageState,
} from '@/lib/utils/broadcastSession';

interface UseBroadcastStreamStageOptions {
  stream: MediaStream | null;
  profileId: string | null;
  profileName: string | null;
  assets: BroadcastAvatarAssets;
  settings: VibeTubeRenderSettings;
}

export function useBroadcastStreamStage({
  stream,
  profileId,
  profileName,
  assets,
  settings,
}: UseBroadcastStreamStageOptions) {
  const [stageState, setStageState] = useState<BroadcastStageState>(() =>
    createIdleBroadcastStageState(assets, profileId, profileName, settings.show_profile_names),
  );
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

  useEffect(() => {
    if (!stream || !profileId) {
      setStageState(
        createIdleBroadcastStageState(assets, profileId, profileName, settings.show_profile_names),
      );
      return;
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.18;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const resumeAudioContext = () => {
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch(() => {});
      }
    };

    resumeAudioContext();
    const resumeEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
    for (const eventName of resumeEvents) {
      window.addEventListener(eventName, resumeAudioContext, { passive: true });
    }

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    sourceRef.current = source;
    levelHistoryRef.current = [];
    talkingRef.current = false;
    nextBlinkAtRef.current = performance.now() + settings.blink_min_interval_sec * 1000;
    headTargetRef.current = { x: 0, y: 0, nextChangeAt: performance.now() };
    headCurrentRef.current = { x: 0, y: 0 };

    const timeData = new Uint8Array(analyser.fftSize);

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
          Math.max(0.1, settings.blink_max_interval_sec - settings.blink_min_interval_sec) * 1000;
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

      setStageState({
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
      });

      animationRef.current = window.requestAnimationFrame(tick);
    };

    animationRef.current = window.requestAnimationFrame(tick);

    return () => {
      for (const eventName of resumeEvents) {
        window.removeEventListener(eventName, resumeAudioContext);
      }
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      analyserRef.current?.disconnect();
      analyserRef.current = null;
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      levelHistoryRef.current = [];
      talkingRef.current = false;
      blinkUntilRef.current = 0;
      nextBlinkAtRef.current = 0;
      headTargetRef.current = { x: 0, y: 0, nextChangeAt: 0 };
      headCurrentRef.current = { x: 0, y: 0 };
      setStageState(
        createIdleBroadcastStageState(assets, profileId, profileName, settings.show_profile_names),
      );
    };
  }, [assets, profileId, profileName, settings]);

  return stageState;
}
