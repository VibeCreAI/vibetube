import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BroadcastStage } from '@/components/BroadcastTab/BroadcastStage';
import {
  BROADCAST_CHANNEL_NAME,
  BROADCAST_CONTROL_CHANNEL_NAME,
  type BroadcastStageState,
  createIdleBroadcastStageState,
  readBroadcastSnapshot,
} from '@/lib/utils/broadcastSession';

export function BroadcastOutputShell() {
  const [stageState, setStageState] = useState<BroadcastStageState>(() => {
    return (
      readBroadcastSnapshot() ??
      createIdleBroadcastStageState(
        {
          idleUrl: null,
          talkUrl: null,
          idleBlinkUrl: null,
          talkBlinkUrl: null,
        },
        null,
        null,
        false,
      )
    );
  });
  const [isHighlighted, setIsHighlighted] = useState(false);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previousHtmlBackground = document.documentElement.style.background;
    const previousBodyBackground = document.body.style.background;

    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    const snapshot = readBroadcastSnapshot();
    if (snapshot) {
      setStageState(snapshot);
    }

    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<BroadcastStageState>) => {
      setStageState(event.data);
    };

    const controlChannel = new BroadcastChannel(BROADCAST_CONTROL_CHANNEL_NAME);
    controlChannel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== 'highlight') {
        return;
      }

        setIsHighlighted(false);
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current);
        }
        window.requestAnimationFrame(() => {
          setIsHighlighted(true);
        });
        highlightTimerRef.current = window.setTimeout(() => {
          setIsHighlighted(false);
          highlightTimerRef.current = null;
        }, 2200);
      };

    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      setIsHighlighted(false);
      controlChannel.close();
      channel.close();
      document.documentElement.style.background = previousHtmlBackground;
      document.body.style.background = previousBodyBackground;
    };
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void getCurrentWindow()
        .startDragging()
        .catch(() => {
          // Ignore drag failures outside Tauri.
        });
    },
    [],
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      <div
        data-tauri-drag-region
        className="fixed inset-0 z-10 cursor-move bg-transparent"
        onMouseDown={handleMouseDown}
      />
      {isHighlighted ? (
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-[28px] border-[8px] border-cyan-300 bg-[rgba(8,145,178,0.28)] shadow-[0_0_0_4px_rgba(34,211,238,0.35),0_0_48px_rgba(34,211,238,0.85)]"
            style={{
              animation: 'broadcast-output-highlight-pulse 0.48s ease-in-out 4',
            }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-[18px] rounded-[20px] border-2 border-white/70"
            style={{
              animation: 'broadcast-output-highlight-pulse 0.48s ease-in-out 4',
            }}
          />
          <div
            className="absolute left-6 top-6 rounded-full border border-cyan-200/80 bg-[rgba(8,145,178,0.92)] px-4 py-2 text-sm font-semibold tracking-[0.18em] text-white shadow-[0_10px_24px_rgba(8,145,178,0.45)]"
            style={{
              animation: 'broadcast-output-highlight-label 0.48s ease-in-out 4',
            }}
          >
            OUTPUT HERE
          </div>
        </div>
      ) : null}
      <style>{`
        @keyframes broadcast-output-highlight-pulse {
          0%, 100% {
            opacity: 0.22;
            transform: scale(0.997);
          }
          50% {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes broadcast-output-highlight-label {
          0%, 100% {
            opacity: 0.38;
            transform: translateY(-2px);
          }
          50% {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
      <BroadcastStage
        state={stageState}
        transparent
        checkerboard={false}
        showStatus={false}
        showEmptyHint={false}
        className="h-full rounded-none border-0"
      />
    </div>
  );
}
