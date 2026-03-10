import type { LanguageCode } from '@/lib/constants/languages';
import { useServerStore } from '@/stores/serverStore';
import type {
  ActiveTasksResponse,
  GenerationRequest,
  GenerationResponse,
  HealthResponse,
  HistoryListResponse,
  HistoryQuery,
  HistoryResponse,
  ImageModelStatusResponse,
  ModelDownloadRequest,
  ModelStatusListResponse,
  ProfileSampleResponse,
  StoryBatchCreateRequest,
  StoryBatchCreateResponse,
  StoryCreate,
  StoryDetailResponse,
  StoryItemBatchUpdate,
  StoryItemCreate,
  StoryItemDetail,
  StoryItemMove,
  StoryItemRegenerateRequest,
  StoryItemReorder,
  StoryItemSplit,
  StoryItemTrim,
  StoryResponse,
  StoryVibeTubeRenderRequest,
  TranscriptionResponse,
  VibeTubeAvatarGenerateRequest,
  VibeTubeAvatarPackResponse,
  VibeTubeAvatarPreviewResponse,
  VibeTubeExportFormat,
  VibeTubeJobResponse,
  VibeTubeRenderRequest,
  VibeTubeRenderResponse,
  VoiceProfileCreate,
  VoiceProfileResponse,
} from './types';

class ApiClient {
  private getBaseUrl(): string {
    const serverUrl = useServerStore.getState().serverUrl;
    return serverUrl;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  // Health
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  // Profiles
  async createProfile(data: VoiceProfileCreate): Promise<VoiceProfileResponse> {
    return this.request<VoiceProfileResponse>('/profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listProfiles(query?: { exclude_story_only?: boolean }): Promise<VoiceProfileResponse[]> {
    const params = new URLSearchParams();
    if (query?.exclude_story_only !== undefined) {
      params.append('exclude_story_only', String(query.exclude_story_only));
    }
    const queryString = params.toString();
    const endpoint = queryString ? `/profiles?${queryString}` : '/profiles';
    return this.request<VoiceProfileResponse[]>(endpoint);
  }

  async getProfile(profileId: string): Promise<VoiceProfileResponse> {
    return this.request<VoiceProfileResponse>(`/profiles/${profileId}`);
  }

  async updateProfile(profileId: string, data: VoiceProfileCreate): Promise<VoiceProfileResponse> {
    return this.request<VoiceProfileResponse>(`/profiles/${profileId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.request<void>(`/profiles/${profileId}`, {
      method: 'DELETE',
    });
  }

  async addProfileSample(
    profileId: string,
    file: File,
    referenceText: string,
  ): Promise<ProfileSampleResponse> {
    const url = `${this.getBaseUrl()}/profiles/${profileId}/samples`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('reference_text', referenceText);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async listProfileSamples(profileId: string): Promise<ProfileSampleResponse[]> {
    return this.request<ProfileSampleResponse[]>(`/profiles/${profileId}/samples`);
  }

  async deleteProfileSample(sampleId: string): Promise<void> {
    await this.request<void>(`/profiles/samples/${sampleId}`, {
      method: 'DELETE',
    });
  }

  async updateProfileSample(
    sampleId: string,
    referenceText: string,
  ): Promise<ProfileSampleResponse> {
    return this.request<ProfileSampleResponse>(`/profiles/samples/${sampleId}`, {
      method: 'PUT',
      body: JSON.stringify({ reference_text: referenceText }),
    });
  }

  async updateProfileSampleGain(sampleId: string, gainDb: number): Promise<ProfileSampleResponse> {
    return this.request<ProfileSampleResponse>(`/profiles/samples/${sampleId}/gain`, {
      method: 'PUT',
      body: JSON.stringify({ gain_db: gainDb }),
    });
  }

  async exportProfile(profileId: string): Promise<Blob> {
    const url = `${this.getBaseUrl()}/profiles/${profileId}/export`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.blob();
  }

  async importProfile(file: File): Promise<VoiceProfileResponse> {
    const url = `${this.getBaseUrl()}/profiles/import`;
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async uploadAvatar(profileId: string, file: File): Promise<VoiceProfileResponse> {
    const url = `${this.getBaseUrl()}/profiles/${profileId}/avatar`;
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async deleteAvatar(profileId: string): Promise<void> {
    await this.request<void>(`/profiles/${profileId}/avatar`, {
      method: 'DELETE',
    });
  }

  // Generation
  async generateSpeech(data: GenerationRequest): Promise<GenerationResponse> {
    return this.request<GenerationResponse>('/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // History
  async listHistory(query?: HistoryQuery): Promise<HistoryListResponse> {
    const params = new URLSearchParams();
    if (query?.profile_id) params.append('profile_id', query.profile_id);
    if (query?.search) params.append('search', query.search);
    if (query?.exclude_story_generations !== undefined) {
      params.append('exclude_story_generations', String(query.exclude_story_generations));
    }
    if (query?.limit) params.append('limit', query.limit.toString());
    if (query?.offset) params.append('offset', query.offset.toString());

    const queryString = params.toString();
    const endpoint = queryString ? `/history?${queryString}` : '/history';

    return this.request<HistoryListResponse>(endpoint);
  }

  async getGeneration(generationId: string): Promise<HistoryResponse> {
    return this.request<HistoryResponse>(`/history/${generationId}`);
  }

  async deleteGeneration(generationId: string): Promise<void> {
    await this.request<void>(`/history/${generationId}`, {
      method: 'DELETE',
    });
  }

  async exportGeneration(generationId: string): Promise<Blob> {
    const url = `${this.getBaseUrl()}/history/${generationId}/export`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.blob();
  }

  async exportGenerationAudio(generationId: string): Promise<Blob> {
    const url = `${this.getBaseUrl()}/history/${generationId}/export-audio`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.blob();
  }

  async importGeneration(file: File): Promise<{
    id: string;
    profile_id: string;
    profile_name: string;
    text: string;
    message: string;
  }> {
    const url = `${this.getBaseUrl()}/history/import`;
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  // Audio
  getAudioUrl(audioId: string): string {
    return `${this.getBaseUrl()}/audio/${audioId}`;
  }

  getSampleUrl(sampleId: string): string {
    return `${this.getBaseUrl()}/samples/${sampleId}`;
  }

  // Transcription
  async transcribeAudio(file: File, language?: LanguageCode): Promise<TranscriptionResponse> {
    const formData = new FormData();
    formData.append('file', file);
    if (language) {
      formData.append('language', language);
    }

    const url = `${this.getBaseUrl()}/transcribe`;
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  // Model Management
  async getModelStatus(): Promise<ModelStatusListResponse> {
    return this.request<ModelStatusListResponse>('/models/status');
  }

  async triggerModelDownload(modelName: string): Promise<{ message: string }> {
    console.log(
      '[API] triggerModelDownload called for:',
      modelName,
      'at',
      new Date().toISOString(),
    );
    const result = await this.request<{ message: string }>('/models/download', {
      method: 'POST',
      body: JSON.stringify({ model_name: modelName } as ModelDownloadRequest),
    });
    console.log('[API] triggerModelDownload response:', result);
    return result;
  }

  async deleteModel(modelName: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/models/${modelName}`, {
      method: 'DELETE',
    });
  }

  async getStylizedPixelImageModelStatus(): Promise<ImageModelStatusResponse> {
    return this.request<ImageModelStatusResponse>('/image-models/stylizedpixel/status');
  }

  async downloadStylizedPixelImageModel(): Promise<{ message: string }> {
    return this.request<{ message: string }>('/image-models/stylizedpixel/download', {
      method: 'POST',
    });
  }

  // Task Management
  async getActiveTasks(): Promise<ActiveTasksResponse> {
    return this.request<ActiveTasksResponse>('/tasks/active');
  }

  // Audio Channels
  async listChannels(): Promise<
    Array<{
      id: string;
      name: string;
      is_default: boolean;
      device_ids: string[];
      created_at: string;
    }>
  > {
    return this.request('/channels');
  }

  async createChannel(data: { name: string; device_ids: string[] }): Promise<{
    id: string;
    name: string;
    is_default: boolean;
    device_ids: string[];
    created_at: string;
  }> {
    return this.request('/channels', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateChannel(
    channelId: string,
    data: {
      name?: string;
      device_ids?: string[];
    },
  ): Promise<{
    id: string;
    name: string;
    is_default: boolean;
    device_ids: string[];
    created_at: string;
  }> {
    return this.request(`/channels/${channelId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteChannel(channelId: string): Promise<{ message: string }> {
    return this.request(`/channels/${channelId}`, {
      method: 'DELETE',
    });
  }

  async getChannelVoices(channelId: string): Promise<{ profile_ids: string[] }> {
    return this.request(`/channels/${channelId}/voices`);
  }

  async setChannelVoices(channelId: string, profileIds: string[]): Promise<{ message: string }> {
    return this.request(`/channels/${channelId}/voices`, {
      method: 'PUT',
      body: JSON.stringify({ profile_ids: profileIds }),
    });
  }

  async getProfileChannels(profileId: string): Promise<{ channel_ids: string[] }> {
    return this.request(`/profiles/${profileId}/channels`);
  }

  async setProfileChannels(profileId: string, channelIds: string[]): Promise<{ message: string }> {
    return this.request(`/profiles/${profileId}/channels`, {
      method: 'PUT',
      body: JSON.stringify({ channel_ids: channelIds }),
    });
  }

  // Stories
  async listStories(): Promise<StoryResponse[]> {
    return this.request<StoryResponse[]>('/stories');
  }

  async createStory(data: StoryCreate): Promise<StoryResponse> {
    return this.request<StoryResponse>('/stories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createStoryBatch(data: StoryBatchCreateRequest): Promise<StoryBatchCreateResponse> {
    return this.request<StoryBatchCreateResponse>('/stories/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async importStoryJson(file: File): Promise<StoryBatchCreateResponse> {
    const url = `${this.getBaseUrl()}/stories/import-json`;
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async getStory(storyId: string): Promise<StoryDetailResponse> {
    return this.request<StoryDetailResponse>(`/stories/${storyId}`);
  }

  async updateStory(storyId: string, data: StoryCreate): Promise<StoryResponse> {
    return this.request<StoryResponse>(`/stories/${storyId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteStory(storyId: string): Promise<void> {
    await this.request<void>(`/stories/${storyId}`, {
      method: 'DELETE',
    });
  }

  async addStoryItem(storyId: string, data: StoryItemCreate): Promise<StoryItemDetail> {
    return this.request<StoryItemDetail>(`/stories/${storyId}/items`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removeStoryItem(storyId: string, itemId: string): Promise<void> {
    await this.request<void>(`/stories/${storyId}/items/${itemId}`, {
      method: 'DELETE',
    });
  }

  async regenerateStoryItem(
    storyId: string,
    itemId: string,
    data: StoryItemRegenerateRequest,
  ): Promise<StoryItemDetail> {
    return this.request<StoryItemDetail>(`/stories/${storyId}/items/${itemId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateStoryItemTimes(storyId: string, data: StoryItemBatchUpdate): Promise<void> {
    await this.request<void>(`/stories/${storyId}/items/times`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async reorderStoryItems(storyId: string, data: StoryItemReorder): Promise<StoryItemDetail[]> {
    return this.request<StoryItemDetail[]>(`/stories/${storyId}/items/reorder`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async moveStoryItem(
    storyId: string,
    itemId: string,
    data: StoryItemMove,
  ): Promise<StoryItemDetail> {
    return this.request<StoryItemDetail>(`/stories/${storyId}/items/${itemId}/move`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async trimStoryItem(
    storyId: string,
    itemId: string,
    data: StoryItemTrim,
  ): Promise<StoryItemDetail> {
    return this.request<StoryItemDetail>(`/stories/${storyId}/items/${itemId}/trim`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async splitStoryItem(
    storyId: string,
    itemId: string,
    data: StoryItemSplit,
  ): Promise<StoryItemDetail[]> {
    return this.request<StoryItemDetail[]>(`/stories/${storyId}/items/${itemId}/split`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async duplicateStoryItem(storyId: string, itemId: string): Promise<StoryItemDetail> {
    return this.request<StoryItemDetail>(`/stories/${storyId}/items/${itemId}/duplicate`, {
      method: 'POST',
    });
  }

  async exportStoryAudio(storyId: string): Promise<Blob> {
    const url = `${this.getBaseUrl()}/stories/${storyId}/export-audio`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: response.statusText,
      }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }

    return response.blob();
  }

  async renderStoryVibeTube(
    storyId: string,
    data: StoryVibeTubeRenderRequest = {},
  ): Promise<VibeTubeRenderResponse> {
    return this.request<VibeTubeRenderResponse>(`/stories/${storyId}/render-vibetube`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async renderVibeTube(data: VibeTubeRenderRequest): Promise<VibeTubeRenderResponse> {
    const url = `${this.getBaseUrl()}/vibetube/render`;
    const formData = new FormData();

    if (data.profile_id) formData.append('profile_id', data.profile_id);
    if (data.text) formData.append('text', data.text);
    if (data.language) formData.append('language', data.language);
    if (data.generation_id) formData.append('generation_id', data.generation_id);
    if (data.fps !== undefined) formData.append('fps', String(data.fps));
    if (data.resolution_preset !== undefined)
      formData.append('resolution_preset', data.resolution_preset);
    if (data.width !== undefined) formData.append('width', String(data.width));
    if (data.height !== undefined) formData.append('height', String(data.height));
    if (data.on_threshold !== undefined) formData.append('on_threshold', String(data.on_threshold));
    if (data.off_threshold !== undefined)
      formData.append('off_threshold', String(data.off_threshold));
    if (data.smoothing_windows !== undefined)
      formData.append('smoothing_windows', String(data.smoothing_windows));
    if (data.min_hold_windows !== undefined)
      formData.append('min_hold_windows', String(data.min_hold_windows));
    if (data.blink_min_interval_sec !== undefined)
      formData.append('blink_min_interval_sec', String(data.blink_min_interval_sec));
    if (data.blink_max_interval_sec !== undefined)
      formData.append('blink_max_interval_sec', String(data.blink_max_interval_sec));
    if (data.blink_duration_frames !== undefined)
      formData.append('blink_duration_frames', String(data.blink_duration_frames));
    if (data.head_motion_amount_px !== undefined)
      formData.append('head_motion_amount_px', String(data.head_motion_amount_px));
    if (data.head_motion_change_sec !== undefined)
      formData.append('head_motion_change_sec', String(data.head_motion_change_sec));
    if (data.head_motion_smoothness !== undefined)
      formData.append('head_motion_smoothness', String(data.head_motion_smoothness));
    if (data.voice_bounce_amount_px !== undefined)
      formData.append('voice_bounce_amount_px', String(data.voice_bounce_amount_px));
    if (data.voice_bounce_sensitivity !== undefined)
      formData.append('voice_bounce_sensitivity', String(data.voice_bounce_sensitivity));
    if (data.use_background !== undefined)
      formData.append('use_background', String(data.use_background));
    if (data.use_background_color !== undefined)
      formData.append('use_background_color', String(data.use_background_color));
    if (data.use_background_image !== undefined)
      formData.append('use_background_image', String(data.use_background_image));
    if (data.background_color !== undefined)
      formData.append('background_color', data.background_color);
    if (data.subtitle_enabled !== undefined)
      formData.append('subtitle_enabled', String(data.subtitle_enabled));
    if (data.subtitle_style !== undefined) formData.append('subtitle_style', data.subtitle_style);
    if (data.subtitle_text_color !== undefined)
      formData.append('subtitle_text_color', data.subtitle_text_color);
    if (data.subtitle_outline_color !== undefined)
      formData.append('subtitle_outline_color', data.subtitle_outline_color);
    if (data.subtitle_outline_width !== undefined)
      formData.append('subtitle_outline_width', String(data.subtitle_outline_width));
    if (data.subtitle_font_family !== undefined)
      formData.append('subtitle_font_family', data.subtitle_font_family);
    if (data.subtitle_bold !== undefined)
      formData.append('subtitle_bold', String(data.subtitle_bold));
    if (data.subtitle_italic !== undefined)
      formData.append('subtitle_italic', String(data.subtitle_italic));
    if (data.show_profile_names !== undefined)
      formData.append('show_profile_names', String(data.show_profile_names));
    if (data.background_image) formData.append('background_image', data.background_image);

    if (data.idle) formData.append('idle', data.idle);
    if (data.talk) formData.append('talk', data.talk);
    if (data.idle_blink) formData.append('idle_blink', data.idle_blink);
    if (data.talk_blink) formData.append('talk_blink', data.talk_blink);
    if (data.blink) formData.append('blink', data.blink);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }
    return response.json();
  }

  getVibeTubePreviewUrl(jobId: string): string {
    return `${this.getBaseUrl()}/vibetube/jobs/${jobId}/video`;
  }

  async exportVibeTubeVideo(
    jobId: string,
    format: VibeTubeExportFormat | 'auto' = 'auto',
  ): Promise<Blob> {
    const url = `${this.getBaseUrl()}/vibetube/jobs/${jobId}/export-video?format=${format}`;
    const response = await fetch(url);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }
    return response.blob();
  }

  async exportVibeTubeMp4(jobId: string): Promise<Blob> {
    return this.exportVibeTubeVideo(jobId, 'mp4');
  }

  async exportVibeTubeSubtitles(jobId: string, format: 'srt' | 'vtt' = 'srt'): Promise<Blob> {
    const url = `${this.getBaseUrl()}/vibetube/jobs/${jobId}/export-subtitles?format=${format}`;
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          'Subtitle export endpoint not found on backend. Restart/update backend server, then try again.',
        );
      }
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }
    return response.blob();
  }

  async listVibeTubeJobs(): Promise<VibeTubeJobResponse[]> {
    return this.request<VibeTubeJobResponse[]>('/vibetube/jobs');
  }

  async deleteVibeTubeJob(jobId: string): Promise<void> {
    await this.request<void>(`/vibetube/jobs/${jobId}`, { method: 'DELETE' });
  }

  async getVibeTubeAvatarPack(profileId: string): Promise<VibeTubeAvatarPackResponse> {
    return this.request<VibeTubeAvatarPackResponse>(`/profiles/${profileId}/vibetube-avatar-pack`);
  }

  async saveVibeTubeAvatarPack(data: {
    profileId: string;
    idle: File;
    talk: File;
    idleBlink: File;
    talkBlink: File;
  }): Promise<VibeTubeAvatarPackResponse> {
    const url = `${this.getBaseUrl()}/profiles/${data.profileId}/vibetube-avatar-pack`;
    const formData = new FormData();
    formData.append('idle', data.idle);
    formData.append('talk', data.talk);
    formData.append('idle_blink', data.idleBlink);
    formData.append('talk_blink', data.talkBlink);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `HTTP error! status: ${response.status}`);
    }
    return response.json();
  }

  async generateVibeTubeAvatarPreview(
    profileId: string,
    data: VibeTubeAvatarGenerateRequest,
  ): Promise<VibeTubeAvatarPreviewResponse> {
    return this.request<VibeTubeAvatarPreviewResponse>(
      `/profiles/${profileId}/vibetube-avatar-pack/generate-preview`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async generateVibeTubeAvatarIdlePreview(
    profileId: string,
    data: VibeTubeAvatarGenerateRequest,
  ): Promise<VibeTubeAvatarPreviewResponse> {
    return this.request<VibeTubeAvatarPreviewResponse>(
      `/profiles/${profileId}/vibetube-avatar-pack/generate-idle-preview`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async generateVibeTubeAvatarRestPreview(
    profileId: string,
    data: VibeTubeAvatarGenerateRequest,
  ): Promise<VibeTubeAvatarPreviewResponse> {
    return this.request<VibeTubeAvatarPreviewResponse>(
      `/profiles/${profileId}/vibetube-avatar-pack/generate-rest-preview`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  }

  async getVibeTubeAvatarPreview(profileId: string): Promise<VibeTubeAvatarPreviewResponse> {
    return this.request<VibeTubeAvatarPreviewResponse>(
      `/profiles/${profileId}/vibetube-avatar-preview`,
    );
  }

  async applyVibeTubeAvatarPreview(profileId: string): Promise<VibeTubeAvatarPackResponse> {
    return this.request<VibeTubeAvatarPackResponse>(
      `/profiles/${profileId}/vibetube-avatar-pack/apply-preview`,
      { method: 'POST' },
    );
  }

  getVibeTubeAvatarPreviewStateUrl(
    profileId: string,
    state: 'idle' | 'talk' | 'idle_blink' | 'talk_blink',
  ): string {
    return `${this.getBaseUrl()}/profiles/${profileId}/vibetube-avatar-preview/${state}`;
  }

  getVibeTubeAvatarStateUrl(
    profileId: string,
    state: 'idle' | 'talk' | 'idle_blink' | 'talk_blink',
  ): string {
    return `${this.getBaseUrl()}/profiles/${profileId}/vibetube-avatar-pack/${state}`;
  }
}

export const apiClient = new ApiClient();
