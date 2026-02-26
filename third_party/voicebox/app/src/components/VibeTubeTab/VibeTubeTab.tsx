import { Download, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { VibeTubeRenderResponse } from '@/lib/api/types';
import { useProfiles } from '@/lib/hooks/useProfiles';

export function VibeTubeTab() {
  const { data: profiles } = useProfiles();
  const { toast } = useToast();

  const [profileId, setProfileId] = useState('');
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const [text, setText] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [result, setResult] = useState<VibeTubeRenderResponse | null>(null);

  const [idle, setIdle] = useState<File | null>(null);
  const [talk, setTalk] = useState<File | null>(null);
  const [idleBlink, setIdleBlink] = useState<File | null>(null);
  const [talkBlink, setTalkBlink] = useState<File | null>(null);
  const [blink, setBlink] = useState<File | null>(null);

  const onRender = async () => {
    if (!profileId) {
      toast({ title: 'Select a voice', description: 'Choose a voice profile first.', variant: 'destructive' });
      return;
    }
    if (!text.trim()) {
      toast({ title: 'Missing text', description: 'Enter text to generate voice.', variant: 'destructive' });
      return;
    }
    if (!idle || !talk) {
      toast({ title: 'Missing avatar states', description: 'idle.png and talk.png are required.', variant: 'destructive' });
      return;
    }

    setIsRendering(true);
    try {
      const response = await apiClient.renderVibeTube({
        profile_id: profileId,
        text: text.trim(),
        language,
        idle,
        talk,
        idle_blink: idleBlink || undefined,
        talk_blink: talkBlink || undefined,
        blink: blink || undefined,
      });
      setResult(response);
      toast({ title: 'Render complete', description: 'VibeTube overlay was generated.' });
    } catch (error) {
      toast({
        title: 'Render failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsRendering(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto py-6">
      <div className="max-w-3xl space-y-6">
        <div>
          <h2 className="text-2xl font-bold">VibeTube</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Generate voice + render PNGtuber overlay video in one flow.
          </p>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Voice Profile</Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger>
                <SelectValue placeholder="Select voice profile..." />
              </SelectTrigger>
              <SelectContent>
                {profiles?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Language</Label>
            <Select value={language} onValueChange={(value) => setLanguage(value as 'en' | 'zh')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="zh">Chinese</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Script</Label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder="Paste your script..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FileInput label="idle.png (required)" onPick={setIdle} />
            <FileInput label="talk.png (required)" onPick={setTalk} />
            <FileInput label="idle_blink.png (optional)" onPick={setIdleBlink} />
            <FileInput label="talk_blink.png (optional)" onPick={setTalkBlink} />
            <FileInput label="blink.png (optional fallback)" onPick={setBlink} />
          </div>
        </div>

        <Button onClick={onRender} disabled={isRendering}>
          <Sparkles className="h-4 w-4 mr-2" />
          {isRendering ? 'Rendering...' : 'Render VibeTube Overlay'}
        </Button>

        {result && (
          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">Latest Render</h3>
            <p className="text-sm text-muted-foreground break-all">Video: {result.video_path}</p>
            <p className="text-sm text-muted-foreground break-all">Meta: {result.meta_path}</p>
            <Button asChild variant="outline">
              <a href={`file:///${result.output_dir.replace(/\\/g, '/')}`} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4 mr-2" />
                Open Output Folder
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FileInput({
  label,
  onPick,
}: {
  label: string;
  onPick: (file: File | null) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input type="file" accept=".png,image/png" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    </div>
  );
}
