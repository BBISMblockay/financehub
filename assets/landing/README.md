# SILO welcome artwork

The welcome page uses the refined Blender-rendered SILO scene, with Sales,
Ads, Finance and Inventory connected to the SILO badge. These files are
web-optimized encodings of that still, not screenshots of the application.

- `silo-hero.webp`: 1800 × 1100, desktop/high-density source
- `silo-hero-1080.webp`: 1080 × 660, smaller responsive source
- `silo-hero.jpg`: 1800 × 1100, non-WebP fallback

The source artwork is static. No autoplay video, animated loop, JavaScript
rendering library, or account data is included. Responsive composition is in
`index.html`; the image remains decorative because the page copy names the
product's purpose. Keep the image dimensions and byte budgets in
`tests/public-landing.test.mjs` in sync if replacing the render.
