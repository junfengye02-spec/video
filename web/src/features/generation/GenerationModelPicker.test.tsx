import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationModelPicker } from "./GenerationModelPicker";

const strings = {
  loading: "Loading models",
  loadError: "Could not load models",
  empty: "No models",
  refresh: "Refresh models",
  unconfiguredDuration: "The administrator has not configured a generation duration",
  fixedDuration: (seconds: number) => `Fixed ${seconds}s`,
  supportedDurations: (seconds: number[]) => `Supports ${seconds.join(" / ")}s`,
  flexibleDuration: (minimum: number | null, maximum: number | null) => (
    `Adjustable ${minimum ?? "?"}-${maximum ?? "?"}s`
  ),
  frameCapabilityBoth: "Native first and last frames",
  frameCapabilityStart: "Native first frame",
  frameCapabilityEnd: "Native last frame",
  frameCapabilityNone: "Native first/last frames unavailable",
};

afterEach(cleanup);

describe("GenerationModelPicker", () => {
  it("loads capability models and lets the user select a returned model", async () => {
    const onChange = vi.fn();
    const loadModels = vi.fn(async () => ({
      capability: "image" as const,
      models: ["image-a", "image-b"],
    }));
    render(
      <GenerationModelPicker
        capability="image"
        label="Image model"
        strings={strings}
        value="image-a"
        loadModels={loadModels}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Image model" })).toBeInTheDocument());
    expect(screen.queryByText(/models available/)).not.toBeInTheDocument();
    expect(loadModels).toHaveBeenCalledWith("image");
    const trigger = screen.getByRole("button", { name: "Image model" });
    expect(trigger).toHaveTextContent("image-a");

    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((option) => option.textContent)).toEqual([
      "image-a",
      "image-b",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "image-b" }));
    expect(onChange).toHaveBeenCalledWith("image-b");
  });

  it("keeps the current model editable when loading fails", async () => {
    const loadModels = vi.fn().mockRejectedValueOnce(new Error("offline"));
    render(
      <GenerationModelPicker
        capability="video"
        label="Video model"
        strings={strings}
        value="saved-video-model"
        loadModels={loadModels}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Could not load models")).toBeInTheDocument());
    expect(screen.getByLabelText("Video model")).toHaveValue("saved-video-model");
    expect(screen.queryByRole("button", { name: "Refresh models" })).not.toBeInTheDocument();
  });

  it("shows verified duration and native frame capabilities for video models", async () => {
    const loadModels = vi.fn(async () => ({
      capability: "video" as const,
      models: ["omni_flash-10s"],
      profiles: [{
        provider: "newapi",
        model_id: "omni_flash-10s",
        operation: "text_to_video" as const,
        duration_mode: "fixed" as const,
        fixed_duration_seconds: 10,
        supported_duration_seconds: [],
        min_duration_seconds: null,
        max_duration_seconds: null,
        supports_start_frame: false,
        supports_end_frame: false,
        supports_extend: false,
        supports_multi_shot_prompt: false,
        contract_source: "admin_configuration" as const,
        profile_revision: "duration-v1",
        duration_configuration_status: "configured" as const,
      }],
    }));

    render(
      <GenerationModelPicker
        capability="video"
        label="Video model"
        strings={strings}
        value="omni_flash-10s"
        loadModels={loadModels}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText(
      "Fixed 10s · Native first/last frames unavailable",
    )).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Video model" })).toHaveTextContent(
      "omni_flash-10s · Fixed 10s",
    );
  });

  it("marks an unverified duration contract in the model menu", async () => {
    const onAvailabilityChange = vi.fn();
    const loadModels = vi.fn(async () => ({
      capability: "video" as const,
      models: ["catalog-only-model"],
      profiles: [{
        provider: "newapi",
        model_id: "catalog-only-model",
        operation: "text_to_video" as const,
        duration_mode: "unknown" as const,
        fixed_duration_seconds: null,
        supported_duration_seconds: [],
        min_duration_seconds: null,
        max_duration_seconds: null,
        supports_start_frame: false,
        supports_end_frame: false,
        supports_extend: false,
        supports_multi_shot_prompt: false,
        contract_source: "provider_catalog" as const,
        profile_revision: "provider-catalog-unknown-v1",
        duration_configuration_status: "unconfigured" as const,
      }],
    }));

    render(
      <GenerationModelPicker
        capability="video"
        label="Video model"
        strings={strings}
        value="catalog-only-model"
        loadModels={loadModels}
        onChange={vi.fn()}
        onAvailabilityChange={onAvailabilityChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Video model" }))
      .toHaveTextContent(
        "catalog-only-model · The administrator has not configured a generation duration",
      ));
    fireEvent.click(screen.getByRole("button", { name: "Video model" }));
    expect(screen.getByRole("menuitem", {
      name: /catalog-only-model.*administrator has not configured/,
    })).toBeDisabled();
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);
  });
});
