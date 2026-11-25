use std::panic::{AssertUnwindSafe, catch_unwind};

use binwalk_ng::signatures::SignatureResult;
use serde_json::json;

use super::synthetic::{
    GZIP_AT, IMAGE_LEN, KERNEL_LEN, UIMAGE_AT, UIMAGE_HEADER_LEN, UIMAGE_NAME, crc32, gzip_stored,
    gzip_text, image, pseudo_random, uimage,
};
use super::*;

/// What [`Report`] promises: offset order, and every finding inside the dump.
fn broken_promises(report: &Report) -> Vec<String> {
    let mut broken = Vec::new();
    for pair in report.findings.windows(2) {
        if pair[0].offset > pair[1].offset {
            broken.push(format!("out of order: {:?} before {:?}", pair[0], pair[1]));
        }
    }
    for f in &report.findings {
        let end = f.offset + f.size.unwrap_or(1);
        if f.size == Some(0) || end > report.len {
            broken.push(format!("not inside {} bytes: {f:?}", report.len));
        }
    }
    broken
}

/// Every magic byte pattern the scanner looks for, with its signature's name.
fn magics() -> Vec<(String, Vec<u8>)> {
    binwalk_ng::magic::patterns()
        .into_iter()
        .flat_map(|s| {
            let name = s.name;
            s.magic.into_iter().map(move |m| (name.clone(), m))
        })
        .collect()
}

fn result(offset: usize, size: usize) -> SignatureResult {
    SignatureResult {
        offset,
        size,
        id: "a8a5f3c2-0000-4000-8000-000000000000".into(),
        name: "gzip".into(),
        description: "gzip compressed data".into(),
        confidence: 250,
        ..Default::default()
    }
}

#[test]
fn crc32_matches_the_standard_check_value() {
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
}

#[test]
fn finds_the_uimage_and_the_gzip_where_they_were_put() {
    let report = scan(&image());
    assert_eq!(report.len, IMAGE_LEN as u64);
    assert_eq!(broken_promises(&report), [] as [String; 0]);
    assert_eq!(report.findings.len(), 2, "{report:#?}");

    let u = &report.findings[0];
    assert_eq!(u.offset, UIMAGE_AT as u64, "{u:?}");
    assert_eq!(u.kind, "uimage", "{u:?}");
    assert_eq!(u.confidence, Confidence::High, "{u:?}");
    assert_eq!(
        u.size,
        Some((UIMAGE_HEADER_LEN + KERNEL_LEN) as u64),
        "{u:?}"
    );
    assert!(u.description.contains(UIMAGE_NAME), "{u:?}");

    let g = &report.findings[1];
    assert_eq!(g.offset, GZIP_AT as u64, "{g:?}");
    assert_eq!(g.kind, "gzip", "{g:?}");
    assert_eq!(g.confidence, Confidence::High, "{g:?}");
    assert_eq!(
        g.size,
        Some(gzip_stored(&gzip_text()).len() as u64),
        "{g:?}"
    );
}

#[test]
fn one_scanner_scans_more_than_one_dump() {
    let scanner = Scanner::new();
    let first = scanner.scan(&image());
    assert_eq!(scanner.scan(&[0xFF; 64]).findings, []);
    assert_eq!(scanner.scan(&image()), first);
    assert_eq!(scan(&image()), first);
}

#[test]
fn an_erased_chip_and_an_empty_buffer_hold_nothing() {
    for fill in [0xFF, 0x00] {
        assert_eq!(
            scan(&vec![fill; IMAGE_LEN]),
            Report {
                len: IMAGE_LEN as u64,
                findings: vec![],
                // And every block says so: one byte value has no entropy.
                entropy: Entropy {
                    block: 256,
                    millibits: vec![0; IMAGE_LEN / 256],
                },
                strings: Strings::default(),
            }
        );
    }
    assert_eq!(
        scan(&[]),
        Report {
            len: 0,
            findings: vec![],
            entropy: Entropy {
                block: 256,
                millibits: vec![],
            },
            strings: Strings::default(),
        }
    );
}

/// The made-up image has a name in its uImage header and twenty lines of
/// text in its gzip stream. Its kernel is noise, which throws up a few short
/// runs by chance; nothing in it runs to fifteen characters.
#[test]
fn the_report_lists_the_text_in_the_image() {
    let report = scan(&image());
    let strings = &report.strings;
    assert_eq!(strings.min_chars, 4);
    assert!(!strings.cut);
    assert_eq!(strings.total, strings.found.len() as u64);
    assert!(
        strings
            .found
            .windows(2)
            .all(|pair| pair[0].offset <= pair[1].offset)
    );
    for text in &strings.found {
        let end = text.offset + text.chars * text.encoding.width();
        assert!(end <= report.len, "{text:?}");
    }

    let long: Vec<(u64, &str)> = strings
        .found
        .iter()
        .filter(|text| text.chars >= 15)
        .map(|text| (text.offset, text.text.as_str()))
        .collect();
    // The name is 32 bytes into the uImage header; the text starts after
    // gzip's 10-byte header and the stored block's 5.
    let line = "burnwright test: nothing here is anyone's firmware";
    let mut expected = vec![((UIMAGE_AT + 32) as u64, UIMAGE_NAME)];
    expected.extend((0..20).map(|i| ((GZIP_AT + 15 + i * (line.len() + 1)) as u64, line)));
    assert_eq!(long, expected);
}

/// The made-up image is erased flash with a kernel of noise and some text
/// in it. The entropy has to show all three.
#[test]
fn the_report_says_where_the_image_is_empty_packed_and_plain() {
    let entropy = scan(&image()).entropy;
    assert_eq!(entropy.block, 256);
    assert_eq!(entropy.millibits.len(), IMAGE_LEN / 256);
    let at = |offset: usize| entropy.millibits[offset / 256];

    assert_eq!(at(0), 0, "erased");
    assert_eq!(at(IMAGE_LEN - 1), 0, "erased");
    // A whole block inside the pretend kernel.
    let kernel = at(UIMAGE_AT + UIMAGE_HEADER_LEN + 0x100);
    assert!(kernel > 7000, "the kernel: {kernel}");
    // A whole block inside the gzip stream's stored text.
    let text = at(GZIP_AT + 0x100);
    assert!((3000..6000).contains(&text), "the text: {text}");
}

/// The same image end to end, 16 times: 32 findings, each where it was put.
#[test]
fn a_dump_full_of_findings_reports_them_in_offset_order() {
    let copies = 16;
    let report = scan(&image().repeat(copies));
    assert_eq!(broken_promises(&report), [] as [String; 0]);

    let found: Vec<(u64, &str)> = report
        .findings
        .iter()
        .map(|f| (f.offset, f.kind.as_str()))
        .collect();
    let expected: Vec<(u64, &str)> = (0..copies)
        .flat_map(|n| {
            let base = n * IMAGE_LEN;
            [
                ((base + UIMAGE_AT) as u64, "uimage"),
                ((base + GZIP_AT) as u64, "gzip"),
            ]
        })
        .collect();
    assert_eq!(found, expected);
}

/// A dump that stops early is ordinary on a bench. Cut a small image at
/// every length: no cut may panic, and no cut may report something that
/// runs past where the dump stops.
#[test]
fn no_cut_of_the_image_panics_or_reports_past_the_end() {
    let scanner = Scanner::new();
    let mut image = vec![0xFF; 0x40];
    image.extend_from_slice(&uimage("cut me", &pseudo_random(0x100, 3)));
    image.extend_from_slice(&[0xFF; 0x20]);
    image.extend_from_slice(&gzip_stored(b"cut me too, anywhere you like"));
    image.extend_from_slice(&[0xFF; 0x20]);

    // Whole, it holds both. Otherwise the cuts below prove nothing.
    let kinds: Vec<String> = scanner
        .scan(&image)
        .findings
        .into_iter()
        .map(|f| f.kind)
        .collect();
    assert_eq!(kinds, ["uimage", "gzip"]);

    let mut wrong = Vec::new();
    for n in 0..=image.len() {
        match catch_unwind(AssertUnwindSafe(|| scanner.scan(&image[..n]))) {
            Err(_) => wrong.push(format!("cut at {n}: panicked")),
            Ok(report) => {
                if report.len != n as u64 {
                    wrong.push(format!("cut at {n}: len is {}", report.len));
                }
                for broken in broken_promises(&report) {
                    wrong.push(format!("cut at {n}: {broken}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Every signature's magic bytes with garbage behind them, in the middle of
/// a buffer and hard against its end: the parsers' worst inputs.
#[test]
fn no_magic_followed_by_garbage_panics_or_reports_past_the_end() {
    let scanner = Scanner::new();
    let magics = magics();
    assert!(magics.len() > 100, "only {} magics", magics.len());

    let mut wrong = Vec::new();
    let mut check =
        |what: String, data: &[u8]| match catch_unwind(AssertUnwindSafe(|| scanner.scan(data))) {
            Err(_) => wrong.push(format!("{what}: panicked")),
            Ok(report) => {
                for broken in broken_promises(&report) {
                    wrong.push(format!("{what}: {broken}"));
                }
            }
        };
    for (index, (name, magic)) in magics.iter().enumerate() {
        for seed in 0..8u64 {
            let garbage = pseudo_random(2048, index as u64 * 31 + seed);
            // tail = how many bytes follow the magic before the buffer ends
            for tail in [0usize, 1, 3, 7, 16, 63, 512, 2048] {
                let mut data = vec![0xFF; 64];
                data.extend_from_slice(magic);
                data.extend_from_slice(&garbage[..tail]);
                check(format!("{name} seed {seed} tail {tail}"), &data);
                // And at offset 0, where "short" signatures apply.
                check(format!("{name} seed {seed} tail {tail} at 0"), &data[64..]);
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} inputs went wrong: {:#?}",
        wrong.len(),
        &wrong[..wrong.len().min(40)]
    );
}

#[test]
fn confidence_follows_binwalks_three_levels() {
    assert_eq!(confidence(0), Confidence::Low);
    assert_eq!(confidence(127), Confidence::Low);
    assert_eq!(confidence(128), Confidence::Medium);
    assert_eq!(confidence(249), Confidence::Medium);
    assert_eq!(confidence(250), Confidence::High);
    assert_eq!(confidence(255), Confidence::High);
    assert!(Confidence::Low < Confidence::Medium && Confidence::Medium < Confidence::High);
}

/// binwalk's `id` is a UUID made up for each result. The format's name is
/// its `name`.
#[test]
fn a_finding_takes_its_kind_from_binwalks_name() {
    assert_eq!(
        finding(result(0x40, 0x20), 0x100),
        Some(Finding {
            offset: 0x40,
            size: Some(0x20),
            kind: "gzip".into(),
            description: "gzip compressed data".into(),
            confidence: Confidence::High,
        })
    );
}

#[test]
fn a_size_of_zero_means_the_scanner_couldnt_tell() {
    assert_eq!(finding(result(0x40, 0), 0x100).unwrap().size, None);
}

/// binwalk drops these itself today. This is the line it's held to: a row
/// in the app jumps to `offset` and saves `offset..offset + size`.
#[test]
fn a_result_that_isnt_inside_the_dump_is_left_out() {
    // Ends exactly where the dump does: fine.
    assert_eq!(finding(result(0xC0, 0x40), 0x100).unwrap().size, Some(0x40));
    // One byte further isn't.
    assert_eq!(finding(result(0xC0, 0x41), 0x100), None);
    // Starts at or past the end, size known or not.
    assert_eq!(finding(result(0x100, 0), 0x100), None);
    assert_eq!(finding(result(0x101, 0x10), 0x100), None);
    assert_eq!(finding(result(0, 0), 0), None);
    // An offset and a size that overflow when added.
    assert_eq!(finding(result(0x40, usize::MAX), 0x100), None);
}

/// The shape the webview is sent. A change here is a change to the
/// TypeScript that reads it.
#[test]
fn a_report_is_this_json() {
    let report = Report {
        len: 0x1_0000,
        findings: vec![
            Finding {
                offset: 0x1000,
                size: Some(0x840),
                kind: "uimage".into(),
                description: "uImage firmware image".into(),
                confidence: Confidence::High,
            },
            Finding {
                offset: 0x4000,
                size: None,
                kind: "squashfs".into(),
                description: "SquashFS file system".into(),
                confidence: Confidence::Medium,
            },
            Finding {
                offset: 0x8000,
                size: None,
                kind: "copyright".into(),
                description: "Copyright text".into(),
                confidence: Confidence::Low,
            },
        ],
        entropy: Entropy {
            block: 256,
            millibits: vec![0, 8000, 4217],
        },
        strings: Strings {
            min_chars: 6,
            total: 31,
            cut: false,
            found: vec![
                strings::Text {
                    offset: 0x1020,
                    chars: 15,
                    encoding: strings::Encoding::Ascii,
                    text: "burnwright test".into(),
                },
                strings::Text {
                    offset: 0x9000,
                    chars: 300,
                    encoding: strings::Encoding::Utf16le,
                    text: "Setup".into(),
                },
            ],
        },
    };
    let json = json!({
        "len": 65536,
        "entropy": { "block": 256, "millibits": [0, 8000, 4217] },
        "strings": {
            "min_chars": 6,
            "total": 31,
            "cut": false,
            "found": [
                { "offset": 4128, "chars": 15, "encoding": "ascii", "text": "burnwright test" },
                { "offset": 36864, "chars": 300, "encoding": "utf16le", "text": "Setup" },
            ],
        },
        "findings": [
            {
                "offset": 4096,
                "size": 2112,
                "kind": "uimage",
                "description": "uImage firmware image",
                "confidence": "high",
            },
            {
                "offset": 16384,
                "size": null,
                "kind": "squashfs",
                "description": "SquashFS file system",
                "confidence": "medium",
            },
            {
                "offset": 32768,
                "size": null,
                "kind": "copyright",
                "description": "Copyright text",
                "confidence": "low",
            },
        ],
    });
    assert_eq!(serde_json::to_value(&report).unwrap(), json);
    assert_eq!(serde_json::from_value::<Report>(json).unwrap(), report);
}
