// The stream page's dependencies in the real app: the two commands in
// `src-tauri/src/stream/mod.rs` and the webview's localStorage.
import { invoke } from "@tauri-apps/api/core";
import type { StreamBackend, StreamDeps } from "./controller";
import { streamSettingsStore } from "./settings";

export const streamBackend: StreamBackend = {
  configure: (enabled, port) => invoke("stream_configure", { enabled, port }),
  publish: (status) => invoke("stream_publish", { status }),
};

export function tauriStreamDeps(device: StreamDeps["device"]): StreamDeps {
  return {
    backend: streamBackend,
    device,
    settings: streamSettingsStore(window.localStorage),
  };
}
