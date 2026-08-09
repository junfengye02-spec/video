import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InspirationComposer } from "./InspirationComposer";

vi.mock("../../generation/GenerationModelPicker", () => ({
  GenerationModelPicker: ({ label }: { label: string }) => <span>{label}</span>,
}));

afterEach(cleanup);

describe("InspirationComposer", () => {
  it("renders the text model label as Chinese instead of a literal Unicode escape", () => {
    render(
      <InspirationComposer
        disabled={false}
        loading={false}
        message=""
        onChange={vi.fn()}
        onTextModelChange={vi.fn()}
        onSubmit={vi.fn()}
        suggestions={[]}
        textModel="gpt-5.6-sol"
      />,
    );

    expect(screen.getByText("灵感文本模型")).toBeInTheDocument();
    expect(screen.queryByText(String.raw`\u7075\u611f\u6587\u672c\u6a21\u578b`)).not.toBeInTheDocument();
  });
});
