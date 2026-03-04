import { useMemo, useState } from 'react';
import { AudioTab } from '@/components/AudioTab/AudioTab';
import { ModelsTab } from '@/components/ModelsTab/ModelsTab';
import { ServerTab } from '@/components/ServerTab/ServerTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VibeTubeTab } from '@/components/VibeTubeTab/VibeTubeTab';

type SettingsSection = 'vibetube' | 'audio' | 'models' | 'server';

interface SettingsTabProps {
  initialSection?: SettingsSection;
}

export function SettingsTab({ initialSection = 'vibetube' }: SettingsTabProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);

  const title = useMemo(() => {
    switch (activeSection) {
      case 'audio':
        return 'Audio Channels';
      case 'models':
        return 'Model Management';
      case 'server':
        return 'Server Connection';
      default:
        return 'VibeTube Render Settings';
    }
  }, [activeSection]);

  return (
    <div className="h-full flex flex-col min-h-0 py-6">
      <div className="mb-4 px-2">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">{title}</p>
      </div>

      <Tabs
        value={activeSection}
        onValueChange={(value) => setActiveSection(value as SettingsSection)}
        className="flex-1 min-h-0 flex flex-col"
      >
        <div className="px-2 pb-2">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="vibetube">VibeTube</TabsTrigger>
            <TabsTrigger value="audio">Audio Channels</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="server">Server</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="vibetube" className="flex-1 min-h-0 overflow-hidden mt-0">
          <VibeTubeTab />
        </TabsContent>
        <TabsContent value="audio" className="flex-1 min-h-0 overflow-hidden mt-0 px-2">
          <AudioTab />
        </TabsContent>
        <TabsContent value="models" className="flex-1 min-h-0 overflow-hidden mt-0 px-2">
          <ModelsTab />
        </TabsContent>
        <TabsContent value="server" className="flex-1 min-h-0 overflow-hidden mt-0 px-2">
          <ServerTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
