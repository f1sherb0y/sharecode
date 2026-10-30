// Stands in for the NSIS installer: records its arguments and exits with FAKE_EXIT (default 0).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = std::path::Path::new(&std::env::var("TEMP").unwrap()).join("sharecode-fake-installer.txt");
    std::fs::write(out, args.join(" ")).unwrap();
    std::process::exit(std::env::var("FAKE_EXIT").ok().and_then(|v| v.parse().ok()).unwrap_or(0));
}
