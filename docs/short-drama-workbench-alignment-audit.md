# Short Drama Workbench Alignment Audit

Date: 2026-07-03

## Resolution Plan

Implementation plan: `docs/superpowers/plans/2026-07-03-short-drama-workbench-alignment.md`

Resolution status:
- Shot language: implemented across Tasks 1, 2, 3, 9, 10, 11.
- Reference assets in generation: implemented across Tasks 3 and 5.
- Real shot regeneration: implemented in Task 4.
- Save vs regenerate separation: implemented in Task 4.
- Artifact freshness: implemented in Task 5.
- Key validation: implemented in Task 6.
- Live progress: implemented in Task 7.
- Model-backed storyboard creation: implemented in Task 2.
- Character ID UI: implemented in Task 9.
- Render reload: implemented in Task 8.
- Asset `shot_ids` sync: implemented in Task 5.
- Render key requirements: implemented in Task 8.
- Consistency scope: implemented in Task 10.

## Current Production Contract

This audit records the current resolved behavior of the short-drama Workbench after the alignment plan landed. The Workbench now documents and implements a single production contract across the API, persisted artifacts, and web UI.

### 1. Storyboards Are Model-Backed

`/api/projects/short-drama` creates the initial storyboard through the selected text model instead of falling back to a deterministic mock storyboard. The returned storyboard is part of the real project state and seeds downstream workflow artifacts.

### 2. Storyboard Shots Preserve Structured Shot Language

Workbench shots now carry shot intent and structured shot-language fields, including shot size, camera movement, lens, depth of field, lighting, and color temperature. Those fields are preserved in saved shot metadata, carried into generated artifacts, and available to prompt-building for downstream video generation.

### 3. Shot Saves And Shot Regeneration Are Separate Operations

Saving a shot updates shot metadata and refreshes dependent workflow artifacts without pretending that a new video was generated. Regenerating a shot is a distinct operation that requires the selected video provider inputs and produces a new single-shot generation attempt with its own status and outputs.

### 4. Video Prompts Are Asset-Aware

When a shot is regenerated or rendered, the selected video model receives a prompt built from the current shot data plus any bound character, scene, and prop references. Reference bindings are therefore part of the actual generation path rather than a UI-only annotation.

### 5. Workflow Artifacts Stay Fresh After Edits

Shot saves, shot regeneration, and asset-link updates rewrite the dependent workflow artifacts so the Production timeline reflects current project state rather than stale handoff files from project creation time.

### 6. Provider Keys Are Really Validated

The session key flow validates the supplied provider information against the requested models instead of blindly acknowledging any submitted value. Validation failures are surfaced back to the client so the key gate reflects real provider readiness.

### 7. Production Progress Streams Live

The Production panel consumes the backend event stream and shows live job progress while generation and render work are in flight. Progress is no longer limited to a final response event appended after the fact.

### 8. Project Reload Restores Render State

Project reload returns the latest render report and final output path when they exist, allowing the Production view to restore the current render result after refresh or reopen instead of showing only artifact-file presence.

### 9. Asset-To-Shot Links Stay In Sync

The Workbench keeps `shot.asset_ids` and asset `shot_ids` synchronized so shot bindings are represented consistently in the storyboard, asset library, and rewritten handoff artifacts.

### 10. Render Uses The Keys It Actually Needs

Final render follows the current production path requirements and no longer blocks on unrelated text or image provider keys when only the video provider is required for the render path being executed.

### 11. Consistency Checks Cover The Workbench Contract

Consistency evaluation now extends beyond character and style drift checks to include Workbench-specific production controls such as structured shot language and asset-binding validity, so the reported score reflects the actual contract users rely on in the Production view.

## Summary

The short-drama Workbench now behaves as a production-aligned OpenMontage surface: storyboard creation is model-backed, shot language is structured and preserved, generation prompts use bound reference assets, save and regenerate have separate semantics, workflow artifacts stay current, key validation is real, progress updates stream live, render state survives reload, asset linkages stay synchronized, render key requirements match actual execution, and consistency reporting covers the real operational contract.
