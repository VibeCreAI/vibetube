from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

import requests


class VibetubeError(RuntimeError):
    """Raised when Vibetube API calls fail."""


@dataclass(slots=True)
class VoiceProfile:
    profile_id: str
    name: str
    language: str | None = None


def list_profiles(vibetube_url: str, timeout_sec: float = 20.0) -> list[VoiceProfile]:
    base = vibetube_url.rstrip("/")
    url = f"{base}/profiles"

    try:
        response = requests.get(url, timeout=timeout_sec)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        raise VibetubeError(f"Failed to list profiles from {url}: {exc}") from exc
    except ValueError as exc:
        raise VibetubeError(f"Vibetube response was not JSON at {url}.") from exc

    profiles_raw = data if isinstance(data, list) else data.get("profiles", [])
    out: list[VoiceProfile] = []
    for item in profiles_raw:
        if not isinstance(item, dict):
            continue
        profile_id = str(item.get("id") or item.get("profile_id") or "").strip()
        name = str(item.get("name") or item.get("display_name") or profile_id).strip()
        language = item.get("language")
        if not profile_id:
            continue
        out.append(VoiceProfile(profile_id=profile_id, name=name, language=str(language) if language else None))
    return out


def create_profile(
    vibetube_url: str,
    name: str,
    language: str = "en",
    sample_wav: Path | None = None,
    transcript: str | None = None,
    timeout_sec: float = 60.0,
) -> VoiceProfile:
    base = vibetube_url.rstrip("/")
    create_url = f"{base}/profiles"
    payload = {"name": name, "language": language}

    try:
        response = requests.post(create_url, json=payload, timeout=timeout_sec)
        response.raise_for_status()
        created = response.json() if response.content else {}
    except requests.RequestException as exc:
        raise VibetubeError(f"Failed creating profile at {create_url}: {exc}") from exc
    except ValueError as exc:
        raise VibetubeError(f"Vibetube returned invalid JSON when creating profile at {create_url}.") from exc

    profile_id = str(created.get("id") or created.get("profile_id") or "").strip()
    if not profile_id:
        # Fallback: re-list and find by name.
        candidates = [p for p in list_profiles(vibetube_url=vibetube_url, timeout_sec=timeout_sec) if p.name == name]
        if not candidates:
            raise VibetubeError("Vibetube profile creation response did not include profile id.")
        profile = candidates[-1]
    else:
        profile = VoiceProfile(profile_id=profile_id, name=name, language=language)

    if sample_wav is not None:
        add_sample_to_profile(
            vibetube_url=vibetube_url,
            profile_id=profile.profile_id,
            sample_wav=sample_wav,
            transcript=transcript,
            timeout_sec=timeout_sec,
        )

    return profile


def add_sample_to_profile(
    vibetube_url: str,
    profile_id: str,
    sample_wav: Path,
    transcript: str | None = None,
    timeout_sec: float = 120.0,
) -> None:
    if not sample_wav.exists():
        raise VibetubeError(f"Sample audio not found: {sample_wav}")

    base = vibetube_url.rstrip("/")
    endpoint_candidates = [
        f"{base}/profiles/{profile_id}/samples",
        f"{base}/profiles/{profile_id}/sample",
        f"{base}/profiles/{profile_id}/audio",
    ]

    file_field_candidates = ("file", "audio", "sample")
    last_error: str | None = None

    for endpoint in endpoint_candidates:
        for field in file_field_candidates:
            try:
                with sample_wav.open("rb") as handle:
                    files = {field: (sample_wav.name, handle, "audio/wav")}
                    data = {}
                    if transcript:
                        data["text"] = transcript
                    response = requests.post(endpoint, files=files, data=data, timeout=timeout_sec)
                if response.status_code < 400:
                    return
                last_error = f"{endpoint} responded {response.status_code}"
            except requests.RequestException as exc:
                last_error = str(exc)

    raise VibetubeError(
        "Could not upload sample audio to Vibetube profile. "
        "Your Vibetube build may require adding samples in its UI/workflow. "
        f"Last error: {last_error}"
    )


def synthesize_with_vibetube(
    text: str,
    vibetube_url: str,
    out_wav: Path,
    profile_id: str | None = None,
    language: str | None = None,
    timeout_sec: float = 90.0,
) -> Path:
    base = vibetube_url.rstrip("/")
    payload = {"text": text}
    if profile_id:
        payload["profile_id"] = profile_id
    if language:
        payload["language"] = language

    candidates = [
        (f"{base}/generate", payload),
        (f"{base}/v1/tts", payload),
        (f"{base}/tts", payload),
    ]

    last_error = None
    for url, body in candidates:
        try:
            response = requests.post(url, json=body, timeout=timeout_sec)
            if response.status_code >= 400:
                last_error = f"{url} responded {response.status_code}"
                continue

            content_type = response.headers.get("content-type", "")
            if "audio" in content_type or response.content.startswith(b"RIFF"):
                out_wav.write_bytes(response.content)
                return out_wav

            data = response.json()
            if _try_write_from_json_payload(data, base, out_wav, timeout_sec):
                return out_wav
            last_error = f"{url} returned JSON without recognized audio fields"
        except requests.RequestException as exc:
            last_error = str(exc)
        except ValueError:
            last_error = f"{url} returned non-audio, non-JSON response"

    raise VibetubeError(
        "Could not generate audio via Vibetube. "
        f"Attempted endpoints at {vibetube_url}. Last error: {last_error}"
    )


def _try_write_from_json_payload(data: dict, base_url: str, out_wav: Path, timeout_sec: float) -> bool:
    b64_keys = ("audio_base64", "audio", "wav_base64")
    for key in b64_keys:
        value = data.get(key)
        if isinstance(value, str):
            try:
                out_wav.write_bytes(base64.b64decode(value))
                return True
            except Exception:
                pass

    path_keys = ("audio_url", "url", "file_url")
    for key in path_keys:
        value = data.get(key)
        if isinstance(value, str):
            resolved = value if value.startswith("http") else urljoin(base_url + "/", value.lstrip("/"))
            response = requests.get(resolved, timeout=timeout_sec)
            response.raise_for_status()
            out_wav.write_bytes(response.content)
            return True

    local_file = data.get("audio_path")
    if isinstance(local_file, str):
        path = Path(local_file)
        if path.exists():
            out_wav.write_bytes(path.read_bytes())
            return True

    return False
