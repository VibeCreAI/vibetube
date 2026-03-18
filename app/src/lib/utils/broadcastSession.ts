export interface BroadcastAvatarAssets {
  idleUrl: string | null;
  talkUrl: string | null;
  idleBlinkUrl: string | null;
  talkBlinkUrl: string | null;
}

export interface BroadcastStageState {
  live: boolean;
  profileId: string | null;
  profileName: string | null;
  talking: boolean;
  blinkClosed: boolean;
  level: number;
  bounceOffsetPx: number;
  headOffsetX: number;
  headOffsetY: number;
  showProfileName: boolean;
  assets: BroadcastAvatarAssets;
  updatedAt: number;
}

export const BROADCAST_CHANNEL_NAME = 'vibetube.broadcast.session';
export const BROADCAST_CONTROL_CHANNEL_NAME = 'vibetube.broadcast.control';
export const BROADCAST_SNAPSHOT_STORAGE_KEY = 'vibetube.broadcast.snapshot';

export function createIdleBroadcastStageState(
  assets: BroadcastAvatarAssets,
  profileId: string | null,
  profileName: string | null,
  showProfileName: boolean,
): BroadcastStageState {
  return {
    live: false,
    profileId,
    profileName,
    talking: false,
    blinkClosed: false,
    level: 0,
    bounceOffsetPx: 0,
    headOffsetX: 0,
    headOffsetY: 0,
    showProfileName,
    assets,
    updatedAt: Date.now(),
  };
}

export function readBroadcastSnapshot(): BroadcastStageState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(BROADCAST_SNAPSHOT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as BroadcastStageState;
  } catch {
    return null;
  }
}

export function writeBroadcastSnapshot(state: BroadcastStageState): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(BROADCAST_SNAPSHOT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}
