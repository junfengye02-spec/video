import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrings } from "../i18n";
import { createContinuityPlan } from "../test/fixtures";
import { GlobalSettingsPage } from "./GlobalSettingsPage";

const singleVideoPlan = createContinuityPlan("single_video");
const seriesPlan = createContinuityPlan("mini_series");

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  cleanup();
});

describe("GlobalSettingsPage", () => {
  it("shows the reduced settings set for a single video", () => {
    render(<GlobalSettingsPage plan={singleVideoPlan} saving={false} onSave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "故事核心" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "视觉规则" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "角色与关系" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "分集规划" })).not.toBeInTheDocument();
    expect(screen.getByText("只影响后续优化和生成，不会修改已完成分镜")).toBeInTheDocument();
  });

  it("uses injected locale strings for both the page and continuity editor", () => {
    const strings = getStrings("en");
    render(
      <GlobalSettingsPage
        plan={createContinuityPlan("single_video")}
        saving={false}
        strings={strings}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Global Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Story Core" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Characters and Relationships" })).toBeInTheDocument();
    expect(screen.getByLabelText("Worldview")).toBeInTheDocument();
    expect(screen.getByText(strings.globalSettings.notice)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save global settings" })).toBeInTheDocument();
  });

  it("preserves raw line-list typing while focused and saves normalized lines", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <GlobalSettingsPage
        plan={createContinuityPlan("single_video")}
        saving={false}
        onSave={onSave}
      />,
    );
    const taboos = screen.getByLabelText("禁忌");

    fireEvent.focus(taboos);
    fireEvent.change(taboos, { target: { value: "第一条" } });
    fireEvent.change(taboos, { target: { value: "第一条\n" } });
    expect(taboos).toHaveValue("第一条\n");

    fireEvent.change(taboos, { target: { value: "第一条\n  第二条  " } });
    expect(taboos).toHaveValue("第一条\n  第二条  ");
    fireEvent.blur(taboos);
    expect(taboos).toHaveValue("第一条\n第二条");

    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].series_bible.taboos).toEqual(["第一条", "第二条"]);
  });

  it("resets focused line-list text when a different plan prop arrives", async () => {
    const firstPlan = createContinuityPlan("single_video");
    const nextPlan = createContinuityPlan("single_video");
    firstPlan.series_bible.taboos = ["旧设定"];
    nextPlan.series_bible.taboos = ["新设定一", "新设定二"];
    const { rerender } = render(
      <GlobalSettingsPage plan={firstPlan} saving={false} onSave={vi.fn()} />,
    );
    const taboos = screen.getByLabelText("禁忌");

    fireEvent.focus(taboos);
    fireEvent.change(taboos, { target: { value: "未完成草稿\n" } });
    expect(taboos).toHaveValue("未完成草稿\n");

    rerender(<GlobalSettingsPage plan={nextPlan} saving={false} onSave={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("禁忌")).toHaveValue("新设定一\n新设定二"));
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeDisabled();
  });

  it("shows and saves episode planning for a series", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GlobalSettingsPage plan={seriesPlan} saving={false} onSave={onSave} />);

    expect(screen.getByRole("heading", { name: "分集规划" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("第 1 集目标"), { target: { value: "找到失踪证人" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].episodes[0].goal).toBe("找到失踪证人");
  });

  it("keeps the edited draft visible and reports a rejected save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("服务端拒绝保存"));
    render(
      <GlobalSettingsPage
        plan={createContinuityPlan("single_video")}
        saving={false}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("世界观"), { target: { value: "失败后仍保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("服务端拒绝保存");
    expect(screen.getByLabelText("世界观")).toHaveValue("失败后仍保留的草稿");
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeEnabled();
  });

  it("hides single-video episode controls while preserving detached stored episode data", async () => {
    const plan = createContinuityPlan("single_video");
    const storedEpisode = {
      ...createContinuityPlan("mini_series").episodes[0],
      episode_number: 7,
      inherited_state: ["保留跨集继承"],
      locked: true,
    };
    plan.active_episode_number = 7;
    plan.episodes = [storedEpisode];
    const originalWorldview = plan.series_bible.worldview;
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<GlobalSettingsPage plan={plan} saving={false} onSave={onSave} />);

    expect(screen.queryByRole("heading", { name: "分集规划" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 7 集目标")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 7 集继承状态")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加分集" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("世界观"), { target: { value: "单视频新世界观" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    const savedPlan = onSave.mock.calls[0][0];
    expect(savedPlan.active_episode_number).toBe(7);
    expect(savedPlan.episodes).toEqual([storedEpisode]);
    expect(savedPlan.episodes).not.toBe(plan.episodes);
    expect(savedPlan.story_state).not.toBe(plan.story_state);
    expect(plan.series_bible.worldview).toBe(originalWorldview);
  });

  it("saves only a dirty draft and resets the dirty baseline after success", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <GlobalSettingsPage
        plan={createContinuityPlan("single_video")}
        saving={false}
        onSave={onSave}
      />,
    );
    const saveButton = screen.getByRole("button", { name: "保存全局设定" });

    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("主线"), { target: { value: "新的故事主线" } });
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("replaces the draft and baseline when a different plan prop arrives", async () => {
    const firstPlan = createContinuityPlan("single_video");
    const nextPlan = createContinuityPlan("long_series");
    nextPlan.series_bible.worldview = "新项目世界观";
    const { rerender } = render(
      <GlobalSettingsPage plan={firstPlan} saving={false} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("世界观"), { target: { value: "即将放弃的草稿" } });
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeEnabled();

    rerender(<GlobalSettingsPage plan={nextPlan} saving={false} onSave={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("世界观")).toHaveValue("新项目世界观"));
    expect(screen.getByRole("heading", { name: "分集规划" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeDisabled();
  });

  it("ignores an older save success after a different plan prop arrives", async () => {
    const deferred = createDeferred();
    const onSave = vi.fn().mockReturnValue(deferred.promise);
    const firstPlan = createContinuityPlan("single_video");
    const nextPlan = createContinuityPlan("single_video");
    nextPlan.series_bible.worldview = "新项目世界观";
    const { rerender } = render(
      <GlobalSettingsPage plan={firstPlan} saving={false} onSave={onSave} />,
    );

    fireEvent.change(screen.getByLabelText("世界观"), { target: { value: "旧项目待保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    rerender(<GlobalSettingsPage plan={nextPlan} saving={false} onSave={onSave} />);
    await waitFor(() => expect(screen.getByLabelText("世界观")).toHaveValue("新项目世界观"));

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(screen.getByLabelText("世界观")).toHaveValue("新项目世界观");
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an older save rejection after a different plan prop arrives", async () => {
    const deferred = createDeferred();
    const onSave = vi.fn().mockReturnValue(deferred.promise);
    const firstPlan = createContinuityPlan("single_video");
    const nextPlan = createContinuityPlan("long_series");
    nextPlan.series_bible.main_arc = "新项目主线";
    const { rerender } = render(
      <GlobalSettingsPage plan={firstPlan} saving={false} onSave={onSave} />,
    );

    fireEvent.change(screen.getByLabelText("主线"), { target: { value: "旧项目待保存主线" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    rerender(<GlobalSettingsPage plan={nextPlan} saving={false} onSave={onSave} />);
    await waitFor(() => expect(screen.getByLabelText("主线")).toHaveValue("新项目主线"));

    await act(async () => {
      deferred.reject(new Error("旧项目保存失败"));
      await deferred.promise.catch(() => undefined);
    });

    expect(screen.getByLabelText("主线")).toHaveValue("新项目主线");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存全局设定" })).toBeDisabled();
  });

  it("serializes every continuity field with normalized lists and stable episode indexing", async () => {
    const plan = createContinuityPlan("mini_series");
    plan.series_bible.taboos = ["禁忌一", "禁忌二"];
    plan.episodes = [{ ...plan.episodes[0], episode_number: 3 }];
    plan.active_episode_number = 3;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GlobalSettingsPage plan={plan} saving={false} onSave={onSave} />);

    expect(screen.getByLabelText("禁忌")).toHaveValue("禁忌一\n禁忌二");

    const scalarEdits: Array<[string, string]> = [
      ["世界观", "世界观新值"],
      ["主线", "主线新值"],
      ["风格锁定", "风格新值"],
      ["视觉规则", "视觉新值"],
    ];
    const listEdits: Array<[string, string]> = [
      ["禁忌", "禁忌甲"],
      ["场景", "场景甲"],
      ["道具", "道具甲"],
      ["关系图", "关系甲"],
      ["角色认知", "认知甲"],
      ["角色状态", "状态甲"],
      ["关系变化", "变化甲"],
      ["进行中伏笔", "伏笔甲"],
      ["已回收伏笔", "回收甲"],
      ["道具状态", "道具状态甲"],
      ["当前位置", "位置甲"],
    ];

    scalarEdits.forEach(([label, value]) => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    });
    listEdits.forEach(([label, value]) => {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: `  ${value}  \n\n${value}乙  ` },
      });
    });
    fireEvent.change(screen.getByLabelText("第 3 集分集标题"), { target: { value: "第三集" } });
    fireEvent.change(screen.getByLabelText("第 3 集目标"), { target: { value: "目标新值" } });
    fireEvent.change(screen.getByLabelText("第 3 集冲突"), { target: { value: "冲突新值" } });
    fireEvent.change(screen.getByLabelText("第 3 集反转"), { target: { value: "反转新值" } });
    fireEvent.change(screen.getByLabelText("第 3 集悬念"), { target: { value: "悬念新值" } });
    fireEvent.change(screen.getByLabelText("第 3 集继承状态"), {
      target: { value: "  继承甲\n\n继承乙  " },
    });
    fireEvent.click(screen.getByLabelText("第 3 集锁定"));
    fireEvent.click(screen.getByRole("button", { name: "添加分集" }));

    expect(screen.getByLabelText("第 4 集目标")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "设第 4 集为当前制作集" }));
    fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const savedPlan = onSave.mock.calls[0][0];
    expect(savedPlan.series_bible).toEqual({
      worldview: "世界观新值",
      main_arc: "主线新值",
      style_lock: "风格新值",
      visual_rules: "视觉新值",
      taboos: ["禁忌甲", "禁忌甲乙"],
      locations: ["场景甲", "场景甲乙"],
      props: ["道具甲", "道具甲乙"],
      relationship_map: ["关系甲", "关系甲乙"],
    });
    expect(savedPlan.story_state).toEqual({
      character_knowledge: ["认知甲", "认知甲乙"],
      character_status: ["状态甲", "状态甲乙"],
      relationship_changes: ["变化甲", "变化甲乙"],
      active_foreshadowing: ["伏笔甲", "伏笔甲乙"],
      resolved_foreshadowing: ["回收甲", "回收甲乙"],
      prop_state: ["道具状态甲", "道具状态甲乙"],
      current_locations: ["位置甲", "位置甲乙"],
    });
    expect(savedPlan.episodes).toEqual([
      {
        episode_number: 3,
        title: "第三集",
        goal: "目标新值",
        conflict: "冲突新值",
        twist: "反转新值",
        cliffhanger: "悬念新值",
        inherited_state: ["继承甲", "继承乙"],
        locked: true,
      },
      {
        episode_number: 4,
        title: "",
        goal: "",
        conflict: "",
        twist: "",
        cliffhanger: "",
        inherited_state: [],
        locked: false,
      },
    ]);
    expect(savedPlan.active_episode_number).toBe(4);
    expect(JSON.parse(JSON.stringify(savedPlan))).toEqual(savedPlan);
    expect(plan.series_bible.worldview).not.toBe("世界观新值");
    expect(plan.episodes[0].locked).toBe(false);
  });
});
