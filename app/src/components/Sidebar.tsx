import { Link, useMatchRoute } from '@tanstack/react-router';
import { BookOpen, Clapperboard, Loader2, Moon, Settings, Sun, UserRound } from 'lucide-react';
import vibetubeLogo from '@/assets/vibetube-logo.png';
import { cn } from '@/lib/utils/cn';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';

interface SidebarProps {
  isMacOS?: boolean;
}

const tabs = [
  { id: 'main', path: '/', icon: Clapperboard, label: 'Generate' },
  { id: 'stories', path: '/stories', icon: BookOpen, label: 'Stories' },
  { id: 'characters', path: '/characters', icon: UserRound, label: 'Characters' },
  { id: 'settings', path: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar({ isMacOS }: SidebarProps) {
  const isGenerating = useGenerationStore((state) => state.isGenerating);
  const audioUrl = usePlayerStore((state) => state.audioUrl);
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const isPlayerVisible = !!audioUrl;
  const matchRoute = useMatchRoute();

  return (
    <div
      className={cn(
        'fixed left-0 top-0 h-full w-20 bg-sidebar border-r border-border flex flex-col items-center py-6 gap-6',
        isMacOS && 'pt-14',
      )}
    >
      {/* Logo */}
      <div className="mb-2 h-12 w-12 rounded-full bg-black ring-2 ring-cyan-400/70 flex items-center justify-center">
        <img src={vibetubeLogo} alt="VibeTube" className="w-10 h-10 object-contain" />
      </div>

      {/* Navigation Buttons */}
      <div className="flex flex-col gap-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          // For index route, use exact match; for others, use default matching
          const isSettingsRoute =
            matchRoute({ to: '/settings' }) ||
            matchRoute({ to: '/audio' }) ||
            matchRoute({ to: '/models' }) ||
            matchRoute({ to: '/server' }) ||
            matchRoute({ to: '/vibetube' });
          const isActive = tab.id === 'settings'
            ? isSettingsRoute
            : tab.path === '/'
              ? matchRoute({ to: '/', exact: true })
              : matchRoute({ to: tab.path });

          return (
            <Link
              key={tab.id}
              to={tab.path}
              className={cn(
                'w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200',
                'hover:bg-muted/50',
                isActive ? 'bg-muted/50 text-foreground shadow-lg' : 'text-muted-foreground',
              )}
              title={tab.label}
              aria-label={tab.label}
            >
              <Icon className="h-5 w-5" />
            </Link>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200',
          'hover:bg-muted/50 text-muted-foreground',
        )}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

      {/* Spacer to push loader to bottom */}
      <div className="flex-1" />

      {/* Generation Loader */}
      {isGenerating && (
        <div
          className={cn(
            'w-full flex items-center justify-center transition-all duration-200',
            isPlayerVisible ? 'mb-[120px]' : 'mb-0',
          )}
        >
          <Loader2 className="h-6 w-6 text-accent animate-spin" />
        </div>
      )}
    </div>
  );
}
