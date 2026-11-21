//! A minimal test runner, shared by the targets that set `harness = false`.
//!
//! Those targets are their own fake CLI (see `minipro_engine.rs`), and the
//! tool arguments the engine passes would be rejected by libtest. This runs
//! the tests one after another, takes a name filter and `--list`, and exits
//! with libtest's failure code.

use std::panic;

pub type Test = (&'static str, fn());

pub fn run_tests(tests: &[Test]) {
    let cli: Vec<String> = std::env::args().skip(1).collect();
    if cli.iter().any(|a| a == "--list") {
        for (name, _) in tests {
            println!("{name}: test");
        }
        return;
    }
    let filter = cli.iter().find(|a| !a.starts_with('-'));
    let selected: Vec<&Test> = tests
        .iter()
        .filter(|(name, _)| filter.is_none_or(|f| name.contains(f.as_str())))
        .collect();
    println!("\nrunning {} tests", selected.len());
    let mut failed = Vec::new();
    for (name, test) in &selected {
        let outcome = panic::catch_unwind(test);
        println!(
            "test {name} ... {}",
            if outcome.is_ok() { "ok" } else { "FAILED" }
        );
        if outcome.is_err() {
            failed.push(*name);
        }
    }
    let passed = selected.len() - failed.len();
    if failed.is_empty() {
        println!("\ntest result: ok. {passed} passed; 0 failed\n");
    } else {
        println!("\nfailures:");
        for name in &failed {
            println!("    {name}");
        }
        println!(
            "\ntest result: FAILED. {passed} passed; {} failed\n",
            failed.len()
        );
        std::process::exit(101);
    }
}
