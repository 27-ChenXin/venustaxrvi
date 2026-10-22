"""
Lumina Horizon – Cosplay/Party AI Transformation Kiosk
FastAPI Backend Server  (v3 — cosplay/party pivot)

Pipeline per group session:
  1. POST /upload                 – per person, EXIF-correct, resize, save JPEG → upload_id (×N)
  2. POST /analyze-person         – per person, vision LLM gender detection → {gender}
  3. POST /assign-character       – per person, random character pick (theme + gender), reroll-able
  4. POST /group-transform        – start async group transform → group_id
     background task:
       - N person transforms in parallel via Replicate (google/nano-banana-2):
         image-mode themes (cosplay, game)   → user photo + costume reference image
         prompt-mode themes (historic, movie) → user photo + descriptive prompt only
       - composite all N transformed people onto one shared background (user-picked or random)
       - one light nano-banana-2 harmonize pass over the full composite
       - generate QR, persist gallery
  5. GET  /group-status/{group_id} – poll progress
  6. GET  /gallery                 – paginated gallery
  7. POST /admin/login             – admin auth
"""

import os
import uuid
import json
import base64
import logging
import asyncio
import io
import random
import shutil
import time
import zipfile
from pathlib import Path
from typing import Optional, List
from datetime import datetime
from collections import deque
from contextlib import asynccontextmanager

import replicate
import qrcode
import requests
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Query, Body, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image, ImageOps
from dotenv import load_dotenv

load_dotenv()

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

TRANSFORM_MODEL      = "google/nano-banana-2"
# VISION_MODEL         = os.getenv("VISION_MODEL",    "google/gemini-3.5-flash")
VISION_MODEL         = os.getenv("VISION_MODEL",    "lucataco/qwen3-vl-8b-instruct:39e893666996acf464cff75688ad49ac95ef54e9f1c688fbc677330acc478e11")
VISION_FALLBACK      = os.getenv("VISION_FALLBACK", "lucataco/qwen2-vl-7b-instruct:bf57361c75677fc33d480d0c5f02926e621b2caa2000347cb74aeae9d2ca07ee")
REPLICATE_API_TOKEN  = os.getenv("REPLICATE_API_TOKEN", "")
REPLICATE_TIMEOUT    = 300.0   # seconds — must outlast worst-case GPU cold-start (~2-3 min)
BASE_URL             = os.getenv("BASE_URL", "http://localhost:10003")
ENABLE_CORS          = os.getenv("ENABLE_CORS", "false").lower() == "true"
ENABLE_REMBG         = os.getenv("ENABLE_REMBG", "true").lower() == "true"
REMBG_MODEL_NAME      = os.getenv("REMBG_MODEL_NAME", "u2netp")
ADMIN_USERNAME       = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD       = os.getenv("ADMIN_PASSWORD", "lumina2025")

MAX_PERSONS          = 4   # max group size supported by the headcount picker

# Directories
# Use /var/data (Render persistent disk) when available, otherwise fall back to local paths
_DATA_ROOT            = Path(os.getenv("DATA_DIR", "/var/data" if Path("/var/data").exists() else "."))
UPLOADS_DIR           = _DATA_ROOT / "uploads"
GALLERY_DIR           = _DATA_ROOT / "gallery"
GALLERY_METADATA_FILE = GALLERY_DIR / "gallery_metadata.json"
GALLERY_MAX_ITEMS     = 500
RETRIEVAL_LOG_FILE    = GALLERY_DIR / "retrieval_log.csv"
ADMIN_SESSIONS_FILE   = _DATA_ROOT / "admin_sessions.json"
APP_SETTINGS_FILE     = GALLERY_DIR / "app_settings.json"

# Image output quality
OUTPUT_QUALITY   = 92
MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # 20 MB

# In-memory stores
jobs: dict           = {}   # group_id → job dict
admin_sessions: set  = set()
gallery_history       = deque(maxlen=GALLERY_MAX_ITEMS)

# Runtime-mutable settings
app_settings: dict = {
    "gallery_public":           False,
    "replicate_token_override": "",
}


def get_replicate_token(user_token: str = "") -> str:
    """Token priority: admin override → user-provided → env var."""
    return (
        app_settings.get("replicate_token_override")
        or user_token
        or REPLICATE_API_TOKEN
    )


def _poll_replicate(client, model_ref: str, input_dict: dict, poll_interval: float = 3.0):
    """
    Create a Replicate prediction and poll for completion using short individual
    HTTP requests instead of a long-lived SSE stream.

    SSE streaming (used by client.run()) is killed by cloud NAT gateways and
    proxies after ~60-90 s of idle TCP — exactly what happens on Render when
    a heavy model takes 2-3 min to infer.  Polling avoids that entirely.

    model_ref: "owner/name"  → uses latest deployment (no version pin)
               "owner/name:hash" → pins to specific version hash
    """
    if ":" in model_ref:
        version = model_ref.split(":", 1)[1]
        prediction = client.predictions.create(version=version, input=input_dict)
    else:
        prediction = client.predictions.create(model=model_ref, input=input_dict)

    while prediction.status not in ("succeeded", "failed", "canceled"):
        time.sleep(poll_interval)
        prediction.reload()

    if prediction.status != "succeeded":
        raise RuntimeError(
            f"Replicate prediction {prediction.status}: "
            f"{prediction.error or 'no error detail'}"
        )
    return prediction.output


def _extract_url(output) -> str:
    """
    google/nano-banana-2 returns a single URI string. Some Replicate SDK paths
    still hand back a list or a FileOutput-like object with a `.url` attr —
    handle all three shapes defensively.
    """
    first = output[0] if isinstance(output, list) else output
    return first.url if hasattr(first, "url") else str(first)


# ═══════════════════════════════════════════════════════════════════
# LOGGING & DIR SETUP
# ═══════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

for _d in (UPLOADS_DIR, GALLERY_DIR):
    _d.mkdir(exist_ok=True)

# ═══════════════════════════════════════════════════════════════════
# CONFIG LOADING
# ═══════════════════════════════════════════════════════════════════

def load_cosplay_config() -> dict:
    config_file = Path(__file__).parent / "config_cosplay.json"
    try:
        with open(config_file, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        logger.info(
            f"✅  Loaded cosplay config: {len(data.get('themes', {}))} themes, "
            f"{len(data.get('characters', {}))} characters"
        )
        return data
    except Exception as exc:
        logger.error(f"❌  config_cosplay.json: {exc}")
        raise RuntimeError(f"Cannot start without cosplay config: {exc}")


COSPLAY_CONFIG: dict = load_cosplay_config()


def pick_random_character(theme_key: str, gender: str, exclude_keys: Optional[List[str]] = None) -> Optional[dict]:
    """Random character filtered by theme + gender, avoiding exclude_keys (reroll support)."""
    exclude = set(exclude_keys or [])
    all_chars = list(COSPLAY_CONFIG.get("characters", {}).values())
    candidates = [c for c in all_chars if c["theme_key"] == theme_key and c["gender"] == gender and c["key"] not in exclude]
    if not candidates:
        # Nothing left to reroll into — allow repeats rather than dead-ending the UI.
        candidates = [c for c in all_chars if c["theme_key"] == theme_key and c["gender"] == gender]
    if not candidates:
        return None
    return random.choice(candidates)


def build_person_prompt(theme: dict, character: dict, attempt: int = 1) -> str:
    """
    Identity-preservation guard + costume reference edit instructions.
    Supports theme-level overrides and character-specific prompts in image mode,
    ensuring full costume visibility (especially for mascot/fry-box suits).
    """
    guard = COSPLAY_CONFIG.get("identity_guard", "")
    if theme.get("mode") == "image":
        key = "image_mode_instruction" if attempt <= 1 else "image_mode_instruction_retry"
        extra = theme.get(key) or COSPLAY_CONFIG.get(key) or ""
        char_prompt = character.get("prompt", "")
        # For fries theme, ensure identity guard allows the costume's fry box text/label
        if theme.get("key") == "fries":
            guard = (
                "Keep the exact face, facial features, skin tone, and identity of the person in the photo "
                "completely unchanged — do not alter their face in any way. Only dress them in the full costume "
                "shown in the reference image. Do not add any other people or watermarks."
            )
        parts = [guard, extra, char_prompt]
        return " ".join(p for p in parts if p).strip()
    return f"{guard} {character.get('prompt', '')}".strip()


def _is_content_safety_error(exc: Exception) -> bool:
    """True if a Replicate prediction failed due to the model's own content
    safety / moderation filter (e.g. E005 'flagged as sensitive') rather than
    a transient/infra failure — these are worth a reworded retry, not a
    blind retry of the identical request."""
    msg = str(exc).lower()
    return any(s in msg for s in ("flagged as sensitive", "e005", "safety", "sensitive"))


def build_harmonize_prompt(n: int) -> str:
    """
    Solo photos and groups get headcount-specific prompts (1, 2, 3, or 4) so the
    model strictly preserves the exact number of people selected by the user.
    """
    key = f"harmonize_prompt_{n}"
    if key in COSPLAY_CONFIG:
        return COSPLAY_CONFIG[key]
    if n == 1:
        return COSPLAY_CONFIG.get(
            "harmonize_prompt_single",
            "Blend this person naturally into the background scene with unified lighting. "
            "Do not change their face, costume, pose, or identity. This photo has exactly "
            "one person — do not add any other people.",
        )
    return COSPLAY_CONFIG.get(
        "harmonize_prompt",
        f"Blend all {n} people in this photo into one cohesive scene with unified lighting. "
        f"Keep all {n} people fully visible. This photo has exactly {n} people — do not add or remove anyone.",
    )


# ═══════════════════════════════════════════════════════════════════
# GALLERY PERSISTENCE
# ═══════════════════════════════════════════════════════════════════

def load_gallery_metadata() -> None:
    global gallery_history
    try:
        if GALLERY_METADATA_FILE.exists():
            with open(GALLERY_METADATA_FILE, "r") as fh:
                meta = json.load(fh)
            items = meta.get("items", [])
            valid = [i for i in items if (GALLERY_DIR / i["transformed_file"]).exists()]
            gallery_history = deque(valid[:GALLERY_MAX_ITEMS], maxlen=GALLERY_MAX_ITEMS)
            logger.info(f"📂  Loaded {len(gallery_history)} gallery items")
        else:
            logger.info("📂  No gallery metadata — starting fresh")
    except Exception as exc:
        logger.error(f"Gallery load failed: {exc}")
        gallery_history = deque(maxlen=GALLERY_MAX_ITEMS)


def save_gallery_metadata() -> None:
    try:
        with open(GALLERY_METADATA_FILE, "w") as fh:
            json.dump(
                {"items": list(gallery_history), "last_updated": datetime.now().isoformat()},
                fh, indent=2,
            )
    except Exception as exc:
        logger.error(f"Gallery save failed: {exc}")


load_gallery_metadata()


# ═══════════════════════════════════════════════════════════════════
# ADMIN SESSION PERSISTENCE
# ═══════════════════════════════════════════════════════════════════

def load_admin_sessions() -> None:
    global admin_sessions
    try:
        if ADMIN_SESSIONS_FILE.exists():
            with open(ADMIN_SESSIONS_FILE, "r") as fh:
                admin_sessions = set(json.load(fh).get("sessions", []))
            logger.info(f"🔐  Loaded {len(admin_sessions)} admin session(s)")
    except Exception as exc:
        logger.warning(f"Admin sessions load failed: {exc}")


def save_admin_sessions() -> None:
    try:
        with open(ADMIN_SESSIONS_FILE, "w") as fh:
            json.dump({"sessions": list(admin_sessions)}, fh)
    except Exception as exc:
        logger.error(f"Admin sessions save failed: {exc}")


def load_app_settings() -> None:
    """Restore persisted app settings (gallery_public etc.) from disk."""
    try:
        if APP_SETTINGS_FILE.exists():
            with open(APP_SETTINGS_FILE, "r") as fh:
                stored = json.load(fh)
            for k, v in stored.items():
                app_settings[k] = v
            logger.info(f"✅  Loaded app settings from disk: {stored}")
    except Exception as exc:
        logger.warning(f"App settings load failed: {exc}")


def save_app_settings() -> None:
    """Persist app settings (excluding sensitive tokens) to disk."""
    try:
        safe = {k: v for k, v in app_settings.items() if k != "replicate_token_override"}
        with open(APP_SETTINGS_FILE, "w") as fh:
            json.dump(safe, fh)
    except Exception as exc:
        logger.error(f"App settings save failed: {exc}")


load_admin_sessions()
load_app_settings()


# ═══════════════════════════════════════════════════════════════════
# FASTAPI APP
# ═══════════════════════════════════════════════════════════════════

# ── Warmup state ──────────────────────────────────────────────────────────
_warmup_done:         bool                   = False
_warmup_task: "asyncio.Task | None"          = None

# Smallest valid image (1×1 white PNG) used as warmup input — costs almost
# nothing on the model side but forces Replicate to boot the container.
_WARMUP_DATA_URI = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIA"
    "BQAABjE+ibYAAAAASUVORK5CYII="
)


async def _run_warmup() -> None:
    """
    Send a trivial prediction to each Replicate model to boot their
    containers before the first real user arrives.
    All errors are silently swallowed — warmup failure must never affect
    normal kiosk operation.
    """
    global _warmup_done

    # ── 0. rembg session (used by the group-composite stage) ───────────
    # Independent of the Replicate token — load it regardless so the first
    # real group photo doesn't pay the one-time model-load cost.
    if ENABLE_REMBG:
        try:
            logger.info(f"⚡  Warming rembg session (model={REMBG_MODEL_NAME})…")
            await asyncio.to_thread(_get_rembg_session)
            logger.info("✅  rembg session warm")
        except Exception as exc:
            logger.warning(f"⚠️  rembg warmup failed (non-fatal): {exc}")

    token = get_replicate_token()
    if not token:
        logger.info("⚡  Replicate warmup skipped — no token configured yet")
        return

    client = replicate.Client(api_token=token, timeout=REPLICATE_TIMEOUT)

    # ── 1. Vision model (used by /analyze-person) ──────────────────────
    try:
        logger.info(f"⚡  Warming vision model: {VISION_MODEL[:55]}…")
        def _vision_ping():
            out = client.run(VISION_MODEL, input={
                "media":          _WARMUP_DATA_URI,
                "prompt":         "Reply with the single word: warm",
                "max_new_tokens": 8,
            })
            return "".join(str(t) for t in (out or []))
        await asyncio.to_thread(_vision_ping)
        logger.info("✅  Vision model warm")
    except Exception as exc:
        logger.warning(f"⚠️  Vision warmup failed (non-fatal): {exc}")

    # ── 2. Transform model (used by every person + harmonize pass) ────
    try:
        logger.info(f"⚡  Warming transform model: {TRANSFORM_MODEL}…")
        def _transform_ping():
            return client.run(TRANSFORM_MODEL, input={
                "image_input":    [_WARMUP_DATA_URI],
                "prompt":         "Add a tiny blue dot.",
                "output_format":  "jpg",
            })
        await asyncio.to_thread(_transform_ping)
        logger.info("✅  Transform model warm")
    except Exception as exc:
        logger.warning(f"⚠️  Transform warmup failed (non-fatal): {exc}")

    _warmup_done = True
    logger.info("🔥  Replicate models warmed — first user will skip cold-start delay")


def schedule_warmup_once(delay_seconds: int = 45) -> None:
    """
    Schedule _run_warmup to run once in the background after `delay_seconds`.
    Safe to call multiple times — only the first effective call schedules the task.
    """
    global _warmup_task, _warmup_done
    if _warmup_done:
        return
    if _warmup_task and not _warmup_task.done():
        return  # already scheduled / running

    async def _delayed():
        await asyncio.sleep(delay_seconds)
        await _run_warmup()

    try:
        _warmup_task = asyncio.create_task(_delayed())
        logger.info(f"⚡  Model warmup scheduled in {delay_seconds}s")
    except RuntimeError:
        logger.warning("⚠️  schedule_warmup_once: no running event loop — warmup skipped")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm Replicate models 45 s after boot — by then the server is fully
    # initialised and any token baked into .env is loaded.
    schedule_warmup_once(delay_seconds=45)
    yield


app = FastAPI(
    title="Lumina Horizon – Cosplay/Party AI Kiosk",
    description="Group cosplay/historic/movie photo transformation pipeline",
    version="3.0.0",
    lifespan=lifespan,
)

if ENABLE_CORS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    logger.info("✅  CORS enabled")


# ═══════════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# ═══════════════════════════════════════════════════════════════════

class AssignCharacterRequest(BaseModel):
    theme_key:     str
    gender:        str
    exclude_keys:  Optional[List[str]] = None


class PersonInput(BaseModel):
    upload_id:      str
    gender:         str
    character_key:  str


class GroupTransformRequest(BaseModel):
    theme_key:             str
    persons:               List[PersonInput]
    background_image:      Optional[str] = None   # relative path e.g. 'backgrounds/palace1.jpg'
    session_id:            Optional[str] = None
    user_replicate_token:  Optional[str] = None


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminSettingsRequest(BaseModel):
    gallery_public:  Optional[bool] = None
    replicate_token: Optional[str]  = None


# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

_MIME_BY_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def generate_qr_png_b64(url: str) -> str:
    qr = qrcode.QRCode(version=1, box_size=8, border=3,
                       error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#001f24", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def jpeg_bytes_to_data_uri(data: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


def read_path_as_data_uri(path: Path) -> str:
    """Mime-aware — reference costume images may be .jpg, .png, or .webp."""
    mime = _MIME_BY_EXT.get(path.suffix.lower(), "image/jpeg")
    with open(path, "rb") as fh:
        return f"data:{mime};base64," + base64.b64encode(fh.read()).decode()


def pil_to_jpeg_bytes(img: Image.Image, quality: int = OUTPUT_QUALITY) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


# ═══════════════════════════════════════════════════════════════════
# GENDER ANALYSIS  (/analyze-person)
# ═══════════════════════════════════════════════════════════════════
#
# Capture is now one person per photo, so this only needs a single-word
# gender read — no left-to-right multi-person bookkeeping required anymore.

_GENDER_PROMPT = """\
/no_think
Look at the person in this photo. Reply with ONLY one word — either "male" or "female" — and nothing else."""


def _parse_gender(raw: str) -> Optional[str]:
    t = raw.strip().lower()
    if "female" in t:
        return "female"
    if "male" in t:
        return "male"
    return None


async def run_gender_analysis(upload_path: Path, user_token: str = "") -> dict:
    """
    Always returns a usable gender — never blocks the kiosk flow. On total
    analysis failure it falls back to a random 50/50 guess so character
    assignment can still proceed.
    """
    token = get_replicate_token(user_token)
    if not token:
        logger.warning("⚠️  Gender analysis skipped — no Replicate token available")
        return {"status": "error", "reason": "no_token", "gender": random.choice(["male", "female"])}

    client = replicate.Client(api_token=token, timeout=REPLICATE_TIMEOUT)

    def _drain(output) -> str:
        if isinstance(output, dict):
            return output.get("text", "") or ""
        if hasattr(output, "__iter__") and not isinstance(output, (str, bytes)):
            return "".join(str(t) for t in output)
        return str(output) if output else ""

    def _call() -> str:
        try:
            return _drain(client.run(VISION_MODEL, input={
                "media": data_uri, "prompt": _GENDER_PROMPT, "max_new_tokens": 16,
            }))
        except Exception as e:
            logger.warning(f"⚠️  Gender analysis primary failed: {e} — trying fallback")
            return _drain(client.run(VISION_FALLBACK, input={
                "media": data_uri, "prompt": _GENDER_PROMPT, "max_new_tokens": 16,
            }))

    try:
        data_uri = await asyncio.to_thread(read_path_as_data_uri, upload_path)
        raw = await asyncio.to_thread(_call)
        logger.info(f"🔍  Gender analysis raw: {raw[:60]!r}")
        gender = _parse_gender(raw)
        if gender:
            logger.info(f"✅  Gender analysis OK: {gender}")
            return {"status": "ok", "gender": gender}
        logger.warning(f"⚠️  Gender analysis unparseable — defaulting randomly")
        return {"status": "partial", "gender": random.choice(["male", "female"])}
    except Exception as exc:
        logger.warning(f"⚠️  Gender analysis failed: {exc}")
        return {"status": "error", "reason": "llm_failed", "gender": random.choice(["male", "female"])}


# ═══════════════════════════════════════════════════════════════════
# GROUP COMPOSITE  (Pillow + rembg cutouts onto a shared background)
# ═══════════════════════════════════════════════════════════════════

FINAL_ASPECT_RATIO = "4:3"   # locked output shape — must match the harmonize call's aspect_ratio

_rembg_session = None


def _get_rembg_session():
    """
    Lazily create ONE rembg session and reuse it for every call.

    Without an explicit session, rembg.remove() builds a new session (and
    reloads the model from disk) on every invocation — with rembg's current
    default model being bria-rmbg (~1.02 GB) rather than the older u2net
    (~176 MB), that meant reloading a gigabyte-scale model per person, per
    group, with memory pressure scaling with photos processed rather than
    peak single-request usage. Pinning REMBG_MODEL_NAME=u2netp (~4.6 MB) and
    loading it once fixes both the per-call footprint and the cumulative
    growth pattern.
    """
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        logger.info(f"⚡  Loading rembg session (model={REMBG_MODEL_NAME})…")
        _rembg_session = new_session(REMBG_MODEL_NAME)
        logger.info("✅  rembg session ready")
    return _rembg_session


def _composite_group(person_bytes_list: List[bytes], bg_choice: Optional[str]) -> Image.Image:
    """
    Cut each person's transformed result out via rembg and pack them,
    left-to-right in capture order, shoulder-to-shoulder in a horizontally
    centred cluster onto one shared background image — not spread out to
    the canvas edges. Canvas is always built at FINAL_ASPECT_RATIO (4:3)
    regardless of group size, so the harmonize pass never has to reframe.
    """
    canvas_h = 1024
    canvas_w = round(canvas_h * 4 / 3)   # 4:3 landscape, matches FINAL_ASPECT_RATIO
    margin   = round(canvas_w * 0.04)    # keep the whole group off the very edge

    bg_path = (IMGS_DIR / "cosplay" / bg_choice) if (bg_choice and IMGS_DIR) else None
    if bg_path and bg_path.exists():
        bg = Image.open(bg_path).convert("RGB")
        scale = max(canvas_w / bg.width, canvas_h / bg.height)
        bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.Resampling.LANCZOS)
        bx = (bg.width - canvas_w) // 2
        by = (bg.height - canvas_h) // 2
        canvas = bg.crop((bx, by, bx + canvas_w, by + canvas_h)).convert("RGBA")
    else:
        if bg_choice:
            logger.warning(f"⚠️  Background image not found: {bg_path}")
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (20, 20, 20, 255))

    # ── Cut everyone out, crop tightly to the subject, and scale to fit safe window ──
    # Masthead overlay is 1344×896 with top header/bats (y=0..95) and bottom banner (y=785..896).
    # When 1365×1024 canvas is centered behind it (offset -64px vertically), the completely clear
    # safe window on canvas is y=160..845 (~685px).
    # Setting bottom_y = 840 anchors feet/boots at masthead y=776, cleanly above the bottom border.
    # Target height is calibrated so the FULL costume (from head/hat down to boots/shoes) is 100%
    # visible inside the transparent frame without being clipped or "too big".
    n = len(person_bytes_list)
    if n == 1:
        target_cutout_h = round(canvas_h * 0.66)  # ~676px — full costume completely visible
        bottom_y        = round(canvas_h * 0.82)  # ~840px (masthead y=776, safely above bottom banner)
    elif n == 2:
        target_cutout_h = round(canvas_h * 0.64)  # ~655px
        bottom_y        = round(canvas_h * 0.82)  # ~840px
    elif n == 3:
        target_cutout_h = round(canvas_h * 0.62)  # ~635px
        bottom_y        = round(canvas_h * 0.82)  # ~840px
    else:
        target_cutout_h = round(canvas_h * 0.60)  # ~614px
        bottom_y        = round(canvas_h * 0.82)  # ~840px

    cutouts = []
    for idx, pbytes in enumerate(person_bytes_list):
        person_img = Image.open(io.BytesIO(pbytes)).convert("RGB")
        cutout = person_img.convert("RGBA")
        if ENABLE_REMBG:
            try:
                from rembg import remove as rembg_remove
                cutout = rembg_remove(person_img, session=_get_rembg_session())
                # Tightly crop to non-transparent pixels so we scale the actual character,
                # rather than scaling empty transparent margins.
                alpha = cutout.split()[-1]
                bbox = alpha.getbbox()
                if bbox:
                    pad = 4
                    w_box = (
                        max(0, bbox[0] - pad),
                        max(0, bbox[1] - pad),
                        min(cutout.width, bbox[2] + pad),
                        min(cutout.height, bbox[3] + pad)
                    )
                    cutout = cutout.crop(w_box)
            except Exception as exc:
                logger.warning(f"⚠️  rembg cutout failed for person {idx}: {exc} — pasting full frame")

        scale = target_cutout_h / max(1, cutout.height)
        cutout = cutout.resize((max(1, round(cutout.width * scale)), max(1, round(cutout.height * scale))), Image.Resampling.LANCZOS)
        cutouts.append(cutout)

    # ── Safe window width is ~1128px (x=119..1247 in canvas coordinates). ──
    # Rather than aggressively shrinking characters when total width exceeds avail_w,
    # use natural group photography overlap (shoulder-to-shoulder staging, up to 25%).
    avail_w = round(canvas_w * 0.80)  # ~1092px safe width
    total_w = sum(c.width for c in cutouts)

    if n == 1:
        # Perfectly centre solo person
        x = (canvas_w - cutouts[0].width) // 2
        canvas.paste(cutouts[0], (x, bottom_y - cutouts[0].height), cutouts[0])
    elif total_w <= avail_w:
        # Fits side-by-side without overlap: distribute shoulder-to-shoulder centered
        x = (canvas_w - total_w) // 2
        for cutout in cutouts:
            canvas.paste(cutout, (x, bottom_y - cutout.height), cutout)
            x += cutout.width
    else:
        # Group exceeds avail_w: calculate natural shoulder overlap
        excess = total_w - avail_w
        overlap = excess / (n - 1)
        avg_w = total_w / n
        max_natural_overlap = avg_w * 0.25  # up to 25% shoulder overlap is natural and maintains full character size

        if overlap > max_natural_overlap:
            # Need a gentle shrink so overlap stays within comfortable limits
            needed_w = avail_w + (n - 1) * max_natural_overlap
            shrink = needed_w / total_w
            cutouts = [
                c.resize((max(1, round(c.width * shrink)), max(1, round(c.height * shrink))), Image.Resampling.LANCZOS)
                for c in cutouts
            ]
            total_w = sum(c.width for c in cutouts)
            excess = max(0, total_w - avail_w)
            overlap = excess / (n - 1)

        # Place characters with calculated overlap, centered horizontally
        net_group_w = total_w - round(overlap * (n - 1))
        start_x = (canvas_w - net_group_w) // 2
        curr_x = float(start_x)
        for cutout in cutouts:
            canvas.paste(cutout, (round(curr_x), bottom_y - cutout.height), cutout)
            curr_x += cutout.width - overlap

    return canvas.convert("RGB")


# ═══════════════════════════════════════════════════════════════════
# MASTHEAD OVERLAY  (branded frame baked onto the final harmonized photo)
# ═══════════════════════════════════════════════════════════════════

_masthead_cache: Optional[Image.Image] = None


def _get_masthead() -> Optional[Image.Image]:
    """Load branded overlay frame once and reuse it for every job."""
    global _masthead_cache
    if _masthead_cache is None and IMGS_DIR:
        overlay_name = COSPLAY_CONFIG.get("overlay", "overlays/halloween-rvi.png")
        mh_path = IMGS_DIR / overlay_name
        if not mh_path.exists():
            for fallback in ["overlays/halloween-rvi.png", "overlays/halloween_rvi.png", "overlays/masthead.png"]:
                candidate = IMGS_DIR / fallback
                if candidate.exists():
                    mh_path = candidate
                    break
        if mh_path.exists():
            _masthead_cache = Image.open(mh_path).convert("RGBA")
            logger.info(f"🖼️  Loaded overlay frame ({mh_path.name}): {_masthead_cache.size}")
        else:
            logger.warning(f"⚠️  Overlay frame not found: {mh_path}")
    return _masthead_cache


def apply_masthead(photo: Image.Image) -> Image.Image:
    """
    Centre `photo` behind the branded masthead frame and flatten to one image.

    Final canvas size is taken from the masthead itself (currently 1344×896),
    not hardcoded — the frame's transparent window reveals the centred photo;
    its opaque border/ribbon/logo areas simply cover whatever part of the
    photo falls behind them. If the masthead asset is missing, the photo is
    returned unchanged rather than failing the job.
    """
    masthead = _get_masthead()
    if masthead is None:
        return photo

    mw, mh = masthead.size
    canvas = Image.new("RGBA", (mw, mh), masthead.getpixel((1, 1)))
    photo_rgba = photo.convert("RGBA")
    offset = ((mw - photo_rgba.width) // 2, (mh - photo_rgba.height) // 2)
    canvas.paste(photo_rgba, offset)
    return Image.alpha_composite(canvas, masthead).convert("RGB")


# ═══════════════════════════════════════════════════════════════════
# API ENDPOINTS
# ═══════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {"status": "ok", "service": "lumina-horizon-cosplay", "version": "3.0.0"}


@app.get("/config")
async def get_config():
    return {**COSPLAY_CONFIG, "max_persons": MAX_PERSONS}


@app.get("/settings")
async def get_public_settings():
    return {
        "gallery_public":        app_settings.get("gallery_public", True),
        "replicate_configured":  bool(get_replicate_token()),
    }


# ── Upload ──────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload_image(image: UploadFile = File(...)):
    """Accept camera JPEG/PNG for one person, EXIF-correct, resize, save. Returns upload_id."""
    if not (image.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are accepted.")

    content = await image.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Image too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB).")

    try:
        pil_img = Image.open(io.BytesIO(content))
        try:
            orient = pil_img.getexif().get(0x0112)
            if orient and orient != 1:
                pil_img = ImageOps.exif_transpose(pil_img)
                logger.info(f"📐  EXIF orientation={orient} corrected")
        except Exception:
            pass
        pil_img = pil_img.convert("RGB")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Cannot decode image.")

    # Standardise every upload to 1024×1024 (1:1 square) — centre-crop, scale to cover.
    _SQ = 1024
    if pil_img.width != _SQ or pil_img.height != _SQ:
        _orig_w, _orig_h = pil_img.width, pil_img.height
        _scale  = max(_SQ / pil_img.width, _SQ / pil_img.height)
        _nw     = round(pil_img.width  * _scale)
        _nh     = round(pil_img.height * _scale)
        _resized = pil_img.resize((_nw, _nh), Image.Resampling.LANCZOS)
        _ox      = (_nw - _SQ) // 2
        _oy      = (_nh - _SQ) // 2
        pil_img  = _resized.crop((_ox, _oy, _ox + _SQ, _oy + _SQ))
        logger.info(f"📐  Square-cropped to {_SQ}×{_SQ} (source was {_orig_w}×{_orig_h})")

    upload_id   = str(uuid.uuid4())
    upload_path = UPLOADS_DIR / f"{upload_id}.jpg"
    pil_img.save(upload_path, format="JPEG", quality=90, optimize=True)
    logger.info(f"📸  Upload saved: {upload_id[:8]}  ({pil_img.width}×{pil_img.height})")
    return {"upload_id": upload_id, "width": pil_img.width, "height": pil_img.height}


# ── Gender analysis ────────────────────────────────────────────────────────

@app.post("/analyze-person")
async def analyze_person(
    upload_id: str = Query(...),
    user_replicate_token: str = Query(""),
):
    upload_path = UPLOADS_DIR / f"{upload_id}.jpg"
    if not upload_path.exists():
        return {"status": "error", "reason": "upload_not_found", "gender": random.choice(["male", "female"])}
    return await run_gender_analysis(upload_path, user_token=user_replicate_token)


# ── Character assignment (random pick + reroll) ─────────────────────────────

@app.post("/assign-character")
async def assign_character(request: AssignCharacterRequest):
    theme = COSPLAY_CONFIG.get("themes", {}).get(request.theme_key)
    if not theme:
        raise HTTPException(status_code=400, detail=f"Unknown theme: {request.theme_key!r}")
    gender = request.gender if request.gender in ("male", "female") else "male"
    character = pick_random_character(request.theme_key, gender, request.exclude_keys)
    if not character:
        raise HTTPException(status_code=404, detail="No characters available for this theme/gender.")
    return {"character": character}


# ── Group transform ──────────────────────────────────────────────────────────

@app.post("/group-transform")
async def start_group_transform(request: GroupTransformRequest, background_tasks: BackgroundTasks):
    """Start async group transformation for 1–4 people. Returns group_id immediately."""
    theme = COSPLAY_CONFIG.get("themes", {}).get(request.theme_key)
    if not theme:
        raise HTTPException(status_code=400, detail=f"Unknown theme: {request.theme_key!r}")

    n = len(request.persons)
    if n < 1 or n > MAX_PERSONS:
        raise HTTPException(status_code=422, detail=f"Group size must be between 1 and {MAX_PERSONS}.")

    persons_data = []
    for p in request.persons:
        upload_path = UPLOADS_DIR / f"{p.upload_id}.jpg"
        if not upload_path.exists():
            raise HTTPException(status_code=404, detail="One or more photos were not found — please recapture.")
        character = COSPLAY_CONFIG.get("characters", {}).get(p.character_key)
        if not character or character["theme_key"] != request.theme_key:
            raise HTTPException(status_code=400, detail=f"Invalid character key: {p.character_key!r}")
        persons_data.append({"upload_id": p.upload_id, "gender": p.gender, "character": character})

    group_id = str(uuid.uuid4())
    jobs[group_id] = {
        "status":     "processing",
        "progress":   5,
        "theme_key":  request.theme_key,
        "theme_name": theme.get("display_name", request.theme_key),
        "session_id": request.session_id,
        "created_at": datetime.now().isoformat(),
        "persons": [
            {
                "character_key":  pd["character"]["key"],
                "character_name": pd["character"]["name"],
                "sub_status":     "queued",
            }
            for pd in persons_data
        ],
    }

    background_tasks.add_task(run_group_transformation, group_id, persons_data, theme, request)
    logger.info(f"🚀  Group transform {group_id[:8]} — theme={request.theme_key}, {n} person(s)")
    return {"group_id": group_id}


# ── Status ──────────────────────────────────────────────────────────────────

@app.get("/group-status/{group_id}")
async def get_group_status(group_id: str):
    job = jobs.get(group_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


# ── Gallery ─────────────────────────────────────────────────────────────────

@app.get("/gallery/count")
async def get_gallery_count(theme: str = Query("")):
    items = list(gallery_history)
    if theme:
        items = [i for i in items if i.get("theme_key") == theme]
    return {"total": len(items)}


@app.get("/gallery")
async def get_gallery(
    page:        int = Query(1,  ge=1),
    limit:       int = Query(24, ge=1, le=100),
    theme:       str = Query(""),
    admin_token: str = Query(""),
):
    is_admin = admin_token in admin_sessions
    if not is_admin and not app_settings.get("gallery_public", False):
        raise HTTPException(status_code=403, detail="Gallery is not publicly accessible.")
    items = list(gallery_history)
    if theme:
        items = [i for i in items if i.get("theme_key") == theme]

    total      = len(items)
    page_items = items[(page - 1) * limit : page * limit]

    if not is_admin:
        safe = {"id", "theme_key", "theme_name", "characters", "group_size",
                "transformed_file", "timestamp"}
        page_items = [{k: v for k, v in item.items() if k in safe} for item in page_items]

    return {"items": page_items, "total": total, "page": page, "is_admin": is_admin}


# ── Mobile retrieval ─────────────────────────────────────────────────────────

@app.get("/retrieve/{token}")
async def retrieve_by_token(token: str):
    item = next((i for i in gallery_history if i.get("token") == token), None)
    if not item:
        raise HTTPException(status_code=404, detail="Image not found or token expired.")
    characters = item.get("characters", [])
    character_names = ", ".join(c.get("name", "") for c in characters) if characters else item.get("style_name", "")
    return {
        "token":            token,
        "result_url":       f"/gallery-files/{item['transformed_file']}",
        "theme_name":       item.get("theme_name") or item.get("destination_name", ""),
        "character_names":  character_names,
        "timestamp":        item.get("timestamp", ""),
        "quote":            item.get("quote", ""),
    }


@app.post("/log-retrieval")
async def log_retrieval(
    request: Request,
    name:  str = Body(...),
    email: str = Body(...),
    token: str = Body(...),
):
    name  = name.strip()[:120]
    email = email.strip()[:254]
    token = token.strip()[:64]
    ts    = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    ip    = request.client.host if request.client else "unknown"
    gallery_item = next((i for i in gallery_history if i.get("token") == token), None)
    theme_name = (gallery_item.get("theme_name") or gallery_item.get("destination_name", "")) if gallery_item else ""
    characters = gallery_item.get("characters", []) if gallery_item else []
    character_names = ", ".join(c.get("name", "") for c in characters) if characters else ""
    try:
        import csv
        write_header = not RETRIEVAL_LOG_FILE.exists() or RETRIEVAL_LOG_FILE.stat().st_size == 0
        with RETRIEVAL_LOG_FILE.open("a", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            if write_header:
                w.writerow(["name", "email", "time", "token", "ip", "theme", "characters"])
            w.writerow([name, email, ts, token, ip, theme_name, character_names])
        logger.info(f"📋  Retrieval logged: {name!r} {email!r} theme={theme_name!r}")
    except Exception as exc:
        logger.error(f"Retrieval log failed: {exc}")
    return {"success": True}


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.post("/admin/login")
async def admin_login(request: AdminLoginRequest):
    if request.username == ADMIN_USERNAME and request.password == ADMIN_PASSWORD:
        token = str(uuid.uuid4())
        admin_sessions.add(token)
        save_admin_sessions()
        logger.info("🔐  Admin login OK")
        return {"success": True, "token": token}
    logger.warning("⚠️  Failed admin login")
    raise HTTPException(status_code=401, detail="Invalid credentials.")


@app.post("/admin/logout")
async def admin_logout(admin_token: str = Query("")):
    admin_sessions.discard(admin_token)
    save_admin_sessions()
    return {"success": True}


@app.get("/admin/settings")
async def get_admin_settings(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    return {
        "gallery_public":       app_settings.get("gallery_public", True),
        "replicate_configured": bool(get_replicate_token()),
    }


@app.patch("/admin/settings")
async def update_admin_settings(request: AdminSettingsRequest, admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    if request.gallery_public is not None:
        app_settings["gallery_public"] = request.gallery_public
    if request.replicate_token is not None:
        app_settings["replicate_token_override"] = request.replicate_token.strip()
    save_app_settings()
    # Kick off model warm-up now that a token is available
    if get_replicate_token():
        schedule_warmup_once(delay_seconds=60)
    return {
        "success": True,
        "settings": {
            "gallery_public":       app_settings["gallery_public"],
            "replicate_configured": bool(get_replicate_token()),
        },
    }


@app.delete("/admin/gallery/all")
async def delete_all_gallery(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    deleted_files = 0
    for item in list(gallery_history):
        for fk in ("original_file", "transformed_file"):
            fp = GALLERY_DIR / (item.get(fk) or "")
            if fp.name and fp.exists():
                try:
                    fp.unlink()
                    deleted_files += 1
                except Exception:
                    pass
    count = len(gallery_history)
    gallery_history.clear()
    save_gallery_metadata()
    logger.info(f"🗑️  Deleted all gallery — {count} entries, {deleted_files} files")
    return {"success": True, "deleted_entries": count, "deleted_files": deleted_files}


@app.delete("/admin/gallery/{item_id}")
async def delete_gallery_item(item_id: str, admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    item = next((i for i in gallery_history if i.get("id") == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Gallery item not found.")
    deleted = 0
    for fk in ("original_file", "transformed_file"):
        fp = GALLERY_DIR / (item.get(fk) or "")
        if fp.name and fp.exists():
            try:
                fp.unlink()
                deleted += 1
            except Exception:
                pass
    gallery_history.remove(item)
    save_gallery_metadata()
    logger.info(f"🗑️  Deleted gallery item {item_id[:8]}, {deleted} file(s)")
    return {"success": True, "deleted_files": deleted}


@app.get("/admin/gallery/download-all")
async def download_all_gallery(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in gallery_history:
            tf = item.get("transformed_file")
            if not tf:
                continue
            fp = GALLERY_DIR / tf
            if fp.exists():
                tn  = (item.get("theme_name") or "unknown").replace(" ", "_")
                ts  = (item.get("timestamp")  or "")[:10]
                zf.write(fp, f"{ts}_{tn}_{tf}")
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=lumina-gallery.zip"},
    )


@app.get("/admin/stats")
async def admin_stats(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    items = list(gallery_history)
    by_theme: dict = {}
    for item in items:
        tk = item.get("theme_key", "unknown")
        by_theme[tk] = by_theme.get(tk, 0) + 1
    return {"total_transformations": len(items), "by_theme": by_theme, "recent": items[:10]}


@app.get("/admin/retrieval-log")
async def download_retrieval_log(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    if not RETRIEVAL_LOG_FILE.exists() or RETRIEVAL_LOG_FILE.stat().st_size == 0:
        empty = b"name,email,time,token,ip,theme,characters\n"
        return StreamingResponse(iter([empty]), media_type="text/csv",
                                 headers={"Content-Disposition": "attachment; filename=retrieval-log.csv"})
    return FileResponse(str(RETRIEVAL_LOG_FILE), media_type="text/csv", filename="retrieval-log.csv")


@app.delete("/admin/retrieval-log")
async def reset_retrieval_log(admin_token: str = Query("")):
    if admin_token not in admin_sessions:
        raise HTTPException(status_code=401, detail="Not authorised.")
    try:
        if RETRIEVAL_LOG_FILE.exists():
            RETRIEVAL_LOG_FILE.unlink()
        logger.info("🗑️  Retrieval log reset by admin")
    except Exception as exc:
        logger.error(f"Retrieval log reset failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
    return {"success": True}


# ═══════════════════════════════════════════════════════════════════
# BACKGROUND TASK — run_group_transformation
# ═══════════════════════════════════════════════════════════════════

async def run_group_transformation(
    group_id:     str,
    persons_data: List[dict],
    theme:        dict,
    request:      GroupTransformRequest,
) -> None:
    """
    Per group session:
      1. N person transforms in parallel via google/nano-banana-2
         (image-mode: user photo + costume reference; prompt-mode: user photo + text prompt)
      2. Composite all N results onto one shared background — user-picked or random (rembg + Pillow)
      3. One light nano-banana-2 harmonize pass over the full composite
      4. Generate QR, persist gallery
    """
    try:
        jobs[group_id]["progress"] = 8
        api_token = get_replicate_token(request.user_replicate_token or "")
        if not api_token:
            raise ValueError(
                "No Replicate API key available. "
                "Enter your key in the login screen, or ask an admin to configure one."
            )

        client       = replicate.Client(api_token=api_token, timeout=REPLICATE_TIMEOUT)
        n            = len(persons_data)
        image_mode   = theme.get("mode") == "image"
        completed    = {"n": 0}

        # ── Stage: per-person transform, run in parallel ─────────────────
        MAX_PERSON_ATTEMPTS = 2   # 1 primary + 1 reworded retry on a content-safety flag

        async def _transform_one(idx: int, pd: dict) -> bytes:
            jobs[group_id]["persons"][idx]["sub_status"] = "processing"
            character = pd["character"]

            upload_path   = UPLOADS_DIR / f"{pd['upload_id']}.jpg"
            user_data_uri = jpeg_bytes_to_data_uri(upload_path.read_bytes())

            last_exc = None
            for attempt in range(1, MAX_PERSON_ATTEMPTS + 1):
                prompt      = build_person_prompt(theme, character, attempt=attempt)
                image_input = [user_data_uri]
                if image_mode:
                    ref_path = (IMGS_DIR / "cosplay" / character["reference_image"]) if IMGS_DIR else None
                    if ref_path and ref_path.exists():
                        image_input.append(read_path_as_data_uri(ref_path))
                    else:
                        logger.warning(f"⚠️  [{group_id[:8]}] Reference image missing: {ref_path}")

                def _call():
                    return _poll_replicate(client, TRANSFORM_MODEL, {
                        "image_input":    image_input,
                        "prompt":         prompt,
                        "output_format":  "jpg",
                    })

                t0 = time.time()
                try:
                    output = await asyncio.to_thread(_call)
                    url    = _extract_url(output)
                    r      = await asyncio.to_thread(lambda: requests.get(url, timeout=90))
                    r.raise_for_status()

                    jobs[group_id]["persons"][idx]["sub_status"] = "done"
                    completed["n"] += 1
                    jobs[group_id]["progress"] = 10 + int(50 * completed["n"] / n)
                    logger.info(f"⏱️  [{group_id[:8]}] person {idx} ({character['name']}) done in {time.time()-t0:.1f}s (attempt {attempt})")
                    return r.content
                except Exception as exc:
                    last_exc = exc
                    if attempt < MAX_PERSON_ATTEMPTS and _is_content_safety_error(exc):
                        logger.warning(
                            f"⚠️  [{group_id[:8]}] person {idx} ({character['name']}) "
                            f"flagged by content safety on attempt {attempt} — retrying with softer wording"
                        )
                        continue
                    break

            jobs[group_id]["persons"][idx]["sub_status"] = "error"
            if _is_content_safety_error(last_exc):
                raise ValueError(
                    f"The photo for {character['name']} couldn't be transformed — it was flagged by the "
                    "AI's safety filter. Please try a different photo, or shuffle for a different character."
                )
            raise last_exc

        try:
            person_results = await asyncio.gather(*[
                _transform_one(i, pd) for i, pd in enumerate(persons_data)
            ])
        except Exception:
            for p in jobs[group_id]["persons"]:
                if p["sub_status"] == "processing":
                    p["sub_status"] = "error"
            raise

        jobs[group_id]["progress"] = 62

        # ── Stage: composite onto the chosen (or a random) background ────
        bg_pool   = COSPLAY_CONFIG.get("backgrounds", {}).get(request.theme_key, [])
        bg_choice = request.background_image if request.background_image in bg_pool else None
        if not bg_choice:
            bg_choice = random.choice(bg_pool) if bg_pool else None
        composite = await asyncio.to_thread(_composite_group, list(person_results), bg_choice)
        jobs[group_id]["progress"] = 70

        # ── Stage: harmonize pass (lighting/shadows only) ─────────────────
        composite_data_uri = jpeg_bytes_to_data_uri(pil_to_jpeg_bytes(composite))

        def _harmonize_call():
            return _poll_replicate(client, TRANSFORM_MODEL, {
                "image_input":    [composite_data_uri],
                "prompt":         build_harmonize_prompt(n),
                "aspect_ratio":   FINAL_ASPECT_RATIO,   # composite is already built at this ratio — locks it in
                "output_format":  "jpg",
            })

        try:
            h_output = await asyncio.to_thread(_harmonize_call)
            h_url    = _extract_url(h_output)
            hr       = await asyncio.to_thread(lambda: requests.get(h_url, timeout=90))
            hr.raise_for_status()
            result_bytes = hr.content
        except Exception as h_exc:
            logger.warning(f"⚠️  [{group_id[:8]}] Harmonize pass failed ({h_exc}) — using unharmonized composite")
            result_bytes = pil_to_jpeg_bytes(composite)

        jobs[group_id]["progress"] = 85
        result_pil = Image.open(io.BytesIO(result_bytes)).convert("RGB")

        # ── Stage: masthead overlay ────────────────────────────────────
        # Reframes the harmonized photo onto the branded masthead canvas —
        # becomes the one image saved/served everywhere downstream (gallery,
        # mobile retrieval, admin download), same as every other stage here.
        result_pil = await asyncio.to_thread(apply_masthead, result_pil)

        # ── Stage: save files ──────────────────────────────────────────
        item_id   = str(uuid.uuid4())
        xfmd_file = f"{item_id}_transformed.jpg"
        await asyncio.to_thread(
            lambda: result_pil.save(GALLERY_DIR / xfmd_file, format="JPEG", quality=OUTPUT_QUALITY)
        )

        # Representative "original" thumbnail = first captured person
        orig_file    = f"{item_id}_original.jpg"
        first_upload = UPLOADS_DIR / f"{persons_data[0]['upload_id']}.jpg"
        has_orig     = first_upload.exists()
        if has_orig:
            await asyncio.to_thread(shutil.copy2, first_upload, GALLERY_DIR / orig_file)

        # ── Stage: QR code ─────────────────────────────────────────────
        jobs[group_id]["progress"] = 93
        token  = str(uuid.uuid4())
        qr_url = f"{BASE_URL}/mobile.html?token={token}"
        qr_b64 = generate_qr_png_b64(qr_url)

        # ── Stage: persist gallery metadata ──────────────────────────
        character_summaries = [
            {"name": pd["character"]["name"], "gender": pd["gender"], "source": pd["character"].get("source", "")}
            for pd in persons_data
        ]
        entry = {
            "id":               item_id,
            "token":            token,
            "job_id":           group_id,
            "theme_key":        request.theme_key,
            "theme_name":       theme.get("display_name", request.theme_key),
            "characters":       character_summaries,
            "group_size":       n,
            "background_image": bg_choice or "",
            "session_id":       request.session_id or "",
            "original_file":    orig_file if has_orig else "",
            "transformed_file": xfmd_file,
            "timestamp":        datetime.now().isoformat(),
            "width":            result_pil.width,
            "height":           result_pil.height,
            "persons":          n,
        }
        gallery_history.appendleft(entry)
        save_gallery_metadata()

        # Clean up all N upload files after successful gallery save
        for pd in persons_data:
            try:
                (UPLOADS_DIR / f"{pd['upload_id']}.jpg").unlink(missing_ok=True)
            except Exception:
                pass

        jobs[group_id].update({
            "status":       "completed",
            "progress":     100,
            "result_url":   f"/gallery-files/{xfmd_file}",
            "original_url": f"/gallery-files/{orig_file}" if has_orig else "",
            "token":        token,
            "qr_code":      qr_b64,
            "qr_url":       qr_url,
            "theme_name":   theme.get("display_name", request.theme_key),
            "characters":   character_summaries,
        })
        logger.info(f"✅  [{group_id[:8]}] Complete — token={token[:8]}, {n} person(s)")

    except Exception as exc:
        logger.error(f"❌  [{group_id[:8]}] Group transform failed: {exc}")
        jobs[group_id].update({"status": "error", "error": str(exc)})


# ═══════════════════════════════════════════════════════════════════
# STATIC FILES  (mount LAST)
# ═══════════════════════════════════════════════════════════════════

def _resolve_dir(rel_to_file: str, docker_abs: str) -> Optional[Path]:
    p = Path(__file__).parent.parent / rel_to_file
    if p.exists():
        return p
    p2 = Path(docker_abs)
    return p2 if p2.exists() else None


WEB_APP_DIR = _resolve_dir("web-app", "/app/web-app")
IMGS_DIR    = _resolve_dir("imgs",    "/app/imgs")

if WEB_APP_DIR:
    app.mount("/gallery-files", StaticFiles(directory=str(GALLERY_DIR)),   name="gallery_files")
    if IMGS_DIR:
        app.mount("/imgs", StaticFiles(directory=str(IMGS_DIR)), name="dest_images")
    else:
        logger.warning("⚠️  imgs/ directory not found — costume/background images will be missing")
    app.mount("/", StaticFiles(directory=str(WEB_APP_DIR), html=True), name="webapp")
    logger.info(f"📂  Serving web-app from: {WEB_APP_DIR}")
else:
    logger.warning("⚠️  web-app/ directory not found — static files not served")

# end of main.py
