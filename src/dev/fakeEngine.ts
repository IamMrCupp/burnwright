// A pretend minipro for the device screen: a programmer, a chip database
// and a chip in the socket, all in memory. The Vitest flow tests run
// against it, and `pnpm dev` in a plain browser (no Tauri) uses it so the
// screen can be worked on with no hardware. It is never part of a release
// build.
//
// It answers the way the real engine does, as far as the screen can tell:
// the same progress events, the same error kinds and messages, the size
// and chip ID checks minipro makes, and a write that leaves the chip
// half-done when it's cancelled.
import type {
  ChipCheck,
  ChipEntry,
  ChipInfo,
  ChipSearch,
  DeviceInfo,
  Diagnosis,
  EngineError,
  OperationOptions,
  Programmer,
} from "../lib/engine";
import type { DeviceEngine } from "../lib/device/controller";

/** A chip in the fake database. */
export interface FakeChip {
  info: ChipInfo;
  /** Its chip ID, e.g. "0xEF4016". Without one, minipro can't check it. */
  id?: string;
  /** Listed, but `chipInfo` fails the way minipro does on an entry it can't parse. */
  unreadable?: boolean;
}

/** What's in the socket. */
export interface FakeSocket {
  /** The database name of the chip that is really there. */
  chip: string;
  memory: Uint8Array;
  /** Writes and erases don't take: the read-back then fails. */
  writeProtected?: boolean;
  /** Socket pins that don't make contact, for the pin test. */
  badPins?: number[];
}

export interface FakeEngineOptions {
  /** The programmer on USB; `null` for none. Default: a T48. */
  programmer?: DeviceInfo | null;
  /** The chip database. Default: `FAKE_CHIPS`. */
  chips?: FakeChip[];
  /** The chip in the socket; `null` for an empty socket. */
  socket?: FakeSocket | null;
  /** What `diagnoseProgrammer` answers. */
  diagnosis?: Diagnosis;
  /** Files `loadImage` can open, by path. */
  files?: Record<string, Uint8Array>;
  /** Milliseconds between progress steps. Default 0: as fast as the event loop. */
  stepMs?: number;
  /** Progress steps per stage. Default 4. */
  steps?: number;
}

/** One call the fake received, for tests to assert on. */
export interface FakeCall {
  command: string;
  part?: string;
  options?: Pick<OperationOptions, "ignoreChipId" | "ignoreSize">;
  pinCheck?: boolean;
  path?: string;
}

export interface FakeEngine extends DeviceEngine {
  /** Every call so far, in order. */
  calls: FakeCall[];
  /** The programmer on USB. Assign to plug one in or pull it. */
  programmer: DeviceInfo | null;
  /** The chip in the socket. Assign to swap it. */
  socket: FakeSocket | null;
  /** Files written by `saveImage`, by path. */
  saved: Record<string, Uint8Array>;
  /** Make running operations wait at their next progress step. */
  hold(): void;
  /** Let held operations go on. */
  release(): void;
  /** Fail the next device operation with `error`, before it touches the chip. */
  failNext(error: EngineError): void;
}

const T48: DeviceInfo = {
  programmer: "T48",
  firmware: "01.1.32",
  chip: null,
  firmware_status: null,
  firmware_expected: null,
  support_warning: "T48 support is not yet complete!",
};

/** A database entry for a memory chip of `bytes` bytes; `extra` overrides any field. */
export function fakeChip(
  name: string,
  bytes: number,
  extra: Partial<ChipInfo> = {},
): ChipInfo {
  const pkg = name.includes("@") ? name.slice(name.indexOf("@") + 1) : null;
  return {
    name,
    package: pkg,
    kind: "programmable",
    available_on: ["tl866ii", "t48", "t56"],
    memory: { size: bytes, unit: "bytes", bytes, data_sizes: [] },
    socket: { kind: "dip", pins: 8 },
    icsp: null,
    protocol: 3,
    read_buffer_size: 4096,
    write_buffer_size: 256,
    details: [],
    ...extra,
  };
}

/**
 * A small database with one of each kind of chip the screen treats
 * differently. The entries follow what minipro 0.7.4 prints for the real
 * parts (see `crates/engine/fixtures/minipro/chips`).
 */
export const FAKE_CHIPS: FakeChip[] = [
  { info: fakeChip("W25Q32BV@SOIC8", 4_194_304, { icsp: "ICP009.JPG" }), id: "0xEF4016" },
  { info: fakeChip("W25Q32BV", 4_194_304, { icsp: "ICP009.JPG" }), id: "0xEF4016" },
  { info: fakeChip("W25Q64BV@SOIC8", 8_388_608, { icsp: "ICP009.JPG" }), id: "0xEF4017" },
  { info: fakeChip("MX25L3206E@SOP8", 4_194_304, { icsp: "ICP009.JPG" }), id: "0xC22016" },
  { info: fakeChip("AT24C02", 256, { protocol: 1, read_buffer_size: 256, write_buffer_size: 8 }) },
  {
    info: fakeChip("AT28C256", 32_768, {
      socket: { kind: "dip", pins: 28 },
      protocol: 6,
      read_buffer_size: 1024,
      write_buffer_size: 64,
    }),
  },
  { info: fakeChip("AT28C256E", 32_768), unreadable: true },
  {
    info: fakeChip("M27C256B@DIP28", 32_768, {
      socket: { kind: "dip", pins: 28 },
      protocol: 7,
      read_buffer_size: 1024,
      write_buffer_size: 128,
      details: [
        { label: "VPP programming voltage", value: "13V" },
        { label: "VDD write voltage", value: "6.5V" },
        { label: "VCC verify voltage", value: "5V" },
        { label: "Pulse delay", value: "100us" },
      ],
    }),
  },
  {
    info: fakeChip("ATMEGA328P@DIP28", 32_768, {
      memory: { size: 32_768, unit: "bytes", bytes: 32_768, data_sizes: [1024] },
      socket: { kind: "dip", pins: 28 },
      icsp: "ICP007.JPG",
      protocol: 29,
      read_buffer_size: 256,
      write_buffer_size: 128,
    }),
    id: "0x1E950F",
  },
  {
    info: fakeChip("TC58DVG02D5TAI0@TSOP48", 138_412_032, {
      socket: { kind: "adapter", image: "Adapter008.JPG" },
      protocol: 45,
      read_buffer_size: 8448,
      write_buffer_size: 2112,
    }),
  },
  {
    info: fakeChip("DS35M2GB(x4)@SOP16", 0, {
      available_on: ["t56"],
      memory: { size: 0, unit: "bytes", bytes: null, data_sizes: [131_102] },
      socket: { kind: "dip", pins: 16 },
      protocol: 45,
      read_buffer_size: 8704,
      write_buffer_size: 2176,
    }),
  },
  {
    info: fakeChip("GAL16V8D", 0, {
      memory: { size: 2194, unit: "bits", bytes: null, data_sizes: [] },
      socket: { kind: "dip", pins: 20 },
      protocol: 42,
      read_buffer_size: 0,
      write_buffer_size: 0,
      details: [{ label: "VPP programming voltage", value: "16V" }],
    }),
  },
  {
    info: {
      name: "7400",
      package: null,
      kind: "logic",
      available_on: [],
      memory: null,
      socket: { kind: "dip", pins: 14 },
      icsp: null,
      protocol: null,
      read_buffer_size: null,
      write_buffer_size: null,
      details: [
        { label: "VCC voltage", value: "5V" },
        { label: "Vector count", value: "4" },
      ],
    },
  },
];

function entryOf(chip: FakeChip): ChipEntry {
  return { name: chip.info.name, package: chip.info.package, custom: chip.unreadable ?? false };
}

function hex(value: number, digits: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function engineError(
  kind: EngineError["kind"],
  message: string,
  device_state: EngineError["device_state"] = null,
): EngineError {
  return { kind, message, device_state };
}

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const chips = options.chips ?? FAKE_CHIPS;
  const files = options.files ?? {};
  const stepMs = options.stepMs ?? 0;
  const steps = Math.max(1, options.steps ?? 4);
  const diagnosis: Diagnosis = options.diagnosis ?? {
    os: "macos",
    programmers: [],
    probe_error: null,
  };

  let held: Promise<void> | null = null;
  let letGo: () => void = () => {};
  let nextFailure: EngineError | null = null;

  const find = (name: string) => chips.find((c) => c.info.name === name);

  /** One progress step: wait if held, wait `stepMs`, then stop if cancelled. */
  async function step(operation: string, mutates: boolean, signal?: AbortSignal) {
    if (held) await held;
    if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs));
    else await Promise.resolve();
    if (signal?.aborted) {
      throw engineError(
        "cancelled",
        mutates
          ? `${operation} cancelled: the device may be in an inconsistent state`
          : `${operation} cancelled`,
        mutates ? "may_be_inconsistent" : "unchanged",
      );
    }
  }

  /** A stage with a percentage, calling `at` after each step with the fraction done. */
  async function stage(
    name: "read" | "write" | "verify" | "blank_check" | "erase",
    label: string,
    operation: string,
    mutates: boolean,
    opts: OperationOptions,
    at?: (fraction: number) => void,
  ) {
    opts.onProgress?.({ type: "stage_started", stage: name, label });
    for (let i = 1; i <= steps; i++) {
      await step(operation, mutates, opts.signal);
      at?.(i / steps);
      opts.onProgress?.({
        type: "progress",
        stage: name,
        percent: Math.round((i / steps) * 100),
      });
    }
    opts.onProgress?.({ type: "stage_finished", stage: name, seconds: 0.5 });
  }

  /**
   * What every operation on the chip starts with: the command line, the
   * programmer, then minipro's chip ID check. Returns the selected part and
   * the socket.
   */
  function open(part: string, flags: string, opts: OperationOptions) {
    const overrides = `${opts.ignoreChipId ? " -y" : ""}${opts.ignoreSize ? " -s" : ""}`;
    opts.onProgress?.({
      type: "command",
      line: `minipro -p ${/^[\w@.+-]+$/.test(part) ? part : `'${part}'`}${overrides} ${flags}`,
    });
    if (nextFailure) {
      const failure = nextFailure;
      nextFailure = null;
      opts.onProgress?.({ type: "error", message: failure.message });
      throw failure;
    }
    const programmer = fake.programmer;
    if (!programmer) {
      opts.onProgress?.({ type: "error", message: "No programmer found." });
      throw engineError("no_programmer", "no programmer detected");
    }
    opts.onProgress?.({
      type: "info",
      message: `Found ${programmer.programmer} ${programmer.firmware ?? ""}`.trim(),
    });
    const selected = find(part);
    if (!selected || selected.unreadable) {
      const message = `Device ${part} not found!`;
      opts.onProgress?.({ type: "error", message });
      throw engineError("minipro", message);
    }
    const socket = fake.socket;
    if (!socket) {
      const message = "Overcurrent protection!";
      opts.onProgress?.({ type: "error", message });
      throw engineError("minipro", message);
    }
    const inSocket = find(socket.chip);
    if (selected.id && inSocket?.id && selected.id !== inSocket.id) {
      if (!opts.ignoreChipId) {
        opts.onProgress?.({
          type: "error",
          message: `Invalid Chip ID: expected ${selected.id}, got ${inSocket.id} (${inSocket.info.name})`,
        });
        throw engineError(
          "chip_id_mismatch",
          `chip ID mismatch: expected ${selected.id}, found ${inSocket.id} (${inSocket.info.name})`,
        );
      }
      opts.onProgress?.({
        type: "warning",
        message: `WARNING: Chip ID mismatch: expected ${selected.id}, got ${inSocket.id} (${inSocket.info.name})`,
      });
    } else if (selected.id) {
      opts.onProgress?.({ type: "info", message: `Chip ID: ${selected.id}  OK` });
    }
    return { selected, socket };
  }

  /** minipro's image size check. Returns how many bytes it works on. */
  function checkImage(selected: FakeChip, data: ArrayLike<number>, opts: OperationOptions) {
    const size = selected.info.memory?.bytes ?? data.length;
    if (data.length === size) return size;
    if (!opts.ignoreSize) {
      opts.onProgress?.({
        type: "error",
        message: `Incorrect file size: ${data.length} (needed ${size}, use -s/S to ignore)`,
      });
      throw engineError(
        "size_mismatch",
        `the image is ${data.length} bytes and the chip takes ${size}`,
      );
    }
    opts.onProgress?.({
      type: "warning",
      message: `Warning: Incorrect file size: ${data.length} (needed ${size})`,
    });
    return Math.min(data.length, size);
  }

  /** Compare the chip with `data` over `length` bytes, the way minipro reports it. */
  function compare(socket: FakeSocket, data: ArrayLike<number>, length: number, opts: OperationOptions) {
    for (let i = 0; i < length; i++) {
      const device = socket.memory[i] ?? 0xff;
      if (device !== data[i]) {
        const message = `Verification failed at address ${hex(i, 4)}: File=${hex(data[i], 2)}, Device=${hex(device, 2)}`;
        opts.onProgress?.({ type: "error", message });
        throw engineError("verify_failed", message);
      }
    }
    opts.onProgress?.({ type: "info", message: "Verification OK" });
  }

  const fake: FakeEngine = {
    calls: [],
    programmer: options.programmer === undefined ? T48 : options.programmer,
    socket: options.socket === undefined ? null : options.socket,
    saved: {},
    hold() {
      if (!held) {
        held = new Promise((resolve) => {
          letGo = resolve;
        });
      }
    },
    release() {
      held = null;
      letGo();
    },
    failNext(error) {
      nextFailure = error;
    },

    async detect(opts = {}) {
      fake.calls.push({ command: "detect" });
      opts.onProgress?.({ type: "command", line: "minipro -k" });
      await step("operation", false, opts.signal);
      const programmer = fake.programmer;
      if (!programmer) {
        opts.onProgress?.({ type: "info", message: "[No programmer found]" });
        throw engineError("no_programmer", "no programmer detected");
      }
      opts.onProgress?.({
        type: "info",
        message: `${programmer.programmer.toLowerCase()}: ${programmer.programmer}`,
      });
      opts.onProgress?.({ type: "command", line: "minipro -V" });
      opts.onProgress?.({
        type: "info",
        message: `Found ${programmer.programmer} ${programmer.firmware ?? ""}`.trim(),
      });
      return programmer;
    },

    async diagnoseProgrammer() {
      fake.calls.push({ command: "diagnoseProgrammer" });
      return diagnosis;
    },

    async searchChips(_programmer: Programmer, query: string, limit = 50): Promise<ChipSearch> {
      fake.calls.push({ command: "searchChips" });
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const first = words[0] ?? "";
      const rank = (name: string) => {
        const lower = name.toLowerCase();
        if (lower === query.trim().toLowerCase()) return 0;
        return lower.startsWith(first) ? 1 : 2;
      };
      const matches = chips
        .map(entryOf)
        .filter((entry) => words.every((w) => entry.name.toLowerCase().includes(w)))
        .map((entry, order) => ({ entry, order }))
        .sort((a, b) => rank(a.entry.name) - rank(b.entry.name) || a.order - b.order)
        .map(({ entry }) => entry);
      return { total: matches.length, chips: matches.slice(0, limit) };
    },

    async chipInfo(_programmer: Programmer, name: string): Promise<ChipInfo> {
      fake.calls.push({ command: "chipInfo", part: name });
      const chip = find(name);
      if (!chip) throw engineError("unknown_chip", `minipro has no chip called ${name}`);
      if (chip.unreadable) {
        throw engineError(
          "minipro",
          `minipro error: minipro can't read its database entry for ${name}: An error occurred while parsing XML database.`,
        );
      }
      return chip.info;
    },

    async checkChip(part, pinCheck = false, opts = {}): Promise<ChipCheck> {
      fake.calls.push({ command: "checkChip", part, pinCheck });
      // `-D` reports a mismatch as a result, not as a failure.
      const { selected, socket } = open(part, pinCheck ? "-D -z" : "-D", {
        ...opts,
        ignoreChipId: true,
        onProgress: (event) => {
          if (event.type !== "warning") opts.onProgress?.(event);
        },
      });
      await step("operation", false, opts.signal);
      const device = { ...(fake.programmer as DeviceInfo), chip: part };
      const bad = socket.badPins ?? [];
      if (pinCheck && bad.length > 0) {
        for (const pin of bad) {
          opts.onProgress?.({ type: "error", message: `Bad contact on pin:${pin}` });
        }
        return { device, chip_id: null, pins: { status: "bad_contact", pins: bad } };
      }
      const pins = pinCheck ? ({ status: "passed" } as const) : null;
      const inSocket = find(socket.chip);
      if (!selected.id) return { device, chip_id: { status: "no_chip_id" }, pins };
      if (inSocket?.id && inSocket.id !== selected.id) {
        return {
          device,
          chip_id: {
            status: "mismatch",
            expected: selected.id,
            found: inSocket.id,
            detected: inSocket.info.name,
          },
          pins,
        };
      }
      return { device, chip_id: { status: "match", id: selected.id }, pins };
    },

    async read(part, kind, opts = {}) {
      fake.calls.push({ command: "read", part, options: pick(opts) });
      const { selected, socket } = open(part, `-c ${kind} -r -`, opts);
      await stage("read", "Reading Code", "read", false, opts);
      const size = selected.info.memory?.bytes ?? socket.memory.length;
      const data = new Array<number>(size).fill(0xff);
      for (let i = 0; i < Math.min(size, socket.memory.length); i++) data[i] = socket.memory[i];
      return data;
    },

    async write(part, kind, data, opts = {}) {
      fake.calls.push({ command: "write", part, options: pick(opts) });
      const { selected, socket } = open(part, `-c ${kind} -w -`, opts);
      const length = checkImage(selected, data, opts);
      const live = !socket.writeProtected;
      await stage("erase", "Erasing", "write", true, { ...opts, onProgress: opts.onProgress }, () => {
        if (live) socket.memory.fill(0xff);
      });
      let written = 0;
      await stage("write", "Writing Code", "write", true, opts, (fraction) => {
        const upTo = Math.min(Math.round(length * fraction), socket.memory.length);
        if (live) for (; written < upTo; written++) socket.memory[written] = data[written];
      });
      await stage("verify", "Reading Code", "write", true, opts);
      compare(socket, data, Math.min(length, socket.memory.length), opts);
    },

    async verify(part, kind, data, opts = {}) {
      fake.calls.push({ command: "verify", part, options: pick(opts) });
      const { selected, socket } = open(part, `-c ${kind} -m -`, opts);
      const length = checkImage(selected, data, opts);
      await stage("verify", "Reading Code", "verify", false, opts);
      compare(socket, data, Math.min(length, socket.memory.length), opts);
    },

    async blankCheck(part, opts = {}) {
      fake.calls.push({ command: "blankCheck", part, options: pick(opts) });
      const { socket } = open(part, "-b", opts);
      await stage("blank_check", "Reading Code", "blank check", false, opts);
      return socket.memory.every((byte) => byte === 0xff);
    },

    async erase(part, opts = {}) {
      fake.calls.push({ command: "erase", part, options: pick(opts) });
      const { socket } = open(part, "-E", opts);
      await stage("erase", "Erasing", "erase", true, opts, (fraction) => {
        if (socket.writeProtected) return;
        socket.memory.fill(0xff, 0, Math.round(socket.memory.length * fraction));
      });
    },

    async loadImage(path) {
      fake.calls.push({ command: "loadImage", path });
      const file = files[path] ?? fake.saved[path];
      if (!file) throw `${path}: No such file or directory (os error 2)`;
      return Array.from(file);
    },

    async saveImage(path, data) {
      fake.calls.push({ command: "saveImage", path });
      fake.saved[path] = Uint8Array.from(data);
    },
  };

  return fake;
}

function pick(opts: OperationOptions): FakeCall["options"] {
  return { ignoreChipId: opts.ignoreChipId ?? false, ignoreSize: opts.ignoreSize ?? false };
}
