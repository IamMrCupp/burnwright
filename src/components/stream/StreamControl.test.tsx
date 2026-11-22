import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeEngine } from "../../dev/fakeEngine";
import { DeviceController } from "../../lib/device/controller";
import {
  StreamController,
  type StreamBackend,
  type StreamServerState,
} from "../../lib/stream/controller";
import { StreamControl } from "./StreamControl";

function setup(taken: number[] = []) {
  const device = new DeviceController({
    engine: createFakeEngine(),
    dialogs: { open: async () => null, save: async () => null, openAlgorithms: async () => null },
  });
  const configured: [boolean, number][] = [];
  const backend: StreamBackend = {
    async configure(enabled, port): Promise<StreamServerState> {
      configured.push([enabled, port]);
      if (!enabled) return { running: false, url: null, error: null };
      if (taken.includes(port)) {
        return {
          running: false,
          url: null,
          error: `Port ${port} is in use by something else. Pick another.`,
        };
      }
      return { running: true, url: `http://127.0.0.1:${port}/stream`, error: null };
    },
    publish: async () => {},
  };
  const controller = new StreamController({ backend, device });
  render(<StreamControl controller={controller} />);
  return { controller, configured };
}

const toggle = () => screen.getByRole("button", { name: /^Stream page/ });
const open = () => fireEvent.click(toggle());
const panel = () => screen.queryByRole("region", { name: "Stream page" });
const serve = () => screen.getByRole("checkbox", { name: "Serve a page for OBS" });
const port = () => screen.getByRole("spinbutton", { name: "Port" });

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("StreamControl", () => {
  it("starts off, with the panel put away", () => {
    setup();
    expect(toggle()).toHaveTextContent("Stream page: off");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeNull();
  });

  it("turns the page on and shows its address", async () => {
    const { configured } = setup();
    open();
    expect(serve()).not.toBeChecked();
    expect(port()).toHaveValue(8790);
    fireEvent.click(serve());
    expect(await screen.findByText("http://127.0.0.1:8790/stream")).toBeInTheDocument();
    expect(serve()).toBeChecked();
    expect(toggle()).toHaveTextContent("Stream page: on");
    expect(configured).toEqual([[true, 8790]]);

    fireEvent.click(serve());
    await vi.waitFor(() => expect(toggle()).toHaveTextContent("Stream page: off"));
    expect(screen.queryByText("http://127.0.0.1:8790/stream")).toBeNull();
  });

  it("says what stays off the page", () => {
    setup();
    open();
    expect(panel()).toHaveTextContent("File paths, the log and the buffer stay here.");
    expect(panel()).toHaveTextContent("Only this computer can open it.");
  });

  it("moves to the port typed, on Enter or on leaving the box", async () => {
    const { configured } = setup();
    open();
    fireEvent.click(serve());
    await screen.findByText("http://127.0.0.1:8790/stream");
    fireEvent.change(port(), { target: { value: "9001" } });
    fireEvent.keyDown(port(), { key: "Enter" });
    expect(await screen.findByText("http://127.0.0.1:9001/stream")).toBeInTheDocument();
    fireEvent.change(port(), { target: { value: "9002" } });
    fireEvent.blur(port());
    expect(await screen.findByText("http://127.0.0.1:9002/stream")).toBeInTheDocument();
    expect(configured.map(([, p]) => p)).toEqual([8790, 9001, 9002]);
  });

  it("holds back a port that can't be used, and says which can", async () => {
    const { configured } = setup();
    open();
    for (const value of ["80", "70000", "", "87.5"]) {
      fireEvent.change(port(), { target: { value } });
      fireEvent.keyDown(port(), { key: "Enter" });
      expect(port()).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Pick a port from 1024 to 65535.")).toBeInTheDocument();
    }
    expect(configured).toEqual([]);
    fireEvent.change(port(), { target: { value: "9001" } });
    expect(port()).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Pick a port from 1024 to 65535.")).toBeNull();
  });

  it("says so when the port is taken", async () => {
    setup([8790]);
    open();
    fireEvent.click(serve());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Port 8790 is in use by something else. Pick another.",
    );
    expect(toggle()).toHaveTextContent("Stream page: problem");
  });

  it("copies the address", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    open();
    fireEvent.click(serve());
    await screen.findByText("http://127.0.0.1:8790/stream");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:8790/stream");
  });

  it("puts the panel away on Escape and on a click elsewhere", () => {
    setup();
    open();
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(toggle()).toHaveFocus();

    open();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()).toBeNull();

    open();
    fireEvent.pointerDown(serve());
    expect(panel()).not.toBeNull();
  });

  it("keeps a port typed when the panel is put away, however it's put away", async () => {
    const { configured } = setup();
    open();
    fireEvent.click(serve());
    await screen.findByText("http://127.0.0.1:8790/stream");

    fireEvent.change(port(), { target: { value: "9001" } });
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()).toBeNull();
    open();
    expect(await screen.findByText("http://127.0.0.1:9001/stream")).toBeInTheDocument();

    fireEvent.change(port(), { target: { value: "9002" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
    open();
    expect(await screen.findByText("http://127.0.0.1:9002/stream")).toBeInTheDocument();

    fireEvent.change(port(), { target: { value: "9003" } });
    fireEvent.click(toggle());
    expect(panel()).toBeNull();
    open();
    expect(await screen.findByText("http://127.0.0.1:9003/stream")).toBeInTheDocument();
    expect(configured.map(([, p]) => p)).toEqual([8790, 9001, 9002, 9003]);
  });

  it("drops a port that can't be used when the panel is put away", async () => {
    const { configured } = setup();
    open();
    fireEvent.change(port(), { target: { value: "80" } });
    expect(port()).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    open();
    expect(port()).toHaveValue(8790);
    expect(port()).toHaveAttribute("aria-invalid", "false");
    expect(configured).toEqual([]);
  });

  it("hides file paths on its own switch, and says so in the bar", () => {
    const { controller, configured } = setup();
    expect(screen.queryByText("Paths hidden")).toBeNull();
    open();
    const hide = screen.getByRole("checkbox", { name: "Hide file paths in this window" });
    expect(hide).not.toBeChecked();
    fireEvent.click(hide);
    expect(hide).toBeChecked();
    expect(controller.getState().settings.hidePaths).toBe(true);
    expect(screen.getByText("Paths hidden")).toBeInTheDocument();
    // It has nothing to do with the page: the server isn't started for it.
    expect(configured).toEqual([]);
    expect(toggle()).toHaveTextContent("Stream page: off");

    fireEvent.click(hide);
    expect(screen.queryByText("Paths hidden")).toBeNull();
  });
});
