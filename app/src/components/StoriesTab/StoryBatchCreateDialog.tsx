import { ChevronDown, ChevronUp, Copy, FileJson, Loader2, Plus, Trash2 } from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import type { StoryBatchCreateRequest, StoryVibeTubeRenderRequest } from '@/lib/api/types';
import { LANGUAGE_OPTIONS } from '@/lib/constants/languages';
import { useProfiles } from '@/lib/hooks/useProfiles';
import { useCreateStoryBatch } from '@/lib/hooks/useStories';
import { getPersistedVibeTubeRenderSettings } from '@/lib/utils/vibetubeSettings';
import { useStoryStore } from '@/stores/storyStore';

interface BatchRow {
  id: string;
  profile_name: string;
  text: string;
  language: string;
  model_size: '1.7B' | '0.6B';
  seed: string;
  instruct: string;
  showAdvanced: boolean;
}

interface StoryBatchCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function createRow(profileName = ''): BatchRow {
  return {
    id: crypto.randomUUID(),
    profile_name: profileName,
    text: '',
    language: 'en',
    model_size: '1.7B',
    seed: '',
    instruct: '',
    showAdvanced: false,
  };
}

const BULK_JSON_GUIDE = `Create a story JSON file for a voice-generation app.

Return JSON only. Do not add markdown fences or commentary.

Rules:
- Use this exact top-level shape:
  {
    "story_name": "string",
    "description": "string",
    "auto_render": false,
    "entries": [
      {
        "profile_name": "Exact Voice Profile Name",
        "text": "Line to speak",
        "language": "en",
        "model_size": "1.7B",
        "seed": 42,
        "instruct": "optional delivery instructions"
      }
    ]
  }
- story_name is required.
- description is optional.
- auto_render should usually be false.
- entries must be an array with at least one item.
- profile_name must exactly match an existing voice profile name in the app.
- text is required for every entry.
- language can be one of: zh, en, ja, ko, de, fr, ru, pt, es, it.
- model_size can be "1.7B" or "0.6B".
- seed and instruct are optional.
- Keep the story sequential. Do not add timing or track fields.

Example:
{
  "story_name": "Campfire Tale",
  "description": "Narrator and wolf scene",
  "auto_render": false,
  "entries": [
    {
      "profile_name": "Narrator",
      "text": "It was a cold night in the woods.",
      "language": "en",
      "model_size": "1.7B"
    },
    {
      "profile_name": "Wolf",
      "text": "Who's there?",
      "language": "en",
      "model_size": "1.7B",
      "instruct": "low and suspicious"
    }
  ]
}`;

export function StoryBatchCreateDialog({ open, onOpenChange }: StoryBatchCreateDialogProps) {
  const { data: profiles } = useProfiles();
  const createStoryBatch = useCreateStoryBatch();
  const setSelectedStoryId = useStoryStore((state) => state.setSelectedStoryId);
  const { toast } = useToast();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [storyName, setStoryName] = useState('');
  const [description, setDescription] = useState('');
  const [autoRender, setAutoRender] = useState(false);
  const [renderSettingsOverride, setRenderSettingsOverride] = useState<
    StoryVibeTubeRenderRequest | undefined
  >(undefined);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  const defaultProfileName = useMemo(
    () => (profiles?.length === 1 ? profiles[0].name : ''),
    [profiles],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    setStoryName((prev) => prev || 'New Story');
    setRows((prev) =>
      prev.length > 0 ? prev : [createRow(defaultProfileName), createRow(defaultProfileName)],
    );
  }, [open, defaultProfileName]);

  const updateRow = (rowId: string, updates: Partial<BatchRow>) => {
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, ...updates } : row)));
  };

  const moveRow = (index: number, direction: -1 | 1) => {
    setRows((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [row] = next.splice(index, 1);
      next.splice(nextIndex, 0, row);
      return next;
    });
  };

  const addRow = () => {
    setRows((prev) => [...prev, createRow(defaultProfileName)]);
  };

  const removeRow = (rowId: string) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== rowId)));
  };

  const resetState = () => {
    setStoryName('');
    setDescription('');
    setAutoRender(false);
    setRenderSettingsOverride(undefined);
    setImportWarnings([]);
    setRows([createRow(defaultProfileName), createRow(defaultProfileName)]);
  };

  const populateFromJson = (parsed: StoryBatchCreateRequest) => {
    setStoryName(parsed.story_name);
    setDescription(parsed.description || '');
    setAutoRender(Boolean(parsed.auto_render));
    setRenderSettingsOverride(parsed.render_settings);

    const knownProfiles = profiles ? new Set(profiles.map((profile) => profile.name.trim())) : null;
    const warnings = parsed.entries
      .map((entry, index) => {
        const profileName = entry.profile_name.trim();
        if (!profileName) {
          return `Row ${index + 1}: missing profile_name`;
        }
        if (!knownProfiles) {
          return null;
        }
        return knownProfiles.has(profileName)
          ? null
          : `Row ${index + 1}: unknown profile "${profileName}"`;
      })
      .filter((value): value is string => value !== null);

    setImportWarnings(warnings);
    setRows(
      parsed.entries.map((entry) => ({
        id: crypto.randomUUID(),
        profile_name: entry.profile_name,
        text: entry.text,
        language: entry.language || 'en',
        model_size: entry.model_size || '1.7B',
        seed: entry.seed !== undefined ? String(entry.seed) : '',
        instruct: entry.instruct || '',
        showAdvanced: Boolean(
          entry.instruct || entry.seed !== undefined || entry.language || entry.model_size,
        ),
      })),
    );
  };

  const handleJsonFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as StoryBatchCreateRequest;

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON root must be an object.');
      }

      if (!parsed.story_name || typeof parsed.story_name !== 'string') {
        throw new Error('story_name is required.');
      }

      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        throw new Error('entries must contain at least one item.');
      }

      populateFromJson(parsed);

      toast({
        title: 'JSON imported',
        description: `Loaded ${parsed.entries.length} rows into the bulk story form.`,
      });
    } catch (error) {
      toast({
        title: 'Invalid JSON file',
        description: error instanceof Error ? error.message : 'Could not parse the JSON file.',
        variant: 'destructive',
      });
    }
  };

  const handleCopyGuide = async () => {
    try {
      await navigator.clipboard.writeText(BULK_JSON_GUIDE);
      toast({
        title: 'Guide copied',
        description: 'Prompt text copied. Paste it into ChatGPT or another LLM.',
      });
    } catch (_error) {
      toast({
        title: 'Copy failed',
        description: 'Could not copy the guide text to the clipboard.',
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = () => {
    const trimmedStoryName = storyName.trim();
    if (!trimmedStoryName) {
      toast({
        title: 'Story name required',
        description: 'Enter a name for the new story.',
        variant: 'destructive',
      });
      return;
    }

    if (rows.length === 0) {
      toast({
        title: 'Rows required',
        description: 'Add at least one voice row.',
        variant: 'destructive',
      });
      return;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.profile_name.trim()) {
        toast({
          title: 'Voice required',
          description: `Row ${index + 1} is missing a voice profile.`,
          variant: 'destructive',
        });
        return;
      }

      if (!row.text.trim()) {
        toast({
          title: 'Text required',
          description: `Row ${index + 1} is missing text.`,
          variant: 'destructive',
        });
        return;
      }
    }

    createStoryBatch.mutate(
      {
        story_name: trimmedStoryName,
        description: description.trim() || undefined,
        auto_render: autoRender,
        render_settings: autoRender
          ? renderSettingsOverride || getPersistedVibeTubeRenderSettings()
          : undefined,
        entries: rows.map((row) => ({
          profile_name: row.profile_name.trim(),
          text: row.text.trim(),
          language: row.language as (typeof LANGUAGE_OPTIONS)[number]['value'],
          model_size: row.model_size,
          seed: row.seed.trim() ? Number(row.seed) : undefined,
          instruct: row.instruct.trim() || undefined,
        })),
      },
      {
        onSuccess: (result) => {
          setSelectedStoryId(result.story.id);
          onOpenChange(false);
          resetState();
          toast({
            title: 'Story created',
            description:
              autoRender && !result.render_job
                ? `"${result.story.name}" was created, but auto-render could not start.`
                : `"${result.story.name}" was created with ${result.results.length} clips.`,
          });
        },
        onError: (error) => {
          toast({
            title: 'Bulk generation failed',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!createStoryBatch.isPending) {
          if (!nextOpen) {
            resetState();
          }
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Create Story</DialogTitle>
          <DialogDescription>
            Build a new story by generating multiple voices in one sequential batch.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleJsonFileSelected}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => importInputRef.current?.click()}
            disabled={createStoryBatch.isPending}
          >
            <FileJson className="mr-2 h-4 w-4" />
            Import JSON
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setGuideOpen(true)}
            disabled={createStoryBatch.isPending}
          >
            <Copy className="mr-2 h-4 w-4" />
            JSON Guide
          </Button>
          {importWarnings.length > 0 && (
            <div className="text-sm text-destructive">{importWarnings.join(' | ')}</div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bulk-story-name">Story Name</Label>
            <Input
              id="bulk-story-name"
              value={storyName}
              onChange={(e) => setStoryName(e.target.value)}
              disabled={createStoryBatch.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2 pt-7">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoRender}
                onChange={(e) => setAutoRender(e.target.checked)}
                disabled={createStoryBatch.isPending}
              />
              Auto Render Video
            </Label>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="bulk-story-description">Description</Label>
          <Textarea
            id="bulk-story-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={createStoryBatch.isPending}
            className="min-h-20"
          />
        </div>

        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={row.id} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-sm">Row {index + 1}</div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => moveRow(index, -1)}
                    disabled={createStoryBatch.isPending || index === 0}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => moveRow(index, 1)}
                    disabled={createStoryBatch.isPending || index === rows.length - 1}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateRow(row.id, { showAdvanced: !row.showAdvanced })}
                    disabled={createStoryBatch.isPending}
                  >
                    {row.showAdvanced ? 'Hide' : 'More'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(row.id)}
                    disabled={createStoryBatch.isPending || rows.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[220px,1fr]">
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select
                    value={row.profile_name}
                    onValueChange={(value) => updateRow(row.id, { profile_name: value })}
                    disabled={createStoryBatch.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles?.map((profile) => (
                        <SelectItem key={profile.id} value={profile.name}>
                          {profile.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Text</Label>
                  <Textarea
                    value={row.text}
                    onChange={(e) => updateRow(row.id, { text: e.target.value })}
                    disabled={createStoryBatch.isPending}
                    className="min-h-24"
                  />
                </div>
              </div>

              {row.showAdvanced && (
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Language</Label>
                    <Select
                      value={row.language}
                      onValueChange={(value) => updateRow(row.id, { language: value })}
                      disabled={createStoryBatch.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Model</Label>
                    <Select
                      value={row.model_size}
                      onValueChange={(value: '1.7B' | '0.6B') =>
                        updateRow(row.id, { model_size: value })
                      }
                      disabled={createStoryBatch.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1.7B">Qwen3-TTS 1.7B</SelectItem>
                        <SelectItem value="0.6B">Qwen3-TTS 0.6B</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Seed</Label>
                    <Input
                      value={row.seed}
                      onChange={(e) =>
                        updateRow(row.id, { seed: e.target.value.replace(/[^0-9]/g, '') })
                      }
                      disabled={createStoryBatch.isPending}
                      placeholder="Optional"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-4">
                    <Label>Instructions</Label>
                    <Textarea
                      value={row.instruct}
                      onChange={(e) => updateRow(row.id, { instruct: e.target.value })}
                      disabled={createStoryBatch.isPending}
                      className="min-h-20"
                      placeholder="Optional delivery instructions"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={addRow}
            disabled={createStoryBatch.isPending}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Row
          </Button>
          <div className="flex items-center gap-2">
            {createStoryBatch.isPending && (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating {rows.length} clips...
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createStoryBatch.isPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={createStoryBatch.isPending}>
              Create Story
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>JSON Guide</DialogTitle>
            <DialogDescription>
              Copy this prompt and give it to ChatGPT or another LLM to generate story JSON.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={BULK_JSON_GUIDE} readOnly className="min-h-[420px] font-mono text-xs" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGuideOpen(false)}>
              Close
            </Button>
            <Button type="button" onClick={handleCopyGuide}>
              <Copy className="mr-2 h-4 w-4" />
              Copy Guide
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
