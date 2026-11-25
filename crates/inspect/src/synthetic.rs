//! Made-up flash images for the tests, built in code. No real firmware goes
//! in the repo: not XGecu's, and not anyone else's either.

/// CRC-32 (IEEE), bit by bit. Slow and short, which is fine for a few KiB.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

/// A valid gzip file holding `payload` in one stored (uncompressed) block.
pub fn gzip_stored(payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() <= 0xFFFF, "one stored block holds 64 KiB - 1");
    let len = payload.len() as u16;
    let mut out = vec![0x1F, 0x8B, 0x08, 0x00]; // magic, deflate, no flags
    out.extend_from_slice(&0x6000_0000u32.to_le_bytes()); // mtime
    out.extend_from_slice(&[0x00, 0x03]); // extra flags, OS = Unix
    out.push(0x01); // final block, stored
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&crc32(payload).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out
}

/// A valid legacy uImage: the 64-byte header, both checksums right, then
/// `payload`. Linux kernel, MIPS, uncompressed.
pub fn uimage(name: &str, payload: &[u8]) -> Vec<u8> {
    let mut header = [0u8; UIMAGE_HEADER_LEN];
    header[0..4].copy_from_slice(&0x2705_1956u32.to_be_bytes());
    // 4..8 is the header checksum, computed over the header with it zeroed.
    header[8..12].copy_from_slice(&0x6000_0000u32.to_be_bytes()); // created
    header[12..16].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    header[16..20].copy_from_slice(&0x8000_0000u32.to_be_bytes()); // load
    header[20..24].copy_from_slice(&0x8000_0000u32.to_be_bytes()); // entry
    header[24..28].copy_from_slice(&crc32(payload).to_be_bytes());
    header[28] = 5; // OS: Linux
    header[29] = 5; // CPU: MIPS32
    header[30] = 2; // type: OS kernel image
    header[31] = 0; // compression: none
    let name = name.as_bytes();
    header[32..32 + name.len().min(31)].copy_from_slice(&name[..name.len().min(31)]);
    let checksum = crc32(&header);
    header[4..8].copy_from_slice(&checksum.to_be_bytes());
    let mut out = header.to_vec();
    out.extend_from_slice(payload);
    out
}

/// How long a legacy uImage header is.
pub const UIMAGE_HEADER_LEN: usize = 64;
/// Where [`image`] puts its uImage.
pub const UIMAGE_AT: usize = 0x1000;
/// How long the kernel in [`image`]'s uImage is.
pub const KERNEL_LEN: usize = 0x800;
/// The name in [`image`]'s uImage header.
pub const UIMAGE_NAME: &str = "burnwright test";
/// Where [`image`] puts its gzip stream.
pub const GZIP_AT: usize = 0x4000;
/// How long [`image`] is: 64 KiB, a small SPI flash.
pub const IMAGE_LEN: usize = 0x1_0000;

/// A made-up flash image: erased (`0xFF`) except for a uImage at
/// [`UIMAGE_AT`] and a gzip stream at [`GZIP_AT`].
pub fn image() -> Vec<u8> {
    let mut image = vec![0xFF; IMAGE_LEN];
    let u = uimage(UIMAGE_NAME, &pseudo_random(KERNEL_LEN, 7));
    image[UIMAGE_AT..UIMAGE_AT + u.len()].copy_from_slice(&u);
    let g = gzip_stored(&gzip_text());
    image[GZIP_AT..GZIP_AT + g.len()].copy_from_slice(&g);
    image
}

/// What [`image`]'s gzip stream holds.
pub fn gzip_text() -> Vec<u8> {
    b"burnwright test: nothing here is anyone's firmware\n".repeat(20)
}

/// `len` bytes from xorshift64, the same for the same `seed` everywhere.
pub fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.extend_from_slice(&state.to_le_bytes());
    }
    out.truncate(len);
    out
}
