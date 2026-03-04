import {
  AudioWaveform,
  Clapperboard,
  Download,
  Eye,
  Loader2,
  MoreHorizontal,
  Play,
  PlayCircle,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { HistoryResponse, VibeTubeJobResponse } from '@/lib/api/types';
import { BOTTOM_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import {
  useDeleteGeneration,
  useExportGenerationAudio,
  useHistory,
  useImportGeneration,
} from '@/lib/hooks/useHistory';
import { cn } from '@/lib/utils/cn';
import { formatDate, formatDuration } from '@/lib/utils/format';
import {
  getPersistedVibeTubeBackgroundImageFileAsync,
  getPersistedVibeTubeRenderSettings,
} from '@/lib/utils/vibetubeSettings';
import { usePlayerStore } from '@/stores/playerStore';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// OLD TABLE-BASED COMPONENT - REMOVED (can be found in git history)
// This is the new alternate history view with fixed height rows

// NEW ALTERNATE HISTORY VIEW - FIXED HEIGHT ROWS WITH INFINITE SCROLL
export function HistoryTable() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [allHistory, setAllHistory] = useState<HistoryResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [generationToDelete, setGenerationToDelete] = useState<{ id: string; name: string } | null>(null);
  const [vibeDialogOpen, setVibeDialogOpen] = useState(false);
  const [selectedGeneration, setSelectedGeneration] = useState<HistoryResponse | null>(null);
  const [selectedVibeJobId, setSelectedVibeJobId] = useState<string | null>(null);
  const [renderingGenerationIds, setRenderingGenerationIds] = useState<Set<string>>(new Set());
  const [isDeletingVibeRender, setIsDeletingVibeRender] = useState(false);
  const limit = 20;
  const { toast } = useToast();

  const {
    data: historyData,
    isLoading,
    isFetching,
  } = useHistory({
    exclude_story_generations: true,
    limit,
    offset: page * limit,
  });

  const deleteGeneration = useDeleteGeneration();
  const exportGenerationAudio = useExportGenerationAudio();
  const importGeneration = useImportGeneration();
  const setAudioWithAutoPlay = usePlayerStore((state) => state.setAudioWithAutoPlay);
  const restartCurrentAudio = usePlayerStore((state) => state.restartCurrentAudio);
  const currentAudioId = usePlayerStore((state) => state.audioId);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const audioUrl = usePlayerStore((state) => state.audioUrl);
  const isPlayerVisible = !!audioUrl;
  const vibetubeJobsQuery = useQuery({
    queryKey: ['vibetube-jobs'],
    queryFn: () => apiClient.listVibeTubeJobs(),
  });

  // Update accumulated history when new data arrives
  useEffect(() => {
    if (historyData?.items) {
      setTotal(historyData.total);
      if (page === 0) {
        // Reset to first page
        setAllHistory(historyData.items);
      } else {
        // Append new items, avoiding duplicates
        setAllHistory((prev) => {
          const existingIds = new Set(prev.map((item) => item.id));
          const newItems = historyData.items.filter((item) => !existingIds.has(item.id));
          return [...prev, ...newItems];
        });
      }
    }
  }, [historyData, page]);

  // Reset to page 0 when deletions or imports occur
  useEffect(() => {
    if (deleteGeneration.isSuccess || importGeneration.isSuccess) {
      setPage(0);
      setAllHistory([]);
    }
  }, [deleteGeneration.isSuccess, importGeneration.isSuccess]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    const loadMoreEl = loadMoreRef.current;
    if (!loadMoreEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && !isFetching && allHistory.length < total) {
          setPage((prev) => prev + 1);
        }
      },
      {
        root: scrollRef.current,
        rootMargin: '100px',
        threshold: 0.1,
      },
    );

    observer.observe(loadMoreEl);
    return () => observer.disconnect();
  }, [isFetching, allHistory.length, total]);

  // Track scroll position for gradient effect
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const handleScroll = () => {
      setIsScrolled(scrollEl.scrollTop > 0);
    };

    scrollEl.addEventListener('scroll', handleScroll);
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, []);

  const handlePlay = (audioId: string, text: string, profileId: string) => {
    // If clicking the same audio, restart it from the beginning
    if (currentAudioId === audioId) {
      restartCurrentAudio();
    } else {
      // Otherwise, load the new audio and auto-play it
      const audioUrl = apiClient.getAudioUrl(audioId);
      setAudioWithAutoPlay(audioUrl, audioId, profileId, text.substring(0, 50));
    }
  };

  const handleDownloadAudio = (generationId: string, text: string) => {
    exportGenerationAudio.mutate(
      { generationId, text },
      {
        onError: (error) => {
          toast({
            title: 'Failed to download audio',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDeleteClick = (generationId: string, profileName: string) => {
    setGenerationToDelete({ id: generationId, name: profileName });
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (generationToDelete) {
      deleteGeneration.mutate(generationToDelete.id);
      setDeleteDialogOpen(false);
      setGenerationToDelete(null);
    }
  };

  const openVibeDialog = (gen: HistoryResponse) => {
    setSelectedGeneration(gen);
    setSelectedVibeJobId(null);
    vibetubeJobsQuery.refetch();
    setVibeDialogOpen(true);
  };

  const getLatestLinkedJob = (gen: HistoryResponse): VibeTubeJobResponse | null => {
    const jobs = (vibetubeJobsQuery.data ?? []).filter(
      (job) => job.source_generation_id === gen.id,
    );
    if (!jobs.length) {
      return null;
    }
    jobs.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return jobs[0] ?? null;
  };

  const handlePlayLatestVideo = (gen: HistoryResponse) => {
    const latest = getLatestLinkedJob(gen);
    if (!latest) {
      toast({
        title: 'No linked video yet',
        description: 'Render a video first, then Play Video will open the latest linked render.',
      });
      return;
    }
    setSelectedGeneration(gen);
    setSelectedVibeJobId(latest.job_id);
    setVibeDialogOpen(true);
  };

  const handleRenderVibeTube = async (gen: HistoryResponse) => {
    setRenderingGenerationIds((prev) => {
      const next = new Set(prev);
      next.add(gen.id);
      return next;
    });
    toast({
      title: 'Rendering video...',
      description: 'VibeTube render started in background for this generation.',
    });
    try {
      const settings = getPersistedVibeTubeRenderSettings();
      const backgroundImage = settings.use_background_image
        ? await getPersistedVibeTubeBackgroundImageFileAsync()
        : undefined;
      const result = await apiClient.renderVibeTube({
        profile_id: gen.profile_id,
        generation_id: gen.id,
        ...settings,
        background_image: backgroundImage,
      });
      await queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] });
      setSelectedVibeJobId(result.job_id);
      toast({
        title: 'VibeTube render complete',
        description: `Render ${result.job_id.slice(0, 8)} linked to this generation.`,
      });
      openVibeDialog(gen);
    } catch (error) {
      toast({
        title: 'Render failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRenderingGenerationIds((prev) => {
        const next = new Set(prev);
        next.delete(gen.id);
        return next;
      });
    }
  };

  const linkedJobs: VibeTubeJobResponse[] = (vibetubeJobsQuery.data ?? []).filter(
    (job) => selectedGeneration && job.source_generation_id === selectedGeneration.id,
  );
  const selectedVibeJob =
    linkedJobs.find((job) => job.job_id === selectedVibeJobId) ?? linkedJobs[0] ?? null;

  const handleDeleteVibeRender = async (jobId: string) => {
    const confirmed = await confirm('Delete this linked VibeTube render?');
    if (!confirmed) return;
    setIsDeletingVibeRender(true);
    try {
      await apiClient.deleteVibeTubeJob(jobId);
      await queryClient.invalidateQueries({ queryKey: ['vibetube-jobs'] });
      if (selectedVibeJobId === jobId) {
        setSelectedVibeJobId(null);
      }
      toast({ title: 'Render deleted', description: 'Linked VibeTube render removed.' });
    } catch (error) {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsDeletingVibeRender(false);
    }
  };

  const handleExportVibeMp4 = async (jobId: string) => {
    try {
      const blob = await apiClient.exportVibeTubeMp4(jobId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vibetube-${jobId}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'MP4 exported', description: 'Saved linked VibeTube MP4.' });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExportVibeSrt = async (jobId: string) => {
    try {
      const blob = await apiClient.exportVibeTubeSubtitles(jobId, 'srt');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vibetube-${jobId}.srt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Subtitles exported', description: 'Saved linked VibeTube subtitles (SRT).' });
    } catch (error) {
      toast({
        title: 'Subtitle export failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleImportConfirm = () => {
    if (selectedFile) {
      importGeneration.mutate(selectedFile, {
        onSuccess: (data) => {
          setImportDialogOpen(false);
          setSelectedFile(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
          toast({
            title: 'Generation imported',
            description: data.message || 'Generation imported successfully',
          });
        },
        onError: (error) => {
          toast({
            title: 'Failed to import generation',
            description: error.message,
            variant: 'destructive',
          });
        },
      });
    }
  };

  if (isLoading && page === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const history = allHistory;
  const hasMore = allHistory.length < total;

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {history.length === 0 ? (
        <div className="text-center py-12 px-5 border-2 border-dashed mb-5 border-muted rounded-md text-muted-foreground flex-1 flex items-center justify-center">
          No voice generations, yet...
        </div>
      ) : (
        <>
          {isScrolled && (
            <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none" />
          )}
          <div
            ref={scrollRef}
            className={cn(
              'flex-1 min-h-0 overflow-y-auto space-y-2 pb-4',
              isPlayerVisible && BOTTOM_SAFE_AREA_PADDING,
            )}
          >
            {history.map((gen) => {
              const isCurrentlyPlaying = currentAudioId === gen.id && isPlaying;
              const isRenderingVideo = renderingGenerationIds.has(gen.id);
              return (
                <div
                  key={gen.id}
                  className={cn(
                    'flex items-start gap-4 min-h-[126px] border rounded-md p-3 bg-card hover:bg-muted/70 transition-colors text-left w-full',
                    isCurrentlyPlaying && 'bg-muted/70',
                  )}
                >
                  {/* Waveform icon */}
                  <div className="flex items-center shrink-0">
                    <AudioWaveform className="h-5 w-5 text-muted-foreground" />
                  </div>

                  {/* Left side - Meta information */}
                  <div className="flex flex-col gap-1.5 w-48 shrink-0 justify-start pt-1">
                    <div className="font-medium text-sm truncate" title={gen.profile_name}>
                      {gen.profile_name}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{gen.language}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDuration(gen.duration)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(gen.created_at)}
                    </div>
                    {isRenderingVideo && (
                      <div className="flex items-center gap-1.5 text-xs text-accent">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Rendering video...</span>
                      </div>
                    )}
                  </div>

                  {/* Right side - Transcript textarea */}
                  <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <Textarea
                      value={gen.text}
                      className="min-h-[72px] resize-none text-sm text-muted-foreground select-text"
                      readOnly
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePlay(gen.id, gen.text, gen.profile_id)}
                      >
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Play Audio
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePlayLatestVideo(gen)}
                      >
                        <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
                        Play Video
                      </Button>
                    </div>
                  </div>

                  {/* Far right - Ellipsis actions */}
                  <div
                    className="w-10 shrink-0 flex justify-end"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => handlePlay(gen.id, gen.text, gen.profile_id)}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          Play Audio
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDownloadAudio(gen.id, gen.text)}
                          disabled={exportGenerationAudio.isPending}
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Export Audio
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleRenderVibeTube(gen)}
                          disabled={isRenderingVideo}
                        >
                          <Clapperboard className="mr-2 h-4 w-4" />
                          {isRenderingVideo ? 'Rendering...' : 'Render Video'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openVibeDialog(gen)}>
                          <Eye className="mr-2 h-4 w-4" />
                          Preveiw/Export Video
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDeleteClick(gen.id, gen.profile_name)}
                          disabled={deleteGeneration.isPending}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}

            {/* Load more trigger element */}
            {hasMore && (
              <div ref={loadMoreRef} className="flex items-center justify-center py-4">
                {isFetching && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
              </div>
            )}

            {/* End of list indicator */}
            {!hasMore && history.length > 0 && (
              <div className="text-center py-4 text-xs text-muted-foreground">
                You've reached the end
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Generation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this generation from "{generationToDelete?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setGenerationToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleteGeneration.isPending}
            >
              {deleteGeneration.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Generation</DialogTitle>
            <DialogDescription>
              Import the generation from "{selectedFile?.name}". This will add it to your history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setImportDialogOpen(false);
                setSelectedFile(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImportConfirm}
              disabled={importGeneration.isPending || !selectedFile}
            >
              {importGeneration.isPending ? 'Importing...' : 'Import'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={vibeDialogOpen} onOpenChange={setVibeDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Linked VibeTube Renders</DialogTitle>
            <DialogDescription>
              {selectedGeneration
                ? `${selectedGeneration.profile_name} | ${selectedGeneration.text.slice(0, 80)}`
                : 'Select a generation to view linked renders.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {selectedGeneration && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRenderVibeTube(selectedGeneration)}
                  disabled={renderingGenerationIds.has(selectedGeneration.id)}
                >
                  <Clapperboard className="mr-2 h-4 w-4" />
                  {renderingGenerationIds.has(selectedGeneration.id) ? 'Rendering...' : 'Render New'}
                </Button>
              )}
              {selectedVibeJob && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExportVibeMp4(selectedVibeJob.job_id)}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export MP4
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExportVibeSrt(selectedVibeJob.job_id)}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export SRT
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteVibeRender(selectedVibeJob.job_id)}
                    disabled={isDeletingVibeRender}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {isDeletingVibeRender ? 'Deleting...' : 'Delete'}
                  </Button>
                </>
              )}
            </div>

            {selectedVibeJob ? (
              <video
                className="w-full rounded-lg border bg-black/60 max-h-[380px]"
                controls
                autoPlay
                preload="metadata"
                key={selectedVibeJob.job_id}
                src={apiClient.getVibeTubePreviewUrl(selectedVibeJob.job_id)}
              />
            ) : (
              <div className="text-sm text-muted-foreground">
                No linked render found for this generation yet.
              </div>
            )}

            {linkedJobs.length > 0 && (
              <div className="space-y-2 max-h-44 overflow-y-auto border rounded-md p-2">
                {linkedJobs.map((job) => (
                  <button
                    key={job.job_id}
                    type="button"
                    className={cn(
                      'w-full text-left rounded-md border px-3 py-2 text-sm hover:bg-muted/60 transition-colors',
                      selectedVibeJob?.job_id === job.job_id && 'bg-muted',
                    )}
                    onClick={() => setSelectedVibeJobId(job.job_id)}
                  >
                    <div className="font-medium">{job.job_id.slice(0, 8)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(job.created_at)} |{' '}
                      {job.duration_sec != null ? formatDuration(job.duration_sec) : '--'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVibeDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
