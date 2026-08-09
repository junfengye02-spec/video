# Shot first/tail-frame continuity closure record

Date: 2026-07-20  
Workspace: `C:\Users\zhuba\Desktop\OpenMontage\videro`

## Outcome

Adjacent shots can now carry a locally extracted tail frame into the next shot when, and only when,
the storyboard explicitly declares continuous action. User-selected or uploaded first frames always
win. Hard cuts, temporal/spatial jumps, and disabled carry remain cuts.

The default path does not generate still images. It extracts the last valid non-black decodable frame
from the current video locally, registers it as an opaque `MediaAsset`, and costs zero provider units.
AI image generation remains an explicit single-image fallback behind the existing independent image
quote and retry contract.

## Persisted contract

Shot continuity now persists and round-trips:

- `mode`: `carry | cut | match_cut`
- `inherit_previous_tail`
- `explicit_user_first_frame_asset_id`
- `inherited_first_frame_asset_id`
- `last_frame_asset_id`
- typed first/tail frame references with source, status, version, generation job, and origin versions
- continuity locks for composition, subject pose, gaze, motion direction, lighting, and scene state
- stale state without deleting older media

`MediaAsset` supports `source_type=video_frame` with source shot, video version, media SHA-256,
sample time, and ready/stale status. Migration `015_video_frame_assets.py` is applied locally;
`alembic current` reports `015 (head)`.

Import/export validates typed video-frame provenance and browser backups preserve continuity IDs,
opaque local media references, frame media, and Phase 6 `render_report.file_size_bytes` cache facts.

## Resolution and Provider routing

Effective visual input priority is:

1. explicit user first frame (upload or selected project asset);
2. previous shot's current locally extracted video tail, only for explicit carry;
3. ordinary bound character/scene/prop references;
4. explicit one-image AI fallback after an image quote;
5. legal text-to-video when no image is usable.

Production NewAPI currently accepts ordinary `images` for `/v1/videos`; it does not expose a verified
first-frame/tail-frame field contract in this codebase. Its model profiles therefore continue to report
`supports_start_frame=false` and `supports_end_frame=false`. When a required boundary frame is ready,
the request now degrades honestly to `reference_to_video`: the start/end boundary images are placed
first, in temporal order, and the provider prompt assigns each image an explicit start-frame or
end-frame role. The former local three-image default has been removed. Only a verified provider/model
`max_reference_images` contract may impose a count limit; the current NewAPI profile declares no such
limit. Only assets bound to the current shot are considered, never every asset in a long-form project.
Asset selection takes one representative image per bound asset before taking additional views of the
same asset. Each
asset image receives its own indexed, type-specific role: identity only for characters, environment
structure only for scenes, and object appearance only for props. Asset images cannot override boundary
composition or temporal state, and the ambiguous file-path prompt section is removed. The response records
`degraded_from_operation`; it never claims that the provider natively locked either frame.

`image_to_video` or `first_last_frame_to_video` remains selected only for a future provider whose
runtime metadata or schema explicitly declares the corresponding native operation and fields.

The SYAPI tool no longer advertises `image_to_video` or `first_last_frame_to_video`, because its current
implementation can only place images in the generic NewAPI `images` array. Direct attempts to request
those native operations fail locally before HTTP submission.

Generation responses expose `operation`, `referenced_asset_ids`, and legal degradation so the UI and
records do not imply unsupported provider capability. Reference-guided output is probabilistic; frame
assets must still be present and ready before submission, but exact boundary alignment is not promised.

## Local extraction and stale behavior

Tail extraction uses ffprobe duration/fps/dimensions and samples from EOF minus one frame, moving
backward when a frame is black, empty, corrupt, undecodable, or dimensionally invalid. PNG and metadata
are written atomically. Video SHA/version makes repeated extraction idempotent.

After an upstream shot video/version changes:

- the old current tail reference becomes stale;
- downstream inherited first-frame references become stale;
- PostgreSQL and compatibility `asset_library` records become stale;
- old frame files and old videos remain available for recovery;
- an explicit user first frame remains authoritative.

Normal provider publication and provider recovery both invoke the same free tail-frame registration
service. Generation failure preserves the old video, old output URL/path, and old keyframes.

## UI

The storyboard inspector now provides:

- first/tail previews and source labels;
- `cut`, `carry`, and `match_cut` controls;
- explicit carry toggle;
- upload first frame through the existing asset upload path;
- choose an existing resource;
- remove explicit first frame and remove a tail-frame binding without deleting media;
- explicit `AI first frame` and `AI target tail frame` commands;
- fixed one-image generation, independent quote display/retry, duplicate-click lock, focus restoration,
  project-switch stale-response protection, and draft-only updates;
- project aspect-ratio image sizing (`16:9 -> 1536x1024`, `9:16 -> 1024x1536`, `1:1 -> 1024x1024`).

AI-generated keyframes are labeled `AI generated (quoted separately)`, uploaded/selected user images
remain `User image`, and extracted inheritance is labeled free. Opening the AI drawer never generates
or charges; only an explicit submit starts the existing quote flow. Keyframe selection never implicitly
starts video generation.

The keyframe UI was split into `ShotKeyframes.tsx` (363 lines),
`ShotFrameGeneration.tsx` (262 lines), and the reused `AssetGenerationDrawer.tsx` (274 lines).

## Real integration acceptance

### Runtime 422 regression

Project `ea3db1f2b7da46b89a553c6bd56de219`, shot `shot_09` initially returned 422 because the running
8787 process predated the new `continuity` schema. After the backend restart, runtime OpenAPI includes
the complete continuity request field. Phase 6 repeated the same visible UI binding save:

- PATCH returned 200;
- dirty changed to saved and the save button disabled;
- no alert/422 appeared;
- the resource remained selected;
- the binding was then removed and saved again to restore the original project state;
- no video generation ran.

### Existing Phase 6 videos: zero-cost extraction

Project `cf0e8246dbc9419699d02d98699790aa` reused its existing three videos. None was regenerated.
All three original shots were `cut`, so extraction registered tails without inventing inheritance.

| Shot | Video version | Tail asset | Video SHA-256 | Sample time | Cost |
| --- | ---: | --- | --- | ---: | ---: |
| `shot_01` | 1 | `8f58d853d17a4a1a8298d9b45a887391` | `5418f4cf852bfef7c5c4d6367c9faa1cd8447ef571424186ee09207495b82630` | 9.957333 s | 0 |
| `shot_02` | 1 | `af397cc2bc054b41a02fedc63fa5aa3a` | `520da9648946b79b1ba9481343206fa7d4fff7cb1fb27b529573b59bb01e1fb5` | 9.957333 s | 0 |
| `shot_03` | 2 | `458a342ddcef461baf3ac4933bf64811` | `dc69101ea79fd8fb166ebec0a0c6657de2667cd2e145aec4212204b6280a5bca` | 9.957333 s | 0 |

Each frame is 720x1280, non-black, and decoded successfully. Metadata reports 10.0 seconds, 24 fps,
`backtrack_frames=1`, and `provider_cost_units=0`. A second extraction returned the same three asset
IDs with `reused=true`; video-frame asset count remained 3.

Database proof:

- total generation jobs: 57 before, 57 after extraction and UI drawer inspection;
- chargeable generation jobs: 50 before, 50 after extraction;
- active generation jobs at closure: 0;
- no quote, settlement, wallet adjustment, or Provider call was created by this acceptance.

### Visible UI acceptance

The signed-in Phase 6 storyboard visibly showed the extracted tail preview, free source label, and all
three opaque tail assets. The AI first-frame drawer showed scene kind locked, count locked to 1,
`gpt-image-2`, and the correct 16:9 size `1536x1024`. Its prompt preserved subject/scene/light/screen
direction and prohibited direction reversal. The drawer was closed without clicking generation.

Evidence:

- `docs/acceptance/2026-07-20-shot-frame-continuity/phase6-tail-frames-contact-sheet.png`
- `docs/acceptance/2026-07-20-shot-frame-continuity/storyboard-tail-frame-ready-1440.png`
- `docs/acceptance/2026-07-20-shot-frame-continuity/storyboard-ai-first-frame-wide-quote-drawer-1440.png`
- the three full-resolution extracted PNGs in the same directory

## Verification

Targeted continuity/server selection: 46 passed.  
Targeted real-payload and preservation API tests: 3 passed.  
Targeted storyboard/resource/export web set: 164 passed.  
Pre-closure web full suite: 55 files / 762 tests passed.  
Final suite after this record: server 1230 passed / 25 skipped; web 56 files / 763 tests.

Production build before the final gate: 1765 modules, CSS 165.86 kB (27.63 kB gzip), main JS
591.32 kB (176.45 kB gzip). The existing >500 kB chunk warning remains.

Static checks at closure:

- runtime OpenAPI contains `continuity`;
- `transition: all`: 0 matches;
- legacy shell selectors: 0 matches;
- deleted legacy storyboard component references: 0 matches;
- Object URLs are owned/revoked by `MediaRepository`; downloads revoke immediately;
- React replaces changed video URLs; preview, list, and filmstrip nodes pause and remove `src` on unmount;
- no new runtime dependency was introduced;
- `git diff --check` passes.

## Remaining visual risk

Local tail carry improves physical continuity but cannot guarantee identity or geometry when the video
provider only offers general reference conditioning. Native first/tail-frame providers should be
enabled only after their exact production request fields are verified. Intentional cuts remain the
correct choice for the three Phase 6 location changes. No paid visual sample was produced in this
closure, so the remaining provider-conditioned visual variance is recorded rather than hidden.
