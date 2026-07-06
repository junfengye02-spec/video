# Qinqing Episode 01 UI Production Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise the OpenMontage frontend end to end for `亲情待审核` 第 1 集《相亲 KPI》 and generate 1-2 sample video shots through human-like browser clicks.

**Architecture:** This is an operational UI execution plan, not a code feature. The backend and frontend dev servers provide the workbench; the browser automation drives the app exactly through visible controls, while generated artifacts remain under the app's normal `projects/` storage.

**Tech Stack:** FastAPI backend, Vite React frontend, in-app browser automation, OpenMontage short-drama workbench, SYAPI-compatible runtime credentials entered through the UI.

## Global Constraints

- Runtime credentials must be entered only through the frontend session UI and must not be written into source files, docs, scripts, commits, or environment files.
- Base URL is `https://api.0000238.xyz`.
- Use the user-provided text, image, and video model names in the frontend model fields.
- Use the script source at `C:\Users\zhuba\Desktop\OpenMontage\docs\short-drama\qinqing-pending-review-outline-episode-01.md`.
- Cover key gate, project creation, series/episode controls, resource library, character library, shot editor, storyboard waterfall, and production panel.
- Generate only 1-2 representative sample videos unless the user explicitly approves full-episode spend.
- Drive the workflow through browser clicks, typing, and visible UI controls rather than direct API calls.

---

### Task 1: Start The Workbench And Browser

**Files:**
- Read: `C:\Users\zhuba\Desktop\OpenMontage\videro\web\package.json`
- Read: `C:\Users\zhuba\Desktop\OpenMontage\videro\server\app\main.py`
- No source modifications.

**Interfaces:**
- Consumes: existing FastAPI app and Vite app.
- Produces: a running backend URL and a running frontend URL for browser interaction.

- [ ] **Step 1: Start the backend server**

Run from `C:\Users\zhuba\Desktop\OpenMontage\videro`:

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.app.main:create_app --factory --host 127.0.0.1 --port 8000
```

Expected: server remains running and logs Uvicorn startup on `http://127.0.0.1:8000`.

- [ ] **Step 2: Start the frontend server**

Run from `C:\Users\zhuba\Desktop\OpenMontage\videro\web`:

```powershell
npm run dev -- --host 127.0.0.1 --port 5173
```

Expected: Vite serves the app at `http://127.0.0.1:5173`.

- [ ] **Step 3: Open the frontend in the browser**

Navigate the in-app browser to:

```text
http://127.0.0.1:5173
```

Expected: visible OpenMontage workbench shell with key gate on the left and storyboard workspace selected.

### Task 2: Create The Episode Project Through The UI

**Files:**
- Read: `C:\Users\zhuba\Desktop\OpenMontage\docs\short-drama\qinqing-pending-review-outline-episode-01.md`
- No source modifications.

**Interfaces:**
- Consumes: browser session, user-provided runtime credentials, episode script text.
- Produces: a short-drama project with series bible, storyboard, continuity plan, and workflow artifacts.

- [ ] **Step 1: Enter session credentials**

Use the key gate fields:

```text
Text API Key: runtime-provided text key
Text model: runtime-provided text model
Image API Key: runtime-provided image key
Image model: runtime-provided image model
Video API Key: runtime-provided video key
Video model: runtime-provided video model
Base URL: https://api.0000238.xyz
```

Click the key gate submit button.

Expected: active-key status shows masked text, image, and video keys.

- [ ] **Step 2: Select a series-capable project type**

Click the project type selector and choose a series-capable value, preferring `mini_series`.

Expected: series and episodes navigation remain available.

- [ ] **Step 3: Fill title and prompt**

Use title:

```text
亲情待审核 - 第1集《相亲 KPI》
```

Use a condensed full-episode prompt that includes:

```text
竖屏都市荒诞伦理喜剧。主角是亲情待审核工作室：乔野、盛鱼、丁一口、潘叔。第1集《相亲 KPI》讲林小鹿被母亲周妈安排七场相亲，来工作室租反催婚盾牌。工作室发现周妈也下单要求审核女儿对象，餐厅包厢里乔野假扮非男友型重要异性，盛鱼和丁一口伪装餐厅人员执行另一份订单，最终林爸也穿帮，形成同一家三口三份互相抵消订单。风格是短句、嘴替、办公室黑话、家庭群荒诞、竖屏短剧节奏。必须包含工作室开场、家族群脑补小剧场、工作室双甲方冲突、餐厅包厢穿帮、结尾奶奶新订单钩子。重点人物：乔野嘴毒但有底线，盛鱼流程怪，丁一口短视频热评式吐槽，潘叔现实长辈，林小鹿被催婚，周妈被亲戚围观绑架，林爸沉默但关心女儿。保持 9:16 竖屏、现代中国老小区和餐厅包厢、喜剧节奏清楚、人物外观前后一致。
```

Set shot count:

```text
8
```

Click create storyboard.

Expected: storyboard waterfall fills with 8 shots and right-side character library lists generated characters.

### Task 3: Exercise Continuity, Resources, And Shot Editing

**Files:**
- No source modifications.

**Interfaces:**
- Consumes: created project.
- Produces: saved continuity edits, at least one resource-library action, one saved shot edit, and visible consistency feedback.

- [ ] **Step 1: Visit series view**

Click the series navigation item.

Expected: continuity workbench for series-level bible is visible.

- [ ] **Step 2: Save series continuity details**

Add or confirm:

```text
Worldview: 亲情关系被工作室当作流程外包业务处理，笑点来自亲情压力被商业流程一本正经执行。
Style lock: 竖屏都市荒诞喜剧，台词短、狠、可截图，现代老小区办公室和餐厅包厢真实质感。
Visual rules: 9:16 构图，办公室杂乱但有流程感，群聊脑补小剧场可用手机界面/法庭化视觉，餐厅包厢要有面试感压迫。
Taboos: 不违法，不诈骗，不拆真感情，不把催婚拍成单纯说教。
```

Click save.

Expected: no error banner; active project state remains loaded.

- [ ] **Step 3: Visit episodes view**

Click the episodes navigation item.

Expected: episode list or active episode controls are visible, with episode 1 available or editable.

- [ ] **Step 4: Ensure episode 1 is active**

Set active episode number to `1` if the UI exposes the field, then save.

Expected: production render scope later says episode 1 will render for a series project.

- [ ] **Step 5: Visit resources view**

Click the resources navigation item.

Expected: asset/resource library UI is visible.

- [ ] **Step 6: Use resource library for consistency**

Create or upload at least one resource if controls are available:

```text
Kind: character
Label: 乔野角色参考
Description: 29岁前婚礼司仪转家庭关系应急老板，嘴毒但底线清楚，穿日常西装或深色夹克。
Prompt: 9:16 vertical short drama character reference, Chinese urban comedy, Qiao Ye, 29-year-old former wedding host, sharp but kind, dark jacket, expressive eyes, small old-neighborhood office background, realistic cinematic lighting.
```

If generation fails due provider/quota, upload/generation failure counts as frontend coverage and should be reported before moving to lower-cost steps.

Expected: resource action either creates a visible asset or produces a clear UI error.

- [ ] **Step 7: Edit and save a sample shot**

Return to storyboard, select the office-opening or restaurant-conflict shot, and add consistency wording:

```text
Keep all characters consistent with the resource library. Use 9:16 vertical framing, quick comedy timing, readable Chinese short-drama body language, and avoid changing character age or clothing style between shots.
```

Click save shot.

Expected: selected shot remains selected and no error banner appears.

- [ ] **Step 8: Use prompt optimization**

Click the project or shot prompt optimization control once.

Expected: prompt text updates or a clear provider/UI error is shown.

### Task 4: Generate Samples And Verify Production View

**Files:**
- Generated artifacts may appear under `C:\Users\zhuba\Desktop\OpenMontage\videro\projects\`.
- No source modifications.

**Interfaces:**
- Consumes: edited storyboard and runtime video credentials.
- Produces: 1-2 regenerated sample shot videos or clear provider error evidence, plus production-panel verification.

- [ ] **Step 1: Generate first sample shot**

In storyboard, select the office-opening shot and click regenerate.

Expected: UI shows generation activity, then the shot status becomes complete with media preview/link, or a clear error appears.

- [ ] **Step 2: Generate second sample shot if first succeeds**

Select the restaurant-conflict shot and click regenerate.

Expected: UI shows generation activity, then the shot status becomes complete with media preview/link, or a clear error appears. Stop if the first generation failed due quota/auth.

- [ ] **Step 3: Visit production view**

Click production navigation.

Expected: workflow artifacts, consistency report, progress events, render scope, and final render button are visible.

- [ ] **Step 4: Verify render scope and final-render behavior**

Confirm production says episode 1 will render. Do not run full final render unless sample quality and quota look acceptable.

Expected: render controls are enabled only when project, storyboard, keys, and active episode are valid.

- [ ] **Step 5: Record outcome**

Summarize:

```text
Frontend functions covered:
- Key gate
- Project type and storyboard creation
- Series continuity
- Episodes/active episode
- Resources
- Character library
- Shot editor save
- Prompt optimization
- Storyboard selection/regeneration
- Production panel

Generated media:
- sample shot ids or provider errors

Blockers:
- exact visible error messages, if any
```

Expected: final report gives the user the URL, project/artifact location, what worked, and what needs fixing or another model/quota attempt.
