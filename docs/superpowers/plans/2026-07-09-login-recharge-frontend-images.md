# Login Recharge Frontend Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate six complete frontend concept images for the login-and-recharge OpenMontage product flow.

**Architecture:** This is an asset-generation task, not a code change. The output is a set of image files saved under `output/frontend-concepts/`, plus a manifest documenting prompts, filenames, and validation notes.

**Tech Stack:** Image generation API or built-in image generation capability, local filesystem, Markdown manifest.

## Global Constraints

- Do not modify the current React/Vite frontend.
- Do not expose real API keys, gateway URLs, provider names, or model settings in images.
- Use Chinese UI copy for normal users.
- Visual style: clear SaaS plus light cinematic feel, white background, soft teal primary color, dark ink text, minimal warm accent.
- Cards should use radius 8px or less.
- Images should represent desktop 1440px product screens.
- Output directory: `output/frontend-concepts/`.

---

### Task 1: Prepare Output Folder And Prompt Set

**Files:**
- Create: `output/frontend-concepts/prompts.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-09-login-recharge-frontend-images-design.md`
- Produces: six named prompt specs used by image generation.

- [ ] **Step 1: Create the output folder**

Run: `New-Item -ItemType Directory -Force output/frontend-concepts`

Expected: the directory exists.

- [ ] **Step 2: Write six prompt specs**

Create `output/frontend-concepts/prompts.md` containing prompt sections for:

```text
login-register
wallet-plans
create-home
storyboard-workbench
asset-library
render-download
```

Each prompt must include: use case `ui-mockup`, desktop aspect, Chinese UI copy, clean SaaS plus light cinematic feel, and a constraint to avoid API keys, model names, gateway URLs, provider names, watermarks, browser chrome, and marketing landing-page composition.

- [ ] **Step 3: Commit the prompt set**

Run:

```powershell
git add -- output/frontend-concepts/prompts.md
git commit -m "docs: add frontend image prompt set"
```

Expected: only `prompts.md` is committed.

### Task 2: Generate The Six Concept Images

**Files:**
- Create: `output/frontend-concepts/login-register.png`
- Create: `output/frontend-concepts/wallet-plans.png`
- Create: `output/frontend-concepts/create-home.png`
- Create: `output/frontend-concepts/storyboard-workbench.png`
- Create: `output/frontend-concepts/asset-library.png`
- Create: `output/frontend-concepts/render-download.png`

**Interfaces:**
- Consumes: `output/frontend-concepts/prompts.md`
- Produces: six PNG image assets for review.

- [ ] **Step 1: Generate `login-register.png`**

Use the `login-register` prompt. Expected: a complete login/register screen with product preview and no technical key fields.

- [ ] **Step 2: Generate `wallet-plans.png`**

Use the `wallet-plans` prompt. Expected: balance, packages, estimated generation counts, and recharge call to action.

- [ ] **Step 3: Generate `create-home.png`**

Use the `create-home` prompt. Expected: story idea input, project type, duration, style, and generate storyboard action.

- [ ] **Step 4: Generate `storyboard-workbench.png`**

Use the `storyboard-workbench` prompt. Expected: shot list, current shot preview/editor, character/progress side panel, advanced controls hidden.

- [ ] **Step 5: Generate `asset-library.png`**

Use the `asset-library` prompt. Expected: upload controls, asset categories, character reference cards, and lock-consistency hint.

- [ ] **Step 6: Generate `render-download.png`**

Use the `render-download` prompt. Expected: video preview, four-step progress, credit consumption, download, and continue editing.

### Task 3: Validate And Document Outputs

**Files:**
- Create: `output/frontend-concepts/manifest.md`

**Interfaces:**
- Consumes: six generated PNG files.
- Produces: a review manifest with file paths and validation notes.

- [ ] **Step 1: Inspect each image**

Check that each image:

```text
shows a full desktop product screen
uses Chinese beginner-friendly UI copy
does not show API keys, model names, provider names, or gateway URLs
uses a clean, comfortable style
matches its page purpose
```

- [ ] **Step 2: Write the manifest**

Create `output/frontend-concepts/manifest.md` with:

```markdown
# OpenMontage Frontend Concept Images

- login-register.png: validation notes
- wallet-plans.png: validation notes
- create-home.png: validation notes
- storyboard-workbench.png: validation notes
- asset-library.png: validation notes
- render-download.png: validation notes
```

- [ ] **Step 3: Commit generated assets and manifest**

Run:

```powershell
git add -- output/frontend-concepts
git commit -m "assets: add login recharge frontend concepts"
```

Expected: six PNGs, `prompts.md`, and `manifest.md` are committed unless `prompts.md` was already committed in Task 1.
