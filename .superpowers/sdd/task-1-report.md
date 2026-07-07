# Task 1 Report: Backend Selector Inputs

## What I implemented

I added project-scoped reference image resolution for shot regeneration and wired `run_single_shot_generation()` through a new `build_video_selector_inputs()` helper. The runner now gathers reference images from the selected shot's saved `asset_ids`, resolves only existing image files inside the project directory, deduplicates them, and truncates the list to three images so it stays within `SyapiVideo._collect_images()` limits.

When reference images are found, the video selector now receives `operation: "reference_to_video"` plus `reference_image_paths`; otherwise it keeps using `text_to_video`. I also updated the runtime event text to include the selected mode and reference-image count, and extended the return payload with `operation` and `reference_image_paths`.

## Tests and results

I added the two regression tests from the brief to `server/tests/test_openmontage_runner.py`.

Verification:
- Focused red command: failed as expected with 2 failing assertions.
- Focused green command: 4 passed.
- Full file verification: 10 passed.
- `git diff --check`: clean.

## TDD Evidence

RED command summary:
`python -m pytest server/tests/test_openmontage_runner.py::test_run_single_shot_generation_uses_reference_to_video_when_asset_images_exist server/tests/test_openmontage_runner.py::test_run_single_shot_generation_keeps_text_to_video_without_existing_reference_images -q`

Output summary: both tests failed for the expected missing behavior. The first assertion showed the selector still used `text_to_video` instead of `reference_to_video`; the second showed the result payload did not yet include `operation`.

GREEN command summary:
`python -m pytest server/tests/test_openmontage_runner.py::test_run_single_shot_generation_passes_video_model_and_key server/tests/test_openmontage_runner.py::test_run_single_shot_generation_uses_reference_to_video_when_asset_images_exist server/tests/test_openmontage_runner.py::test_run_single_shot_generation_keeps_text_to_video_without_existing_reference_images server/tests/test_openmontage_runner.py::test_run_single_shot_generation_prompt_includes_shot_language_and_asset_references -q`

Output summary: `4 passed in 0.07s`.

## Files changed

- `server/app/openmontage_runner.py`
- `server/tests/test_openmontage_runner.py`

## Self-review findings

- The reference-image resolver only accepts `.png`, `.jpg`, `.jpeg`, and `.webp`, matching the task brief.
- Path resolution is restricted to files that exist under the project directory; missing paths and paths outside the project root are ignored.
- The selector input now changes mode only when at least one valid reference image is found.
- The return payload mirrors the selected selector mode so downstream code can inspect the path taken.

## Concerns

None beyond the expected dependency on the selector's existing three-image input cap. The implementation intentionally leaves unrelated runner behavior unchanged.
