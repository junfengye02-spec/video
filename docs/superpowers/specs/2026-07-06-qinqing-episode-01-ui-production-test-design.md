# 亲情待审核第 1 集前端全流程制作测试设计

Date: 2026-07-06

## Goal

Use the OpenMontage frontend as a human operator would to create and test the first episode of `亲情待审核` (`相亲 KPI`) from the supplied outline and script. The run should cover the full short-drama workbench surface, not only generate a video sample.

The production target is sample-first: create a full project and exercise every major frontend function, then generate 1-2 representative video sample shots before deciding whether to spend quota on a full-episode render.

## Source Material

- Script source: `C:\Users\zhuba\Desktop\OpenMontage\docs\short-drama\qinqing-pending-review-outline-episode-01.md`
- Episode: 第 1 集《相亲 KPI》
- Format: vertical short drama, urban absurd family comedy
- Primary locations: 亲情待审核工作室, 竖屏家族群脑补小剧场, 餐厅包厢
- Core characters: 乔野, 盛鱼, 丁一口, 潘叔, 林小鹿, 周妈, 林爸

## Runtime Credentials

The user provided runtime credentials for text, image, and video generation plus a gateway base URL. These credentials must be entered only through the frontend session UI and must not be written into source files, docs, scripts, commits, or environment files.

The visible, non-secret runtime choices are:

- Base URL: `https://api.0000238.xyz`
- Text model: user-provided gateway text model
- Image model: user-provided gateway image model
- Video model: user-provided gateway video model

## Frontend Surfaces To Cover

1. Key gate
   - Enter base URL, text key, image key, video key, and model names.
   - Submit through the UI and confirm masked active-key status.

2. Project creation
   - Use the storyboard view.
   - Choose a series-capable project type so the series and episode controls are available.
   - Set title to `亲情待审核 - 第1集《相亲 KPI》`.
   - Paste a condensed but complete prompt derived from the supplied episode script.
   - Set a small shot count for controllable testing, initially 6-8 shots.

3. Series and episode controls
   - Visit the series view and verify the continuity plan can be edited/saved.
   - Visit the episodes view and verify active episode state is visible/editable.
   - Ensure episode 1 is the active production episode before render-related operations.

4. Resource library
   - Use the resources view to create or upload at least one character reference, one scene reference, and one prop/reference concept where the UI supports it.
   - Use generated or uploaded references to improve consistency across characters and locations.

5. Character library
   - Confirm generated characters appear in the right-side character library.
   - Use the library as a consistency check while selecting/editing shots.

6. Shot editor
   - Select several shots from the storyboard waterfall.
   - Edit at least one shot prompt for better comedy timing, vertical framing, and character consistency.
   - Save the shot through the UI.
   - Use prompt optimization on the project or a shot where available.

7. Storyboard waterfall
   - Select shots, verify statuses, and use the regenerate action on selected sample shots.
   - Prefer one office-opening shot and one restaurant-conflict shot for video samples.

8. Production panel
   - Visit production after sample generation.
   - Verify workflow artifacts, consistency report, progress events, render-scope messaging, final-render controls, and preview/download behavior if a final render is attempted.
   - For this sample-first run, full final render is optional and should only be run if sample cost and quality look acceptable.

## Production Approach

Recommended approach: UI-driven full workflow smoke run with sample video generation.

1. Start backend and frontend dev servers.
2. Open the frontend in the browser.
3. Use browser automation only for human-like clicks, typing, selection, and form submission.
4. Generate storyboard from the episode script.
5. Exercise resource, continuity, shot-editing, optimization, regeneration, and production views.
6. Generate 1-2 sample videos rather than the full episode.
7. Inspect visible UI state and downloaded/previewed media paths.

This approach tests the frontend honestly while limiting quota exposure.

## Alternatives Considered

Direct API generation:
Fast and scriptable, but it would not test the frontend workflow the user asked to validate.

Immediate full-episode render:
Best for end-to-end deliverable confidence, but expensive and risky before checking character consistency and clip quality.

Manual-only UI operation:
Closest to a human session, but slower and less reproducible than browser automation.

## Error Handling

- If key validation or generation fails, report the exact UI-visible error and classify it as credential, provider quota, model incompatibility, backend failure, or frontend bug.
- If a video generation call fails for quota or provider reasons, stop before attempting additional costly generations.
- If render is disabled because active episode is missing, fix it through the episode/continuity UI before retesting production.
- If generated characters or scene references are inconsistent, use the resource library and shot editor to tighten prompts before regenerating.

## Testing Evidence

Collect evidence from:

- Browser-visible UI state after each major action.
- Backend/frontend terminal output when a server error occurs.
- Generated project artifacts in `projects/`.
- Sample video preview or media URL in the production/storyboard UI.

## Out Of Scope

- Persisting API keys to repository files or `.env`.
- Full first-season continuity authoring beyond what is needed to test the current UI.
- Refactoring frontend or backend code unless a blocker prevents the UI flow from completing.
- Running all possible model/provider combinations.
