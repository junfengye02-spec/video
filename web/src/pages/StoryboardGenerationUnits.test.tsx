import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  GenerationExecutionSnapshot,
  GenerationExecutionUnit,
  GenerationPlan,
  GenerationUnit,
  GenerationUnitsGenerateResponse,
  Shot,
} from "../domain/types";
import { ApiError } from "../platform/http/HttpClient";
import { createProjectResponse, createShot } from "../test/fixtures";
import { getStrings } from "../i18n";
import { StoryboardPage, type StoryboardPageProps } from "./StoryboardPage";

const project = createProjectResponse({ shotCount: 6 });

function shots(count = 6): Shot[] {
  return Array.from({ length: count }, (_, index) => createShot({
    id: `shot-${index + 1}`,
    index: index + 1,
    beat_id: `beat-${index + 1}`,
    beat: `叙事节拍 ${index + 1}`,
    recommended_duration_seconds: 5,
    duration_range_seconds: [4, 6],
    can_merge_with_next: index < count - 1,
  }));
}

function profile(modelId: string, seconds: number, maxBeats: number) {
  return {
    provider: "newapi",
    model_id: modelId,
    operation: "text_to_video" as const,
    duration_mode: "fixed" as const,
    fixed_duration_seconds: seconds,
    supported_duration_seconds: [],
    min_duration_seconds: null,
    max_duration_seconds: null,
    supports_start_frame: false,
    supports_end_frame: false,
    supports_extend: false,
    supports_sequential_beats: maxBeats > 1,
    supports_multi_shot_prompt: maxBeats > 1,
    max_narrative_beats_per_unit: maxBeats,
    contract_source: "verified_override" as const,
    profile_revision: `test-${modelId}`,
    duration_configuration_status: "configured" as const,
  };
}

function unit(
  sourceShots: Shot[],
  index: number,
  modelId: string,
  seconds: number,
  overrides: Partial<GenerationUnit> = {},
): GenerationUnit {
  const ids = sourceShots.map((shot) => shot.id);
  return {
    id: `unit-${index}-${modelId.replace(/[^a-z0-9]/gi, "-")}`,
    revision: 1,
    status: "planned",
    shot_ids: ids,
    source_shot_ids: ids,
    source_beat_ids: sourceShots.map((shot) => shot.beat_id ?? shot.id),
    source_segment_ids: sourceShots.map((_, segmentIndex) => (
      `segment-${index}-${segmentIndex + 1}`
    )),
    prompt_segments: sourceShots.map((shot, segmentIndex) => ({
      id: `segment-${index}-${segmentIndex + 1}`,
      source_shot_id: shot.id,
      source_beat_id: shot.beat_id ?? shot.id,
      sequence: segmentIndex + 1,
      segment_index: segmentIndex + 1,
      segment_count: sourceShots.length,
      recommended_content_duration_seconds: shot.recommended_duration_seconds ?? null,
      prompt: shot.prompt,
      transition: "continuous",
      continuity_requirements: [],
      start_state: `State before ${shot.id}`,
      action_progress: shot.prompt,
      end_state: `State after ${shot.id}`,
    })),
    provider: "newapi",
    model_id: modelId,
    operation: "text_to_video",
    requested_duration_seconds: seconds,
    source_duration_seconds: null,
    timeline_duration_seconds: seconds,
    output_asset_id: null,
    output_path: null,
    billing_job_id: null,
    task_item_id: null,
    replaces_unit_id: null,
    profile: profile(modelId, seconds, sourceShots.length),
    ...overrides,
  };
}

function plan(
  sourceShots: Shot[],
  modelId: string,
  groups: number[],
  seconds: number,
  overrides: Partial<GenerationPlan> = {},
): GenerationPlan {
  let offset = 0;
  const units = groups.map((size, index) => {
    const source = sourceShots.slice(offset, offset + size);
    offset += size;
    return unit(source, index + 1, modelId, seconds);
  });
  const native = groups.length * seconds;
  const target = 30;
  const segments = units.flatMap((candidate) => candidate.prompt_segments);
  return {
    version: "1.0",
    id: modelId.startsWith("sora") ? "b".repeat(64) : "a".repeat(64),
    storyboard_revision: "sha256:storyboard",
    provider: "newapi",
    model_id: modelId,
    shot_ids: sourceShots.map((shot) => shot.id),
    storyboard_shot_count: sourceShots.length,
    generation_unit_count: units.length,
    protected_generation_unit_ids: [],
    pending_shot_ids: sourceShots.map((shot) => shot.id),
    covered_shot_ids: sourceShots.map((shot) => shot.id),
    covered_segment_ids: segments.map((segment) => segment.id),
    target_duration_seconds: target,
    native_total_duration_seconds: native,
    timeline_total_duration_seconds: native,
    duration_difference_seconds: native - target,
    compatible_with_target: native === target,
    requires_confirmation: native !== target,
    can_generate: native === target,
    confirmed_strategy: null,
    issues: native === target ? [] : [{
      code: "target_duration_incompatible",
      message: `模型原生时长 ${native} 秒，与目标 ${target} 秒不一致。`,
      shot_id: null,
      unit_id: null,
    }],
    adaptation_options: native === target
      ? ["choose_compatible_model"]
      : [
        "accept_longer_duration",
        "revise_or_merge_storyboard",
        "choose_compatible_model",
      ],
    generation_segments: segments,
    generation_units: units,
    ...overrides,
  };
}

function executionUnit(
  source: GenerationUnit,
  overrides: Partial<GenerationExecutionUnit> = {},
): GenerationExecutionUnit {
  return {
    id: source.id,
    plan_id: "ledger-plan",
    revision: source.revision,
    status: source.status,
    active: false,
    source_shot_ids: source.source_shot_ids,
    source_shot_versions: Object.fromEntries(source.source_shot_ids.map((id) => [id, 1])),
    source_beat_ids: source.source_beat_ids,
    source_segment_ids: source.source_segment_ids,
    prompt_segments: source.prompt_segments,
    provider: source.provider,
    model_id: source.model_id,
    operation: source.operation,
    profile_revision: source.profile.profile_revision,
    profile: source.profile,
    requested_duration_seconds: source.requested_duration_seconds,
    source_duration_seconds: source.source_duration_seconds,
    timeline_duration_seconds: source.timeline_duration_seconds,
    output_asset_id: source.output_asset_id,
    output_path: source.output_path,
    task_item_id: source.task_item_id,
    billing_job_id: source.billing_job_id,
    replaces_unit_id: source.replaces_unit_id,
    diagnostics: {},
    created_at: "2026-07-24T00:00:00Z",
    updated_at: "2026-07-24T00:00:00Z",
    ...overrides,
  };
}

function acceptedTask(unitIds: string[]): GenerationUnitsGenerateResponse {
  return {
    task_id: "task-units",
    status: "queued",
    deduplicated: false,
    task: {
      id: "task-units",
      project_id: "p1",
      task_type: "generation_unit_video.generate",
      status: "queued",
      idempotency_key: "generation-units:test",
      progress: 0,
      total_items: unitIds.length,
      completed_items: 0,
      failed_items: 0,
      error_code: null,
      error_message: null,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
      items: unitIds.map((unitId, index) => ({
        id: `item-${unitId}`,
        batch_id: "task-units",
        position: index,
        task_type: "generation_unit_video.generate",
        status: "queued",
        idempotency_key: `key-${unitId}`,
        input: {},
        target_entity_type: "generation_unit",
        target_entity_id: unitId,
        target_entity_version: 1,
        attempt_count: 0,
        max_attempts: 10,
        progress: 0,
        retryable: true,
        error_code: null,
        error_message: null,
        result: null,
        billing_job_id: null,
        provider_wait_started_at: null,
        provider_next_poll_at: null,
        provider_poll_count: 0,
        dependencies: [],
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      })),
    },
  };
}

function pageProps(
  sourceShots: Shot[],
  overrides: Partial<StoryboardPageProps> = {},
): StoryboardPageProps {
  return {
    projectId: "p1",
    assets: project.series_bible.assets ?? [],
    characters: project.series_bible.characters,
    generationPreferences: {
      image_model: "gpt-image-2",
      video_model: "omni_flash-10s",
      image_size: "1024x1024",
      image_quality: "standard",
      aspect_ratio: "16:9",
    },
    generationExecution: null,
    optimizingShotId: null,
    regeneratingShotId: null,
    savingShotId: null,
    selectedShotId: sourceShots[0]?.id ?? null,
    shots: sourceShots,
    projectDurationSeconds: 30,
    resolveShotMedia: () => null,
    onSelectShot: vi.fn(),
    onOptimizePrompt: vi.fn(),
    onSaveShot: vi.fn(),
    onRegenerateShot: vi.fn(),
    onReviseStoryboard: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPage(sourceShots: Shot[], overrides: Partial<StoryboardPageProps> = {}) {
  return render(
    <MemoryRouter>
      <StoryboardPage {...pageProps(sourceShots, overrides)} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Storyboard generation-unit mock E2E", () => {
  it("automatically replans active units after their source shot is edited", async () => {
    const sourceShots = shots(2);
    const editedShots = sourceShots.map((shot, index) => (
      index === 0 ? { ...shot, version: shot.version + 1, prompt: "Revised prompt" } : shot
    ));
    const old = unit(sourceShots, 1, "omni_flash-10s", 10, {
      id: "unit-old",
      status: "complete",
      output_asset_id: "asset-old",
      output_path: "assets/video/units/unit-old/v1.mp4",
    });
    const replacement = unit(editedShots, 1, "omni_flash-10s", 10, {
      id: "unit-replacement",
      replaces_unit_id: old.id,
    });
    const replacementPlan = plan(editedShots, "omni_flash-10s", [2], 10, {
      id: "e".repeat(64),
      generation_units: [replacement],
      requires_confirmation: false,
      can_generate: true,
      compatible_with_target: true,
      target_duration_seconds: 10,
      duration_difference_seconds: 0,
      issues: [],
    });
    const execution: GenerationExecutionSnapshot = {
      version: "1.0",
      project_id: "p1",
      updated_at: "2026-07-24T00:00:00Z",
      active_generation_unit_ids: [old.id],
      generation_units: [executionUnit(old, { active: true })],
    };
    const preview = vi.fn(async () => replacementPlan);

    renderPage(editedShots, {
      generationExecution: execution,
      onPreviewGenerationPlan: preview,
      onGenerateGenerationUnits: vi.fn(),
    });

    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
      regenerate_unit_ids: [old.id],
    })));
    expect(screen.getAllByText(getStrings("zh").shotEditor.videoOutdatedStatus).length)
      .toBeGreaterThan(0);
    expect(screen.getByText(getStrings("zh").shotEditor.videoOutdatedHint)).toBeInTheDocument();
  });

  it("renders the Omni 6-to-3 mapping and submits three unit IDs", async () => {
    const sourceShots = shots();
    const omni = plan(sourceShots, "omni_flash-10s", [2, 2, 2], 10);
    const submit = vi.fn(async (payload) => acceptedTask(payload.generation_unit_ids));
    renderPage(sourceShots, {
      onPreviewGenerationPlan: vi.fn(async () => omni),
      onGenerateGenerationUnits: submit,
    });

    expect(await screen.findByText("6 个叙事节拍 / 3 个视频生成单元 / 预计 30 秒"))
      .toBeInTheDocument();
    const durationComparison = screen.getByLabelText("生成计划时长对比");
    expect(within(durationComparison).getByText("内容建议时长")).toBeInTheDocument();
    expect(within(durationComparison).getByText("模型请求时长")).toBeInTheDocument();
    expect(within(durationComparison).getByText("原生总时长")).toBeInTheDocument();
    expect(screen.getAllByText("内容建议 10 秒")).toHaveLength(3);
    expect(screen.getAllByText("请求 10 秒")).toHaveLength(3);
    expect(screen.queryByText(/最多 .* 节拍/)).not.toBeInTheDocument();
    expect(screen.getAllByText("叙事节拍 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("叙事节拍 6").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "生成 3 个待处理单元" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      generation_plan_id: omni.id,
      generation_unit_ids: omni.generation_units.map((candidate) => candidate.id),
      idempotency_key: expect.stringMatching(/^generation-units:/),
    }));
  });

  it("blocks Sora 36 seconds until the server returns an accept-longer plan", async () => {
    const sourceShots = shots();
    const blocked = plan(sourceShots, "sora-12s", [2, 2, 2], 12);
    const confirmed = {
      ...blocked,
      id: "c".repeat(64),
      requires_confirmation: false,
      can_generate: true,
      confirmed_strategy: "accept_longer_duration" as const,
    };
    const preview = vi.fn(async (payload) => (
      payload.confirmed_strategy === "accept_longer_duration" ? confirmed : blocked
    ));
    renderPage(sourceShots, {
      generationPreferences: {
        ...pageProps(sourceShots).generationPreferences!,
        video_model: "sora-12s",
      },
      onPreviewGenerationPlan: preview,
      onGenerateGenerationUnits: vi.fn(),
    });

    expect(await screen.findByText("6 个叙事节拍 / 3 个视频生成单元 / 预计 36 秒"))
      .toBeInTheDocument();
    expect(screen.getByText("+6 秒")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成 3 个待处理单元" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "接受更长成片" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({
      video_model: "sora-12s",
      shot_ids: sourceShots.map((shot) => shot.id),
      regenerate_unit_ids: [],
      confirmed_strategy: "accept_longer_duration",
    }));
    expect(screen.getByRole("button", { name: "生成 3 个待处理单元" })).toBeEnabled();
  });

  it("renders a 5-second single-beat model as 6 units and 30 seconds", async () => {
    const sourceShots = shots();
    const fiveSecond = plan(sourceShots, "single-beat-5s", [1, 1, 1, 1, 1, 1], 5);
    renderPage(sourceShots, {
      generationPreferences: {
        ...pageProps(sourceShots).generationPreferences!,
        video_model: "single-beat-5s",
      },
      onPreviewGenerationPlan: vi.fn(async () => fiveSecond),
      onGenerateGenerationUnits: vi.fn(),
    });

    expect(await screen.findByText("6 个叙事节拍 / 6 个视频生成单元 / 预计 30 秒"))
      .toBeInTheDocument();
    expect(screen.getAllByText("请求 5 秒")).toHaveLength(6);
  });

  it("offers all three server-backed actions when a mapping is incompatible", async () => {
    const sourceShots = shots();
    sourceShots[1] = {
      ...sourceShots[1],
      can_merge_with_next: false,
      cannot_split_reason: "动作必须在这里完整结束",
    };
    const incompatible = plan(sourceShots, "omni_flash-10s", [2, 1, 1, 2], 10, {
      can_generate: false,
      compatible_with_target: false,
      requires_confirmation: true,
      issues: [{
        code: "generation_partition_impossible",
        message: "不可合并边界需要更长的原生成片。",
        shot_id: "shot-2",
        unit_id: null,
      }],
      adaptation_options: [
        "accept_longer_duration",
        "revise_or_merge_storyboard",
        "choose_compatible_model",
      ],
    });
    const reviseStoryboard = vi.fn().mockResolvedValue(undefined);
    renderPage(sourceShots, {
      onPreviewGenerationPlan: vi.fn(async () => incompatible),
      onGenerateGenerationUnits: vi.fn(),
      onReviseStoryboard: reviseStoryboard,
    });

    expect(await screen.findByText("不可合并边界需要更长的原生成片。"))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接受更长成片" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /减少或合并分镜/ }));
    await waitFor(() => expect(reviseStoryboard).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link", { name: /减少或合并分镜/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换兼容模型" })).toBeInTheDocument();
    expect(screen.getByText(/动作必须在这里完整结束/)).toBeInTheDocument();
  });

  it("switches only pending candidates and preserves protected unit models", async () => {
    const sourceShots = shots();
    const initial = plan(sourceShots, "omni_flash-10s", [2, 2, 2], 10);
    const protectedUnits = initial.generation_units.slice(0, 2).map((candidate) => ({
      ...candidate,
      status: "complete" as const,
      output_asset_id: `asset-${candidate.id}`,
      output_path: `assets/video/units/${candidate.id}/v1.mp4`,
    }));
    const soraPending = unit(sourceShots.slice(4), 3, "sora-12s", 12);
    const switched = plan(sourceShots, "sora-12s", [2, 2, 2], 12, {
      generation_units: [...protectedUnits, soraPending],
      protected_generation_unit_ids: protectedUnits.map((candidate) => candidate.id),
      pending_shot_ids: sourceShots.slice(4).map((shot) => shot.id),
      generation_unit_count: 3,
      native_total_duration_seconds: 32,
      timeline_total_duration_seconds: 32,
      duration_difference_seconds: 2,
    });
    const preview = vi.fn(async (payload) => (
      payload.video_model === "sora-12s" ? switched : {
        ...initial,
        generation_units: [...protectedUnits, initial.generation_units[2]],
        protected_generation_unit_ids: protectedUnits.map((candidate) => candidate.id),
        pending_shot_ids: sourceShots.slice(4).map((shot) => shot.id),
      }
    ));
    renderPage(sourceShots, {
      onPreviewGenerationPlan: preview,
      onGenerateGenerationUnits: vi.fn(),
    });

    expect((await screen.findAllByText("已保护"))).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("本次生成的视频模型"), {
      target: { value: "sora-12s" },
    });

    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
      video_model: "sora-12s",
      regenerate_unit_ids: [],
    })));
    expect(screen.getAllByText("newapi · omni_flash-10s")).toHaveLength(2);
    expect(screen.getByText("newapi · sora-12s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成 1 个待处理单元" })).toBeInTheDocument();
  });

  it("requires whole-unit confirmation and retains the old active asset during replacement", async () => {
    const sourceShots = shots(2);
    const old = unit(sourceShots, 1, "omni_flash-10s", 10, {
      id: "unit-old",
      status: "complete",
      output_asset_id: "asset-old",
      output_path: "assets/video/units/unit-old/v1.mp4",
    });
    const protectedPlan = plan(sourceShots, "omni_flash-10s", [2], 10, {
      generation_units: [old],
      protected_generation_unit_ids: [old.id],
      pending_shot_ids: [],
      target_duration_seconds: 10,
      duration_difference_seconds: 0,
      compatible_with_target: true,
      requires_confirmation: false,
      can_generate: true,
      issues: [],
      adaptation_options: ["choose_compatible_model"],
    });
    const replacement = unit(sourceShots, 1, "omni_flash-10s", 10, {
      id: "unit-replacement",
      status: "planned",
      replaces_unit_id: old.id,
    });
    const replacementPlan = {
      ...protectedPlan,
      id: "d".repeat(64),
      generation_units: [replacement],
      protected_generation_unit_ids: [],
      pending_shot_ids: sourceShots.map((shot) => shot.id),
    };
    const execution: GenerationExecutionSnapshot = {
      version: "1.0",
      project_id: "p1",
      updated_at: "2026-07-24T00:00:00Z",
      active_generation_unit_ids: [old.id],
      generation_units: [executionUnit(old, { active: true })],
    };
    const preview = vi.fn(async (payload) => (
      payload.regenerate_unit_ids?.includes(old.id) ? replacementPlan : protectedPlan
    ));
    const legacyRegenerate = vi.fn();
    const submit = vi.fn(async (payload) => {
      const response = acceptedTask(payload.generation_unit_ids);
      response.status = "waiting_provider";
      response.task.status = "waiting_provider";
      response.task.items = response.task.items?.map((item) => ({
        ...item,
        status: "waiting_provider" as const,
      })) ?? [];
      return response;
    });
    renderPage(sourceShots, {
      generationExecution: execution,
      onPreviewGenerationPlan: preview,
      onGenerateGenerationUnits: submit,
      onRegenerateShot: legacyRegenerate,
    });

    const currentUnitBadge = await screen.findByText("当前可用");
    const currentUnitRow = currentUnitBadge.closest("article");
    expect(currentUnitRow).not.toBeNull();
    fireEvent.click(within(currentUnitRow as HTMLElement).getByRole("button", { name: "重新生成此单元" }));
    const dialog = screen.getByRole("dialog", { name: "整体重生成多分镜单元" });
    expect(within(dialog).getByText("分镜 1")).toBeInTheDocument();
    expect(within(dialog).getByText("分镜 2")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("如果只需修改一个节拍");
    fireEvent.click(within(dialog).getByRole("button", { name: "整体重新生成" }));

    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
      regenerate_unit_ids: [old.id],
    })));
    expect(screen.getByText("当前可用")).toBeInTheDocument();
    expect(screen.getByText(/assets\/video\/units\/unit-old\/v1\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/替换成功前/)).toBeInTheDocument();
    expect(legacyRegenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "生成 1 个待处理单元" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      generation_plan_id: replacementPlan.id,
      generation_unit_ids: [replacement.id],
    })));
    expect(await screen.findByText("等待中")).toBeInTheDocument();
    expect(screen.getByText(/assets\/video\/units\/unit-old\/v1\.mp4/)).toBeInTheDocument();
  });

  it("surfaces an actionable v2 feature-flag error without using the shot endpoint", async () => {
    const sourceShots = shots(2);
    const candidate = plan(sourceShots, "omni_flash-10s", [2], 10, {
      target_duration_seconds: 10,
      duration_difference_seconds: 0,
      compatible_with_target: true,
      requires_confirmation: false,
      can_generate: true,
      issues: [],
      adaptation_options: ["choose_compatible_model"],
    });
    const submit = vi.fn(async () => {
      throw new ApiError(404, "disabled", "generation_units_v2_disabled");
    });
    renderPage(sourceShots, {
      onPreviewGenerationPlan: vi.fn(async () => candidate),
      onGenerateGenerationUnits: submit,
    });

    fireEvent.click(await screen.findByRole("button", { name: "生成 1 个待处理单元" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前环境未开启 generation units v2",
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("renders and previews every completed generation unit independently", async () => {
    const sourceShots = shots(5);
    const completedUnits = Array.from({ length: 9 }, (_, index) => {
      const source = index === 8
        ? sourceShots.slice(3, 5)
        : [sourceShots[index % sourceShots.length]];
      const candidate = unit(source, index + 1, "omni_flash-10s", 10, {
        id: `completed-unit-${index + 1}`,
        status: "complete",
        output_asset_id: `asset-${index + 1}`,
        output_path: `assets/video/units/completed-unit-${index + 1}/v1.mp4`,
      });
      return {
        ...candidate,
        prompt_segments: candidate.prompt_segments.map((segment) => ({
          ...segment,
          sequence: index + 1,
        })),
      };
    });
    const execution: GenerationExecutionSnapshot = {
      version: "1.0",
      project_id: "p1",
      updated_at: "2026-07-24T00:00:00Z",
      active_generation_unit_ids: completedUnits.map((candidate) => candidate.id),
      generation_units: completedUnits.map((candidate) => executionUnit(candidate, { active: true })),
    };

    renderPage(sourceShots, {
      generationExecution: execution,
      resolveGenerationUnitPath: (path) => `/media/${path}`,
    });

    const strip = await screen.findByTestId("generation-unit-filmstrip");
    expect(within(strip).getAllByRole("button", { name: /选择视频单元/ })).toHaveLength(9);

    fireEvent.click(within(strip).getByRole("button", {
      name: "选择视频单元 9，分镜 04、05",
    }));

    const stageTitle = await screen.findByRole("heading", { name: "视频单元 09" });
    const stage = stageTitle.closest("section");
    expect(stage).not.toBeNull();
    expect(Array.from(stage?.querySelectorAll("video") ?? []).some((video) => (
      video.getAttribute("src") === "/media/assets/video/units/completed-unit-9/v1.mp4"
    ))).toBe(true);

    const inspector = screen.getAllByRole("region", { name: "视频生成单元" }).find((region) => (
      within(region).queryByRole("button", { name: "重新生成此单元" })
    ));
    expect(inspector).toBeDefined();
    expect(within(inspector as HTMLElement).getByText("分镜 04、分镜 05")).toBeVisible();
    fireEvent.click(within(inspector as HTMLElement).getByRole("button", { name: "重新生成此单元" }));
    expect(within(inspector as HTMLElement).getByRole("button", { name: "已加入重生成计划" })).toBeDisabled();
  });
});
