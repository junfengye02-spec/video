import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequestError } from "../../auth/api";
import { VideoModelAdminPage } from "./VideoModelAdminPage";

const serviceMocks = vi.hoisted(() => ({
  listAdminVideoModels: vi.fn(),
  updateAdminVideoModelDuration: vi.fn(),
}));

vi.mock("../../features/admin/videoModels", () => serviceMocks);

const catalog = {
  provider: "newapi" as const,
  catalog_refresh_status: "ok" as const,
  catalog_error_code: null,
  models: [{
    provider: "newapi",
    model_id: "configured-model-with-a-very-long-provider-identifier-v3",
    catalog_status: "available" as const,
    configuration_status: "configured" as const,
    call_duration_seconds: 10,
    version: 3,
    profile_revision: "video-model-duration-v3-long-revision",
    updated_by: "admin-1",
    updated_at: "2026-07-28T08:00:00Z",
  }, {
    provider: "newapi",
    model_id: "catalog-only-model",
    catalog_status: "available" as const,
    configuration_status: "unconfigured" as const,
    call_duration_seconds: null,
    version: null,
    profile_revision: null,
    updated_by: null,
    updated_at: null,
  }, {
    provider: "newapi",
    model_id: "removed/model-v1",
    catalog_status: "missing_from_catalog" as const,
    configuration_status: "configured" as const,
    call_duration_seconds: 5,
    version: 2,
    profile_revision: "video-model-duration-v2",
    updated_by: "admin-2",
    updated_at: "2026-07-27T08:00:00Z",
  }],
};

beforeEach(() => {
  serviceMocks.listAdminVideoModels.mockReset();
  serviceMocks.updateAdminVideoModelDuration.mockReset();
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: "zh-CN",
  });
  serviceMocks.listAdminVideoModels.mockResolvedValue(catalog);
  serviceMocks.updateAdminVideoModelDuration.mockResolvedValue({
    provider: "newapi",
    model_id: catalog.models[0].model_id,
    configuration_status: "configured",
    call_duration_seconds: 12,
    version: 4,
    profile_revision: "video-model-duration-v4-new-revision",
    updated_by: "admin-1",
    updated_at: "2026-07-28T09:00:00Z",
  });
});

afterEach(cleanup);

describe("VideoModelAdminPage", () => {
  it("shows API-backed configured, unconfigured, and catalog-missing states", async () => {
    render(<VideoModelAdminPage />);

    expect(await screen.findByRole("heading", { name: "视频模型时长" })).toBeInTheDocument();
    expect(screen.getAllByText("已配置")).toHaveLength(2);
    expect(screen.getByText("未配置")).toBeInTheDocument();
    expect(screen.getByText("目录已缺失")).toBeInTheDocument();
    expect(screen.getByText("video-model-duration-v3-long-revision")).toBeInTheDocument();
    expect(screen.getByText("尚未配置")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "按模型 ID 搜索" }), {
      target: { value: "catalog-only" },
    });
    expect(screen.getByText("catalog-only-model")).toBeInTheDocument();
    expect(screen.queryByText("removed/model-v1")).not.toBeInTheDocument();
  });

  it("requires confirmation and a reason before saving, then shows the new version", async () => {
    render(<VideoModelAdminPage />);
    const modelId = catalog.models[0].model_id;
    const input = await screen.findByLabelText(`${modelId} 的单次生成时长`);
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getAllByRole("button", { name: "复核变更" })[0]);

    const dialog = screen.getByRole("dialog", { name: `确认 ${modelId}` });
    const confirm = within(dialog).getByRole("button", { name: "保存时长" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("变更原因"), {
      target: { value: "供应商文档与实测结果一致" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(serviceMocks.updateAdminVideoModelDuration).toHaveBeenCalledWith(
      modelId,
      {
        call_duration_seconds: 12,
        expected_version: 3,
        reason: "供应商文档与实测结果一致",
      },
    ));
    expect(await screen.findByText(`${modelId} 已保存为 v4。`)).toBeInTheDocument();
    expect(screen.getByText("v4")).toBeInTheDocument();
    expect(screen.getByText("video-model-duration-v4-new-revision")).toBeInTheDocument();
  });

  it("reloads the latest version after an optimistic-lock conflict", async () => {
    const latestCatalog = {
      ...catalog,
      models: catalog.models.map((item) => item.model_id === catalog.models[0].model_id
        ? { ...item, version: 4, call_duration_seconds: 11 }
        : item),
    };
    serviceMocks.listAdminVideoModels
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(latestCatalog);
    serviceMocks.updateAdminVideoModelDuration.mockRejectedValueOnce(
      new AuthRequestError("conflict", "Conflict", 409),
    );
    render(<VideoModelAdminPage />);
    const modelId = catalog.models[0].model_id;
    fireEvent.change(await screen.findByLabelText(`${modelId} 的单次生成时长`), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "复核变更" })[0]);
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "冲突测试" } });
    fireEvent.click(screen.getByRole("button", { name: "保存时长" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("其他管理员已更新此模型");
    expect(serviceMocks.listAdminVideoModels).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(`${modelId} 的单次生成时长`)).toHaveValue(11);
    expect(screen.getByText("v4")).toBeInTheDocument();
  });

  it("keeps persisted settings visible when the provider catalog refresh fails", async () => {
    serviceMocks.listAdminVideoModels.mockResolvedValue({
      ...catalog,
      catalog_refresh_status: "failed",
      catalog_error_code: "provider_model_catalog_unavailable",
      models: [catalog.models[2]],
    });
    render(<VideoModelAdminPage />);

    expect(await screen.findByText("removed/model-v1")).toBeInTheDocument();
    expect(screen.getByText(/NewAPI 目录刷新失败/)).toBeInTheDocument();
    expect(screen.getByText("provider_model_catalog_unavailable")).toBeInTheDocument();
  });
});
