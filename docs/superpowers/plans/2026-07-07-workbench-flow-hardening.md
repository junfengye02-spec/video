# Workbench Flow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining short-drama Workbench flow mismatches after the image-to-video path was repaired.

**Architecture:** Keep the intentional SYAPI gateway binding. Make the Workbench artifacts match the actual FFmpeg render path, make final composition tolerate mixed generated/uploaded clips, write render reports from actual output metadata when available, and refresh frontend state after backend artifact rewrites.

**Tech Stack:** FastAPI backend, pytest, React/Vite frontend, Vitest, FFmpeg/ffprobe.

## Global Constraints

- Do not undo or overwrite the image-to-video changes in `server/app/openmontage_runner.py`.
- Treat fixed SYAPI provider/base URL routing as an intentional product requirement.
- Use TDD for behavior changes.
- Keep edits scoped to Workbench flow and tests.

---

### Task 1: Pipeline Artifact Runtime And Continuity

**Files:**
- Modify: `server/app/openmontage_runner.py`
- Modify: `server/app/main.py`
- Test: `server/tests/test_openmontage_runner.py`
- Test: `server/tests/test_api.py`

- [x] Add failing tests that `build_pipeline_inputs(..., continuity_plan=...)` preserves continuity and Workbench artifacts use `ffmpeg`.
- [x] Restore `continuity_plan` as an explicit keyword-safe parameter.
- [x] Verify `render_runtime="ffmpeg"` is preserved from Workbench artifact sync paths where required.
- [x] Run targeted backend tests.

### Task 2: Robust Final Composition

**Files:**
- Modify: `server/app/openmontage_runner.py`
- Test: `server/tests/test_openmontage_runner.py`

- [x] Add failing tests proving final composition no longer uses FFmpeg concat copy mode.
- [x] Build FFmpeg commands with one `-i` per clip, a video filter graph that scales/pads to `720x1280`, and H.264 output.
- [x] Keep project-path safety checks.
- [x] Run targeted backend tests.

### Task 3: Render Report From Actual Output Metadata

**Files:**
- Modify: `server/app/openmontage_runner.py`
- Test: `server/tests/test_openmontage_runner.py`

- [x] Add failing tests for render report duration/resolution using probed output data.
- [x] Reuse `tools.video._shared.probe_output` and fall back to previous assumptions when ffprobe data is unavailable.
- [x] Return reused shot videos in render outputs so API results match the actual compose inputs.
- [x] Run targeted backend tests.

### Task 4: Frontend Workflow State Refresh

**Files:**
- Inspect: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

- [x] Verify reference image upload and continuity save handlers refresh the project snapshot after artifact rewrites.
- [x] Confirm current `App.tsx` refreshes state after upload and continuity save so stale artifacts/media are not shown.
- [x] Run targeted frontend tests.

### Task 5: Documentation And Full Verification

**Files:**
- Modify: `docs/short-drama-workbench-alignment-audit.md`

- [x] Mark fixed items in the audit follow-up.
- [x] Run `python -m pytest server/tests -q`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
