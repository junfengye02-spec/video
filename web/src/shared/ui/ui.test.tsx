import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Dialog, IconButton, Menu, MenuItem, Popover, Tabs } from ".";

afterEach(() => cleanup());

describe("shared UI primitives", () => {
  it("keeps loading buttons stable, busy and disabled", () => {
    render(<Button loading icon={<span>+</span>}>创建项目</Button>);
    const button = screen.getByRole("button", { name: "创建项目" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("defaults shared buttons to non-submitting controls", () => {
    const onSubmit = vi.fn();
    render(<form onSubmit={onSubmit}><Button>设置</Button></form>);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("moves tabs with arrow keys and selects the focused tab", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        ariaLabel="模式"
        value="story"
        onValueChange={onChange}
        items={[
          { value: "story", label: "故事" },
          { value: "brand", label: "品牌" },
        ]}
      />,
    );
    const story = screen.getByRole("tab", { name: "故事" });
    story.focus();
    fireEvent.keyDown(story, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "品牌" })).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith("brand");
  });

  it("does not emit duplicate tab changes for the selected tab", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        ariaLabel="模式"
        value="story"
        onValueChange={onChange}
        items={[
          { value: "story", label: "故事" },
          { value: "brand", label: "品牌" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "故事" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens menus with keyboard focus and restores the trigger on Escape", async () => {
    render(
      <Menu
        label="项目操作"
        trigger={(props) => <IconButton {...props} label="更多" icon={<span>…</span>} />}
      >
        <MenuItem>导出</MenuItem>
        <MenuItem danger>删除</MenuItem>
      </Menu>,
    );
    const trigger = screen.getByRole("button", { name: "更多" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "导出" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens menus from ArrowUp and focuses the last enabled item", async () => {
    render(
      <Menu
        label="项目操作"
        trigger={(props) => <IconButton {...props} label="更多" icon={<span>…</span>} />}
      >
        <MenuItem>导出</MenuItem>
        <MenuItem disabled>归档</MenuItem>
        <MenuItem danger>删除</MenuItem>
      </Menu>,
    );
    const trigger = screen.getByRole("button", { name: "更多" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "删除" })).toHaveFocus());
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("focuses popover content and restores its trigger on Escape", async () => {
    render(
      <Popover
        label="创作设置"
        trigger={(props) => <Button {...props}>创作设置</Button>}
      >
        <label>画幅<select><option>16:9</option></select></label>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "创作设置" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "画幅" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "创作设置" })).not.toBeInTheDocument();
  });

  it("traps dialog focus and restores its opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={openerRef} type="button" onClick={() => setOpen(true)}>打开</button>
          <Dialog open={open} title="确认删除" openerRef={openerRef} onClose={() => setOpen(false)}>
            <button type="button" onClick={() => setOpen(false)}>取消</button>
            <button type="button">确认</button>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开" });
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("coalesces repeated dialog close gestures", async () => {
    const onClose = vi.fn();
    render(<Dialog open title="确认" onClose={onClose}><button type="button">继续</button></Dialog>);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
