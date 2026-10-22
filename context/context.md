# Immersive AI Cosplayers MultiVerse – Project Context

> **Status:** `server-code-cache/` = legacy reference (do not deploy) · `server-code/` = active build · `web-app/` = front-end UI (shared)
> **Last updated:** 2026-08-26 — rembg OOM fix (§9); architecture unchanged since the 2026-07-23 cosplay/party pivot (replaces the earlier travel-destination kiosk described in prior revisions of this doc)
> **Branding note:** the on-screen product name/tagline is being actively iterated on by the team independent of this doc (currently "Immersive AI Cosplayers MultiVerse" / home hero "ThemePainter") — treat exact copy as volatile; treat the architecture below as the stable reference.

---

## 1. Product Overview

This is a **cosplay/party-themed AI photo transformation kiosk**. A user (solo or a group of up to 4) picks a theme — **Cosplay, Game, Historic, or Movie** — captures one photo per person, and Google's **`nano-banana-2`** image model (via Replicate) transforms each person into a themed character, composites the whole group onto one shared background scene, and displays a QR code so the result can be retrieved on a phone.

This app was originally a **travel-destination** kiosk (pick a country, get an illustrated "travel memory"). It was fully pivoted to the cosplay/party concept in one extended session on 2026-07-22/23 — see §9 Changelog for the full list of what changed. The repo folder name (`cosplay-theme-webapp`) reflects the new identity; some legacy travel-era assets and docs may still linger uncleaned (flagged in §8).

Primary deployment targets: Docker (self-hosted) and Render (cloud PaaS, currently stale — see §8).

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                                       │
│  web-app/index.html + app.js + styles.css                           │
│  – Vanilla JS, Tailwind CSS CDN, Material Symbols, QRCode.js        │
│  – OGL (WebGL) home-page background effect, loaded as an ES module  │
│    directly from a CDN inside index.html (no bundler)               │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  HTTP  (same origin)
┌───────────────────────────────▼──────────────────────────────────────┐
│  FastAPI Server  (Python 3.12, uvicorn, port 10003)                  │
│  server-code/main.py                                                 │
│                                                                      │
│  Client call sequence (per group session):                           │
│    POST /upload (×N)  →  POST /analyze-person (×N)  →                │
│    POST /assign-character (×N, +reroll)  →  POST /group-transform    │
│                                                                      │
│  Static file mounts (registration order matters — see §7 "/imgs      │
│  routing gotcha"):                                                   │
│    /gallery-files/ → gallery/           (transformed images)         │
│    /imgs/          → imgs/              (cosplay refs + backgrounds) │
│    /               → web-app/  html=True  (SPA + standalone assets)  │
└──────────┬────────────────────────────────────┬──────────────────────┘
           │ replicate Python SDK               │ rembg (local ONNX)
┌──────────▼──────────────────────┐  ┌──────────▼──────────────────────┐
│  Replicate API                   │  │  rembg                          │
│  – google/nano-banana-2          │  │  group-composite stage: cuts    │
│    (per-person costume transform,│  │  each transformed person out,   │
│     ×N in parallel; + one        │  │  pastes onto the shared         │
│     harmonize pass on the final  │  │  background scene               │
│     group composite)             │  └─────────────────────────────────┘
│  – lucataco/qwen3-vl-8b-instruct │
│    (/analyze-person — gender     │
│     detection only, single       │
│     person per call)             │
│  – lucataco/qwen2-vl-7b-instruct │
│    (vision LLM fallback)         │
└─────────────────────────────────┘
```

**Model changes from the travel-kiosk era:** `qwen/qwen-image-edit-plus` → `google/nano-banana-2` for all image transforms. `ddvinh1/inswapper` (face-swap "realistic" style) removed entirely. Vision LLMs (Qwen3-VL primary / Qwen2-VL fallback) unchanged in choice, but scope shrank from full multi-person left-to-right scene analysis down to single-person gender detection, since capture is now one photo per person.

### Storage Layout (runtime)

```
server-code/
  main.py                    ← FastAPI app
  requirements.txt
  config_cosplay.json        ← themes, 36 characters, background pools
  .env                       ← secrets (REPLICATE_API_TOKEN, BASE_URL, …)
  uploads/                   ← original per-person captures (deleted after job completes)
  gallery/
    gallery_metadata.json    ← persisted gallery index (500-item deque)
    retrieval_log.csv        ← QR mobile retrieval log (name, email, ts)
    app_settings.json        ← runtime settings (gallery_public, …)
    admin_sessions.json      ← admin session tokens
    <uuid>_original.jpg      ← representative "before" photo (first captured person)
    <uuid>_transformed.jpg   ← final group composite

web-app/
  index.html                    ← main kiosk SPA shell + Tailwind config + inline OGL Lightfall effect
  mobile.html                    ← mobile QR retrieval page
  app.js                         ← full SPA logic (vanilla JS)
  styles.css                     ← small set of overrides; bulk of styling lives in index.html <style>
  animation-while-loading.svg    ← self-animating (SMIL) loading illustration, transform page
  icons/                         ← journey-step + UI icons (SVG) — served at /icons/*
  favicons/
  imgs/styles/                   ← LEGACY, dead (see §7 "/imgs routing gotcha") — do not add new assets here

imgs/
  cosplay/
    anime/          ← 8 face-blanked costume reference cutouts (Cosplay theme, image-mode)
    game/            ← 10 face-blanked costume reference cutouts (Game theme, image-mode)
    backgrounds/     ← 15 shared background scenes — all 4 themes draw from the same full pool
  countries-and-cities/, countries-and-continentals/, overlays/
    ← LEGACY travel-kiosk assets. Deleted from the working tree as of this pivot (uncommitted git
      deletions) but the deletion hasn't been committed — treat as gone, not as a resource to use.
```

---

## 3. Feature Inventory

### 3.1 User Journey (6 steps + home)

| Step | Page key | Description |
|------|----------|-------------|
| 0 | `home` | Full-bleed animated background (OGL "Lightfall" light-streak effect), hero title/tagline, theme/character/created-count stats, entry button |
| 1 | `setup` | Pick a theme (Cosplay / Game / Historic / Movie tile grid), then group size (1–4 headcount grid) on the same page |
| 2 | `capture` | Loop: capture one photo per person (camera device select, retake). Each capture uploads via `/upload` and fires `/analyze-person` in the background while the next person is captured |
| 3 | `lineup` | Server picks a random character per person (filtered by theme + detected gender). Shuffle/reroll button per person before confirming — instant, no AI call |
| 4 | `background` | Pick one background scene from a zero-gap, scrollable 3-column mosaic (all 15 images, same pool regardless of theme) |
| 5 | `transform` | Fires `/group-transform`, polls `/group-status/{group_id}` every 2.5 s. Progress bar + per-person status chips + an animated loading illustration (`animation-while-loading.svg`) while waiting |
| 6 | `result` | Shows the final group composite, QR code, download/print, recent thumbnails |

Navigation is gated by `isStepUnlocked()` / `navigateTo()` — same breadcrumb-shake-on-locked-click pattern as before the pivot.

### 3.2 AI Transformation Pipeline

**Group session call sequence (client calls in order, N = 1–4 people):**

```
POST /upload                     (×N) → EXIF-correct, centre-crop to 1024×1024 square → upload_id
POST /analyze-person?upload_id=  (×N) → single-person gender detection; never blocks — random
                                          50/50 fallback if the vision call fails entirely
POST /assign-character           (×N, + reroll) → random character from the theme+gender pool;
                                          pure in-memory pick, no AI call, must feel instant
POST /group-transform             → validates everything, starts the async group job → group_id
GET  /group-status/{group_id}     → poll progress (0–100%) + per-person sub_status
```

**Background task (`run_group_transformation`) stages:**

| Stage | Action |
|-------|--------|
| 1 | Validate Replicate API token |
| 2 | **N person transforms in parallel** (`asyncio.gather`) via `google/nano-banana-2`. Image-mode themes (Cosplay/Game) send `image_input=[user_photo, costume_reference_photo]`; prompt-mode themes (Historic/Movie) send `image_input=[user_photo]` plus the character's full descriptive prompt. One bounded retry with a softer, more neutral prompt wording on a detected content-safety rejection (`E005` / "flagged as sensitive") |
| 3 | Composite: rembg-cut each transformed person, pack them shoulder-to-shoulder centred on a **fixed 4:3 canvas** (`FINAL_ASPECT_RATIO` in `main.py`) built from the user-picked (or random-fallback) background image. Shrinks the whole group uniformly if it would overflow, so nobody is ever cropped |
| 4 | One more `google/nano-banana-2` call: harmonize pass over the full composite (lighting/color/shadow unification; pose adjustment is allowed for groups so independently-photographed people don't look like pasted cutouts). **Branches by person count** — solo (n=1) uses a prompt with zero "group"/"together" language (that phrasing was causing the model to hallucinate a second person for solo photos); n≥2 uses the original group-cohesion prompt, unchanged |
| 5 | Save `<id>_original.jpg` (first captured person, representative "before" thumbnail) + `<id>_transformed.jpg` to `gallery/`; delete all N `uploads/<id>.jpg` files |
| 6 | Generate QR code PNG (data-URI) encoding `/mobile.html?token=<uuid>` |
| 7 | Persist `gallery_metadata.json`; update job record to `completed` |

**No longer part of the pipeline** (removed in the pivot): masthead/postcard overlay baking, `background_image` random-only selection (now user-picked), the comic/toon/watercolor/realistic art-style toggle, inswapper face-swap, multi-person-in-one-photo scene analysis.

### 3.3 Themes & Characters (`config_cosplay.json`)

Content is fully data-driven:

- **4 themes**: `cosplay` / `game` (`mode: "image"` — costume comes from a reference photo) and `historic` / `movie` (`mode: "prompt"` — costume comes from text only)
- **36 characters**: cosplay 8 (4M/4F, anime), game 10 (5M/5F, Mobile Legends: Bang Bang + Genshin Impact), historic 8 (4M/4F), movie 10 (5M/5F) — every character is gender-tagged for the random-assignment logic
- **backgrounds**: 15 shared images under `imgs/cosplay/backgrounds/` — the same full pool is available to every theme

**Image-mode character schema:**
```json
{
  "key": "cosplay_erza_scarlet", "theme_key": "cosplay", "name": "Erza Scarlet",
  "source": "Fairy Tail", "gender": "female",
  "description": "S-Class requip mage in gleaming Heart Kreuz armour.",
  "reference_image": "anime/erza scarlet-fairy-tail.jpg"
}
```
**Prompt-mode character schema:** same shape, but a `prompt` field (full descriptive costume/scene text) instead of `reference_image`.

**Shared prompt fragments** (top-level keys in the config, prepended/selected by the server): `identity_guard` (every person-transform call), `image_mode_instruction` + `image_mode_instruction_retry` (Cosplay/Game only), `harmonize_prompt` (n≥2) + `harmonize_prompt_single` (n=1).

### 3.4 Gallery

- Paginated: `GET /gallery?page&limit&theme&admin_token`
- Public/admin toggle (runtime setting, `app_settings.gallery_public`)
- Admin view includes `token`, full `characters` list, etc.; non-admin/public view strips those fields (privacy — see §7 IP-safety note)
- Auto-polls for new items every 8 s while the gallery page is open
- Filterable by theme (clickable chip row, not a native `<select>`)
- Max 500 items (deque, oldest evicted)
- **Admin gallery-detail modal has a "QR Code" action** — regenerates the `/mobile.html?token=...` retrieval QR for any past item on demand (every item already stores its `token`), alongside Download/Print/Delete. Useful when a guest missed scanning their original QR.

### 3.5 Admin Panel

Unchanged mechanically from the travel-kiosk era — modal login (`POST /admin/login`), session token in `sessionStorage` + `admin_sessions.json`. `GET /admin/stats` now groups by `theme_key` (`by_theme`) instead of the old `by_destination`.

### 3.6 Mobile QR Retrieval

`web-app/mobile.html` — reads `?token=` from the URL, calls `GET /retrieve/{token}`, gates behind a name+email form (logged via `POST /log-retrieval`), displays the transformed image.

**IP-safety:** the theme name and character/franchise names are **intentionally not displayed** on this page — that data is commented out in both the HTML (Theme/Cast meta rows) and the JS (`result-title` computation), since this page is reachable by anyone with the link/QR and character names are third-party IP. The title shows a generic "YOUR TRANSFORMATION" instead. The photo itself and download/share still work normally — only the identifying names are hidden. (Admin gallery views are unaffected — staff still see full character/theme info there.)

### 3.7 User Session (Client-side)

Unchanged from before — first-visit modal for name + optional Replicate API key, `localStorage` with 24-hour TTL, forwarded as `user_replicate_token`. Token priority: admin override → user key → `REPLICATE_API_TOKEN` env var.

---

## 4. API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness probe |
| GET | `/config` | — | Full themes + characters + backgrounds config, plus `max_persons` |
| GET | `/settings` | — | Public app settings |
| POST | `/upload` | — | Upload one person's photo; returns `upload_id` |
| POST | `/analyze-person?upload_id=` | — | Single-person gender detection; always returns a usable gender, never errors out the flow |
| POST | `/assign-character` | — | Body `{theme_key, gender, exclude_keys?}` → random character (reroll support via `exclude_keys`) |
| POST | `/group-transform` | — | Body `{theme_key, persons[], background_image?, session_id?, user_replicate_token?}` → starts async group job |
| GET | `/group-status/{group_id}` | — | Poll job progress + per-person `sub_status` |
| GET | `/gallery` | opt admin | Paginated gallery, filter by `theme` |
| GET | `/gallery/count` | — | Count-only (for auto-refresh) |
| GET | `/retrieve/{token}` | — | QR mobile retrieval — returns `theme_name` + `character_names`, deliberately no franchise/source field |
| POST | `/log-retrieval` | — | Log visitor name/email for retrieval |
| POST | `/admin/login` | — | Get admin session token |
| POST | `/admin/logout` | admin | Invalidate token |
| GET/PATCH | `/admin/settings` | admin | Read / update runtime settings |
| GET | `/admin/stats` | admin | Transformation stats, grouped `by_theme` |
| DELETE | `/admin/gallery/{id}` | admin | Delete one gallery item |
| DELETE | `/admin/gallery/all` | admin | Delete all gallery items |
| GET | `/admin/gallery/download-all` | admin | ZIP download |
| GET/DELETE | `/admin/retrieval-log` | admin | CSV download / reset |

**Removed since the travel-kiosk era:** `/destinations` (→ `/config`), `/analyze` (→ `/analyze-person`, single-person), `/strip` (background removal now happens inline during the group-composite stage, not as its own client-facing step), `/transform` + `/status/{job_id}` (→ `/group-transform` + `/group-status/{group_id}`).

**`GroupTransformRequest` body:**
```json
{
  "theme_key": "game",
  "persons": [
    { "upload_id": "...", "gender": "female", "character_key": "game_furina" },
    { "upload_id": "...", "gender": "male",   "character_key": "game_wriothesley" }
  ],
  "background_image": "backgrounds/palace1.jpg",
  "session_id": "...",
  "user_replicate_token": "r8_..."
}
```

---

## 5. Configuration & Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REPLICATE_API_TOKEN` | `""` | Replicate API key (can also be set via admin UI at runtime) |
| `BASE_URL` | `http://localhost:10003` | Public base URL for QR code links |
| `VISION_MODEL` | `lucataco/qwen3-vl-8b-instruct:39e8…` | Vision LLM for `/analyze-person` (`media` field; `/no_think` mode) |
| `VISION_FALLBACK` | `lucataco/qwen2-vl-7b-instruct:bf57…` | Fallback vision LLM |
| `ENABLE_CORS` | `false` | Enable CORS middleware (`true` in docker-compose) |
| `ENABLE_REMBG` | `true` | Enable local background removal (disable on memory-constrained hosts) |
| `REMBG_MODEL_NAME` | `u2netp` | rembg ONNX model — pinned small (~4.6 MB) since rembg's own default is `bria-rmbg` (~1.02 GB), which was causing OOM under load; a single session is loaded once and reused (see `_get_rembg_session()`) rather than reloaded per photo |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `lumina2025` | Admin login password (default unchanged since the travel-kiosk era — still worth rotating before real use) |
| `DATA_DIR` | `/var/data` (if exists) else `.` | Root directory for uploads, gallery, and admin session files |

**Non-env-var behavior constants worth knowing** (in `server-code/main.py`, no override): `MAX_PERSONS = 4` (headcount cap), `FINAL_ASPECT_RATIO = "4:3"` (locked output shape for every group composite, regardless of headcount), `TRANSFORM_MODEL = "google/nano-banana-2"` (hardcoded, not env-configurable — unlike the vision models).

---

## 6. Deployment

### Docker (self-hosted)
```
docker-compose up --build
```
- Container/service name: **`asa-ai-kiosk`** (renamed from `lumina-horizon` during the pivot)
- Port **`10003`** exposed (moved from `10002`)
- Volumes: `./server-code/gallery`, `./server-code/uploads`, `./server-code/.env`
- Health check: `GET /health`

### Render (cloud) — currently stale, not fixed as part of this pivot
- `render.yaml` points `dockerfilePath`/`dockerContext` at `./for-deploy-webapp/`, a directory that **does not exist** in this repo — this predates the cosplay pivot (present since the initial commit) and was never fixed. Don't trust a Render Blueprint deploy from this repo as-is without addressing that first.
- `ENABLE_REMBG=false` recommended on free/starter tier (OOM risk)
- Attach a **Render Disk** mounted at `/var/data` for persistent uploads/gallery across deploys

---

## 7. Key Design Decisions

### Model swap: Qwen Image Edit Plus → `google/nano-banana-2`
Different API shape entirely — `nano-banana-2` takes `prompt` (string) + `image_input` (array, up to 14 images) + `output_format`, with **no `strength`/`cfg_scale`/`steps` knobs**. All transformation quality tuning now happens purely through prompt wording, which is why the harmonize-prompt and content-safety-retry work below matters more here than it did with Qwen. Confirmed via Google's own Gemini image-gen docs (not just Replicate's page, which doesn't list the full enum) that `aspect_ratio` supports `4:3` among others — used to lock `FINAL_ASPECT_RATIO`.

### Content-safety retry (image-mode themes)
Real-photo + reference-image edits (Cosplay/Game) are the request shape most likely to trip Replicate/Gemini's content-safety filter (`E005`, "flagged as sensitive"). Fix: softened `image_mode_instruction` wording (framed as a neutral clothing/wardrobe edit rather than identity-manipulation-sounding phrasing like "give them the costume... onto the person"), plus a bounded one-shot retry with an even more neutral `image_mode_instruction_retry` fallback before giving up. Unverified against the real safety classifier beyond production use so far — if `E005` recurs, this is the next place to look.

### Harmonize prompt branches by person count
The original single harmonize prompt used "group scene"/"standing together"/"angled toward each other" language unconditionally. For a solo photo there's no one to angle toward, and that vivid positive scene-setting language plausibly outweighed the terse "do not add anyone" constraint — the model resolved the contradiction by inventing a second person. Now `build_harmonize_prompt(n)` picks `harmonize_prompt_single` (n=1, no group language, explicit "exactly one person") vs the original `harmonize_prompt` (n≥2, unchanged).

### `/imgs` URL routing gotcha
There are **two unrelated `imgs/` directories** in this repo: root-level `imgs/` (cosplay reference photos + backgrounds, mounted at `/imgs`) and `web-app/imgs/` (old kiosk UI assets). `web-app/` itself is mounted at `/` as a catch-all, but since `/imgs` is registered as its own mount first, **any URL under `/imgs/...` always resolves against the root directory** — files placed in `web-app/imgs/` are silently unreachable (404) unless a same-named file happens to also exist in the root `imgs/`. This masked itself for a long time because `kiosk-logo.png` happens to be duplicated in both places. **New standalone kiosk-UI assets should go at `web-app/` root or `web-app/icons/` (already proven reachable at `/icons/...`), never `web-app/imgs/`.**

### `class="hidden"` vs inline `display:none`
Most of `app.js` toggles visibility via `classList.add/remove('hidden')` against the `.hidden { display: none !important; }` CSS class. Any element that instead hides via an inline `style="display:none"` is a landmine if JS ever tries to un-hide it with `classList.remove('hidden')` — the two mechanisms don't talk to each other, so removing a class the element never had does nothing while the untouched inline style keeps it hidden. Found and fixed one live instance of this (`#transform-result-img`) during the pivot; worth grepping for `display:none` inline styles vs `classList` toggles if new "won't show up" bugs appear elsewhere.

### IP safety on the public retrieval page
See §3.6 — theme/character names are deliberately withheld on `mobile.html` (reachable by anyone with the QR/link) but remain fully visible to admin in the gallery UI, which is the intended trust boundary.

### Home background effect: OGL, ported by hand from React Bits
This app has no React/build step, so the home-page WebGL background (currently "Lightfall," previously "Orb") is manually translated from React Bits' React+OGL source into a plain `<script type="module">` block in `index.html`, importing OGL straight from a CDN (`https://cdn.jsdelivr.net/npm/ogl/dist/ogl.mjs`). Notes for the next swap:
- OGL's `Triangle` helper isn't exported from that CDN build — build the fullscreen triangle manually via `new Geometry(gl, { position: {...}, uv: {...} })` instead (see `initLightfall` for the exact `Float32Array` values, reusable across effects).
- Lazy-init gate (a boolean + real-dimension check) so the WebGL context isn't created while the home page is `display:none`. Trigger = `MutationObserver` on `#page-home`'s `style` attribute + a `ResizeObserver` on the container + a `setTimeout` fallback.
- Reference source for each ported effect (React Bits' "Copy Prompt" output — full component source + props table) is saved at `design/cover-js/<name>.txt` for future reference/re-porting.

### Fonts
Gordita/Calendas Plus (self-hosted `@font-face`, `web-app/fonts/`) were replaced with Mulish/Epilogue loaded via a Google Fonts `<link>` in `<head>`. The old `@font-face` declarations were removed; `web-app/fonts/` is now unused dead weight.

---

## 8. Known Limitations

1. **In-memory job store** – `jobs` dict (keyed by `group_id`) is ephemeral; in-flight jobs are lost on restart.
2. **Single-process async** – all Replicate calls are `asyncio.to_thread`; heavy load queues rather than scales horizontally.
3. **Admin token security** – tokens are plain UUIDs with no expiry; persisted to disk as plaintext.
4. **CORS wildcard** – `allow_origins=["*"]` when CORS is enabled; fine for kiosk, tighten for public deployments.
5. **No rate limiting** – `/upload` and `/group-transform` have no per-IP throttle.
6. ~~**rembg cold start**~~ — fixed 2026-08-26: model pinned to `u2netp` (~4.6 MB, was silently defaulting to `bria-rmbg` ~1.02 GB) and the session is now warmed at boot alongside the Replicate models (see §9 changelog), so this no longer affects the first real request.
7. **Render deploy is currently broken** – see §6, `render.yaml`/`Dockerfile.render` reference a nonexistent path; predates this pivot, not fixed as part of it.
8. **Legacy travel-kiosk assets not cleaned up** – `imgs/countries-and-cities/`, `imgs/countries-and-continentals/`, `imgs/overlays/`, `web-app/imgs/styles/` are dead (no live code references any of them) but still present/uncommitted in the working tree.
9. **`game_marcel`'s gender tag** in `config_cosplay.json` (`male`) is a guess from the reference image's silhouette, not a confirmed identification of the MLBB hero.
10. **Content-safety retry and harmonize pose-blending are unverified against the live model** beyond whatever real usage has happened since — both were built to spec but couldn't be tested against Google's actual classifier/model behavior during development (no token in the dev environment at the time).

---

## 9. Changelog

### 2026-08-26 — rembg OOM fix + warmup coverage

- **Root cause of production out-of-memory failures under load**: `requirements.txt` only floors `rembg>=2.0.57`, and rembg's own default model changed from `u2net` (~176 MB) to `bria-rmbg` (~1.02 GB) in current releases — the server was silently loading a gigabyte-scale ONNX model on every group-composite call. Compounded by `_composite_group()` calling bare `rembg.remove()` with no session, which builds (and reloads) a brand-new session from scratch on every single call — so memory pressure scaled with photos processed, not just peak single-request usage.
- **Fix**: new `REMBG_MODEL_NAME` env var (default `u2netp`, ~4.6 MB — ~220x smaller than `bria-rmbg`) plus `_get_rembg_session()` in `main.py`, a module-level lazily-created session reused for every call via `rembg.remove(img, session=...)`. Also folded into the existing `_run_warmup()` boot sequence (runs regardless of Replicate-token presence, unlike the two Replicate warmup steps) so the one-time ~36s model load happens at boot, not on the first real group's composite stage.
- Ported from an equivalent fix already applied and verified on a sibling app with the same rembg dependency and the same OOM symptom.
- Previously undocumented gap found while re-verifying this doc against the code (2026-08-26): the `_run_warmup`/`schedule_warmup_once` Replicate-model-warming system existed in `main.py` since the cosplay pivot but was never added to this doc — now covered by this entry and the rembg addition folds into the same mechanism.

### 2026-07-22 / 07-23 — Cosplay/Party Pivot (single extended session)

Full replacement of the travel-destination concept. Highlights, roughly in the order they landed:

- **Theme system**: 4 themes (Cosplay, Game, Historic, Movie) replace 8 country destinations; `config_cosplay.json` replaces `config_destinations.json`; 36 characters replace 28 destination styles.
- **New flow**: `setup → capture (×N loop) → lineup (random cast + reroll) → background (user-picked) → transform → result` replaces `capture → destination → quote → transform → result`. Capture moved from a single multi-person photo to one photo per person.
- **Model swap**: `google/nano-banana-2` replaces `qwen/qwen-image-edit-plus` for every transform call. `ddvinh1/inswapper` (face-swap "realistic" style) removed entirely, along with the whole comic/toon/watercolor/realistic art-style picker.
- **Group pipeline rebuilt**: N person transforms run in parallel, then get rembg-composited onto one shared background (now locked to a fixed 4:3 canvas regardless of headcount) and harmonized in one more AI pass — replacing the old single-photo two-pass (costume + art-style) pipeline built around Qwen's anti-hallucination guardrails.
- **Postcard/quote feature removed entirely** — no more masthead overlay selection or baking; the saved result is just the harmonized composite.
- **Background selection is user-picked**, not random — a scrollable, zero-gap 3-column mosaic of all 15 shared background images (grew from an initial curated 9 to 15 mid-session).
- **Gallery QR regeneration** added for admin — any past gallery item's retrieval QR can be pulled up again, not just right after a fresh transform.
- **IP safety**: character/franchise names hidden on the public `mobile.html` retrieval page (admin views unaffected).
- **Fonts**: Gordita/Calendas Plus → Mulish/Epilogue (Google Fonts, self-hosted `@font-face` removed).
- **Home background effect**: Orb → Lightfall (both React Bits components, hand-ported to vanilla JS/OGL).
- **Docker**: container/service renamed `lumina-horizon` → `asa-ai-kiosk`, port `10002` → `10003`.
- **Prompt engineering fixes**: harmonize prompt branches by person count (fixes solo-photo hallucination), content-safety-triggered retry with softer wording for image-mode themes.
- **Bugs found and fixed along the way** (some pre-dating the pivot, surfaced by it): `#journey-zone` breadcrumb hardcoded to `bottom: 300px` instead of the clearly-intended `bottom: var(--footer-h)`; `/imgs` URL collision between the two `imgs/` directories silently 404ing any new `web-app/imgs/` asset; `.transform-panel` and `#transform-result-img` visibility toggling bugs (see §7).

---

## 10. Pending / Future Work

- [ ] Clean up dead legacy asset directories (§8, item 8) — confirm nothing references them, then delete
- [ ] Fix or remove the Render deploy path (`render.yaml` / `Dockerfile.render` reference `for-deploy-webapp/`, which doesn't exist)
- [ ] Verify `game_marcel`'s gender tag against the actual MLBB hero
- [ ] Persist job state so in-flight group jobs survive restarts (SQLite or file-backed)
- [ ] Admin session expiry (e.g., 8-hour TTL)
- [ ] Rate limiting middleware (`slowapi`)
- [ ] Scope CORS origins to known front-end host
- [ ] Real-device verification of the transform-page loading animation and harmonize pose-blending behavior against the live model (both were built/fixed without a Replicate token available in the dev environment)
- [ ] Keep this doc in sync going forward — it went stale for weeks last time and needed a full rewrite rather than a patch

---

## 11. File Map Quick Reference

| Path | Purpose |
|------|---------|
| `server-code/main.py` | FastAPI app — active deployment target |
| `server-code/config_cosplay.json` | Themes, characters, background pools |
| `server-code/requirements.txt` | Python dependencies |
| `server-code-cache/main.py` | Legacy pre-v2 reference (do not deploy) |
| `web-app/index.html` | Main kiosk SPA shell, Tailwind config, inline OGL background effect |
| `web-app/app.js` | All SPA logic (vanilla JS) |
| `web-app/mobile.html` | Mobile QR retrieval page (IP-safe — no character/theme names) |
| `web-app/styles.css` | Small set of CSS overrides |
| `web-app/animation-while-loading.svg` | Transform-page loading illustration (self-animating SVG) |
| `imgs/cosplay/anime/`, `imgs/cosplay/game/` | Costume reference photos (image-mode themes) |
| `imgs/cosplay/backgrounds/` | Shared background scene pool (15 images) |
| `design/cover-js/*.txt` | Saved React Bits "Copy Prompt" source for each ported background effect |
| `docker-compose.yml` | Local Docker deployment — service `asa-ai-kiosk`, port 10003 |
| `Dockerfile` | Cloud image build (port 10003) |
| `Dockerfile.render` / `render.yaml` | Render deployment spec — currently broken, see §6/§8 |
| `nginx-vhost.conf` | Nginx vhost config (reverse proxy setup), port 10003 |
| `context/context.md` | This document |
