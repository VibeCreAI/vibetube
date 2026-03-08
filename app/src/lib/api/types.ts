// API Types matching backend Pydantic models
import type { LanguageCode } from '@/lib/constants/languages';

export interface VoiceProfileCreate {
  name: string;
  description?: string;
  language: LanguageCode;
}

export interface VoiceProfileResponse {
  id: string;
  name: string;
  description?: string;
  language: string;
  avatar_path?: string;
  created_at: string;
  updated_at: string;
}

export interface ProfileSampleCreate {
  reference_text: string;
}

export interface ProfileSampleResponse {
  id: string;
  profile_id: string;
  audio_path: string;
  reference_text: string;
}

export interface GenerationRequest {
  profile_id: string;
  text: string;
  language: LanguageCode;
  seed?: number;
  model_size?: '1.7B' | '0.6B';
  instruct?: string;
}

export interface GenerationResponse {
  id: string;
  profile_id: string;
  text: string;
  language: string;
  audio_path: string;
  duration: number;
  seed?: number;
  created_at: string;
}

export interface HistoryQuery {
  profile_id?: string;
  search?: string;
  exclude_story_generations?: boolean;
  limit?: number;
  offset?: number;
}

export interface HistoryResponse extends GenerationResponse {
  profile_name: string;
}

export interface HistoryListResponse {
  items: HistoryResponse[];
  total: number;
}

export interface TranscriptionRequest {
  language?: LanguageCode;
}

export interface TranscriptionResponse {
  text: string;
  duration: number;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_downloaded?: boolean;
  model_size?: string;
  gpu_available: boolean;
  vram_used_mb?: number;
}

export interface ModelProgress {
  model_name: string;
  current: number;
  total: number;
  progress: number;
  filename?: string;
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  timestamp: string;
  error?: string;
}

export interface ModelStatus {
  model_name: string;
  display_name: string;
  downloaded: boolean;
  downloading: boolean; // True if download is in progress
  size_mb?: number;
  loaded: boolean;
}

export interface ModelStatusListResponse {
  models: ModelStatus[];
}

export interface ModelDownloadRequest {
  model_name: string;
}

export interface ImageModelStatusResponse {
  model_name: string;
  display_name: string;
  downloaded: boolean;
  downloading: boolean;
  download_url: string;
  file_path?: string;
  size_bytes?: number;
}

export interface ActiveDownloadTask {
  model_name: string;
  status: string;
  started_at: string;
}

export interface ActiveGenerationTask {
  task_id: string;
  profile_id: string;
  text_preview: string;
  started_at: string;
}

export interface ActiveTasksResponse {
  downloads: ActiveDownloadTask[];
  generations: ActiveGenerationTask[];
}

export interface StoryCreate {
  name: string;
  description?: string;
}

export interface StoryResponse {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  item_count: number;
}

export interface StoryItemDetail {
  id: string;
  story_id: string;
  generation_id: string;
  start_time_ms: number;
  track: number;
  trim_start_ms: number;
  trim_end_ms: number;
  created_at: string;
  profile_id: string;
  profile_name: string;
  text: string;
  language: string;
  audio_path: string;
  duration: number;
  seed?: number;
  instruct?: string;
  generation_created_at: string;
}

export interface StoryDetailResponse {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  items: StoryItemDetail[];
}

export interface StoryItemCreate {
  generation_id: string;
  start_time_ms?: number;
  track?: number;
}

export interface StoryItemUpdateTime {
  generation_id: string;
  start_time_ms: number;
}

export interface StoryItemBatchUpdate {
  updates: StoryItemUpdateTime[];
}

export interface StoryItemReorder {
  generation_ids: string[];
}

export interface StoryItemMove {
  start_time_ms: number;
  track: number;
}

export interface StoryItemTrim {
  trim_start_ms: number;
  trim_end_ms: number;
}

export interface StoryItemSplit {
  split_time_ms: number;
}

export interface StoryVibeTubeRenderRequest {
  fps?: number;
  resolution_preset?: string;
  width?: number;
  height?: number;
  on_threshold?: number;
  off_threshold?: number;
  smoothing_windows?: number;
  min_hold_windows?: number;
  blink_min_interval_sec?: number;
  blink_max_interval_sec?: number;
  blink_duration_frames?: number;
  head_motion_amount_px?: number;
  head_motion_change_sec?: number;
  head_motion_smoothness?: number;
  voice_bounce_amount_px?: number;
  voice_bounce_sensitivity?: number;
  use_background_color?: boolean;
  use_background_image?: boolean;
  use_background?: boolean;
  background_color?: string;
  background_image_data?: string;
  subtitle_enabled?: boolean;
  subtitle_style?: 'minimal' | 'cinema' | 'glass';
  subtitle_text_color?: string;
  subtitle_outline_color?: string;
  subtitle_outline_width?: number;
  subtitle_font_family?: 'sans' | 'serif' | 'mono';
  subtitle_bold?: boolean;
  subtitle_italic?: boolean;
  story_layout_style?: 'balanced' | 'stage' | 'compact';
  show_profile_names?: boolean;
}

export interface StoryBatchEntry {
  profile_name: string;
  text: string;
  language?: LanguageCode;
  seed?: number;
  model_size?: '1.7B' | '0.6B';
  instruct?: string;
}

export interface StoryBatchCreateRequest {
  story_name: string;
  description?: string;
  entries: StoryBatchEntry[];
  auto_render?: boolean;
  render_settings?: StoryVibeTubeRenderRequest;
}

export interface StoryBatchEntryResult {
  index: number;
  profile_name: string;
  generation_id: string;
  story_item_id: string;
}

export interface StoryBatchCreateResponse {
  story: StoryDetailResponse;
  results: StoryBatchEntryResult[];
  render_job?: VibeTubeRenderResponse | null;
}

export interface VibeTubeRenderRequest {
  profile_id?: string;
  text?: string;
  language?: LanguageCode;
  generation_id?: string;
  fps?: number;
  resolution_preset?: string;
  width?: number;
  height?: number;
  on_threshold?: number;
  off_threshold?: number;
  smoothing_windows?: number;
  min_hold_windows?: number;
  blink_min_interval_sec?: number;
  blink_max_interval_sec?: number;
  blink_duration_frames?: number;
  head_motion_amount_px?: number;
  head_motion_change_sec?: number;
  head_motion_smoothness?: number;
  voice_bounce_amount_px?: number;
  voice_bounce_sensitivity?: number;
  use_background_color?: boolean;
  use_background_image?: boolean;
  use_background?: boolean;
  background_color?: string;
  subtitle_enabled?: boolean;
  subtitle_style?: 'minimal' | 'cinema' | 'glass';
  subtitle_text_color?: string;
  subtitle_outline_color?: string;
  subtitle_outline_width?: number;
  subtitle_font_family?: 'sans' | 'serif' | 'mono';
  subtitle_bold?: boolean;
  subtitle_italic?: boolean;
  story_layout_style?: 'balanced' | 'stage' | 'compact';
  show_profile_names?: boolean;
  background_image?: File;
  idle?: File;
  talk?: File;
  idle_blink?: File;
  talk_blink?: File;
  blink?: File;
}

export interface VibeTubeAvatarPackResponse {
  profile_id: string;
  idle_url?: string;
  talk_url?: string;
  idle_blink_url?: string;
  talk_blink_url?: string;
  complete: boolean;
}

export interface VibeTubeAvatarPreviewResponse {
  profile_id: string;
  idle_url?: string;
  idle_ready?: boolean;
  talk_url?: string;
  idle_blink_url?: string;
  talk_blink_url?: string;
  complete: boolean;
}

export interface VibeTubeAvatarGenerateRequest {
  prompt: string;
  seed?: number;
  size?: number;
  output_size?: number;
  palette_colors?: number;
  seed_step?: number;
  model_id?: string;
  lora_id?: string;
  lora_scale?: number;
  negative_prompt?: string;
  num_inference_steps?: number;
  guidance_scale?: number;
  variation_strength?: number;
  match_existing_style?: boolean;
  reference_strength?: number;
}

export interface VibeTubeRenderResponse {
  job_id: string;
  output_dir: string;
  video_path: string;
  timeline_path: string;
  captions_path?: string;
  meta_path: string;
  duration: number;
  source_generation_id?: string;
  source_story_id?: string;
}

export interface VibeTubeJobResponse {
  job_id: string;
  created_at: string;
  duration_sec?: number;
  video_path?: string;
  source_generation_id?: string;
  source_story_id?: string;
  source_story_name?: string;
  source_profile_name?: string;
  source_text_preview?: string;
}
