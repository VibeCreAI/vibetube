import type { BroadcastStageState } from '@/lib/utils/broadcastSession';
import { cn } from '@/lib/utils/cn';

interface BroadcastStageProps {
  state: BroadcastStageState;
  transparent?: boolean;
  checkerboard?: boolean;
  showStatus?: boolean;
  showEmptyHint?: boolean;
  className?: string;
}

export function BroadcastStage({
  state,
  transparent = true,
  checkerboard = false,
  showStatus = false,
  showEmptyHint = true,
  className,
}: BroadcastStageProps) {
  const hasAssets = Boolean(state.assets.idleUrl && state.assets.talkUrl);
  const activeImage = selectActiveImage(state);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border',
        transparent ? 'bg-transparent border-border/60' : 'bg-card/60',
        checkerboard &&
          'before:absolute before:inset-0 before:bg-[linear-gradient(45deg,#1f2937_25%,transparent_25%),linear-gradient(-45deg,#1f2937_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#1f2937_75%),linear-gradient(-45deg,transparent_75%,#1f2937_75%)] before:bg-[length:24px_24px] before:bg-[position:0_0,0_12px,12px_-12px,-12px_0px] before:opacity-35',
        className,
      )}
    >
      <div className="absolute inset-0" />
      <div className="relative flex h-full min-h-[360px] items-center justify-center p-6">
        {hasAssets && activeImage ? (
          <img
            src={activeImage}
            alt={state.profileName || 'Broadcast avatar'}
            className="max-h-full max-w-full object-contain select-none"
            style={{
              transform: `translate(${state.headOffsetX}px, ${state.headOffsetY - state.bounceOffsetPx}px)`,
            }}
            draggable={false}
          />
        ) : showEmptyHint ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/30 px-5 py-4 text-center text-sm text-muted-foreground">
            Select a profile with a complete VibeTube avatar pack to preview Broadcast mode.
          </div>
        ) : null}
      </div>

      {state.showProfileName && state.profileName && hasAssets ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="rounded-full border border-white/20 bg-black/55 px-3 py-1 text-xs text-white/90 backdrop-blur-sm">
            {state.profileName}
          </div>
        </div>
      ) : null}

      {showStatus ? (
        <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-3 py-1 text-xs text-white/90 backdrop-blur-sm">
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              state.live ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400',
            )}
          />
          <span>{state.live ? 'Live microphone' : 'Idle'}</span>
        </div>
      ) : null}
    </div>
  );
}

function selectActiveImage(state: BroadcastStageState): string | null {
  const { assets, talking, blinkClosed } = state;
  if (talking && blinkClosed) {
    return assets.talkBlinkUrl || assets.talkUrl;
  }
  if (talking) {
    return assets.talkUrl;
  }
  if (blinkClosed) {
    return assets.idleBlinkUrl || assets.idleUrl;
  }
  return assets.idleUrl;
}
