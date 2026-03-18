import { Monitor, Radio, RectangleHorizontal, Settings2 } from 'lucide-react';
import obsGuideAvatar from '@/assets/obs-window-capture-guide.png';
import obsGuideFrame from '@/assets/obs-window-capture-guide.svg';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ObsGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktopApp: boolean;
}

const guideSteps = [
  {
    icon: RectangleHorizontal,
    title: 'Open Broadcast Output first',
    description:
      'In VibeTube Live, click `Open Output` so the dedicated Broadcast Output window exists before you configure OBS.',
  },
  {
    icon: Monitor,
    title: 'Add Window Capture in OBS',
    description:
      'Create a Window Capture source and set Window to `[vibetube.exe]: Broadcast Output`, not the main VibeTube app window.',
  },
  {
    icon: Settings2,
    title: 'Use the matching capture settings',
    description:
      'Set Capture Method to `Windows 10 (1903 and up)` and Window Match Priority to `Window title must match`.',
  },
  {
    icon: Radio,
    title: 'Keep the output window live',
    description:
      'Click Start Live in VibeTube and leave the Broadcast Output window open while OBS is capturing it.',
  },
];

const recommendedSettings = [
  'Turn off `Capture Cursor` for a clean avatar source.',
  'Leave `Capture Audio (BETA)` off. OBS should use your mic input directly for live audio.',
  'Keep `Client Area` on so OBS captures only the output content.',
  'If OBS ever shows a white or black box, switch back to `Windows 10 (1903 and up)` capture.',
];

export function ObsGuideDialog({ open, onOpenChange, isDesktopApp }: ObsGuideDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>OBS Window Capture Guide</DialogTitle>
          <DialogDescription>
            Use this setup to add VibeTube Broadcast Live as a transparent source in OBS.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          <div className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
              <div className="overflow-hidden rounded-2xl border border-border/60 bg-background/40 p-3">
                <div className="relative">
                    <img
                      src={obsGuideFrame}
                      alt="OBS Window Capture settings showing the Broadcast Output window with recommended capture method and match priority."
                      className="w-full rounded-xl border border-border/40"
                    />
                    <div
                      aria-hidden="true"
                      className="absolute rounded-sm"
                      style={{
                        left: '39.8%',
                        top: '16.9%',
                        width: '20.4%',
                        height: '40.8%',
                        backgroundColor: '#0F121B',
                      }}
                    />
                    <img
                      src={obsGuideAvatar}
                      alt=""
                      aria-hidden="true"
                      className="absolute object-contain"
                      style={{
                        left: '39.8%',
                        top: '16.9%',
                        width: '20.4%',
                        height: '40.8%',
                      }}
                    />
                </div>
              </div>

              <div className="space-y-5">
                {!isDesktopApp && (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
                    The dedicated Broadcast Output window is only available in the desktop app. The web build can preview Live in-app, but OBS setup needs the Tauri app.
                  </div>
                )}

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Setup Steps
                  </h3>
                  <div className="space-y-3">
                    {guideSteps.map((step, index) => {
                      const Icon = step.icon;
                      return (
                        <div
                          key={step.title}
                          className="rounded-xl border border-border/60 bg-background/40 p-4"
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="space-y-1">
                              <div className="text-sm font-medium">
                                {index + 1}. {step.title}
                              </div>
                              <p className="text-sm text-muted-foreground">{step.description}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-xl border border-border/60 bg-background/40 p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Recommended OBS Settings
                  </h3>
                  <div className="mt-3 space-y-2">
                    {recommendedSettings.map((setting) => (
                      <p key={setting} className="text-sm text-muted-foreground">
                        {setting}
                      </p>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
