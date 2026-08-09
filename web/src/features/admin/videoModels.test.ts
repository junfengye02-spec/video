import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAdminVideoModels, updateAdminVideoModelDuration } from "./videoModels";

const authMocks = vi.hoisted(() => ({ authRequest: vi.fn() }));

vi.mock("../../auth/api", () => ({ authRequest: authMocks.authRequest }));

beforeEach(() => {
  authMocks.authRequest.mockReset();
});

describe("video model administration service", () => {
  it("loads the provider catalog and persisted configuration union", async () => {
    authMocks.authRequest.mockResolvedValue({
      provider: "newapi",
      catalog_refresh_status: "failed",
      catalog_error_code: "provider_model_catalog_unavailable",
      models: [{
        provider: "newapi",
        model_id: "removed/model-v1",
        catalog_status: "missing_from_catalog",
        configuration_status: "configured",
        call_duration_seconds: 10,
        version: 3,
        profile_revision: "duration-v3",
        updated_by: "admin-1",
        updated_at: "2026-07-28T08:00:00Z",
      }],
    });

    await expect(listAdminVideoModels()).resolves.toMatchObject({
      catalog_refresh_status: "failed",
      models: [{
        model_id: "removed/model-v1",
        catalog_status: "missing_from_catalog",
        call_duration_seconds: 10,
        version: 3,
      }],
    });
    expect(authMocks.authRequest).toHaveBeenCalledWith(
      "/api/admin/video-model-duration-settings",
    );
  });

  it("encodes model IDs and sends the optimistic version with the audit reason", async () => {
    authMocks.authRequest.mockResolvedValue({
      provider: "newapi",
      model_id: "vendor/model-v2",
      configuration_status: "configured",
      call_duration_seconds: 12,
      version: 4,
      profile_revision: "duration-v4",
      updated_by: "admin-1",
      updated_at: "2026-07-28T08:30:00Z",
    });

    await updateAdminVideoModelDuration("vendor/model-v2", {
      call_duration_seconds: 12,
      expected_version: 3,
      reason: "provider contract reverified",
    });

    expect(authMocks.authRequest).toHaveBeenCalledWith(
      "/api/admin/video-model-duration-settings/vendor%2Fmodel-v2",
      {
        method: "PUT",
        body: JSON.stringify({
          call_duration_seconds: 12,
          expected_version: 3,
          reason: "provider contract reverified",
        }),
      },
    );
  });

  it("rejects non-finite duration values in an otherwise successful response", async () => {
    authMocks.authRequest.mockResolvedValue({
      provider: "newapi",
      model_id: "bad-model",
      configuration_status: "configured",
      call_duration_seconds: Number.POSITIVE_INFINITY,
      version: 1,
      profile_revision: "duration-v1",
      updated_by: "admin-1",
      updated_at: "2026-07-28T08:30:00Z",
    });

    await expect(updateAdminVideoModelDuration("bad-model", {
      call_duration_seconds: 10,
      expected_version: 0,
      reason: "test",
    })).rejects.toThrow("Invalid call_duration_seconds");
  });
});
