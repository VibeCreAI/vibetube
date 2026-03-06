import { useState } from 'react';
import { FloatingGenerateBox } from '@/components/Generation/FloatingGenerateBox';
import { StoryBatchCreateDialog } from './StoryBatchCreateDialog';
import { StoryContent } from './StoryContent';
import { StoryList } from './StoryList';

export function StoriesTab() {
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Main content area */}
      <div className="flex-1 min-h-0 flex gap-6 overflow-hidden relative">
        {/* Left Column - Story List */}
        <div className="flex flex-col min-h-0 overflow-hidden w-full max-w-[360px] shrink-0">
          <StoryList onOpenBatchCreate={() => setBatchDialogOpen(true)} />
        </div>

        {/* Right Column - Story Content */}
        <div className="flex flex-col min-h-0 overflow-hidden flex-1">
          <StoryContent />
        </div>

        {/* Floating Generate Box - position is managed via storyStore.trackEditorHeight */}
        <FloatingGenerateBox showVoiceSelector />
      </div>
      <StoryBatchCreateDialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen} />
    </div>
  );
}
