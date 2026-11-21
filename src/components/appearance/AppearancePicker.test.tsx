import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppearanceController, appearanceStore, type AppearanceDeps } from "../../lib/appearance";
import { AppearancePicker } from "./AppearancePicker";

function controllerOn(root: HTMLElement, stored?: string) {
  const values = new Map<string, string>();
  if (stored) values.set("burnwright.appearance", stored);
  const controller = new AppearanceController({
    store: appearanceStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    }),
    root,
    systemDark: {
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AppearanceDeps["systemDark"],
  });
  controller.start();
  return controller;
}

describe("AppearancePicker", () => {
  it("offers System, Light and Dark, with the current choice picked", () => {
    render(<AppearancePicker controller={controllerOn(document.createElement("html"), "dark")} />);
    const select = screen.getByLabelText("Appearance");
    expect(select).toHaveValue("dark");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
  });

  it("changes the look when another choice is picked", () => {
    const root = document.createElement("html");
    const controller = controllerOn(root);
    render(<AppearancePicker controller={controller} />);
    const select = screen.getByLabelText("Appearance");
    expect(select).toHaveValue("system");
    expect(root.dataset.theme).toBe("light");

    fireEvent.change(select, { target: { value: "dark" } });
    expect(controller.getState()).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(select).toHaveValue("dark");
  });
});
