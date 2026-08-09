import { fireEvent, screen, within } from "@testing-library/react";

export function chooseSelectMenuOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  const menu = screen.getByRole("menu", { name: label });
  fireEvent.click(within(menu).getByRole("menuitem", { name: option }));
}

export function selectMenuOptions(label: string): string[] {
  fireEvent.click(screen.getByRole("button", { name: label }));
  return within(screen.getByRole("menu", { name: label }))
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}
