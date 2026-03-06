"""
Pydantic models for request/response validation.
"""

from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, List
from datetime import datetime


class VoiceProfileCreate(BaseModel):
    """Request model for creating a voice profile."""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    language: str = Field(default="en", pattern="^(zh|en|ja|ko|de|fr|ru|pt|es|it)$")


class VoiceProfileResponse(BaseModel):
    """Response model for voice profile."""
    id: str
    name: str
    description: Optional[str]
    language: str
    avatar_path: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ProfileSampleCreate(BaseModel):
    """Request model for adding a sample to a profile."""
    reference_text: str = Field(..., min_length=1, max_length=1000)


class ProfileSampleUpdate(BaseModel):
    """Request model for updating a profile sample."""
    reference_text: str = Field(..., min_length=1, max_length=1000)


class ProfileSampleGainUpdate(BaseModel):
    """Request model for applying gain to a profile sample."""
    gain_db: float = Field(..., ge=-30.0, le=30.0)


class ProfileSampleResponse(BaseModel):
    """Response model for profile sample."""
    id: str
    profile_id: str
    audio_path: str
    reference_text: str

    class Config:
        from_attributes = True


class GenerationRequest(BaseModel):
    """Request model for voice generation."""
    profile_id: str
    text: str = Field(..., min_length=1, max_length=5000)
    language: str = Field(default="en", pattern="^(zh|en|ja|ko|de|fr|ru|pt|es|it)$")
    seed: Optional[int] = Field(None, ge=0)
    model_size: Optional[str] = Field(default="1.7B", pattern="^(1\\.7B|0\\.6B)$")
    instruct: Optional[str] = Field(None, max_length=500)


class GenerationResponse(BaseModel):
    """Response model for voice generation."""
    id: str
    profile_id: str
    text: str
    language: str
    audio_path: str
    duration: float
    seed: Optional[int]
    instruct: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class VibeTubeRenderResponse(BaseModel):
    """Response model for VibeTube render endpoint."""
    job_id: str
    output_dir: str
    video_path: str
    timeline_path: str
    captions_path: Optional[str] = None
    meta_path: str
    duration: float
    source_generation_id: Optional[str] = None
    source_story_id: Optional[str] = None


class VibeTubeAvatarPackResponse(BaseModel):
    """Response model for VibeTube avatar pack bound to a voice profile."""
    profile_id: str
    idle_url: Optional[str] = None
    talk_url: Optional[str] = None
    idle_blink_url: Optional[str] = None
    talk_blink_url: Optional[str] = None
    complete: bool = False


class VibeTubeAvatarPreviewResponse(BaseModel):
    """Response model for generated (not yet applied) avatar preview states."""
    profile_id: str
    idle_url: Optional[str] = None
    idle_ready: bool = False
    talk_url: Optional[str] = None
    idle_blink_url: Optional[str] = None
    talk_blink_url: Optional[str] = None
    complete: bool = False


class VibeTubeAvatarGenerateRequest(BaseModel):
    """Request model for auto-generating a 4-state VibeTube avatar pack."""
    prompt: str = Field(..., min_length=1, max_length=1000)
    seed: Optional[int] = Field(default=None, ge=0)
    size: int = Field(default=512, ge=64, le=1024)
    output_size: int = Field(default=512, ge=64, le=2048)
    palette_colors: int = Field(default=64, ge=2, le=256)
    seed_step: int = Field(default=1, ge=0, le=10_000)
    model_id: Optional[str] = Field(default=None, max_length=300)
    lora_id: Optional[str] = Field(default=None, max_length=300)
    lora_scale: float = Field(default=0.85, ge=0.0, le=2.0)
    negative_prompt: Optional[str] = Field(default=None, max_length=2000)
    num_inference_steps: int = Field(default=24, ge=4, le=120)
    guidance_scale: float = Field(default=7.0, ge=0.0, le=20.0)
    variation_strength: float = Field(default=0.2, ge=0.0, le=1.0)
    match_existing_style: bool = Field(default=True)
    reference_strength: float = Field(default=0.2, ge=0.0, le=1.0)


class VibeTubeJobResponse(BaseModel):
    """Response model for one saved VibeTube render job."""
    job_id: str
    created_at: datetime
    duration_sec: Optional[float] = None
    video_path: Optional[str] = None
    source_generation_id: Optional[str] = None
    source_story_id: Optional[str] = None
    source_story_name: Optional[str] = None
    source_profile_name: Optional[str] = None
    source_text_preview: Optional[str] = None


class StoryVibeTubeRenderRequest(BaseModel):
    """Request model for rendering a full story with VibeTube avatars."""
    fps: int = Field(default=30, ge=1, le=120)
    width: int = Field(default=512, ge=64, le=4096)
    height: int = Field(default=512, ge=64, le=4096)
    on_threshold: float = Field(default=0.024, ge=0.001, le=0.5)
    off_threshold: float = Field(default=0.016, ge=0.001, le=0.5)
    smoothing_windows: int = Field(default=3, ge=1, le=20)
    min_hold_windows: int = Field(default=1, ge=1, le=20)
    blink_min_interval_sec: float = Field(default=3.5, ge=0.2, le=60.0)
    blink_max_interval_sec: float = Field(default=5.5, ge=0.2, le=60.0)
    blink_duration_frames: int = Field(default=3, ge=1, le=30)
    head_motion_amount_px: float = Field(default=3.0, ge=0.0, le=100.0)
    head_motion_change_sec: float = Field(default=2.8, ge=0.1, le=60.0)
    head_motion_smoothness: float = Field(default=0.04, ge=0.001, le=1.0)
    voice_bounce_amount_px: float = Field(default=4.0, ge=0.0, le=100.0)
    voice_bounce_sensitivity: float = Field(default=1.0, ge=0.05, le=8.0)
    use_background_color: bool = False
    use_background_image: bool = False
    use_background: bool = False
    background_color: Optional[str] = Field(default="#101820")
    background_image_data: Optional[str] = None


class HistoryQuery(BaseModel):
    """Query model for generation history."""
    profile_id: Optional[str] = None
    search: Optional[str] = None
    exclude_story_generations: bool = False
    limit: int = Field(default=50, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)


class HistoryResponse(BaseModel):
    """Response model for history entry (includes profile name)."""
    id: str
    profile_id: str
    profile_name: str
    text: str
    language: str
    audio_path: str
    duration: float
    seed: Optional[int]
    instruct: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class HistoryListResponse(BaseModel):
    """Response model for history list."""
    items: List[HistoryResponse]
    total: int


class TranscriptionRequest(BaseModel):
    """Request model for audio transcription."""
    language: Optional[str] = Field(None, pattern="^(en|zh)$")


class TranscriptionResponse(BaseModel):
    """Response model for transcription."""
    text: str
    duration: float


class HealthResponse(BaseModel):
    """Response model for health check."""
    status: str
    model_loaded: bool
    model_downloaded: Optional[bool] = None  # Whether model is cached/downloaded
    model_size: Optional[str] = None  # Current model size if loaded
    gpu_available: bool
    gpu_type: Optional[str] = None  # GPU type (CUDA, MPS, or None)
    vram_used_mb: Optional[float] = None
    backend_type: Optional[str] = None  # Backend type (mlx or pytorch)


class ModelStatus(BaseModel):
    """Response model for model status."""
    model_name: str
    display_name: str
    downloaded: bool
    downloading: bool = False  # True if download is in progress
    size_mb: Optional[float] = None
    loaded: bool = False


class ModelStatusListResponse(BaseModel):
    """Response model for model status list."""
    models: List[ModelStatus]


class ModelDownloadRequest(BaseModel):
    """Request model for triggering model download."""
    model_name: str


class ImageModelStatusResponse(BaseModel):
    """Response model for the bundled optional local image test model."""
    model_name: str
    display_name: str
    downloaded: bool
    downloading: bool = False
    download_url: str
    file_path: Optional[str] = None
    size_bytes: Optional[int] = None


class ActiveDownloadTask(BaseModel):
    """Response model for active download task."""
    model_name: str
    status: str
    started_at: datetime


class ActiveGenerationTask(BaseModel):
    """Response model for active generation task."""
    task_id: str
    profile_id: str
    text_preview: str
    started_at: datetime


class ActiveTasksResponse(BaseModel):
    """Response model for active tasks."""
    downloads: List[ActiveDownloadTask]
    generations: List[ActiveGenerationTask]


class AudioChannelCreate(BaseModel):
    """Request model for creating an audio channel."""
    name: str = Field(..., min_length=1, max_length=100)
    device_ids: List[str] = Field(default_factory=list)


class AudioChannelUpdate(BaseModel):
    """Request model for updating an audio channel."""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    device_ids: Optional[List[str]] = None


class AudioChannelResponse(BaseModel):
    """Response model for audio channel."""
    id: str
    name: str
    is_default: bool
    device_ids: List[str]
    created_at: datetime

    class Config:
        from_attributes = True


class ChannelVoiceAssignment(BaseModel):
    """Request model for assigning voices to a channel."""
    profile_ids: List[str]


class ProfileChannelAssignment(BaseModel):
    """Request model for assigning channels to a profile."""
    channel_ids: List[str]


class StoryCreate(BaseModel):
    """Request model for creating a story."""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)


class StoryResponse(BaseModel):
    """Response model for story (list view)."""
    id: str
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    item_count: int = 0

    class Config:
        from_attributes = True


class StoryItemDetail(BaseModel):
    """Detail model for story item with generation info."""
    id: str
    story_id: str
    generation_id: str
    start_time_ms: int
    track: int = 0
    trim_start_ms: int = 0
    trim_end_ms: int = 0
    created_at: datetime
    # Generation details
    profile_id: str
    profile_name: str
    text: str
    language: str
    audio_path: str
    duration: float
    seed: Optional[int]
    instruct: Optional[str]
    generation_created_at: datetime

    class Config:
        from_attributes = True


class StoryDetailResponse(BaseModel):
    """Response model for story with items."""
    id: str
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    items: List[StoryItemDetail] = []

    class Config:
        from_attributes = True


class StoryItemCreate(BaseModel):
    """Request model for adding a generation to a story."""
    generation_id: str
    start_time_ms: Optional[int] = None  # If not provided, will be calculated automatically
    track: Optional[int] = 0  # Track number (0 = main track)


class StoryItemUpdateTime(BaseModel):
    """Request model for updating a story item's timecode."""
    generation_id: str
    start_time_ms: int = Field(..., ge=0)


class StoryItemBatchUpdate(BaseModel):
    """Request model for batch updating story item timecodes."""
    updates: List[StoryItemUpdateTime]


class StoryItemReorder(BaseModel):
    """Request model for reordering story items."""
    generation_ids: List[str] = Field(..., min_length=1)


class StoryItemMove(BaseModel):
    """Request model for moving a story item (position and/or track)."""
    start_time_ms: int = Field(..., ge=0)
    track: int = 0


class StoryItemTrim(BaseModel):
    """Request model for trimming a story item."""
    trim_start_ms: int = Field(..., ge=0)
    trim_end_ms: int = Field(..., ge=0)


class StoryItemSplit(BaseModel):
    """Request model for splitting a story item."""
    split_time_ms: int = Field(..., ge=0)  # Time within the clip to split at (relative to clip start)


class StoryBatchEntry(BaseModel):
    """One sequential line item in a bulk story generation request."""

    model_config = ConfigDict(extra="forbid")

    profile_name: str = Field(..., min_length=1, max_length=100)
    text: str = Field(..., min_length=1, max_length=5000)
    language: str = Field(default="en", pattern="^(zh|en|ja|ko|de|fr|ru|pt|es|it)$")
    seed: Optional[int] = Field(None, ge=0)
    model_size: Optional[str] = Field(default="1.7B", pattern="^(1\\.7B|0\\.6B)$")
    instruct: Optional[str] = Field(None, max_length=500)


class StoryBatchCreateRequest(BaseModel):
    """Request model for creating a full story from multiple generated entries."""

    model_config = ConfigDict(extra="forbid")

    story_name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    entries: List[StoryBatchEntry] = Field(..., min_length=1)
    auto_render: bool = False
    render_settings: Optional[StoryVibeTubeRenderRequest] = None


class StoryBatchEntryResult(BaseModel):
    """Result metadata for a single generated row inside a story batch."""

    index: int
    profile_name: str
    generation_id: str
    story_item_id: str


class StoryBatchCreateResponse(BaseModel):
    """Response model for a completed bulk story generation/import request."""

    story: StoryDetailResponse
    results: List[StoryBatchEntryResult]
    render_job: Optional[VibeTubeRenderResponse] = None
