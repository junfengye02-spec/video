# Series AI Autocomplete Closure Record

## Scope

This change makes the novice inspiration-to-plan path produce usable continuity for `mini_series`
and `long_series` while preserving `single_video` behavior. It does not change billing, Provider
routing, approval gates, SSE, media recovery, or URL semantics. No new live Provider call or quote
was made; the existing Phase 6 account/media state was left untouched.

## Behavior

- Storyboard planning now carries the authorized `project_type` into the structured request.
- The prompt contract explicitly requests `series_bible.series_prompt`, relationship facts, and a
  `continuity_plan.episodes` array with title, goal, conflict, twist, cliffhanger, inherited state,
  prompt, and outline.
- `mini_series` is normalized to 3-8 episode outlines; `long_series` is normalized to 12-24. Missing
  outlines are padded deterministically so the response remains renderable even when a model omits
  an item. `single_video` emits no episodes or series-only prompt.
- Continuity merge is field-level and fill-only: non-empty user values remain unchanged, locked
  episodes remain unchanged, and unlocked episode fields are filled only when empty. Generated
  episodes are persisted in the existing continuity artifact and remain editable through the normal
  dirty/save/retry flow.
- Inspiration composer drafts are partitioned by project/session key in `sessionStorage`. Failed,
  payment-blocked, duplicate, or interrupted requests retain the draft; successful requests clear
  it. Switching projects and returning restores the correct draft without accepting stale responses.
- Global settings now exposes the series prompt and per-episode outline/prompt. Episode planning UI
  was split into `EpisodePlanningEditor` and `LineListTextarea` so the main editor is 201 lines.

## Key Files

- `server/app/storyboard_generator.py`
- `server/app/inspiration_developer.py`
- `server/app/main.py`
- `server/app/models.py`
- `server/app/projects/schemas.py`
- `web/src/domain/types.ts`
- `web/src/features/workbench/WorkbenchSessionProvider.tsx`
- `web/src/features/inspiration/useInspirationController.ts`
- `web/src/components/continuity/ContinuityEditor.tsx`
- `web/src/components/continuity/EpisodePlanningEditor.tsx`

## Evidence

Targeted server regression: 19 passed, including project-type prompt contracts, 3/12 episode
normalization, fill-only continuity merge, locked episode preservation, and authorized project type
integration. Targeted web regression: 57 passed, including mini/long prompt rendering and save,
duplicate planning lock, failed planning retry, and project-switch draft restoration.

The existing API and ownership suites were also run during implementation (`test_api.py`: 99 passed;
`test_project_ownership.py`: 328 passed, 1 skipped).

Static checks before final gate: `transition: all` 0; legacy migrated selectors 0; shared-to-app/
feature/page reverse imports 0. Existing oversized modules remain documented Phase 6 debt, including
`WorkbenchSessionProvider.tsx` and `server/app/storyboard_generator.py`; this task intentionally
avoids a broad refactor while adding a bounded schema/normalization contract.

## Final Gate

```text
web full: 54 files passed, 750 tests passed
web build: 1763 modules; CSS 163.77 kB (gzip 27.33 kB); JS 573.48 kB (gzip 171.35 kB)
git diff --check: passed with no output
transition: all: 0
legacy migrated selectors: 0
shared reverse dependency imports: 0
```

The final server full run completed with `1205 passed, 25 skipped, 5 failed`. All five failures are
outside this task's files and share one cause in the concurrently modified
`server/app/openmontage_runner.py`: fake `VideoSelector` test doubles without `_providers` raise
`AttributeError` before execution. The failing tests are one atomic-media test and four
`test_openmontage_runner.py` selector tests. This task did not edit or repair that concurrent
first/last-frame/provider work. Series-specific server tests remain green (19 passed), and the API
and ownership suites above passed.

The build retains the existing Rollup warning for a main chunk above 500 kB; this task did not add
route-level code splitting.

## Remaining Risk

Real browser/provider verification for a new mini/long project was not performed because the shared
Phase 6 acceptance session was active and a new series plan would require an additional paid text
Provider call. Existing Phase 6 continuity/dirty/recovery evidence plus the targeted DOM tests cover
the UI behavior without mutating the user's media or billing state.
