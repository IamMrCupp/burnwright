import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceController, appearanceStore, type AppearanceDeps } from "../../lib/appearance";
import type { ThemeSource } from "../../lib/theme";
import { AppearancePicker } from "./AppearancePicker";

function controllerOn(root: HTMLElement, stored?: string, themes?: ThemeSource) {
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
    themes,
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
    expect(controller.getState().choice).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(select).toHaveValue("dark");
  });
});

describe("AppearancePicker with a themes folder", () => {
  const files: Record<string, string> = {
    "amber.json": JSON.stringify({ name: "Amber", base: "dark", colors: { bg: "#120d02" } }),
    "odd.json": JSON.stringify({ name: "Odd", base: "light", colors: { font: "Georgia" } }),
    "broken.json": "{",
  };

  function folder() {
    const source = {
      list: vi.fn(async () => ({
        folder: "/config/themes",
        files: Object.entries(files).map(([file, text]) => ({ file, text })),
      })),
      openFolder: vi.fn(async () => {}),
    };
    return source;
  }

  it("has no theme controls where there's no folder", () => {
    render(<AppearancePicker controller={controllerOn(document.createElement("html"))} />);
    expect(screen.queryByRole("button", { name: "Themes folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Themes" })).not.toBeInTheDocument();
  });

  it("lists the themes after the built-in choices and says which files it left out", async () => {
    render(
      <AppearancePicker controller={controllerOn(document.createElement("html"), undefined, folder())} />,
    );
    await screen.findByRole("option", { name: "Amber" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
      "Amber",
      "Odd",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      /^broken\.json isn't offered: it isn't valid JSON .*\.$/,
    );
  });

  it("applies a picked theme and says what in its file isn't used", async () => {
    const root = document.createElement("html");
    render(<AppearancePicker controller={controllerOn(root, undefined, folder())} />);
    await screen.findByRole("option", { name: "Odd" });

    fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "theme:odd.json" } });
    expect(root.dataset.theme).toBe("light");
    expect(screen.getByLabelText("Appearance")).toHaveValue("theme:odd.json");
    expect(screen.getByRole("status")).toHaveTextContent(
      `odd.json has entries that aren't used: "font" isn't a colour burnwright has.`,
    );

    fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "theme:amber.json" } });
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--bw-bg")).toBe("#120d02");
    expect(screen.getByRole("status")).not.toHaveTextContent("odd.json");
  });

  it("opens the folder and reads it again from its two buttons", async () => {
    const source = folder();
    render(
      <AppearancePicker controller={controllerOn(document.createElement("html"), undefined, source)} />,
    );
    await screen.findByRole("option", { name: "Amber" });
    expect(source.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Themes folder" }));
    expect(source.openFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Themes folder" })).toHaveAttribute(
      "title",
      "/config/themes",
    );

    fireEvent.click(screen.getByRole("button", { name: "Reload themes" }));
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
  });
});
