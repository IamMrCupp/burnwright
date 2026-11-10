// A made-up 16 MiB "chip image" for eyeballing the hex viewer until reads
// come from a real device: a text header, a byte ramp, some noise, then an
// erased (0xFF) tail like a part-filled flash.
export function makeSampleBuffer(size = 16 * 1024 * 1024): Uint8Array {
  const data = new Uint8Array(size).fill(0xff);
  const header = "burnwright sample image - not read from a device\0";
  for (let i = 0; i < header.length && i < size; i++) {
    data[i] = header.charCodeAt(i);
  }
  const rampEnd = Math.min(0x1000, size);
  for (let i = 0x40; i < rampEnd; i++) data[i] = i & 0xff;
  // xorshift32, seeded, so the sample is the same every run.
  let x = 0x2545f491;
  const noiseEnd = size >> 1;
  for (let i = rampEnd; i < noiseEnd; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
  }
  return data;
}

/**
 * A made-up "device read" and "file" pair for eyeballing the diff view: the
 * file is the read with a few bytes changed and 256 bytes short, like an
 * image a little smaller than the chip.
 */
export function makeDiffSample(size = 16 * 1024 * 1024): {
  read: Uint8Array;
  file: Uint8Array;
} {
  const read = makeSampleBuffer(size);
  const file = read.slice(0, Math.max(size - 0x100, 0));
  const edits: Array<[number, number]> = [
    [0x0b, 0x53], // "sample" -> "Sample"
    [0x1234, 0x00],
    [0x1235, 0x00],
    [0x1236, 0x00],
    [0x7f_fff0, 0xa5],
    [0xa0_0000, 0x00],
  ];
  for (const [at, value] of edits) {
    if (at < file.length) file[at] = value;
  }
  return { read, file };
}
