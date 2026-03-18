import { create } from 'zustand';
import type { AudioProcessingOptions } from '@/lib/hooks/useAudioRecording';

interface BroadcastStore {
  selectedProfileId: string | null;
  setSelectedProfileId: (profileId: string | null) => void;
  selectedJobId: string | null;
  setSelectedJobId: (jobId: string | null) => void;
  popoutOpen: boolean;
  setPopoutOpen: (open: boolean) => void;
  captionText: string;
  setCaptionText: (text: string) => void;
  liveAudioProcessing: AudioProcessingOptions;
  setLiveAudioProcessing: (options: AudioProcessingOptions) => void;
  recordAudioProcessing: AudioProcessingOptions;
  setRecordAudioProcessing: (options: AudioProcessingOptions) => void;
}

export const useBroadcastStore = create<BroadcastStore>((set) => ({
  selectedProfileId: null,
  setSelectedProfileId: (selectedProfileId) => set({ selectedProfileId }),
  selectedJobId: null,
  setSelectedJobId: (selectedJobId) => set({ selectedJobId }),
  popoutOpen: false,
  setPopoutOpen: (popoutOpen) => set({ popoutOpen }),
  captionText: '',
  setCaptionText: (captionText) => set({ captionText }),
  liveAudioProcessing: {
    autoGainControl: false,
    noiseSuppression: false,
    echoCancellation: false,
  },
  setLiveAudioProcessing: (liveAudioProcessing) => set({ liveAudioProcessing }),
  recordAudioProcessing: {
    autoGainControl: true,
    noiseSuppression: true,
    echoCancellation: true,
  },
  setRecordAudioProcessing: (recordAudioProcessing) => set({ recordAudioProcessing }),
}));
