import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetRecord } from "../domain/types";
import { createProjectResponse } from "../test/fixtures";
import { ResourceLibraryPage, type ResourceLibraryPageProps } from "./ResourceLibraryPage";

const project = createProjectResponse();
const resourceProps: ResourceLibraryPageProps = {
  assets: project.series_bible.assets ?? [],
  consistencyReport: project.consistency_report,
  currentShotId: "shot-1",
  shots: project.storyboard.shots,
  uploading: false,
  onBindAsset: vi.fn().mockResolvedValue(undefined),
  onUploadReferenceImage: vi.fn().mockResolvedValue(undefined),
};
const secondaryAsset: AssetRecord = {
  id: "prop-envelope",
  kind: "prop",
  label: "信封",
  description: "雨夜发现的密封信件",
  prompt: "红色火漆封口",
  reference_images: [],
};

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ResourceLibraryPage", () => {
  it("never shows asset detail and upload drawers at the same time", () => {
    render(<ResourceLibraryPage {...resourceProps} />);
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    const detail = screen.getByRole("dialog", { name: "资源详情" });
    expect(detail).toBeInTheDocument();
    expect(detail).not.toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
    const upload = screen.getByRole("dialog", { name: "上传资源" });
    expect(upload).toBeInTheDocument();
    expect(upload).not.toHaveAttribute("aria-modal", "true");
  });

  it("binds the selected resource through the current shot save contract", async () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    const originalShotIds = resourceProps.assets[0].shot_ids;
    render(
      <ResourceLibraryPage
        {...resourceProps}
        currentShotId="shot-1"
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "绑定到当前分镜" }));

    await waitFor(() => {
      expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", true);
    });
    expect(resourceProps.assets[0].shot_ids).toBe(originalShotIds);
  });

  it("unbinds an asset already linked to the current shot", async () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: ["asset-char-1"] } : shot
    ));
    render(<ResourceLibraryPage {...resourceProps} shots={shots} onBindAsset={onBindAsset} />);
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "从当前分镜解绑" }));

    await waitFor(() => {
      expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", false);
    });
  });

  it("disables binding when there is no current shot", () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        currentShotId={null}
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));

    expect(screen.getByRole("button", { name: "绑定到当前分镜" })).toBeDisabled();
    expect(onBindAsset).not.toHaveBeenCalled();
  });

  it("keeps detail open and reports a binding failure after clearing its busy state", async () => {
    const deferred = createDeferred();
    const onBindAsset = vi.fn().mockReturnValue(deferred.promise);
    render(<ResourceLibraryPage {...resourceProps} onBindAsset={onBindAsset} />);
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "绑定到当前分镜" }));

    expect(screen.getByRole("button", { name: "正在更新绑定" })).toBeDisabled();
    deferred.reject(new Error("绑定请求被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("绑定请求被拒绝");
    expect(screen.getByRole("dialog", { name: "资源详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "绑定到当前分镜" })).toBeEnabled();
  });

  it("keeps a pending unbind anchored to its asset and gates every panel transition", async () => {
    const deferred = createDeferred();
    const onBindAsset = vi.fn().mockReturnValue(deferred.promise);
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: ["asset-char-1"] } : shot
    ));
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        shots={shots}
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "从当前分镜解绑" }));

    expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", false);
    expect(screen.getByRole("button", { name: "正在更新绑定" })).toBeDisabled();
    const otherAsset = screen.getByRole("button", { name: "查看资源 信封" });
    const upload = screen.getByRole("button", { name: "上传资源" });
    const close = screen.getByRole("button", { name: "关闭资源详情" });
    expect(otherAsset).toBeDisabled();
    expect(upload).toBeDisabled();
    expect(close).toBeDisabled();

    fireEvent.click(otherAsset);
    fireEvent.click(upload);
    fireEvent.click(close);
    const detail = screen.getByRole("dialog", { name: "资源详情" });
    expect(within(detail).getByRole("heading", { name: "玛拉" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "上传资源" })).not.toBeInTheDocument();

    deferred.reject(new Error("解绑请求被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("解绑请求被拒绝");
    expect(within(screen.getByRole("dialog", { name: "资源详情" })).getByRole("heading", { name: "玛拉" })).toBeInTheDocument();
    await waitFor(() => {
      expect(otherAsset).toBeEnabled();
      expect(upload).toBeEnabled();
      expect(close).toBeEnabled();
    });
  });

  it("renders all resource media and only consistency issues for linked shots", () => {
    const asset: AssetRecord = {
      ...resourceProps.assets[0],
      prompt: "红色风衣，短发，冷色写实",
      reference_images: ["/refs/mara-front.png", "/refs/mara-profile.png"],
      media_urls: ["/media/mara-turnaround.mp4", "/media/mara-poster.webp"],
    };
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: [asset.id, asset.id] } : shot
    ));
    const consistencyReport = {
      score: 60,
      issues: [
        { shot_id: "shot-1", severity: "warning" as const, code: "wardrobe", message: "风衣颜色不一致" },
        { shot_id: "shot-2", severity: "error" as const, code: "lighting", message: "未关联分镜问题" },
        { shot_id: null, severity: "info" as const, code: "project", message: "项目级提示" },
      ],
    };
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[asset]}
        shots={shots}
        consistencyReport={consistencyReport}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    const detail = screen.getByRole("dialog", { name: "资源详情" });

    expect(screen.getByText("红色风衣，短发，冷色写实")).toBeInTheDocument();
    expect(within(detail).getByText("已关联 1 个分镜")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "玛拉 参考图 1" })).toHaveAttribute("src", "/refs/mara-front.png");
    expect(screen.getByRole("img", { name: "玛拉 参考图 2" })).toHaveAttribute("src", "/refs/mara-profile.png");
    expect(screen.getByLabelText("玛拉 媒体 1")).toHaveAttribute("src", "/media/mara-turnaround.mp4");
    expect(screen.getByRole("img", { name: "玛拉 媒体 2" })).toHaveAttribute("src", "/media/mara-poster.webp");
    expect(screen.getByText("风衣颜色不一致")).toBeInTheDocument();
    expect(screen.queryByText("未关联分镜问题")).not.toBeInTheDocument();
    expect(screen.queryByText("项目级提示")).not.toBeInTheDocument();
  });

  it("does not render a consistency section without issues for linked shots", () => {
    render(
      <ResourceLibraryPage
        {...resourceProps}
        consistencyReport={{
          score: 80,
          issues: [{ shot_id: "shot-2", severity: "warning", code: "other", message: "其他分镜" }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));

    expect(screen.queryByRole("heading", { name: "相关一致性问题" })).not.toBeInTheDocument();
  });

  it("offers only character, scene and prop upload types and requires a file", () => {
    const onUploadReferenceImage = vi.fn().mockResolvedValue(undefined);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));

    const typeSelect = screen.getByLabelText("资源类型");
    expect(within(typeSelect).getAllByRole("option").map((option) => [option.textContent, option.getAttribute("value")])).toEqual([
      ["角色", "character"],
      ["场景", "scene"],
      ["道具", "prop"],
    ]);
    expect(screen.getByRole("button", { name: "提交上传" })).toBeDisabled();
    expect(onUploadReferenceImage).not.toHaveBeenCalled();
  });

  it("submits the exact trimmed reference image upload payload", async () => {
    const onUploadReferenceImage = vi.fn().mockResolvedValue(undefined);
    const file = new File(["rain"], "rain.webp", { type: "image/webp" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    fireEvent.change(screen.getByLabelText("资源类型"), { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "  雨巷  " } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "  夜雨旧城  " } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "  冷色石板路  " } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    await waitFor(() => {
      expect(onUploadReferenceImage).toHaveBeenCalledWith({
        kind: "scene",
        label: "雨巷",
        description: "夜雨旧城",
        prompt: "冷色石板路",
        file,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "上传资源" })).not.toBeInTheDocument();
    });
  });

  it("retains the upload panel and form values when upload rejects", async () => {
    const onUploadReferenceImage = vi.fn().mockRejectedValue(new Error("上传请求被拒绝"));
    const file = new File(["mara"], "mara.png", { type: "image/png" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "保留的名称" } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("上传请求被拒绝");
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的名称");
    expect(screen.getByRole("button", { name: "提交上传" })).toBeEnabled();
  });

  it("keeps a pending upload mounted and gates every panel transition", async () => {
    const deferred = createDeferred();
    const onUploadReferenceImage = vi.fn().mockReturnValue(deferred.promise);
    const file = new File(["rain"], "rain.webp", { type: "image/webp" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "保留的雨巷" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "保留的描述" } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    expect(onUploadReferenceImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在上传" })).toBeDisabled();
    const otherAsset = screen.getByRole("button", { name: "查看资源 信封" });
    const upload = screen.getByRole("button", { name: "上传资源" });
    const close = screen.getByRole("button", { name: "关闭上传资源" });
    expect(otherAsset).toBeDisabled();
    expect(upload).toBeDisabled();
    expect(close).toBeDisabled();

    fireEvent.click(otherAsset);
    fireEvent.click(upload);
    fireEvent.click(close);
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的雨巷");

    deferred.reject(new Error("延迟上传被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("延迟上传被拒绝");
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的雨巷");
    expect(screen.getByLabelText("描述")).toHaveValue("保留的描述");
    await waitFor(() => {
      expect(otherAsset).toBeEnabled();
      expect(upload).toBeEnabled();
      expect(close).toBeEnabled();
    });
  });

  it("honors the externally supplied uploading busy state", () => {
    const { rerender } = render(<ResourceLibraryPage {...resourceProps} uploading={false} />);
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    rerender(<ResourceLibraryPage {...resourceProps} uploading />);

    expect(screen.getByRole("button", { name: "正在上传" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭上传资源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传资源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看资源 玛拉" })).toBeDisabled();
  });

  it("does not surface a malformed unsupported resource kind", () => {
    const malformedAsset = {
      id: "audio-rain",
      kind: "audio",
      label: "雨声音效",
      reference_images: [],
    } as unknown as AssetRecord;
    render(<ResourceLibraryPage {...resourceProps} assets={[...resourceProps.assets, malformedAsset]} />);

    expect(screen.queryByRole("button", { name: "查看资源 雨声音效" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("资源筛选")).queryByRole("option", { name: "音频" })).not.toBeInTheDocument();
  });
});
