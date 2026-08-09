import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InspirationMessageRow } from "./InspirationMessageRow";

afterEach(cleanup);

describe("InspirationMessageRow", () => {
  it("renders the assistant brand name only once", () => {
    render(<InspirationMessageRow role="assistant" content="Assistant response" />);

    const message = screen.getByRole("article");
    expect(within(message).getAllByText("mise")).toHaveLength(1);
    expect(within(message).getByText("Assistant response")).toBeInTheDocument();
  });
});
