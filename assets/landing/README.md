# SILO welcome artwork

The welcome page preserves the approved refined Blender still, with Sales,
Ads, Finance and Inventory connected to the SILO badge. The optional video is
an independently animated reconstruction of that scene in Blender, not a pan
or zoom of the still. It contains no application screenshots or account data.

## Redo welcome page (`/redo-welcome.html`) — optional interface captures

Drop dark-mode PNGs here; the page probes each path on load and fills the
matching slot when the file exists. Until then, visitors see a labeled empty
frame on the same navy field as the board.

| File | Slot |
|------|------|
| `redo-demo-chart.png` | Revenue chart beside the headline KPI (≈960×540) |
| `redo-demo-dashboard.png` | Full-width dashboard under the hero row (≈1200×720) |
| `redo-demo-ask-silo.png` | Ask Silo analysis panel (≈640×480) |

Use dark-mode Silo captures so the frame matches the landing. The sample dollar
figures in the HTML are poster placeholders only; replace or hide them when a
capture carries the real numbers.

## Still fallback (unchanged)

- `silo-hero.webp`: 1800 × 1100, desktop/high-density source
- `silo-hero-1080.webp`: 1080 × 660, smaller responsive source
- `silo-hero.jpg`: 1800 × 1100, non-WebP fallback

## Motion

- `silo-hero-motion.mp4`: 1080 × 660, 367,366 bytes
- `silo-hero-motion-mobile.mp4`: 720 × 440, 318,136 bytes; selected at ≤600 CSS px
- `silo-hero-motion.js`: small, dependency-free playback controller

The controller automatically assigns a video URL only when the artwork enters
view and reduced-motion / data-saver settings allow playback. Otherwise the
still remains with a reason and an explicit Play animation control. A click
opts into playback for this page only; changes to either preference revoke that
choice. No video download begins under those preferences without that click.
The original responsive still stays underneath until a frame is playing.
Failed autoplay or a five-second pending start keeps a reachable Play control;
network/decode errors offer Retry and a direct video link without automatic
retries. Pause / Play is keyboard accessible. Hidden tabs, offscreen artwork
and auth routing stop playback. Returning never overrides a visitor's Pause.

Both videos are six seconds / 144 frames at 24fps, silent H.264 (`yuv420p`)
with faststart metadata. They are inline, looping and dimensioned, with no external media
service or runtime rendering dependency. If the motion script fails or browser
features are unavailable, the still and a plain Watch animation link remain.
The video and image are decorative; the page copy names the product's purpose.

The editable Blender scene, procedural reconstruction script and render
settings are retained separately with the source deliverable, rather than
committing a large `.blend` file here. Keep the dimensions, source selection
and byte budgets in `tests/public-landing.test.mjs` in sync with future encodes.

## Render validation

The source contains real meshes, extruded labels and animated connection curves,
with a stable camera and independently phased card/badge movement. Frame 145 is
the matching loop endpoint; frames 1–144 are encoded without a duplicate hold.
The separately rendered endpoint is pixel-identical to frame 1. H.264 is lossy:
the web encodes have a small compression step at the boundary, with negligible
mean-brightness change. The desktop web encode retains 0.9964 SSIM versus
the high-quality master, which is retained with the editable source deliverable. The editable-source archive
contains the scene, build/denoise/encode scripts and detailed validation output.
