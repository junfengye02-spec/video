# Short Drama Workbench Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web workbench where users enter a SYAPI gateway key, chat with an AI production assistant, manage a character/asset library, edit a storyboard waterfall, run consistency checks, regenerate individual shots, and submit jobs through the existing OpenMontage video pipeline.

**Architecture:** Add a thin web app around OpenMontage instead of replacing its pipeline. The frontend owns interaction state and review UX; the FastAPI backend owns key validation, job state, artifact persistence, and launching OpenMontage pipeline stages with a per-job `SYAPI_API_KEY` context. Start with a deterministic local mock runner so the UI is usable immediately, then swap in the real pipeline runner.

**Tech Stack:** React + Vite + TypeScript for the frontend, FastAPI + Pydantic + SQLite for the backend, WebSocket or Server-Sent Events for progress, existing `tools/graphics/syapi_image.py`, `tools/video/syapi_video.py`, selectors, pipeline manifests, and `projects/<project>/` artifact layout for generation.

---

## Product Boundary

This is not a full public SaaS in the first pass. The target user is someone who already recharged on the user's SYAPI gateway platform and has a key. The web app only accepts that key and uses it for generation.

First release scope:

- Key-only entry: no registration, password, recharge, billing, or admin portal.
- Chat + short drama mode.
- Character library, location/prop library, storyboard waterfall, consistency report.
- Single-shot regenerate and whole-project render controls.
- Project history stored locally in SQLite and file artifacts under `projects/`.
- Mock generation mode first, real OpenMontage pipeline mode second.

Out of scope for MVP:

- Multi-tenant billing.
- Public credit accounting.
- Team sharing.
- Cloud object storage.
- Payment.
- Full moderation system.

## GitHub Reuse Notes

Do not fork an entire external product into this repository for the MVP. Use these as reference patterns:

- `Forget-C/Jellyfish`: closest UI/product reference for an AI video creation platform. It has AI assistant, digital human, video editing, voice processing, template marketplace, and admin ideas. Reuse information architecture concepts, not code wholesale.
- `HBAI-Ltd/Toonflow-app`: useful reference for advanced canvas-based AI comic/animation workflows, but Electron + canvas is too heavy for first release.
- `linyqh/LocalMiniDrama`: useful conceptual reference for short-drama automation, but it is not the right web shell for OpenMontage.
- Chat shells such as Open WebUI or Chatbot UI can inspire the chat panel, but the core differentiator is the storyboard/asset workbench, so a generic chat clone should not become the main UI.

## File Structure

Create:

- `web/package.json`: frontend scripts and dependencies.
- `web/index.html`: Vite entry document.
- `web/tsconfig.json`: TypeScript config.
- `web/vite.config.ts`: Vite dev proxy to FastAPI.
- `web/src/main.tsx`: React entry.
- `web/src/App.tsx`: page shell and routing state.
- `web/src/api/client.ts`: typed backend client.
- `web/src/domain/types.ts`: shared frontend domain types.
- `web/src/domain/consistency.ts`: pure consistency scoring helpers.
- `web/src/domain/storyboard.ts`: pure storyboard generation/update helpers for mock mode.
- `web/src/components/KeyGate.tsx`: SYAPI key entry and status.
- `web/src/components/ChatPanel.tsx`: prompt/chat production assistant panel.
- `web/src/components/CharacterLibrary.tsx`: character cards, reference images, lock controls.
- `web/src/components/StoryboardWaterfall.tsx`: shot cards, per-shot regenerate, status.
- `web/src/components/ConsistencyPanel.tsx`: report and warnings.
- `web/src/components/JobProgress.tsx`: pipeline stage progress.
- `web/src/styles.css`: application styling.
- `server/app/main.py`: FastAPI application factory and routes.
- `server/app/models.py`: Pydantic request/response models.
- `server/app/storage.py`: SQLite persistence and artifact path helpers.
- `server/app/keyring.py`: key validation, masking, and per-job key context.
- `server/app/mock_runner.py`: deterministic runner for immediate UI demo.
- `server/app/openmontage_runner.py`: real pipeline runner adapter.
- `server/app/events.py`: in-memory event bus for job progress.
- `server/app/settings.py`: path and runtime settings.
- `server/tests/test_keyring.py`: key masking and context tests.
- `server/tests/test_consistency.py`: consistency checks from storyboard artifacts.
- `server/tests/test_mock_runner.py`: mock runner emits expected stages/artifacts.
- `server/tests/test_api.py`: API route behavior.

Modify:

- `.gitignore`: ignore local SQLite db, uploaded temp files, and frontend build output if needed.
- `README.md` or `README_zh-CN.md`: add a short web workbench section after the MVP runs.

## Domain Model

Backend entities:

```python
class Project:
    id: str
    title: str
    mode: Literal["short_drama", "general_video"]
    created_at: str
    updated_at: str

class GatewayKey:
    masked: str
    provider: Literal["syapi"]
    base_url: str
    valid: bool

class Character:
    id: str
    name: str
    role: str
    visual_lock: str
    voice: str | None
    reference_images: list[str]
    locked: bool

class Shot:
    id: str
    scene_id: str
    index: int
    beat: str
    prompt: str
    characters: list[str]
    location: str | None
    props: list[str]
    status: Literal["draft", "ready", "generating", "complete", "failed"]
    consistency_score: int
    output_url: str | None
    output_path: str | None

class Job:
    id: str
    project_id: str
    stage: str
    status: Literal["queued", "running", "complete", "failed"]
    events: list[JobEvent]
```

Artifacts should also be written in OpenMontage style:

```text
projects/<project-id>/
  artifacts/
    series_bible.json
    episode_storyboard.json
    consistency_report.json
    proposal_packet.json
    scene_plan.json
    asset_manifest.json
    edit_decisions.json
    render_report.json
  assets/
    images/
    video/
    audio/
  renders/
    final.mp4
```

## Task 1: Backend Domain, Storage, and Key Context

**Files:**

- Create: `server/app/models.py`
- Create: `server/app/keyring.py`
- Create: `server/app/storage.py`
- Create: `server/app/settings.py`
- Test: `server/tests/test_keyring.py`
- Test: `server/tests/test_storage.py`

- [x] **Step 1: Write key masking tests**

```python
from server.app.keyring import mask_key, key_environment


def test_mask_key_keeps_only_edges():
    assert mask_key("test-key-redacted") == "test...cted"


def test_mask_key_handles_short_keys():
    assert mask_key("abc123") == "******"


def test_key_environment_sets_syapi_key_without_mutating_process_env(monkeypatch):
    monkeypatch.delenv("SYAPI_API_KEY", raising=False)
    env = key_environment("user-key", base_url="https://api.0000238.xyz")
    assert env["SYAPI_API_KEY"] == "user-key"
    assert env["SYAPI_BASE_URL"] == "https://api.0000238.xyz"
```

- [x] **Step 2: Run key tests and verify they fail**

Run:

```bash
pytest server/tests/test_keyring.py -v
```

Expected: fail because `server.app.keyring` does not exist.

- [x] **Step 3: Implement keyring**

Create `server/app/keyring.py`:

```python
from __future__ import annotations


def mask_key(value: str) -> str:
    if len(value) < 12:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def key_environment(value: str, base_url: str = "https://u.syapi.cn") -> dict[str, str]:
    return {
        "SYAPI_API_KEY": value,
        "SYAPI_BASE_URL": base_url.rstrip("/"),
    }
```

- [x] **Step 4: Write storage tests**

```python
from server.app.storage import WorkbenchStore


def test_store_creates_project_and_artifact_dirs(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project(title="Rain Alley", mode="short_drama")

    assert project.title == "Rain Alley"
    assert (tmp_path / "projects" / project.id / "artifacts").is_dir()
    assert (tmp_path / "projects" / project.id / "assets" / "images").is_dir()
    assert (tmp_path / "projects" / project.id / "assets" / "video").is_dir()
    assert (tmp_path / "projects" / project.id / "renders").is_dir()
```

- [x] **Step 5: Run storage tests and verify they fail**

Run:

```bash
pytest server/tests/test_storage.py -v
```

Expected: fail because `WorkbenchStore` does not exist.

- [x] **Step 6: Implement Pydantic models and storage**

Create `server/app/models.py` with Pydantic models for `Project`, `Character`, `Shot`, `ConsistencyIssue`, `ConsistencyReport`, `JobEvent`, and `Job`.

Create `server/app/storage.py` with:

```python
class WorkbenchStore:
    def __init__(self, db_path: Path, projects_root: Path): ...
    def create_project(self, title: str, mode: str) -> Project: ...
    def project_dir(self, project_id: str) -> Path: ...
    def write_artifact(self, project_id: str, name: str, data: dict[str, Any]) -> Path: ...
```

Use SQLite for project rows and filesystem directories for artifacts.

- [x] **Step 7: Run backend domain tests**

Run:

```bash
pytest server/tests/test_keyring.py server/tests/test_storage.py -v
```

Expected: all pass.

## Task 2: Consistency Engine and Mock Storyboard Runner

**Files:**

- Create: `server/app/mock_runner.py`
- Create: `server/app/consistency.py`
- Test: `server/tests/test_consistency.py`
- Test: `server/tests/test_mock_runner.py`

- [x] **Step 1: Write consistency tests**

```python
from server.app.consistency import evaluate_storyboard_consistency


def test_consistency_flags_missing_locked_character_reference():
    series_bible = {
        "characters": [
            {"id": "c1", "name": "Lin", "visual_lock": "red coat, short hair", "locked": True}
        ]
    }
    storyboard = {
        "shots": [
            {"id": "s1", "characters": ["c1"], "prompt": "Lin runs through the rain"}
        ]
    }

    report = evaluate_storyboard_consistency(series_bible, storyboard)

    assert report["score"] < 100
    assert report["issues"][0]["code"] == "missing_visual_lock"
```

- [x] **Step 2: Run consistency tests and verify they fail**

Run:

```bash
pytest server/tests/test_consistency.py -v
```

Expected: fail because `server.app.consistency` does not exist.

- [x] **Step 3: Implement consistency checks**

Create `server/app/consistency.py` with checks for:

- Shot references a character not in `series_bible`.
- Locked character appears in a shot but prompt does not include that character's `visual_lock`.
- Shot has no location.
- Adjacent shots change aspect ratio or visual style unexpectedly.

Return:

```python
{
  "score": 0-100,
  "issues": [
    {"shot_id": "s1", "severity": "warning", "code": "missing_visual_lock", "message": "..."}
  ]
}
```

- [x] **Step 4: Write mock runner tests**

```python
from server.app.mock_runner import build_mock_short_drama


def test_mock_runner_builds_characters_and_shots():
    result = build_mock_short_drama("都市反转短剧，雨夜，女主发现真相")

    assert len(result["series_bible"]["characters"]) >= 2
    assert len(result["storyboard"]["shots"]) >= 4
    assert result["storyboard"]["shots"][0]["status"] == "ready"
```

- [x] **Step 5: Run mock runner tests and verify they fail**

Run:

```bash
pytest server/tests/test_mock_runner.py -v
```

Expected: fail because `build_mock_short_drama` does not exist.

- [x] **Step 6: Implement mock runner**

Create `server/app/mock_runner.py` with deterministic generation from user text:

- Two or three characters.
- Four to six shots.
- Each shot has prompt, beat, location, props, consistency score, and ready status.
- Write no external API calls.

- [x] **Step 7: Run Task 2 tests**

Run:

```bash
pytest server/tests/test_consistency.py server/tests/test_mock_runner.py -v
```

Expected: all pass.

## Task 3: FastAPI API and Progress Events

**Files:**

- Create: `server/app/main.py`
- Create: `server/app/events.py`
- Test: `server/tests/test_api.py`

- [x] **Step 1: Write API tests**

```python
from fastapi.testclient import TestClient

from server.app.main import create_app


def test_key_session_returns_masked_key(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.post("/api/session/key", json={
        "key": "test-key-redacted",
        "base_url": "https://api.0000238.xyz"
    })

    assert response.status_code == 200
    assert response.json()["masked_key"] == "test...cted"


def test_create_short_drama_project_returns_storyboard(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.post("/api/projects/short-drama", json={
        "title": "Rain Alley",
        "prompt": "雨夜都市反转短剧",
        "gateway_key": "test-key-redacted",
        "base_url": "https://api.0000238.xyz"
    })

    assert response.status_code == 200
    body = response.json()
    assert body["project"]["title"] == "Rain Alley"
    assert len(body["series_bible"]["characters"]) >= 2
    assert len(body["storyboard"]["shots"]) >= 4
```

- [x] **Step 2: Run API tests and verify they fail**

Run:

```bash
pytest server/tests/test_api.py -v
```

Expected: fail because `server.app.main` does not exist.

- [x] **Step 3: Implement API routes**

Routes:

- `POST /api/session/key`: accepts key and base URL, returns masked key and provider metadata.
- `POST /api/projects/short-drama`: creates project, runs mock short-drama builder, writes `series_bible.json`, `episode_storyboard.json`, and `consistency_report.json`.
- `GET /api/projects/{project_id}`: returns project artifacts.
- `POST /api/projects/{project_id}/shots/{shot_id}/regenerate`: mock-regenerates one shot and emits events.
- `GET /api/projects/{project_id}/events`: SSE stream for job events.

- [x] **Step 4: Run API tests**

Run:

```bash
pytest server/tests/test_api.py -v
```

Expected: all pass.

## Task 4: Frontend Scaffold and API Client

**Files:**

- Create: `web/package.json`
- Create: `web/index.html`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/api/client.ts`
- Create: `web/src/domain/types.ts`
- Test: `web/src/api/client.test.ts`

- [x] **Step 1: Write API client test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createShortDramaProject } from "./client";

describe("createShortDramaProject", () => {
  it("posts prompt and gateway key to backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1", title: "Rain Alley" } }),
    });

    const result = await createShortDramaProject(
      { title: "Rain Alley", prompt: "雨夜短剧", gateway_key: "key", base_url: "https://api.0000238.xyz" },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/short-drama", expect.objectContaining({ method: "POST" }));
    expect(result.project.id).toBe("p1");
  });
});
```

- [x] **Step 2: Run frontend test and verify it fails**

Run:

```bash
cd web
npm test -- src/api/client.test.ts
```

Expected: fail because frontend files do not exist.

- [x] **Step 3: Implement frontend scaffold and client**

Use Vite React TypeScript. Add scripts:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc && vite build",
    "test": "vitest run"
  }
}
```

Implement `createShortDramaProject`, `saveGatewayKey`, `regenerateShot`, and `loadProject`.

- [x] **Step 4: Run frontend tests**

Run:

```bash
cd web
npm install
npm test -- src/api/client.test.ts
```

Expected: all pass.

## Task 5: Frontend Workbench UI

**Files:**

- Create: `web/src/App.tsx`
- Create: `web/src/components/KeyGate.tsx`
- Create: `web/src/components/ChatPanel.tsx`
- Create: `web/src/components/CharacterLibrary.tsx`
- Create: `web/src/components/StoryboardWaterfall.tsx`
- Create: `web/src/components/ConsistencyPanel.tsx`
- Create: `web/src/components/JobProgress.tsx`
- Create: `web/src/styles.css`
- Test: `web/src/App.test.tsx`

- [x] **Step 1: Write UI smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the key gate and workbench shell", () => {
    render(<App />);
    expect(screen.getByText("OpenMontage Short Drama Workbench")).toBeInTheDocument();
    expect(screen.getByLabelText("SYAPI Gateway Key")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run UI test and verify it fails**

Run:

```bash
cd web
npm test -- src/App.test.tsx
```

Expected: fail because `App` does not exist.

- [x] **Step 3: Implement workbench shell**

Layout:

- Left rail: project mode, key status, project list placeholder.
- Center: chat panel on top, storyboard waterfall below.
- Right panel: character library, consistency report, job progress.

Controls:

- Key input and base URL field.
- Prompt textarea.
- "Create storyboard" button.
- Per-shot "regenerate" button.
- Whole project "render final video" disabled until real runner task.

- [x] **Step 4: Run UI tests and build**

Run:

```bash
cd web
npm test
npm run build
```

Expected: tests pass and build succeeds.

## Task 6: Real OpenMontage Runner Adapter

**Files:**

- Create: `server/app/openmontage_runner.py`
- Test: `server/tests/test_openmontage_runner.py`

- [x] **Step 1: Write runner mapping test**

```python
from server.app.openmontage_runner import build_pipeline_inputs


def test_build_pipeline_inputs_maps_storyboard_to_openmontage_artifacts():
    series_bible = {"characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}]}
    storyboard = {"shots": [{"id": "s1", "prompt": "Lin in red coat runs", "characters": ["c1"]}]}

    result = build_pipeline_inputs(series_bible, storyboard, render_runtime="remotion")

    assert result["scene_plan"]["scenes"][0]["description"] == "Lin in red coat runs"
    assert result["proposal_packet"]["production_plan"]["render_runtime"] == "remotion"
```

- [x] **Step 2: Run runner mapping test and verify it fails**

Run:

```bash
pytest server/tests/test_openmontage_runner.py -v
```

Expected: fail because runner adapter does not exist.

- [x] **Step 3: Implement runner adapter**

Implement pure mapping functions first:

- `build_pipeline_inputs(series_bible, storyboard, render_runtime)`.
- `compile_shot_prompt(shot, character_lookup, style_lock)`.
- `write_pipeline_artifacts(project_dir, pipeline_inputs)`.

Then add an execution wrapper:

- Creates per-job environment using `key_environment`.
- Calls existing OpenMontage tools through selectors where possible.
- Writes outputs to `projects/<project-id>/`.
- Emits stage events: `proposal`, `scene_plan`, `assets`, `edit`, `compose`.

- [x] **Step 4: Run runner tests**

Run:

```bash
pytest server/tests/test_openmontage_runner.py -v
```

Expected: all pass.

## Task 7: End-to-End Dev Run

**Files:**

- Modify: `README.md` or `README_zh-CN.md`

- [x] **Step 1: Add dev commands**

Document:

```bash
uvicorn server.app.main:create_app --factory --reload --host 127.0.0.1 --port 8787
cd web
npm run dev
```

Also document:

```text
Open http://127.0.0.1:5173
Enter SYAPI key
Prompt: 做一个60秒都市反转短剧，女主雨夜发现老板背后的秘密
```

- [x] **Step 2: Run backend**

Run:

```bash
uvicorn server.app.main:create_app --factory --reload --host 127.0.0.1 --port 8787
```

Expected: server starts and `/docs` opens.

- [x] **Step 3: Run frontend**

Run:

```bash
cd web
npm run dev
```

Expected: Vite prints a local URL.

- [x] **Step 4: Browser smoke test**

Open the Vite URL and verify:

- Key gate appears.
- Submitting a key masks it.
- Creating a short-drama project populates character cards.
- Storyboard waterfall has at least four shot cards.
- Consistency panel shows score and issues.
- Regenerate on one shot updates its status and prompt/version.

- [x] **Step 5: Run all verification**

Run:

```bash
pytest server/tests -v
cd web
npm test
npm run build
```

Expected: all pass.

## Design Checkpoints

Before implementation:

- Confirm MVP is key-only, no platform account system.
- Confirm first visible version may use mock runner before real video generation.
- Confirm backend must call existing OpenMontage tools/pipelines for real generation.
- Confirm SYAPI keys are never written to artifact JSON, frontend local storage, logs, or design docs.

After mock MVP:

- Review UI density against syapi storyboard reference.
- Decide whether to keep chat as primary input or make storyboard the primary surface.
- Decide whether first real generation target is single-shot regenerate or whole episode render.

After real runner:

- Add model selection controls for SYAPI variants.
- Add cost estimate from `estimate_cost`.
- Add failure retry and provider error surfacing.
- Add artifact download and final render preview.

## Post-MVP Optimization Roadmap

The MVP is intentionally small because the heaviest risks are not login pages or dashboards; they are whether the storyboard workbench can reliably drive OpenMontage and whether users understand the generation state. Do not add platform features until the generation loop is demonstrably useful.

### Phase 1: Usable Local Workbench

Build this first.

- Key-only access: users paste a SYAPI gateway key for each browser session.
- Mock runner: instant character library, storyboard, and consistency report.
- Real UI surface: chat, character cards, storyboard waterfall, consistency panel, per-shot regenerate.
- Local persistence: SQLite plus `projects/<project-id>/` artifacts.
- Manual dev run: one FastAPI process and one Vite process.

Exit criteria:

- A user can enter a key, submit a short-drama idea, see a generated storyboard, edit prompts, run consistency checks, and regenerate a shot in mock mode.
- No key is stored in artifacts, logs, localStorage, screenshots, or committed files.

### Phase 2: Real Single-Shot Generation

Connect the safest real provider loop before whole-episode rendering.

- Use `syapi_image` for character/reference/keyframe generation.
- Use `syapi_video` for one selected shot.
- Store generated image/video files under the project assets directory.
- Show provider task status, cost estimate, model variant, and failure reason in the shot card.
- Add "regenerate image only", "regenerate video only", and "reuse previous keyframe" controls.

Exit criteria:

- One shot can be generated from the storyboard using the user's gateway key.
- Failed provider jobs surface a clear reason and do not break the project.
- The user can compare at least two attempts for the same shot.

### Phase 3: Whole Episode Pipeline

Only after single-shot generation feels good, connect full OpenMontage execution.

- Compile `series_bible` and `episode_storyboard` into OpenMontage-compatible `proposal_packet`, `scene_plan`, `asset_manifest`, and `edit_decisions`.
- Run image/video generation shot by shot.
- Add queue state: pending, generating image, generating video, ready for compose, composing, complete, failed.
- Use Remotion/FFmpeg compose to create `renders/final.mp4`.
- Add final preview, download, and artifact explorer.

Exit criteria:

- A 4-6 shot short drama can render end to end.
- The UI can resume after page refresh by reading project/job state from SQLite and artifacts.
- The user can rerun only failed shots instead of rerunning the whole episode.

### Phase 4: Consistency and Quality Upgrades

Improve the short-drama differentiator.

- Character reference board: front/side/emotion/wardrobe reference slots.
- Prompt compiler preview: show exactly which global style, character lock, scene lock, and negative prompt are injected into each shot.
- Visual similarity checks: compare generated frames against character references using CLIP/face embeddings when available.
- Continuity checks: wardrobe, location, prop, time-of-day, and emotional-state continuity across adjacent shots.
- Shot QA: detect blank outputs, wrong aspect ratio, low motion, face drift, duplicate shots, and subtitle/audio mismatch.
- Attempt history: keep every generation attempt with prompt, model, cost, output, and user rating.

Exit criteria:

- The consistency panel catches real mistakes before final compose.
- The user can fix a warning by editing the character lock or regenerating a single shot.

### Phase 5: Key-Only Platform Hardening

Add this only when the local workbench is useful.

- Keep the product key-only: no app account, no password login, no recharge UI, no internal credit ledger.
- Validate the pasted gateway key against the SYAPI gateway before allowing real generation.
- Derive an internal anonymous workspace id from a salted hash of the gateway key so projects can be isolated without storing the raw key as identity.
- Store only the masked key and key hash in SQLite; keep the raw key in server memory only for the active job unless the operator explicitly enables encrypted "remember key" mode later.
- Server-side job worker process so long generations survive browser disconnects.
- Key-scoped diagnostics: active jobs, provider failures, average cost, queue depth, and last error per key hash.
- Rate limits per gateway key hash to protect the backend.
- Deployment packaging: one command for local, one documented path for server deployment.

Exit criteria:

- Multiple users can paste their own gateway keys without seeing each other's projects.
- The application never asks for a separate account or password.
- A server restart does not orphan running or completed project artifacts.

### Phase 6: Advanced Studio Features

These are explicitly after the main workbench proves itself.

- Template library for common short-drama genres: urban reversal, workplace conflict, family emotion, suspense hook, product ad drama.
- Multi-episode series bible with recurring characters and reusable locations.
- Voice casting and subtitle timeline.
- Batch variants for A/B hooks.
- Mobile-first storyboard review mode.
- Import from reference video or existing syapi storyboard export.
- Optional canvas/timeline editor inspired by Toonflow-style workflows.

## Self-Review

Spec coverage:

- Key-only entry is covered by Tasks 1, 3, and 5.
- Chat + character library + storyboard waterfall is covered by Task 5.
- Consistency checks are covered by Task 2 and Task 5.
- Single-shot regenerate is covered by Task 3 and Task 5.
- Real OpenMontage pipeline handoff is covered by Task 6.
- Running and verification are covered by Task 7.

Placeholder scan:

- No task depends on an undefined "later" feature for MVP.
- Real provider generation is explicitly separated into Task 6 after mock MVP.

Type consistency:

- Backend uses `series_bible`, `storyboard`, `project`, and `consistency_report` consistently.
- Frontend API client uses snake_case request keys matching FastAPI/Pydantic JSON.

## Completion Record

Completed on 2026-06-30 in `C:\Users\zkyd\Desktop\OpenMontage`.

Implemented:

- Backend domain, storage, key masking, consistency checks, mock runner, API routes, events, and tests.
- React/Vite/TypeScript web workbench with key gate, production assistant, character library, storyboard waterfall, consistency panel, progress panel, API client, and tests.
- OpenMontage runner adapter for mapping `series_bible` and storyboard artifacts into `proposal_packet`, `scene_plan`, `asset_manifest`, and `edit_decisions`.
- README web workbench dev commands and gitignore coverage for local frontend output.

Verified:

- `pytest server/tests -v` -> 13 passed.
- `cd web && npm test` -> 2 passed.
- `cd web && npm run build` -> production build succeeded.
- Browser smoke test at `http://127.0.0.1:5173/` with local FastAPI at `http://127.0.0.1:8787`: key gate masked `sk-1...cdef`, project creation produced 3 character cards and 5 shot cards, consistency panel rendered score/issues, and single-shot regenerate updated the shot to Version 2 with a progress event.
