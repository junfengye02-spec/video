import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the key gate and workbench shell", () => {
    render(<App />);
    expect(screen.getByText("OpenMontage Short Drama Workbench")).toBeInTheDocument();
    expect(screen.getByLabelText("Text API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Image API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Video API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Text Model")).toHaveValue("gpt-5.5");
    expect(screen.getByLabelText("Image Model")).toHaveValue("gpt-image-2");
    expect(screen.getByLabelText("Video Model")).toHaveValue("omni_flash-10s");
    expect(screen.getByRole("button", { name: "Render final video" })).toBeDisabled();
  });
});
