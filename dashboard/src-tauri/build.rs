fn main() {
  let mut attrs = tauri_build::Attributes::new();
  if std::env::var_os("CARGO_FEATURE_MAS").is_some() {
    println!("cargo:rerun-if-changed=capabilities/default.json");
    attrs = attrs.capabilities_path_pattern("./capabilities/default.json");
  }
  tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
