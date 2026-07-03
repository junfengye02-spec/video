# Short Drama Workbench Alignment Audit

Date: 2026-07-02

## Resolution Plan

Implementation plan: `docs/superpowers/plans/2026-07-03-short-drama-workbench-alignment.md`

Resolution status:
- Shot language: planned in Tasks 1, 2, 3, 9, 10, 11.
- Reference assets in generation: planned in Tasks 3 and 5.
- Real shot regeneration: planned in Task 4.
- Save vs regenerate separation: planned in Task 4.
- Artifact freshness: planned in Task 5.
- Key validation: planned in Task 6.
- Live progress: planned in Task 7.
- Model-backed storyboard creation: planned in Task 2.
- Character ID UI: planned in Task 9.
- Render reload: planned in Task 8.
- Asset `shot_ids` sync: planned in Task 5.
- Render key requirements: planned in Task 8.
- Consistency scope: planned in Task 10.

## Confirmed Finding: Shot Language Gap

The lower-level OpenMontage pipeline already has a structured shot-language system, but the short-drama Workbench does not currently expose or preserve it in the storyboard layer.

- `schemas/artifacts/scene_plan.schema.json` supports `shot_language` with `shot_size`, `camera_movement`, `lens_mm`, `lighting_key`, `depth_of_field`, and `color_temperature`.
- `lib/shot_prompt_builder.py` can turn structured shot-language fields into provider-friendly generation prompts.
- `server/app/models.py` and `web/src/domain/types.ts` define Workbench `Shot` without `shot_language` or `shot_intent`.
- `/api/projects/short-drama` currently creates a deterministic mock storyboard through `build_mock_short_drama()` rather than asking the text model to generate structured storyboard shots.
- `server/app/prompt_optimizer.py` uses the text model only for prompt rewriting. Its prompt mentions clearer emotion, visual locks, and shot intent, but it does not ask for structured shot-language JSON.
- `server/app/openmontage_runner.py` maps Workbench shots into `scene_plan` with generic `framing` and `movement` strings, but does not write `shot_language` or call `build_shot_prompt()`.

Impact: shot size, camera movement, lens choice, depth of field, and other cinematography controls exist in the pipeline but are effectively lost in the current Workbench UI/API path.

## Additional Frontend/Backend Alignment Findings

### 1. Reference Assets Do Not Reach Actual Video Generation

Frontend behavior:

- `ShotEditor` lets users bind character, scene, and prop reference assets to a shot through `asset_ids`.
- `updateShot()` posts those `asset_ids` to `/api/projects/{project_id}/shots/{shot_id}/regenerate`.

Backend behavior:

- `regenerate_mock_shot()` persists `asset_ids` on the storyboard shot.
- `build_pipeline_inputs()` includes asset reference image paths in the generated artifact prompt when it has `series_bible.assets`.
- However, `run_single_shot_generation()` calls `compile_shot_prompt()` without an `asset_lookup`, so the real `VideoSelector` prompt used during final render omits the selected reference assets.

Impact: the UI suggests reference binding controls generation, but selected references are not included in the actual video-generation prompt.

### 2. Shot Regeneration Does Not Generate Shot Video

Frontend behavior:

- The UI exposes "Regenerate selected shot" and sends `video_key`, `base_url`, and `video_model`.

Backend behavior:

- `/api/projects/{project_id}/shots/{shot_id}/regenerate` calls `regenerate_mock_shot()` only.
- It updates prompt/version/history/status, but does not call `run_single_shot_generation()`.
- The supplied `video_model` is not used for generation in this route.

Impact: the button reads like a generation action, but it currently edits mock storyboard data rather than producing a new shot video.

### 3. Save Shot And Regenerate Shot Share The Same Backend Operation

Frontend behavior:

- `Save shot` and `Regenerate selected shot` are separate controls.

Backend behavior:

- Both paths post to the same `/shots/{shot_id}/regenerate` endpoint.
- Saving fields increments version/history and emits a `regenerate` event.

Impact: a plain metadata save is treated as a regeneration in backend history/events, which makes revision history less semantically accurate.

### 4. Workflow Timeline Can Show Stale Artifacts As Ready

Frontend behavior:

- The Production view shows workflow artifact readiness from `proposal_packet`, `scene_plan`, `asset_manifest`, `edit_decisions`, and `render_report` file existence.

Backend behavior:

- Initial project creation writes pipeline artifacts.
- Asset generation updates `series_bible` and `asset_library`, but does not rewrite `scene_plan` or `asset_manifest`.
- Shot edits update `episode_storyboard`, but do not rewrite the handoff artifacts until final render.

Impact: the workflow panel can show ready artifacts even when those JSON files no longer represent the current storyboard/assets.

### 5. Key Gate Does Not Actually Validate Keys

Frontend behavior:

- The key form shows a "Checking" state and fallback copy for failed validation.

Backend behavior:

- `/api/session/key` masks keys, stores no persistent session, and always returns `valid: true`.
- It only derives environment names from the video key/base URL; it does not call text, image, or video providers.

Impact: the UI implies provider validation, but the backend only acknowledges supplied values.

### 6. Progress UI Does Not Consume Backend Event Stream

Frontend behavior:

- The Production view includes a Job Progress panel.

Backend behavior:

- The backend exposes `/api/projects/{project_id}/events` as server-sent events and emits multiple render-stage events.
- The frontend does not open an `EventSource`; it only appends the final event returned by request responses.

Impact: progress exists in the backend, but the UI cannot show live render/generation progress.

### 7. Create Storyboard Sends Model Choices That Are Mostly Ignored

Frontend behavior:

- Creating a storyboard requires text, image, and video keys and sends `text_model`, `image_model`, and `video_model`.

Backend behavior:

- `/api/projects/short-drama` calls `build_mock_short_drama()`.
- It does not use the text model to create the storyboard and does not use the image model.
- The video model is only used when writing initial handoff artifacts through `build_pipeline_inputs()`, not to generate storyboard content.

Impact: the first storyboard appears model-backed from the UI, but it is deterministic mock content.

### 8. Character Editing Uses Raw IDs While UI Labels Them As Characters

Frontend behavior:

- `ShotEditor` exposes a free-text "Characters" field.

Backend behavior:

- Consistency checks expect entries to be character IDs matching `series_bible.characters[*].id`.

Impact: users may type names instead of IDs, causing unknown-character consistency warnings or broken character locks.

### 9. Render Results Are Not Restored On Project Reload

Frontend behavior:

- The Production view can show `finalPath` after a successful render.
- `refreshProjectState()` reloads project, series bible, storyboard, consistency report, and workflow artifacts.

Backend behavior:

- `/api/projects/{project_id}/render` returns `final_path` and `render_report`.
- `/api/projects/{project_id}` does not return `render_report` or `final_path`, even if `render_report.json` exists.

Impact: after reload or refresh, the workflow can show `render_report` as ready, but the UI cannot restore the final video path.

### 10. Asset `shot_ids` Are Not Kept In Sync With Shot Bindings

Frontend/data model behavior:

- `AssetRecord` includes `shot_ids`.
- `Shot` includes `asset_ids`.

Backend behavior:

- Generated assets start with `shot_ids: []`.
- Updating a shot persists `shot.asset_ids`, but does not update matching assets' `shot_ids` in `asset_library.json` or `series_bible.assets`.

Impact: asset-to-shot linkage is one-way only. Any UI that reads `asset.shot_ids` will become stale or misleading.

### 11. Render Requires Text/Image Keys Though Only Video Key Is Used

Frontend/backend request behavior:

- Rendering requires `text_key`, `image_key`, and `video_key`.
- `RenderProjectRequest` includes all three keys and model choices.

Backend behavior:

- `render_short_drama_project()` only uses `video_key`, `base_url`, and `video_model` for `VideoSelector`.
- Text and image keys are unused during render.

Impact: users are blocked from rendering if they lack text/image keys, even though final render currently only needs the video provider.

### 12. Consistency Score Covers A Narrower Contract Than The UI Implies

Frontend behavior:

- The Production view presents a general "Consistency" score.

Backend behavior:

- `evaluate_storyboard_consistency()` checks character IDs, visual-lock text presence, location, aspect-ratio drift, and visual-style drift.
- It does not check shot-language completeness, asset binding validity, stale artifacts, or whether selected reference images reached generation prompts.

Impact: the score can look clean while important production controls are missing or disconnected.
