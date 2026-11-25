//! How random each stretch of a dump looks.
//!
//! A dump is cut into blocks and each block gets its Shannon entropy: 0 for
//! one byte value over and over (erased flash is all `0xFF`), 8 bits a byte
//! when every value turns up equally often (compressed or encrypted data).
//! Text and code sit in between. Drawn as a strip, that shows where a dump is
//! empty, where it's packed, and where the two meet, before anyone reads a
//! byte of hex.
//!
//! This is burnwright's own: a histogram and a sum. binwalk's entropy code
//! takes a file path and writes a PNG.

use serde::{Deserialize, Serialize};

/// The smallest block. Under this a block has too few bytes for its entropy
/// to say much: 256 bytes can't hold every byte value more than once.
pub const MIN_BLOCK: usize = 256;

/// The most blocks a dump is cut into, so a strip of them fits a window and
/// a 256 MiB dump gives a report no longer than a 256 KiB one.
pub const MAX_BLOCKS: usize = 1024;

/// The entropy of every block of a dump, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entropy {
    /// How many bytes each value covers. The last value covers what's left,
    /// which may be fewer.
    pub block: u64,
    /// Each block's entropy in thousandths of a bit per byte: 0 to 8000.
    /// Whole numbers, so two machines agree on them to the digit.
    pub millibits: Vec<u16>,
}

/// The block size for a dump of `len` bytes: a power of two, at least
/// [`MIN_BLOCK`], and big enough that there are at most [`MAX_BLOCKS`].
pub fn block_size(len: usize) -> usize {
    len.div_ceil(MAX_BLOCKS).next_power_of_two().max(MIN_BLOCK)
}

/// Measures `data` block by block. An empty dump has no blocks.
pub fn measure(data: &[u8]) -> Entropy {
    let block = block_size(data.len());
    Entropy {
        block: block as u64,
        millibits: data.chunks(block).map(millibits).collect(),
    }
}

/// The Shannon entropy of `block`, in thousandths of a bit per byte.
fn millibits(block: &[u8]) -> u16 {
    let mut counts = [0u32; 256];
    for &byte in block {
        counts[usize::from(byte)] += 1;
    }
    let total = block.len() as f64;
    let bits: f64 = counts
        .iter()
        .filter(|&&count| count != 0)
        .map(|&count| {
            let p = f64::from(count) / total;
            -p * p.log2()
        })
        .sum();
    // Never past 8 bits, whatever the last digit of the sum does.
    (bits * 1000.0).round().clamp(0.0, 8000.0) as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::pseudo_random;

    const MIB: usize = 1024 * 1024;

    #[test]
    fn one_value_over_and_over_has_no_entropy() {
        assert_eq!(millibits(&[0xFF; 4096]), 0);
        assert_eq!(millibits(&[0x00; 4096]), 0);
        assert_eq!(millibits(&[0x5A]), 0);
    }

    #[test]
    fn equal_shares_of_n_values_are_log2_n_bits() {
        let two: Vec<u8> = (0..1024)
            .map(|i| if i % 2 == 0 { 0x00 } else { 0xFF })
            .collect();
        assert_eq!(millibits(&two), 1000);
        let sixteen: Vec<u8> = (0..4096).map(|i| (i % 16) as u8).collect();
        assert_eq!(millibits(&sixteen), 4000);
        let every: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        assert_eq!(millibits(&every), 8000);
    }

    /// Three of one value and one of another: 0.811 bits, from the formula.
    #[test]
    fn unequal_shares_follow_the_formula() {
        assert_eq!(millibits(&[1, 1, 1, 2]), 811);
    }

    #[test]
    fn noise_is_close_to_eight_bits_and_text_is_well_under() {
        let noise = millibits(&pseudo_random(64 * 1024, 5));
        assert!((7990..=8000).contains(&noise), "{noise}");
        let text = millibits(&b"burnwright test: nothing here is anyone's firmware\n".repeat(80));
        assert!((3000..=5000).contains(&text), "{text}");
    }

    #[test]
    fn the_block_is_a_power_of_two_that_keeps_the_count_down() {
        assert_eq!(block_size(0), MIN_BLOCK);
        assert_eq!(block_size(1), MIN_BLOCK);
        // 1,024 blocks of 256 bytes, and not one byte more.
        assert_eq!(block_size(256 * 1024), 256);
        assert_eq!(block_size(256 * 1024 + 1), 512);
        assert_eq!(block_size(4 * MIB), 4096);
        assert_eq!(block_size(256 * MIB), 256 * 1024);
        for len in [
            1,
            255,
            256,
            257,
            65_536,
            1_000_000,
            4 * MIB,
            4 * MIB + 1,
            256 * MIB,
        ] {
            let block = block_size(len);
            assert!(
                block.is_power_of_two() && block >= MIN_BLOCK,
                "{len}: {block}"
            );
            assert!(len.div_ceil(block) <= MAX_BLOCKS, "{len}: {block}");
        }
    }

    #[test]
    fn a_dump_is_measured_block_by_block() {
        // Erased, then noise, then half a block of one value.
        let mut data = vec![0xFF; 512];
        data.extend_from_slice(&pseudo_random(256, 9));
        data.extend_from_slice(&[0x00; 128]);

        let entropy = measure(&data);
        assert_eq!(entropy.block, 256);
        assert_eq!(entropy.millibits.len(), 4);
        assert_eq!(entropy.millibits[0], 0);
        assert_eq!(entropy.millibits[1], 0);
        assert!(entropy.millibits[2] > 7000, "{entropy:?}");
        // The last block is short. It's measured over the bytes it has.
        assert_eq!(entropy.millibits[3], 0);
    }

    #[test]
    fn an_empty_dump_has_no_blocks() {
        assert_eq!(
            measure(&[]),
            Entropy {
                block: MIN_BLOCK as u64,
                millibits: vec![]
            }
        );
    }

    #[test]
    fn the_biggest_dump_gives_no_more_than_the_most_blocks() {
        // 8 MiB stands in for 256: the same code path, a thirtieth the time.
        let entropy = measure(&vec![0xFF; 8 * MIB + 1]);
        assert_eq!(entropy.block, 16 * 1024);
        assert_eq!(entropy.millibits.len(), 513);
        assert!(entropy.millibits.iter().all(|&m| m == 0));
    }
}
