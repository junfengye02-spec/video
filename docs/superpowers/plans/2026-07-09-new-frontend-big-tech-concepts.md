# New Frontend Big-Tech Concepts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate two complete big-tech-inspired frontend concept sets for OpenMontage, with 14 PNG screens per style.

**Architecture:** This is a deterministic visual-asset task, not an application code change. A standalone HTML source renders screens from structured data, then screenshots are exported into two output folders.

**Tech Stack:** HTML/CSS/JavaScript mockup source, local static server, browser screenshots, Pillow for final 2048x1152 resizing and dimension validation.

## Global Constraints

- Do not base the visuals on the current OpenMontage workbench frontend.
- Do not modify the React/Vite app code.
- Do not copy any big-tech page, logo, or brand asset.
- Do not expose real API keys, model names, provider names, gateway URLs, or payment-provider logos.
- Use Chinese UI copy for normal users.
- Generate two styles:
  - A: Stripe/Linear commercial trust + Canva/CapCut beginner friendliness.
  - B: Apple/Runway premium AI video feel + Stripe/Linear refined SaaS.
- Output directory: `output/frontend-concepts-v2/`.

---

### Task 1: Create V2 Mockup Source

**Files:**
- Create: `output/frontend-concepts-v2/showcase.html`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-09-new-frontend-big-tech-visual-systems-design.md`
- Produces: `showcase.html` with query parameters `?capture=1&style=a&page=<slug>` and `?capture=1&style=b&page=<slug>`.

- [ ] **Step 1: Create output directories**

Run:

```powershell
New-Item -ItemType Directory -Force output/frontend-concepts-v2/style-a-2plus3
New-Item -ItemType Directory -Force output/frontend-concepts-v2/style-b-1plus2
```

Expected: both directories exist.

- [ ] **Step 2: Write `showcase.html`**

Create one HTML file that contains:

```text
14 screen slugs:
01-brand-entry
02-login
03-creator-dashboard
04-prompt-composer
05-template-market
06-style-studio
07-generation-progress
08-storyboard-editor
09-shot-regenerate
10-asset-characters
11-final-preview
12-wallet-pricing
13-account-orders
14-optimization-board

two visual themes:
style-a-2plus3
style-b-1plus2
```

The HTML must render a complete 2048x1152 virtual canvas scaled into a 1280x720 browser viewport when `capture=1` is present.

- [ ] **Step 3: Commit source**

Run:

```powershell
git add -f -- output/frontend-concepts-v2/showcase.html
git commit -m "assets: add v2 frontend concept source"
```

Expected: only `showcase.html` is committed for this task.

### Task 2: Export 28 PNG Screens

**Files:**
- Create: `output/frontend-concepts-v2/style-a-2plus3/*.png`
- Create: `output/frontend-concepts-v2/style-b-1plus2/*.png`

**Interfaces:**
- Consumes: `showcase.html`.
- Produces: 28 final PNG images named by slug.

- [ ] **Step 1: Start local static server**

Run from `output/frontend-concepts-v2`:

```powershell
python -m http.server 8792 --bind 127.0.0.1
```

Expected: `http://127.0.0.1:8792/showcase.html` returns 200.

- [ ] **Step 2: Capture all pages**

Use browser screenshots for each style/page combination:

```text
style=a -> output/frontend-concepts-v2/style-a-2plus3/<slug>.png
style=b -> output/frontend-concepts-v2/style-b-1plus2/<slug>.png
```

Expected: 28 PNG files exist.

- [ ] **Step 3: Resize final images**

Use Pillow to resize each captured 1280x720 PNG to 2048x1152.

Expected: every final PNG is exactly `2048x1152`.

### Task 3: Validate And Document

**Files:**
- Create: `output/frontend-concepts-v2/manifest.md`

**Interfaces:**
- Consumes: 28 final PNG images.
- Produces: validation manifest.

- [ ] **Step 1: Validate dimensions and counts**

Run:

```powershell
python -c "from PIL import Image; from pathlib import Path; base=Path('output/frontend-concepts-v2'); files=list(base.glob('style-*/*.png')); print(len(files)); [print(p, Image.open(p).size) for p in files]"
```

Expected: `28` files and all sizes are `(2048, 1152)`.

- [ ] **Step 2: Scan for sensitive content**

Run:

```powershell
rg "sk-|0000238|api key|API key|模型名|网关" output/frontend-concepts-v2
```

Expected: no matches in final image source/manifest except negative explanatory text if intentionally documented.

- [ ] **Step 3: Write manifest**

Create `output/frontend-concepts-v2/manifest.md` listing both style folders, all page slugs, validation result, and design intent.

- [ ] **Step 4: Commit generated assets**

Run:

```powershell
git add -f -- output/frontend-concepts-v2
git commit -m "assets: add v2 big-tech frontend concepts"
```

Expected: source, manifest, and 28 PNG screens are committed.
