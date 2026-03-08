import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, Download, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { VibeTubeExportFormat, VibeTubeJobResponse } from '@/lib/api/types';
import { useHistory } from '@/lib/hooks/useHistory';
import {
  useAddStoryItem,
  useExportStoryAudio,
  useRemoveStoryItem,
  useRenderStoryVibeTube,
  useReorderStoryItems,
  useStory,
} from '@/lib/hooks/useStories';
import { useStoryPlayback } from '@/lib/hooks/useStoryPlayback';
import {
  getPersistedVibeTubeRenderSettings,
  loadPersistedVibeTubeBackgroundImageData,
} from '@/lib/utils/vibetubeSettings';
import { useStoryStore } from '@/stores/storyStore';
import { SortableStoryChatItem } from './StoryChatItem';

function getPrimaryStoryExportFormat(job: VibeTubeJobResponse | null): VibeTubeExportFormat {
  if (!job) {
    return 'mp4';
  }
  if (job.preferred_export_format === 'webm' || job.preferred_export_format === 'mov') {
    return job.preferred_export_format;
  }
  if (job.contains_transparency) {
    return 'mov';
  }
  return 'mp4';
}

function getStoryExportButtonLabel(format: VibeTubeExportFormat): string {
  if (format === 'webm') return 'Export WebM';
  if (format === 'mov') return 'Export MOV';
  return 'Export MP4';
}

export function StoryContent() {
  const queryClient = useQueryClient();
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const { data: story, isLoading } = useStory(selectedStoryId);
  const removeItem = useRemoveStoryItem();
  const reorderItems = useReorderStoryItems();
  const exportAudio = useExportStoryAudio();
  const renderStoryVibeTube = useRenderStoryVibeTube();
  const addStoryItem = useAddStoryItem();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedStoryJobId, setSelectedStoryJobId] = useState<string | null>(null);
  const [isDeletingStoryRender, setIsDeletingStoryRender] = useState(false);

  // Add generation popover state
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const { data: historyData } = useHistory();

  // Filter generations not in story and matching search
  const availableGenerations = useMemo(() => {
    if (!historyData?.items || !story) return [];
    const storyGenerationIds = new Set(story.items.map((i) => i.generation_id));
    const query = searchQuery.toLowerCase();
    return historyData.items.filter(
      (gen) =>
        !storyGenerationIds.has(gen.id) &&
        (gen.text.toLowerCase().includes(query) || gen.profile_name.toLowerCase().includes(query)),
    );
  }, [historyData, story, searchQuery]);

  const storyJobsQuery = useQuery({
    queryKey: ['vibetube-jobs', story?.id],
    enabled: !!story?.id,
    queryFn: async () => {
      const jobs = await apiClient.listVibeTubeJobs();
      return jobs.filter((job) => job.source_story_id === story?.id);
    },
  });

  const storyJobs = storyJobsQuery.data ?? [];
  const selectedStoryJob: VibeTubeJobResponse | null = useMemo(() => {
    if (!storyJobs.length) return null;
    const selected = storyJobs.find((job) => job.job_id === selectedStoryJobId);
    return selected ?? storyJobs[0];
  }, [storyJobs, selectedStoryJobId]);
  const primaryStoryExportFormat = getPrimaryStoryExportFormat(selectedStoryJob);

  useEffect(() => {
    if (!storyJobs.length) {
      setSelectedStoryJobId(null);
      return;
    }
    const stillValid =
      selectedStoryJobId && storyJobs.some((job) => job.job_id === selectedStoryJobId);
    if (!stillValid) {
      setSelectedStoryJobId(storyJobs[0].job_id);
    }
  }, [storyJobs, selectedStoryJobId]);

  // Get track editor height from store for dynamic padding
  const trackEditorHeight = useStoryStore((state) => state.trackEditorHeight);

  // Track editor is shown when story has items
  const hasBottomBar = story && story.items.length > 0;

  // Calculate dynamic bottom padding: track editor + gap
  const bottomPadding = hasBottomBar ? trackEditorHeight + 24 : 0;

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Playback state (for auto-scroll and item highlighting)
  const isPlaying = useStoryStore((state) => state.isPlaying);
  const currentTimeMs = useStoryStore((state) => state.currentTimeMs);
  const playbackStoryId = useStoryStore((state) => state.playbackStoryId);

  // Refs for auto-scrolling to playing item
  const itemRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastScrolledItemRef = useRef<string | null>(null);

  // Use playback hook
  useStoryPlayback(story?.items);

  // Sort items by start_time_ms
  const sortedItems = useMemo(() => {
    if (!story?.items) return [];
    return [...story.items].sort((a, b) => a.start_time_ms - b.start_time_ms);
  }, [story?.items]);

  // Find the currently playing item based on timecode
  const currentlyPlayingItemId = useMemo(() => {
    if (!isPlaying || playbackStoryId !== story?.id || !sortedItems.length) {
      return null;
    }
    const playingItem = sortedItems.find((item) => {
      const itemStart = item.start_time_ms;
      const itemEnd = item.start_time_ms + item.duration * 1000;
      return currentTimeMs >= itemStart && currentTimeMs < itemEnd;
    });
    return playingItem?.generation_id ?? null;
  }, [isPlaying, playbackStoryId, story?.id, sortedItems, currentTimeMs]);

  // Auto-scroll to the currently playing item
  useEffect(() => {
    if (!currentlyPlayingItemId || currentlyPlayingItemId === lastScrolledItemRef.current) {
      return;
    }

    const element = itemRefsMap.current.get(currentlyPlayingItemId);
    if (element && scrollRef.current) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      lastScrolledItemRef.current = currentlyPlayingItemId;
    }
  }, [currentlyPlayingItemId]);

  // Reset last scrolled item when playback stops
  useEffect(() => {
    if (!isPlaying) {
      lastScrolledItemRef.current = null;
    }
  }, [isPlaying]);

  const handleRemoveItem = (itemId: string) => {
    if (!story) return;

    removeItem.mutate(
      {
        storyId: story.id,
        itemId,
      },
      {
        onError: (error) => {
          toast({
            title: 'Failed to remove item',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!story || !over || active.id === over.id) return;

    const oldIndex = sortedItems.findIndex((item) => item.generation_id === active.id);
    const newIndex = sortedItems.findIndex((item) => item.generation_id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    // Calculate the new order
    const newOrder = arrayMove(sortedItems, oldIndex, newIndex);
    const generationIds = newOrder.map((item) => item.generation_id);

    // Send reorder request to backend
    reorderItems.mutate(
      {
        storyId: story.id,
        data: { generation_ids: generationIds },
      },
      {
        onError: (error) => {
          toast({
            title: 'Failed to reorder items',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleExportAudio = () => {
    if (!story) return;

    exportAudio.mutate(
      {
        storyId: story.id,
        storyName: story.name,
      },
      {
        onError: (error) => {
          toast({
            title: 'Failed to export audio',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleAddGeneration = (generationId: string) => {
    if (!story) return;

    addStoryItem.mutate(
      {
        storyId: story.id,
        data: { generation_id: generationId },
      },
      {
        onSuccess: () => {
          setIsAddOpen(false);
          setSearchQuery('');
        },
        onError: (error) => {
          toast({
            title: 'Failed to add generation',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleRenderStoryVibeTube = async () => {
    if (!story) return;
    const settings = getPersistedVibeTubeRenderSettings();
    const backgroundImageData = settings.use_background_image
      ? await loadPersistedVibeTubeBackgroundImageData()
      : '';
    renderStoryVibeTube.mutate(
      {
        storyId: story.id,
        data: {
          ...settings,
          background_image_data: backgroundImageData || settings.background_image_data,
        },
      },
      {
        onSuccess: (result) => {
          toast({
            title: 'VibeTube render started',
            description: `Story render completed as job ${result.job_id.slice(0, 8)}.`,
          });
        },
        onError: (error) => {
          toast({
            title: 'Failed to render story',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleExportStoryRenderVideo = async (jobId: string, format: VibeTubeExportFormat) => {
    try {
      const blob = await apiClient.exportVibeTubeVideo(jobId, format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vibetube-story-${jobId}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({
        title: `${format.toUpperCase()} exported`,
        description:
          format === 'webm'
            ? 'Saved story render WebM with alpha.'
            : format === 'mov'
              ? 'Saved story render MOV with alpha.'
              : 'Saved story render MP4.',
      });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExportStoryRenderSubtitles = async (jobId: string) => {
    try {
      const blob = await apiClient.exportVibeTubeSubtitles(jobId, 'srt');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vibetube-story-${jobId}.srt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Subtitles exported', description: 'Saved story subtitles as SRT.' });
    } catch (error) {
      toast({
        title: 'Subtitle export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDeleteStoryRender = async (jobId: string) => {
    const confirmed = await confirm(
      'Delete this story render? This removes all files for this render.',
    );
    if (!confirmed) return;

    setIsDeletingStoryRender(true);
    try {
      await apiClient.deleteVibeTubeJob(jobId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['vibetube-jobs', story?.id] }),
      ]);
      toast({ title: 'Render deleted', description: 'Removed story render successfully.' });
    } catch (error) {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsDeletingStoryRender(false);
    }
  };

  if (!selectedStoryId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium mb-2">Select a story</p>
          <p className="text-sm">Choose a story from the list to view its content</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading story...</div>
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium mb-2">Story not found</p>
          <p className="text-sm">The selected story could not be loaded</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="mb-4 px-1 space-y-3">
        <div>
          <h2 className="text-2xl font-bold">{story.name}</h2>
          {story.description && (
            <p className="text-sm text-muted-foreground mt-1">{story.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={isAddOpen} onOpenChange={setIsAddOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
              <div className="p-2 border-b">
                <Input
                  placeholder="Search by name or transcript..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto">
                {availableGenerations.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {searchQuery ? 'No matching generations found' : 'No available generations'}
                  </div>
                ) : (
                  availableGenerations.map((gen) => (
                    <button
                      key={gen.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-b-0"
                      onClick={() => handleAddGeneration(gen.id)}
                    >
                      <div className="font-medium text-sm">{gen.profile_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {gen.text.length > 50 ? `${gen.text.substring(0, 50)}...` : gen.text}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
          {story.items.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRenderStoryVibeTube}
              disabled={renderStoryVibeTube.isPending}
            >
              <Clapperboard className="mr-2 h-4 w-4" />
              {renderStoryVibeTube.isPending ? 'Rendering...' : 'Render VibeTube'}
            </Button>
          )}
          {story.items.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportAudio}
              disabled={exportAudio.isPending}
            >
              <Download className="mr-2 h-4 w-4" />
              Export Audio
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto space-y-3"
        style={{ paddingBottom: bottomPadding > 0 ? `${bottomPadding}px` : undefined }}
      >
        <section className="rounded-xl border bg-card/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">Story Video Preview</h3>
              <p className="text-xs text-muted-foreground">
                Only renders generated from this story are shown here.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {selectedStoryJob && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleExportStoryRenderVideo(selectedStoryJob.job_id, primaryStoryExportFormat)
                  }
                >
                  <Download className="mr-2 h-4 w-4" />
                  {getStoryExportButtonLabel(primaryStoryExportFormat)}
                </Button>
              )}
              {selectedStoryJob?.contains_transparency && primaryStoryExportFormat !== 'mov' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExportStoryRenderVideo(selectedStoryJob.job_id, 'mov')}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export MOV
                </Button>
              )}
              {selectedStoryJob && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExportStoryRenderSubtitles(selectedStoryJob.job_id)}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export SRT
                </Button>
              )}
              {selectedStoryJob && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDeleteStoryRender(selectedStoryJob.job_id)}
                  disabled={isDeletingStoryRender}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {isDeletingStoryRender ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </div>
          </div>

          {selectedStoryJob ? (
            <div className="space-y-3">
              <video
                className="w-full rounded-lg border bg-black/60 max-h-[360px]"
                controls
                preload="metadata"
                src={apiClient.getVibeTubePreviewUrl(selectedStoryJob.job_id)}
              >
                <track kind="captions" />
              </video>
              {storyJobs.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {storyJobs.map((job) => (
                    <Button
                      key={job.job_id}
                      variant={job.job_id === selectedStoryJob.job_id ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSelectedStoryJobId(job.job_id)}
                    >
                      {new Date(job.created_at).toLocaleString()}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No story render yet. Click "Render VibeTube" above.
            </div>
          )}
        </section>

        {sortedItems.length === 0 ? (
          <div className="text-center py-12 px-5 border-2 border-dashed border-muted rounded-md text-muted-foreground">
            <p className="text-sm">No items in this story</p>
            <p className="text-xs mt-2">Generate speech using the box below to add items</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortedItems.map((item) => item.generation_id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {sortedItems.map((item, index) => (
                  <div
                    key={item.id}
                    ref={(el) => {
                      if (el) {
                        itemRefsMap.current.set(item.generation_id, el);
                      } else {
                        itemRefsMap.current.delete(item.generation_id);
                      }
                    }}
                  >
                    <SortableStoryChatItem
                      item={item}
                      storyId={story.id}
                      index={index}
                      onRemove={() => handleRemoveItem(item.id)}
                      currentTimeMs={currentTimeMs}
                      isPlaying={isPlaying && playbackStoryId === story.id}
                    />
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
