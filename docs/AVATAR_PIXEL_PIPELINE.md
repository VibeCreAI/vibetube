# Local Avatar Generation (Single-App)

VibeTube now generates the 4 avatar states directly in the backend (no ComfyUI dependency).

Built-in style references (used automatically):

- `backend/assets/avatar_style_refs/*.png`

Optional user overrides (also loaded if present):

- `data/avatar_style_refs/*.png`

Generated files:

- `data/profiles/<profile_id>/vibetube_avatar/idle.png`
- `data/profiles/<profile_id>/vibetube_avatar/talk.png`
- `data/profiles/<profile_id>/vibetube_avatar/idle_blink.png`
- `data/profiles/<profile_id>/vibetube_avatar/talk_blink.png`

Generation order:

1. `idle` is generated from prompt.
2. `talk` is generated from `idle` by opening the mouth.
3. `idle_blink` is generated from `idle` by closing the eyes.
4. `talk_blink` is generated from `talk` by closing the eyes.
5. Images are generated natively at `512x512` by default.
6. Generated images are saved as preview first; user must click Apply.

## API

Preview generation endpoint:

`POST /profiles/{profile_id}/vibetube-avatar-pack/generate-preview`

Apply preview endpoint:

`POST /profiles/{profile_id}/vibetube-avatar-pack/apply-preview`

Payload:

```json
{
  "prompt": "pixel hero with red scarf and brown boots",
  "seed": 12345,
  "size": 512,
  "output_size": 512
}
```

Optional fields:

- `model_id`
- `lora_id`
- `lora_scale`
- `size`
- `palette_colors`
- `seed_step`
- `negative_prompt`
- `num_inference_steps`
- `guidance_scale`
- `variation_strength`

## Built-in UI Presets

Model presets include:

- `runwayml/stable-diffusion-v1-5` (recommended)
- `Onodofthenorth/SD_PixelArt_SpriteSheet_Generator` (experimental)
- `CompVis/stable-diffusion-v1-4`
- custom model ID entry

Style presets:

- None
- Chibi Portrait
- Cozy Hoodie
- Retro Hero

Quality presets:

- Fast
- Balanced
- High

## Model Configuration

Defaults can be set with environment variables before backend startup:

- `VIBETUBE_AVATAR_MODEL_ID` (default: `runwayml/stable-diffusion-v1-5`)
- `VIBETUBE_AVATAR_LORA_ID` (optional)

Example startup on Windows:

```powershell
$env:VIBETUBE_AVATAR_MODEL_ID="runwayml/stable-diffusion-v1-5"
$env:VIBETUBE_AVATAR_LORA_ID=""
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 17493 --reload
```

## UI Flow

In Voice Profile form:

1. Enter character prompt in **Generate From Prompt (Local Model)**.
2. Optionally provide a seed.
3. Click **Generate Preview**.
4. Review images in the 4-state slots.
5. Click **Apply** to save, or click **Generate Preview** again to regenerate.

If generation fails, backend returns a clear message (model loading/runtime errors).
