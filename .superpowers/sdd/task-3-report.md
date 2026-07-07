## What you implemented

- Added frontend copy for text-to-video and image-to-video mode status in English and Chinese.
- Extended `ShotEditor` to track selected asset bindings locally, display a live generation-mode status badge, and expose a regenerate action that saves current edits before calling regenerate.
- Added reference-asset checkbox UI in `ShotEditor` so saved `asset_ids` can be updated from the editor before regeneration.
- Added a focused App behavior test covering mode-status copy, asset selection, and save-before-regenerate call ordering.
- Added the minimal App wiring needed to pass asset records and regenerate state into `ShotEditor`.

## Tests and results

- `npm.cmd test -- src/App.test.tsx` from `C:\Users\zhuba\Desktop\OpenMontage\videro-image-to-video-shot-generation\web`
- Result: PASS, `22` tests passed in `src/App.test.tsx`

## TDD Evidence

- RED command: `npm.cmd test -- src/App.test.tsx`
- RED summary: `1` test failed, `21` passed. Failure was the new behavior test because the UI did not yet render `Text-to-video: no saved reference image selected`.
- GREEN command: `npm.cmd test -- src/App.test.tsx`
- GREEN summary: `22` tests passed, exit code `0`.

## Files changed

- `web/src/App.test.tsx`
- `web/src/App.tsx`
- `web/src/components/ShotEditor.tsx`
- `web/src/i18n.ts`
- `web/src/styles.css`

## Self-review findings

- The save-before-regenerate flow now uses the editor’s current local state to build the save payload, so regenerate cannot run against stale prompt/character/location/prop/asset selections.
- The generation-mode status is derived from selected asset records’ `reference_images`, keeping the displayed mode aligned with the backend reference-image contract.
- Existing focused App tests remain green after adding the new asset checkbox surface.

## Concerns

- The current checkout did not yet pass asset records or regenerate controls into `ShotEditor`, so I made one minimal supporting edit in `web/src/App.tsx` even though the original task ownership list named four primary frontend files.

## Fix report update

- Save failures now rethrow from `handleSaveShot`, so the regenerate path stops before calling `onRegenerateShot` when the save step fails.
- `ShotEditor` now catches save failures on the standalone Save button to avoid an unhandled rejection while preserving the existing error banner behavior.
- The hardcoded `Reference assets` and `No saved reference assets yet.` copy now comes from i18n in both English and Chinese.

## TDD evidence for this follow-up

- RED command: `npm.cmd test -- src/App.test.tsx`
- RED summary: `1` test failed, `22` passed. The new regression test failed because the save-before-regenerate flow still advanced past a rejected save.
- GREEN command: `npm.cmd test -- src/App.test.tsx`
- GREEN summary: `23` tests passed, exit code `0`.
