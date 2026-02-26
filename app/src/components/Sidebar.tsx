import { Link, useMatchRoute } from '@tanstack/react-router';
import { Box, BookOpen, Clapperboard, Loader2, Mic, Moon, Server, Speaker, Sun, Volume2 } from 'lucide-react';
import vibetubeLogo from '@/assets/vibetube-logo.png';
import { cn } from '@/lib/utils/cn';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';

interface SidebarProps {
  isMacOS?: boolean;
}

const tabs = [
  { id: 'main', path: '/', icon: Volume2, label: 'Generate' },
  { id: 'vibetube', path: '/vibetube', icon: Clapperboard, label: 'VibeTube' },
  { id: 'stories', path: '/stories', icon: BookOpen, label: 'Stories' },
  { id: 'voices', path: '/voices', icon: Mic, label: 'Voices' },
  { id: 'audio', path: '/audio', icon: Speaker, label: 'Audio' },
  { id: 'models', path: '/models', icon: Box, label: 'Models' },
  { id: 'server', path: '/server', icon: Server, label: 'Server' },
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
      <div className="mb-2">
        <img src={vibetubeLogo} alt="VibeTube" className="w-12 h-12 object-contain" />
      </div>

      {/* Navigation Buttons */}
      <div className="flex flex-col gap-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          // For index route, use exact match; for others, use default matching
          const isActive =
            tab.path === '/'
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

      {/* Spacer to push loader to bottom */}
      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 mb-3',
          'hover:bg-muted/50 text-muted-foreground',
        )}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

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
