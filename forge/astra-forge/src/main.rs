// astra-forge (P1-T01, P1-T02, P1-T05): assemble Astra = pinned upstream + patch series + overlay.
// Zero-dependency CLI (std only; shells out to curl/tar/gpg/grep/git/cp). Commands:
// fetch, doctor, config, overlay, lint. import/build/test/package/export/bump arrive
// with their phase tasks.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    let mut d = env::current_dir().expect("cwd");
    loop {
        if d.join("upstream.toml").exists() {
            return d;
        }
        if !d.pop() {
            panic!("upstream.toml not found above cwd");
        }
    }
}

/// The host platform name used by `--os` and the objdir/binary helpers.
fn host_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn objdir_name(os: &str) -> String {
    format!("obj-astra-{os}")
}

fn exe_suffix(os: &str) -> &'static str {
    if os == "windows" { ".exe" } else { "" }
}

/// Drop the Windows verbatim prefix that Git for Windows rejects.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path
}

/// Convert a Windows path to the form MSYS/MozillaBuild accepts (`/e/Astra`).
fn to_msys_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        format!("/{}{}", s[0..1].to_lowercase(), &s[2..])
    } else {
        s
    }
}

/// Recursive copy for Windows, where `cp -a` is not available. Linux keeps
/// the existing `cp -a` path so its file modes and symlinks are unchanged.
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy a directory tree, preserving the existing Linux `cp -a` path.
fn copy_dir(root: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    if cfg!(windows) {
        copy_dir_all(src, dst)
    } else {
        run(
            "cp",
            &[
                "-a",
                &format!("{}/.", src.to_string_lossy()),
                &dst.to_string_lossy(),
            ],
            root,
        )
        .map(|_| ())
    }
}

/// `OS:` header from a patch, or `None` when the patch is platform-neutral.
fn patch_os(patch: &Path) -> Option<String> {
    let text = fs::read_to_string(patch).ok()?;
    for line in text.lines() {
        if line.starts_with("---") {
            break;
        }
        if let Some(value) = line.strip_prefix("OS:") {
            let value = value.trim().to_lowercase();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

// Minimal upstream.toml reader: top-level `key = value` string pairs.
fn read_upstream(root: &Path) -> std::collections::HashMap<String, String> {
    let text = fs::read_to_string(root.join("upstream.toml")).expect("read upstream.toml");
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.split('#').next().unwrap_or("").trim();
            let v = v.trim_matches('"').trim().to_string();
            map.insert(k.trim().to_string(), v);
        }
    }
    map
}

fn run_raw(prog: &str, args: &[&str], dir: &Path) -> Result<String, String> {
    let out = Command::new(prog)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("spawn {prog}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{prog} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn run(prog: &str, args: &[&str], dir: &Path) -> Result<String, String> {
    let out = Command::new(prog)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("spawn {prog}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{prog} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn cmd_fetch(root: &Path) -> Result<(), String> {
    let up = read_upstream(root);
    let version = up.get("version").cloned().unwrap_or_default();
    if version.is_empty() || version == "UNVERIFIED" {
        return Err("upstream.toml: set a verified version first".into());
    }
    let url = up.get("url").cloned().unwrap_or_default();
    if url.is_empty() || url == "UNVERIFIED" {
        return Err("upstream.toml: set a verified source url first (P1-T01)".into());
    }
    let engine = root.join("engine");
    let dist = root.join("out").join("dist");
    fs::create_dir_all(&engine).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dist).map_err(|e| e.to_string())?;
    let tarball = dist.join(url.rsplit('/').next().ok_or("bad source url")?);
    if !tarball.exists() {
        println!("fetch: downloading {url}");
        run(
            "curl",
            &["-sSL", "--fail", "-o", &tarball.to_string_lossy(), &url],
            root,
        )?;
    } else {
        println!("fetch: reusing {}", tarball.display());
    }
    // Signature check: <tarball>.asc via gpg when present next to the tarball.
    let asc_url = format!("{url}.asc");
    let asc = dist.join(format!(
        "{}.asc",
        tarball.file_name().unwrap().to_string_lossy()
    ));
    if !asc.exists() {
        match run(
            "curl",
            &["-sSL", "--fail", "-o", &asc.to_string_lossy(), &asc_url],
            root,
        ) {
            Ok(_) => println!("fetch: downloaded signature"),
            Err(e) => println!(
                "fetch: WARNING no signature ({e}); refusing to continue without one in release builds"
            ),
        }
    }
    if asc.exists() {
        println!("fetch: verifying signature");
        run(
            "gpg",
            &[
                "--verify",
                &asc.to_string_lossy(),
                &tarball.to_string_lossy(),
            ],
            root,
        )
        .map_err(|e| {
            format!(
                "{e}\n  hint: import Mozilla's release key, then retry:\n  \
                 gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys \
                 14F26682D0916CDD81E37B6D61B7B526D98F0353"
            )
        })?;
        println!("fetch: signature OK");
    }
    // Extract (idempotent marker).
    let marker = engine.join(".forge-fetch-ok");
    let want = format!("{version}\n{url}\n");
    let have = fs::read_to_string(&marker).unwrap_or_default();
    if have != want || !engine.join("mach").exists() {
        println!("fetch: extracting to engine/");
        run(
            "tar",
            &[
                "--strip-components=1",
                "-xJf",
                &tarball.to_string_lossy(),
                "-C",
                &engine.to_string_lossy(),
            ],
            root,
        )?;
        fs::write(&marker, want).map_err(|e| e.to_string())?;
        // Baseline commit so applied patches are real diffs.
        if !engine.join(".git").exists() {
            run("git", &["init", "-q"], &engine)?;
            run("git", &["add", "-A"], &engine)?;
            run(
                "git",
                &[
                    "-c",
                    "user.name=forge",
                    "-c",
                    "user.email=forge@local",
                    "commit",
                    "-qm",
                    &format!("baseline: firefox {version}"),
                ],
                &engine,
            )?;
        }
    } else {
        println!("fetch: engine/ already at {version}");
    }
    println!("fetch: done ({})", engine.display());
    Ok(())
}

fn cmd_doctor(root: &Path) -> Result<(), String> {
    let mut ok = true;
    for (prog, why) in [
        ("curl", "downloads"),
        ("tar", "extraction"),
        ("gpg", "signatures"),
        ("git", "patch baseline"),
        ("rustc", "forge itself"),
        ("python3", "state-check"),
        ("bun", "UI workspace (P3)"),
    ] {
        match run(prog, &["--version"], root) {
            Ok(first) => println!(
                "doctor: {prog:8} OK ({}) — {why}",
                first.lines().next().unwrap_or("")
            ),
            Err(e) => {
                println!("doctor: {prog:8} MISSING ({e}) — {why}");
                ok = false;
            }
        }
    }
    let up = read_upstream(root);
    for k in ["channel", "version", "source", "url"] {
        match up.get(k) {
            Some(v) if !v.is_empty() && v != "UNVERIFIED" => println!("doctor: upstream.{k} = {v}"),
            _ => {
                println!("doctor: upstream.{k} UNVERIFIED");
                ok = false;
            }
        }
    }
    if let Err(e) = cmd_doctor_mozconfig(root) {
        println!("doctor: mozconfig: {e}");
        ok = false;
    }
    if !ok {
        return Err("doctor: problems found (see above)".into());
    }
    println!("doctor: all green");
    Ok(())
}

// Configure files that may declare build options (P1-T02 evidence set).
fn configure_files(engine: &Path) -> Vec<String> {
    [
        "build/moz.configure/init.configure",
        "build/moz.configure/util.configure",
        "build/moz.configure/update-programs.configure",
        "build/moz.configure/toolchain.configure",
        "moz.configure",
        "toolkit/moz.configure",
        "browser/moz.configure",
    ]
    .iter()
    .map(|p| engine.join(p).to_string_lossy().into_owned())
    .collect()
}

fn configure_has(engine: &Path, needle: &str) -> bool {
    let files = configure_files(engine);
    let mut cmd = Command::new("grep");
    cmd.args(["-rq", "--", needle]);
    for f in &files {
        cmd.arg(f);
    }
    match cmd.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

// Validate config/mozconfig.linux flags against the pinned source (P1-T02).
fn cmd_doctor_mozconfig(root: &Path) -> Result<(), String> {
    let template = root.join("config/mozconfig.linux");
    if !template.exists() {
        return Err("config/mozconfig.linux missing".into());
    }
    let engine = root.join("engine");
    if !engine.join("toolkit/moz.configure").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    // The template carries one placeholder in --with-branding; only the
    // option *name* is validated, so substitute a dummy value first.
    let text = fs::read_to_string(&template).map_err(|e| e.to_string())?;
    let text = text.replace("@ASTRA_BRANDING_DIR@", "astra/branding");
    let mut checked = 0;
    let mut bad: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(flags) = line.strip_prefix("ac_add_options") {
            let flag = flags.trim();
            // Split off any =value; the option name is what must exist.
            let name = flag.split('=').next().unwrap_or(flag);
            // Candidates that prove the option exists in the pinned source.
            let cands: Vec<String> = if let Some(stem) = name
                .strip_prefix("--enable-")
                .or_else(|| name.strip_prefix("--disable-"))
            {
                vec![
                    format!("\"--enable-{stem}\""),
                    format!("\"--disable-{stem}\""),
                ]
            } else if let Some(stem) = name
                .strip_prefix("--with-")
                .or_else(|| name.strip_prefix("--without-"))
            {
                vec![format!("\"--with-{stem}\"")]
            } else {
                vec![format!("\"{name}\"")]
            };
            checked += 1;
            if !cands.iter().any(|c| configure_has(&engine, c)) {
                bad.push(flag.to_string());
                println!("doctor: mozconfig flag NOT FOUND in pinned source: {flag}");
            } else {
                println!("doctor: mozconfig flag OK: {flag}");
            }
        } else if let Some(rest) = line.strip_prefix("export") {
            let rest = rest.trim();
            if let Some((var, val)) = rest.split_once('=') {
                checked += 1;
                let needle = format!("env=\"{var}\"");
                if configure_has(&engine, &needle) {
                    println!(
                        "doctor: mozconfig export OK: {var} (empty disables per options.py:454-456)"
                    );
                } else {
                    bad.push(rest.to_string());
                    println!("doctor: mozconfig export NOT FOUND in pinned source: {rest}");
                }
                let _ = val;
            }
        } else if line.starts_with("mk_add_options") {
            checked += 1;
            println!("doctor: mozconfig passthrough (not a configure flag): {line}");
        } else {
            bad.push(line.to_string());
            println!("doctor: mozconfig UNRECOGNISED line: {line}");
        }
    }
    if checked == 0 {
        return Err("no mozconfig lines checked".into());
    }
    if !bad.is_empty() {
        return Err(format!(
            "{} unknown mozconfig entr{}",
            bad.len(),
            if bad.len() == 1 { "y" } else { "ies" }
        ));
    }
    println!("doctor: mozconfig clean ({checked} lines, see docs/astra/BUILD_FLAGS.md)");
    Ok(())
}

// Branding values from branding/astra.toml (D-19). OWNER_DECISION gaps fall
// back to dev defaults with a warning (release builds refuse them elsewhere).
fn read_branding(root: &Path) -> Result<std::collections::HashMap<String, String>, String> {
    let text = fs::read_to_string(root.join("branding/astra.toml")).map_err(|e| e.to_string())?;
    let mut raw = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim().to_string();
        if let Some((k, v)) = line.split_once('=') {
            raw.insert(
                k.trim().to_string(),
                v.trim().trim_matches('"').trim().to_string(),
            );
        }
    }
    let dev = |key: &str, fallback: &str| match raw.get(key) {
        Some(v) if !v.is_empty() && v != "OWNER_DECISION" => v.clone(),
        _ => {
            println!("branding: WARNING {key} is OWNER_DECISION; using dev default {fallback}");
            fallback.to_string()
        }
    };
    let mut m = std::collections::HashMap::new();
    let display = raw
        .get("display_name")
        .cloned()
        .unwrap_or_else(|| "Astra".into());
    let binary = raw
        .get("binary_name")
        .cloned()
        .unwrap_or_else(|| "astra".into());
    // Astra's own build version, never the engine pin. Required: an empty
    // version must fail the overlay instead of rendering a placeholder that
    // About would show as real.
    let version = raw.get("version").cloned().unwrap_or_default();
    if version.is_empty() {
        return Err(
            "branding/astra.toml: version is required (Astra's dev/alpha build number)".into(),
        );
    }
    m.insert("ASTRA_DISPLAY_NAME".into(), display);
    m.insert("ASTRA_BINARY_NAME".into(), binary.clone());
    m.insert("ASTRA_VERSION".into(), version);
    m.insert("ASTRA_APP_ID".into(), dev("app_id", "com.astra.dev"));
    m.insert(
        "ASTRA_VENDOR".into(),
        dev("vendor", "Astra (dev placeholder)"),
    );
    m.insert(
        "ASTRA_UPDATE_HOST".into(),
        dev(
            "update_host",
            "https://localhost:0/placeholder-astra-update",
        ),
    );
    m.insert("ASTRA_WM_CLASS".into(), format!("{binary}-nightly"));
    Ok(m)
}

// Render overlay/astra/branding/**/*.in templates into engine/astra/branding/
// (P1-T03). Called by cmd_overlay after the copy; strips the .in files.
fn render_branding(root: &Path) -> Result<(), String> {
    let vals = read_branding(root)?;
    let dir = root.join("engine/astra/branding");
    if !dir.exists() {
        return Ok(());
    }
    // Collect first (recursive walk without external deps).
    let mut templates: Vec<std::path::PathBuf> = Vec::new();
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x == "in").unwrap_or(false) {
                templates.push(p);
            }
        }
    }
    if templates.is_empty() {
        println!("branding: no .in templates to render");
        return Ok(());
    }
    for t in &templates {
        let mut text = fs::read_to_string(t).map_err(|e| e.to_string())?;
        for (k, v) in &vals {
            text = text.replace(&format!("@{k}@"), v);
        }
        if text.contains("@ASTRA_") {
            return Err(format!(
                "branding: unsubstituted placeholder in {}",
                t.display()
            ));
        }
        let dest = t.with_extension("");
        fs::write(&dest, &text).map_err(|e| e.to_string())?;
        fs::remove_file(t).map_err(|e| e.to_string())?;
        println!(
            "branding: rendered {}",
            dest.strip_prefix(root).unwrap_or(&dest).display()
        );
    }
    Ok(())
}

// Render config/mozconfig.<os> into out/mozconfig.<os> (P1-T02).
// Substitutes @ASTRA_*@ placeholders from branding/astra.toml.
// Windows is a scaffold: the template mirrors linux and carries explicit
// TODO(windows-port) markers for flags still unverified on a real toolchain.
fn cmd_config(root: &Path, os: &str, branding: &str, objdir: Option<&str>) -> Result<(), String> {
    match os {
        "linux" | "windows" => {}
        _ => {
            return Err(format!("os {os}: only linux|windows yet (macos P10)"));
        }
    }
    let template_path = root.join(format!("config/mozconfig.{os}"));
    if !template_path.exists() {
        return Err(format!("{} missing", template_path.display()));
    }
    let branding_toml = root.join("branding/astra.toml");
    let brands = fs::read_to_string(&branding_toml).map_err(|e| e.to_string())?;
    let mut display = String::from("Astra");
    let mut binary = String::from("astra");
    for line in brands.lines() {
        let line = line.split('#').next().unwrap_or("").trim().to_string();
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim().trim_matches('"').trim().to_string();
            match k.trim() {
                "display_name" => display = v,
                "binary_name" => binary = v,
                _ => {}
            }
        }
    }
    // Non-fatal: OWNER_DECISION placeholders block release builds only (D-19).
    for line in brands.lines() {
        if line.contains("OWNER_DECISION") {
            println!(
                "config: WARNING branding placeholder pending owner decision: {}",
                line.trim()
            );
        }
    }
    let branding_dir = match branding {
        "astra" => "astra/branding",
        "unofficial" => "browser/branding/unofficial",
        other => {
            return Err(format!(
                "unknown --branding {other} (want astra|unofficial)"
            ));
        }
    };
    let template = fs::read_to_string(&template_path).map_err(|e| e.to_string())?;
    let default_objdir = format!("@TOPSRCDIR@/{}", objdir_name(os));
    let objdir = objdir.unwrap_or(&default_objdir);
    let rendered = template
        .replace("@ASTRA_BRANDING_DIR@", branding_dir)
        .replace("@ASTRA_DISPLAY_NAME@", &display)
        .replace("@ASTRA_BINARY_NAME@", &binary)
        .replace("@ASTRA_OBJDIR@", objdir);
    if rendered.contains("@ASTRA_") {
        return Err("config: unsubstituted @ASTRA_*@ placeholder left".into());
    }
    let out_dir = root.join("out");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let dest = out_dir.join(format!("mozconfig.{os}"));
    fs::write(&dest, &rendered).map_err(|e| e.to_string())?;
    println!(
        "config: rendered {} (branding={branding} -> {branding_dir})",
        dest.display()
    );
    if branding == "astra" && !root.join("engine/astra/branding").exists() {
        println!(
            "config: WARNING engine/astra/branding absent (lands P1-T03); configure needs `forge config --branding unofficial` until then"
        );
    }
    println!("config: next: export MOZCONFIG={}", dest.display());
    Ok(())
}

/// True when every added line of a patch already exists in its target files.
/// Used only to decide that a rebuilt tree already carries the patch; it is
/// intentionally conservative (any missing line -> false).
fn patch_content_present(engine: &Path, patch: &Path) -> bool {
    let text = match fs::read_to_string(patch) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let body = match split_header(&text) {
        Ok((_, body)) => body,
        Err(_) => return false,
    };
    let mut saw_added = false;
    for chunk in body.split("\ndiff --git ") {
        let chunk = if chunk.starts_with("diff --git ") {
            chunk.to_string()
        } else {
            format!("diff --git {chunk}")
        };
        let mut target = None;
        let mut added: Vec<&str> = Vec::new();
        for line in chunk.lines() {
            if let Some(rest) = line.strip_prefix("+++ b/") {
                target = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix('+') {
                if !line.starts_with("+++") && !rest.trim().is_empty() {
                    added.push(rest);
                }
            }
        }
        let Some(target) = target else { continue };
        if added.is_empty() {
            continue;
        }
        let path = engine.join(&target);
        let Ok(current) = fs::read_to_string(&path) else {
            return false;
        };
        if !added
            .iter()
            .all(|line| current.lines().any(|have| have == *line))
        {
            return false;
        }
        saw_added = true;
    }
    saw_added
}

// Copy overlay/astra/** into engine/astra/ and apply the P2 hook list (P1-T05).
// Idempotent: re-copies the tree, skips patches that already apply reversed.
fn cmd_overlay(root: &Path, os: &str) -> Result<(), String> {
    let src = root.join("overlay/astra");
    if !src.join("moz.build").exists() {
        return Err("overlay/astra/moz.build missing".into());
    }
    let engine = root.join("engine");
    if !engine.join("mach").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    let dest = engine.join("astra");
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir(root, &src, &dest)?;
    println!("overlay: copied overlay/astra -> engine/astra");
    // Apply hook patches in order (P2 list; full series handling is P1-T12).
    let mut patches: Vec<std::path::PathBuf> = Vec::new();
    let dir = root.join("patches");
    if dir.exists() {
        let mut entries: Vec<_> = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "patch").unwrap_or(false))
            .collect();
        entries.sort();
        patches = entries;
    }
    if patches.is_empty() {
        println!("overlay: no patches/*.patch to apply");
    }
    for p in &patches {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if let Some(only) = patch_os(p) {
            if only != os {
                println!("overlay: {name} skipped (OS: {only})");
                continue;
            }
        }
        // Already applied? `git apply --reverse --check` exits 0 only then.
        // Cargo.lock is a derived vendored artifact: later patches and
        // `mach vendor rust` rewrite it, so reverse-checking it would make an
        // already-applied patch look unapplied on a rebuilt tree.
        let applied = Command::new("git")
            .args([
                "apply",
                "--reverse",
                "--check",
                "--exclude=Cargo.lock",
                &p.to_string_lossy(),
            ])
            .current_dir(&engine)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if applied {
            println!("overlay: {name} already applied, skipping");
            continue;
        }
        // A rebuilt tree can have later commits that make the exact reverse
        // check fail (Cargo.lock, regenerated files) while the patch content
        // is clearly present. Never re-apply over it: the failure mode is a
        // duplicate hunk/new-file error that hides the real state.
        if patch_content_present(&engine, p) {
            println!("overlay: {name} content already present, skipping");
            continue;
        }
        run("git", &["apply", "-v", &p.to_string_lossy()], &engine)?;
        println!("overlay: applied {name}");
    }
    // The blocker's source of truth lives in `blocker/`, never in the patch
    // body or the fetched engine. Stage it after the series so a fresh tree
    // gets the patch-created files and an existing tree is refreshed in place.
    stage_blocker(root, &engine)?;
    if os == "linux" {
        stage_passkeys(root, &engine)?;
    } else {
        println!("overlay: passkeys/engine skipped on {os} (Windows uses Windows Hello)");
    }
    // Sanity: the wiring targets must exist after overlay.
    for f in [
        "astra/moz.build",
        "astra/jar.mn",
        "astra/host/HostAPI.sys.mjs",
        "astra/chrome/hello.html",
        "browser/app.mozbuild",
    ] {
        if !engine.join(f).exists() {
            return Err(format!("overlay: expected {f} missing after apply"));
        }
    }
    render_branding(root)?;
    println!("overlay: done (chrome://astra/ + resource://astra/ staged)");
    Ok(())
}

/// Copy `passkeys/engine/**` into the in-tree Rust component linked by
/// `authrs_bridge` (ASTRA-0014). Derived artifact: edit `passkeys/` and re-run
/// `forge overlay`.
fn stage_passkeys(root: &Path, engine: &Path) -> Result<(), String> {
    let src = root.join("passkeys/engine");
    if !src.join("src/lib.rs").exists() {
        return Err("passkeys/engine/src/lib.rs missing (source of truth)".into());
    }
    let dest = engine.join("toolkit/components/astra_passkeys");
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir(root, &src, &dest)?;
    println!("overlay: staged passkeys/engine -> toolkit/components/astra_passkeys");
    Ok(())
}

/// Copy `blocker/engine/**` into the in-tree component and the shipped data
/// files into `engine/astra/blocker/`. These copies are derived artifacts;
/// edit `blocker/` and re-run `forge overlay`.
fn stage_blocker(root: &Path, engine: &Path) -> Result<(), String> {
    let src = root.join("blocker/engine");
    if !src.join("src/lib.rs").exists() {
        return Err("blocker/engine/src/lib.rs missing (source of truth)".into());
    }
    let dest = engine.join("toolkit/components/astra_blocker_engine");
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir(root, &src, &dest)?;
    println!("overlay: staged blocker/engine -> toolkit/components/astra_blocker_engine");

    let data_dest = engine.join("astra/blocker");
    if data_dest.exists() {
        fs::remove_dir_all(&data_dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(data_dest.join("seed")).map_err(|e| e.to_string())?;
    for (from, to) in [
        ("blocker/lists/catalog.json", "catalog.json"),
        ("blocker/resources/resources.json", "resources.json"),
    ] {
        let source = root.join(from);
        if !source.exists() {
            return Err(format!(
                "overlay: {from} missing (run blocker/tools/sync.py)"
            ));
        }
        fs::copy(&source, data_dest.join(to)).map_err(|e| e.to_string())?;
    }
    let seed = root.join("blocker/seed");
    if seed.exists() {
        for entry in fs::read_dir(&seed).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().map(|e| e == "gz").unwrap_or(false) {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                fs::copy(&path, data_dest.join("seed").join(name)).map_err(|e| e.to_string())?;
            }
        }
    }
    println!("overlay: staged blocker data -> astra/blocker (catalog, resources, seed)");
    Ok(())
}

// ---- P1-T12: patch series model (§6.3) ----
// Patch files are `Patch-Id: ASTRA-NNNN` headers (lines up to the first
// line that is exactly `---`), then a `git diff` body. std-only: no serde.

const REQUIRED_FIELDS: [&str; 9] = [
    "Patch-Id",
    "Title",
    "Tier",
    "Upstream-Files",
    "Intent",
    "Risk",
    "Test",
    "Verified-On",
    "Removal-Plan",
];

fn list_patches(root: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = root.join("patches");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "patch").unwrap_or(false))
        .collect();
    entries.sort();
    Ok(entries)
}

// Split patch text into (header lines, body). Errors when the `---`
// separator is missing. Body lines that happen to be `---` (a filename
// starting with `--`) are not our series' convention; the first
// column-0 `---` ends the header.
fn split_header(text: &str) -> Result<(Vec<String>, String), String> {
    let lines: Vec<&str> = text.lines().collect();
    let sep = lines.iter().position(|l| l.trim_end() == "---");
    match sep {
        Some(i) => Ok((
            lines[..i].iter().map(|s| s.to_string()).collect(),
            lines[i + 1..].join("\n"),
        )),
        None => Err("missing header/body `---` separator".into()),
    }
}

fn header_map(header: &[String]) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for l in header {
        if let Some((k, v)) = l.split_once(':') {
            m.entry(k.trim().to_string())
                .or_insert(v.trim().to_string());
        }
    }
    m
}

fn upstream_files_of(map: &std::collections::HashMap<String, String>) -> Vec<String> {
    map.get("Upstream-Files")
        .map(|v| {
            v.split(|c| c == ',' || c == ' ')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// True when the patch body creates `path` as a new file (`new file mode`
/// hunk with a matching `+++ b/<path>`). Used by the lint carve-out for
/// patches that add new files (e.g. ASTRA-0004): the Upstream-Files entries
/// for those files cannot exist at the engine baseline by construction.
fn patch_adds_new_file(body: &str, path: &str) -> bool {
    let mut new_file = false;
    for line in body.lines() {
        if line.starts_with("new file mode") {
            new_file = true;
            continue;
        }
        if line.starts_with("+++ b/") {
            if new_file && line["+++ b/".len()..].trim() == path {
                return true;
            }
            new_file = false;
        } else if !line.starts_with("+++")
            && !line.starts_with("---")
            && !line.starts_with("diff ")
            && !line.starts_with("index ")
        {
            new_file = false;
        }
    }
    false
}

// Root (baseline) commit of the engine/ git repo — the `forge fetch`
// `baseline: firefox <version>` commit. Falls back to the root commit.
fn find_baseline(engine: &Path) -> Result<String, String> {
    if let Ok(h) = run(
        "git",
        &["log", "--format=%H", "--grep=^baseline:", "--reverse"],
        engine,
    ) {
        if let Some(first) = h.lines().next().filter(|s| !s.is_empty()) {
            return Ok(first.to_string());
        }
    }
    let roots = run("git", &["rev-list", "--max-parents=0", "HEAD"], engine)?;
    roots
        .lines()
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "engine/: no commits found".into())
}

fn git_check(engine: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(engine)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn json_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

// Patch header lint: §6.3 mandatory fields + Tier rules + `git apply --check` (P1-T05/P1-T12).
// Tier rules: Tier ∈ {P0,P1,P2,P3}; every patch lists ≥1 upstream file;
// P3 (experimental) must carry a real removal plan (not "none...").
// Upstream-Files must exist at the engine baseline; Verified-On must equal
// the pinned upstream.toml version; Patch-Id must match the filename and
// the series must be numbered in order.
fn cmd_lint(root: &Path) -> Result<(), String> {
    let entries = list_patches(root)?;
    if entries.is_empty() {
        println!("lint: no patches to check");
        return Ok(());
    }
    let up = read_upstream(root);
    let pinned = up.get("version").cloned().unwrap_or_default();
    let engine = root.join("engine");
    let have_engine_git = engine.join(".git").exists();
    let baseline = if have_engine_git {
        find_baseline(&engine).ok()
    } else {
        None
    };
    let mut ok = true;
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut ids: Vec<String> = Vec::new();
    for p in &entries {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(p).map_err(|e| e.to_string())?;
        let (header, body) = match split_header(&text) {
            Ok(v) => v,
            Err(e) => {
                println!("lint: {name}: {e}");
                ok = false;
                continue;
            }
        };
        let map = header_map(&header);
        for field in REQUIRED_FIELDS {
            match map.get(field) {
                Some(v) if !v.trim().is_empty() => {}
                _ => {
                    println!("lint: {name}: missing header field {field}");
                    ok = false;
                }
            }
        }
        let id = map.get("Patch-Id").cloned().unwrap_or_default();
        if !id.is_empty() {
            if !(name == format!("{id}.patch") || name.starts_with(&format!("{id}-"))) {
                println!("lint: {name}: filename does not start with Patch-Id {id}");
                ok = false;
            }
            if let Some(prev) = seen.get(&id) {
                println!("lint: {name}: duplicate Patch-Id {id} (also in {prev})");
                ok = false;
            } else {
                seen.insert(id.clone(), name.clone());
            }
            ids.push(id);
        }
        let tier = map
            .get("Tier")
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !["P0", "P1", "P2", "P3"].contains(&tier.as_str()) {
            println!("lint: {name}: bad Tier {tier}");
            ok = false;
        } else if tier == "P3" {
            let rp = map
                .get("Removal-Plan")
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if rp.is_empty() || rp.starts_with("none") || rp == "tbd" || rp == "n/a" {
                println!(
                    "lint: {name}: Tier P3 (experimental) needs a real Removal-Plan, not {rp:?}"
                );
                ok = false;
            }
        }
        let files = upstream_files_of(&map);
        if map.contains_key("Upstream-Files") && files.is_empty() {
            println!("lint: {name}: Upstream-Files lists no files");
            ok = false;
        }
        for f in &files {
            let exists = match &baseline {
                Some(b) => git_check(&engine, &["cat-file", "-e", &format!("{b}:{f}")]),
                None => engine.join(f).exists(),
            };
            if have_engine_git && baseline.is_some() && !exists {
                // Carve-out (P4-T02, BLOCKER_WIRING.md §6): an entry missing
                // at baseline is accepted when the patch body creates it
                // (`new file` hunk). `forge export` requires the entry to
                // keep covering the new file; without the entry the next
                // export would silently drop it.
                if patch_adds_new_file(&body, f) {
                    println!("lint: {name}: Upstream-Files entry is patch-added new file: {f}");
                } else {
                    println!("lint: {name}: Upstream-Files entry missing at baseline: {f}");
                    ok = false;
                }
            } else if !have_engine_git && !engine.join(f).exists() {
                println!(
                    "lint: {name}: (no engine checkout) cannot verify Upstream-Files entry: {f}"
                );
            }
        }
        if !pinned.is_empty() && pinned != "UNVERIFIED" {
            match map.get("Verified-On") {
                Some(v) if v.trim() == pinned => {}
                Some(v) => {
                    println!("lint: {name}: Verified-On {v} != pinned upstream {pinned}");
                    ok = false;
                }
                None => {}
            }
        }
        // Must apply cleanly OR already be applied (reverse-checks clean).
        // Cargo.lock is excluded from the forward check: it is a generated
        // lockfile touched by adjacent series patches (e.g. ASTRA-0003 inserts
        // astra_blocker_engine right where ASTRA-0014's hunk expects it), so a
        // later patch can only match once its predecessors are applied — which
        // is exactly how `forge import` applies the series. The reverse check
        // already excludes it for the same reason; all other files are still
        // strictly checked in both directions.
        if engine.join("mach").exists() {
            let pstr = p.to_string_lossy().into_owned();
            let clean = git_check(
                &engine,
                &["apply", "--check", "--exclude=Cargo.lock", &pstr],
            );
            let applied = git_check(
                &engine,
                &[
                    "apply",
                    "--reverse",
                    "--check",
                    "--exclude=Cargo.lock",
                    &pstr,
                ],
            );
            if clean || applied {
                println!(
                    "lint: {name}: applies {}",
                    if applied {
                        "(already applied)"
                    } else {
                        "cleanly"
                    }
                );
            } else {
                println!("lint: {name}: DOES NOT APPLY");
                ok = false;
            }
        }
    }
    let mut ordered = ids.clone();
    ordered.sort();
    if ids != ordered {
        println!("lint: patch series out of Patch-Id order");
        ok = false;
    }
    if !ok {
        return Err("lint: patch header/apply failures (see above)".into());
    }
    println!("lint: all {} patch(es) clean", entries.len());
    Ok(())
}

// `forge export`: regenerate patches/*.patch bodies from the live engine/
// tree (diff of each patch's Upstream-Files vs the fetch baseline commit),
// preserving the §6.3 headers. Fails (before writing anything) when the
// engine tree holds changes no patch covers, so the series never silently
// drops upstream drift.
fn cmd_export(root: &Path) -> Result<(), String> {
    let engine = root.join("engine");
    if !engine.join("mach").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    let entries = list_patches(root)?;
    if entries.is_empty() {
        return Err(
            "no patches/*.patch yet: create the first ASTRA-0001 header, then export".into(),
        );
    }
    let baseline = find_baseline(&engine)?;
    struct Item {
        path: PathBuf,
        name: String,
        header: Vec<String>,
        files: Vec<String>,
    }
    let mut items: Vec<Item> = Vec::new();
    let mut covered: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for p in &entries {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(p).map_err(|e| e.to_string())?;
        let (header, _) = split_header(&text)
            .map_err(|e| format!("export: {name}: {e} (fix the header first)"))?;
        let files = upstream_files_of(&header_map(&header));
        if files.is_empty() {
            return Err(format!("export: {name}: Upstream-Files lists no files"));
        }
        for f in &files {
            covered.entry(f.clone()).or_insert_with(|| name.clone());
        }
        items.push(Item {
            path: p.clone(),
            name,
            header,
            files,
        });
    }
    // Untouched-by-baseline new files are invisible to `git diff` until they
    // are intent-to-add: register every listed Upstream-File that exists in
    // the worktree but is untracked, so both the uncovered-drift check and
    // the body refresh below see real `new file` hunks with full content.
    // (Without this, export silently drops new files — e.g. ASTRA-0004's
    // whole crate vanished on refresh.) Intent-to-add touches only the
    // engine index, never file content.
    {
        let mut untracked: Vec<&str> = Vec::new();
        for it in &items {
            for f in &it.files {
                let tracked = run("git", &["ls-files", "--error-unmatch", f], &engine).is_ok();
                if !tracked && engine.join(f).exists() {
                    untracked.push(f.as_str());
                }
            }
        }
        if !untracked.is_empty() {
            let mut args: Vec<&str> = vec!["add", "--intent-to-add", "-N", "--"];
            args.extend(untracked);
            run("git", &args, &engine)?;
        }
    }
    // Fail fast on uncovered drift (before rewriting anything).
    let short = baseline.chars().take(12).collect::<String>();
    let touched = run(
        "git",
        &["diff", "--name-only", &baseline, "--", "."],
        &engine,
    )?;
    let uncovered: Vec<&str> = touched
        .lines()
        .map(str::trim)
        .filter(|f| {
            !f.is_empty()
            && !covered.contains_key(*f)
            // Vendored Rust sources are reproducible derived artifacts
            // (`mach vendor rust` in import regenerates them; see §6.4).
            && !f.starts_with("third_party/rust/")
            // Overlay output (engine/astra/) is applied by `forge overlay`
            // from overlay/ (source of truth), never patch content.
            && !f.starts_with("astra/")
        })
        .collect();
    if !uncovered.is_empty() {
        let mut msg =
            format!("export: engine/ has changes no patch covers (diff vs baseline {short}):\n");
        for f in uncovered {
            msg.push_str(&format!("  {f}\n"));
        }
        msg.push_str(
            "create patches/ASTRA-00NN-<slug>.patch with a §6.3 header, then re-run export",
        );
        return Err(msg);
    }
    let mut refreshed = 0;
    for it in &items {
        let mut args: Vec<&str> = vec!["diff", &baseline, "--"];
        let owned: Vec<String> = it.files.clone();
        let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        args.extend(refs);
        let body = run_raw("git", &args, &engine)?;
        if body.trim().is_empty() {
            println!(
                "export: {}: no live diff vs baseline, keeping existing body",
                it.name
            );
            continue;
        }
        let mut out = it.header.join("\n");
        out.push_str("\n---\n");
        // Trim only the trailing newlines, never a final blank context line:
        // a hunk whose last line is a blank context line is still part of the
        // hunk and stripping its space corrupts the patch.
        out.push_str(body.trim_end_matches('\n'));
        out.push('\n');
        fs::write(&it.path, &out).map_err(|e| e.to_string())?;
        println!(
            "export: {}: body refreshed ({} file(s))",
            it.name,
            it.files.len()
        );
        refreshed += 1;
    }
    println!(
        "export: done ({refreshed}/{} patch bodies from engine@{short})",
        items.len()
    );
    Ok(())
}

struct PatchStatus {
    id: String,
    file: String,
    tier: String,
    status: String,
    detail: String,
    added: usize,
}

// `patch -p1 --dry-run` detail for a patch that does not apply cleanly:
// surfaces offset/fuzz hunks (git apply --check is binary). Best-effort:
// returns "patch(1) unavailable" when the tool is missing.
fn patch_dryrun_detail(engine: &Path, patch_abs: &str) -> String {
    let out = Command::new("patch")
        .args(["-p1", "--dry-run", "-f"])
        .current_dir(engine)
        .arg("-i")
        .arg(patch_abs)
        .output();
    let out = match out {
        Ok(o) => o,
        Err(_) => return "patch(1) unavailable".into(),
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let mut hits: Vec<&str> = text
        .lines()
        .filter(|l| {
            let l = l.to_lowercase();
            l.contains("offset")
                || l.contains("fuzz")
                || l.contains("succeed")
                || l.contains("fail")
        })
        .take(3)
        .collect();
    if hits.is_empty() {
        hits = text.lines().take(2).collect();
    }
    let d: Vec<String> = hits.into_iter().map(|s| s.trim().to_string()).collect();
    let mut s = d.join(" / ");
    if s.is_empty() {
        s = if out.status.success() {
            "dry-run ok".into()
        } else {
            "dry-run failed".into()
        };
    }
    if s.len() > 300 {
        s.truncate(300);
    }
    s
}

fn count_added(body: &str) -> (usize, usize) {
    let mut added = 0;
    let mut removed = 0;
    for l in body.lines() {
        if l.starts_with("+++") || l.starts_with("---") {
            continue;
        } else if l.starts_with('+') {
            added += 1;
        } else if l.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

// `forge import [--check]`: apply patches/*.patch in series order with
// 3-way fallback. Per-patch clean/offset/fuzz/conflict report goes to
// out/patch-health.json; on success the docs hook refreshes
// docs/astra/UPSTREAM.md. --check only classifies, never writes engine/.
fn cmd_import(root: &Path, check_only: bool, os: &str) -> Result<(), String> {
    let engine = root.join("engine");
    if !engine.join("mach").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    let entries = list_patches(root)?;
    if entries.is_empty() {
        println!("import: no patches to apply");
        return Ok(());
    }
    let baseline = find_baseline(&engine)?;
    let mut report: Vec<PatchStatus> = Vec::new();
    let mut conflicts = 0;
    for p in &entries {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        // Rust's canonicalize returns a verbatim `\\?\E:\...` path on Windows;
        // Git for Windows rejects that prefix.
        let pabs = fs::canonicalize(p)
            .map(strip_verbatim)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        let text = fs::read_to_string(p).map_err(|e| e.to_string())?;
        let (header, body) = match split_header(&text) {
            Ok(v) => v,
            Err(e) => {
                report.push(PatchStatus {
                    id: name.clone(),
                    file: name.clone(),
                    tier: "?".into(),
                    status: "bad-header".into(),
                    detail: e,
                    added: 0,
                });
                conflicts += 1;
                continue;
            }
        };
        let map = header_map(&header);
        let id = map.get("Patch-Id").cloned().unwrap_or_else(|| name.clone());
        let tier = map.get("Tier").cloned().unwrap_or_else(|| "?".into());
        let (added, _) = count_added(&body);
        let mut push = |status: &str, detail: String| {
            report.push(PatchStatus {
                id: id.clone(),
                file: name.clone(),
                tier: tier.clone(),
                status: status.into(),
                detail,
                added,
            });
        };
        if let Some(only) = patch_os(p) {
            if only != os {
                println!("import: {name}: skipped (OS: {only})");
                push("skipped", format!("OS: {only}"));
                continue;
            }
        }
        if git_check(&engine, &["apply", "--reverse", "--check", &pabs]) {
            println!("import: {name}: already applied, skipping");
            push("already-applied", "reverse-check clean".into());
            continue;
        }
        if check_only {
            if git_check(&engine, &["apply", "--check", &pabs]) {
                println!("import: {name}: would apply cleanly");
                push("clean", "applies cleanly (git apply --check)".into());
            } else {
                let d = patch_dryrun_detail(&engine, &pabs);
                println!("import: {name}: needs 3-way or conflicts ({d})");
                push("needs-three-way-or-conflict", d);
            }
            continue;
        }
        if git_check(&engine, &["apply", "--check", &pabs]) {
            match run("git", &["apply", "-v", &pabs], &engine) {
                Ok(_) => {
                    println!("import: {name}: applied cleanly");
                    push("clean", "applies cleanly (git apply --check)".into());
                }
                Err(e) => {
                    println!("import: {name}: CONFLICT ({e})");
                    push("conflict", e);
                    conflicts += 1;
                }
            }
            continue;
        }
        let detail = patch_dryrun_detail(&engine, &pabs);
        match run("git", &["apply", "--3way", "-v", &pabs], &engine) {
            Ok(_) => {
                println!("import: {name}: applied via 3-way ({detail})");
                push("three-way", detail);
            }
            Err(e) => {
                println!("import: {name}: CONFLICT ({e}; {detail})");
                push("conflict", format!("{e}; {detail}"));
                conflicts += 1;
            }
        }
    }
    write_health_json(root, &baseline, &report)?;
    if conflicts > 0 {
        return Err(format!(
            "import: {conflicts} patch(es) conflicted (see out/patch-health.json)"
        ));
    }
    if check_only {
        println!(
            "import: check only, engine/ untouched ({} patch(es) classified)",
            report.len()
        );
        return Ok(());
    }
    match update_docs_hook(root, &report) {
        Ok(n) => println!("import: docs hook refreshed {n} UPSTREAM.md row(s)"),
        Err(e) => println!("import: WARNING docs hook skipped ({e})"),
    }
    // Vendored Rust sources are derived artifacts (Cargo.toml/lock +
    // registry), not patch content: regenerate them so the tree builds.
    // Failures are warnings, not errors — `cargo vet` drift on Mozilla's
    // own crates can block vendoring while our deps are fine (P4-T02);
    // the build fails fast with a missing-crate error if anything needed
    // is actually absent.
    {
        use std::process::Command;
        let mut cmd = Command::new("./mach");
        cmd.args(["vendor", "rust", "--ignore-modified"])
            .current_dir(&engine);
        if std::env::var("MOZCONFIG").is_err() {
            let rendered = root.join("out/mozconfig.linux");
            if rendered.exists() {
                cmd.env("MOZCONFIG", &rendered);
            }
        }
        match cmd.output().map_err(|e| format!("spawn mach: {e}")) {
            Ok(o) if o.status.success() => println!("import: vendored Rust sources refreshed"),
            Ok(o) => println!(
                "import: WARNING `mach vendor rust` incomplete ({}); see docs/astra/BLOCKER_WIRING.md §4",
                String::from_utf8_lossy(&o.stderr)
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("")
            ),
            Err(e) => println!("import: WARNING vendor skipped ({e})"),
        }
    }
    println!(
        "import: done ({} patch(es), health in out/patch-health.json)",
        report.len()
    );
    Ok(())
}

fn write_health_json(root: &Path, baseline: &str, report: &[PatchStatus]) -> Result<(), String> {
    let out_dir = root.join("out");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let up = read_upstream(root);
    let version = up.get("version").cloned().unwrap_or_default();
    let mut s = String::from("{\n");
    s.push_str(&format!("  \"version\": \"{}\",\n", json_escape(&version)));
    s.push_str(&format!("  \"baseline\": \"{}\",\n", json_escape(baseline)));
    s.push_str("  \"patches\": [\n");
    for (i, r) in report.iter().enumerate() {
        s.push_str(&format!(
            "    {{\"id\": \"{}\", \"file\": \"{}\", \"tier\": \"{}\", \"status\": \"{}\", \"added_lines\": {}, \"detail\": \"{}\"}}{}\n",
            json_escape(&r.id), json_escape(&r.file), json_escape(&r.tier),
            json_escape(&r.status), r.added, json_escape(&r.detail),
            if i + 1 == report.len() { "" } else { "," }
        ));
    }
    let n_conflict = report
        .iter()
        .filter(|r| r.status == "conflict" || r.status == "bad-header")
        .count();
    s.push_str(&format!(
        "  ],\n  \"summary\": {{\"total\": {}, \"conflicts\": {}}}\n}}\n",
        report.len(),
        n_conflict
    ));
    fs::write(out_dir.join("patch-health.json"), &s).map_err(|e| e.to_string())?;
    println!("import: wrote out/patch-health.json");
    Ok(())
}

// Refresh the backticked leading status token of a Patch health Status
// cell and stamp/refresh a "via `forge import` <date>" suffix. All other
// prose (verification evidence from earlier phases) is preserved.
fn refresh_status_cell(cell: &str, status: &str, date: &str) -> String {
    let mut s = cell.trim().to_string();
    if s.starts_with('`') {
        if let Some(end) = s[1..].find('`') {
            s.replace_range(..end + 2, &format!("`{status}`"));
        } else {
            s = format!("`{status}` {s}");
        }
    } else {
        s = format!("`{status}` — {s}");
    }
    let stamp = "via `forge import` ";
    if let Some(pos) = s.find(stamp) {
        let after = pos + stamp.len();
        let rest = s[after..].to_string();
        let is_date = rest.len() >= 10
            && rest.chars().take(10).enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == '-'
                } else {
                    c.is_ascii_digit()
                }
            });
        if is_date {
            s.replace_range(after..after + 10, date);
        } else {
            s.insert_str(after, &format!("{date} "));
        }
    } else {
        s.push_str(&format!(" · {stamp}{date}"));
    }
    s
}

fn strip_parens(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut depth: usize = 0;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {
                if depth == 0 {
                    o.push(c);
                }
            }
        }
    }
    o
}

fn first_ints(line: &str, n: usize) -> Vec<usize> {
    // Budgets live inside "(...)" groups ("budget ≤ 1,500"); strip those
    // so only the live counts are compared.
    let scrubbed = strip_parens(line);
    let line = scrubbed.as_str();
    let mut nums = Vec::new();
    let mut cur = String::new();
    for c in line.chars() {
        if c.is_ascii_digit() || c == ',' {
            if c != ',' {
                cur.push(c);
            }
        } else if !cur.is_empty() {
            if let Ok(v) = cur.parse() {
                nums.push(v);
            }
            cur.clear();
            if nums.len() == n {
                break;
            }
        }
    }
    if !cur.is_empty() && nums.len() < n {
        if let Ok(v) = cur.parse() {
            nums.push(v);
        }
    }
    nums
}
fn update_docs_hook(root: &Path, report: &[PatchStatus]) -> Result<usize, String> {
    let path = root.join("docs/astra/UPSTREAM.md");
    if !path.exists() {
        return Err("docs/astra/UPSTREAM.md missing".into());
    }
    let date = run("date", &["+%F"], root).unwrap_or_else(|_| "undated".into());
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let fp = compute_footprint(root)?;
    let mut touched = 0;
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with("- Footprint budget:") {
            // Rewrite only when the numbers actually changed, so the
            // sentence tail ("Headroom intact." etc.) written by humans
            // is never clobbered by a no-op import.
            let have = first_ints(line, 3);
            let want = vec![fp.lines_p2_p3, fp.patches, fp.p3];
            if have == want {
                out.push(line.to_string());
            } else {
                out.push(format!(
                    "- Footprint budget: {} upstream lines touched (budget ≤ 1,500), {} patches (≤ 60), {} P3.",
                    fp.lines_p2_p3, fp.patches, fp.p3
                ));
            }
            continue;
        }
        if line.starts_with('|') {
            let cells: Vec<&str> = line.split('|').collect();
            // | Patch | Tier | Upstream files touched | Status |
            if cells.len() >= 5 {
                let row_id = cells[1].trim().split_whitespace().next().unwrap_or("");
                if let Some(r) = report.iter().find(|r| r.id == row_id) {
                    // Table health reads `clean` when the patch is applied
                    // (already or just now); the precise import status stays
                    // in out/patch-health.json.
                    let shown = if r.status == "already-applied" {
                        "clean"
                    } else {
                        r.status.as_str()
                    };
                    let status = refresh_status_cell(cells[4], shown, date.trim());
                    out.push(format!(
                        "|{}|{}|{}| {status} |",
                        cells[1], cells[2], cells[3]
                    ));
                    touched += 1;
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    let mut final_text = out.join("\n");
    final_text.push('\n');
    fs::write(&path, &final_text).map_err(|e| e.to_string())?;
    Ok(touched)
}

struct Footprint {
    lines_p2_p3: usize,
    patches: usize,
    p3: usize,
}

// §6.7 footprint: added+removed diff-body lines over Tier P2/P3 patches,
// patch count, P3 count. Header lines never count (body only).
fn compute_footprint(root: &Path) -> Result<Footprint, String> {
    let entries = list_patches(root)?;
    let mut lines = 0;
    let mut p3 = 0;
    for p in &entries {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(p).map_err(|e| e.to_string())?;
        let (header, body) = split_header(&text).map_err(|e| format!("footprint: {name}: {e}"))?;
        let map = header_map(&header);
        let tier = map
            .get("Tier")
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let (added, removed) = count_added(&body);
        if tier == "P2" || tier == "P3" {
            lines += added + removed;
        }
        if tier == "P3" {
            p3 += 1;
        }
    }
    Ok(Footprint {
        lines_p2_p3: lines,
        patches: entries.len(),
        p3,
    })
}

// `forge footprint`: enforce the §6.7 budget (defaults ≤4000 lines P2/P3,
// ≤60 patches, ≤8 P3). Always writes out/footprint.json; exits 1 over
// budget with the offending dimensions named.
fn cmd_footprint(
    root: &Path,
    max_lines: usize,
    max_patches: usize,
    max_p3: usize,
) -> Result<(), String> {
    let fp = compute_footprint(root)?;
    let out_dir = root.join("out");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let ok = fp.lines_p2_p3 <= max_lines && fp.patches <= max_patches && fp.p3 <= max_p3;
    let json = format!(
        "{{\n  \"lines_p2_p3\": {}, \"patches\": {}, \"p3\": {},\n  \"budget\": {{\"lines\": {}, \"patches\": {}, \"p3\": {}}},\n  \"ok\": {}\n}}\n",
        fp.lines_p2_p3, fp.patches, fp.p3, max_lines, max_patches, max_p3, ok
    );
    fs::write(out_dir.join("footprint.json"), &json).map_err(|e| e.to_string())?;
    println!(
        "footprint: {} P2/P3 line(s) (budget ≤ {}), {} patch(es) (≤ {}), {} P3 (≤ {})",
        fp.lines_p2_p3, max_lines, fp.patches, max_patches, fp.p3, max_p3
    );
    if !ok {
        let mut over = Vec::new();
        if fp.lines_p2_p3 > max_lines {
            over.push(format!("lines {} > {}", fp.lines_p2_p3, max_lines));
        }
        if fp.patches > max_patches {
            over.push(format!("patches {} > {}", fp.patches, max_patches));
        }
        if fp.p3 > max_p3 {
            over.push(format!("P3 {} > {}", fp.p3, max_p3));
        }
        return Err(format!(
            "footprint: OVER BUDGET ({}) — see out/footprint.json",
            over.join(", ")
        ));
    }
    println!("footprint: within budget (report in out/footprint.json)");
    Ok(())
}

// Run the build: `mach build` (full) or `mach build faster` (frontend-only, U-02).
// Defaults MOZCONFIG to out/mozconfig.linux and SCCACHE_DIR to out/sccache
// when the caller did not set them (the P1-T04 proven setup).
fn cmd_build(root: &Path, os: &str, faster: bool, jobs: Option<&str>) -> Result<(), String> {
    let engine = root.join("engine");
    if !engine.join("mach").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    let mozconfig = std::env::var("MOZCONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join(format!("out/mozconfig.{os}")));
    if !mozconfig.exists() {
        return Err(format!(
            "build: {} absent (run `forge config --os {os}`)",
            mozconfig.display()
        ));
    }
    let sccache = std::env::var("SCCACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            if os == "windows" {
                PathBuf::from("D:/astra-build/sccache")
            } else {
                root.join("out/sccache")
            }
        });
    let mut mach_args: Vec<String> = vec!["build".into()];
    if faster {
        mach_args.push("faster".into());
    }
    if let Some(n) = jobs {
        mach_args.push(format!("-j{n}"));
    }

    let status = if os == "windows" {
        let shell = Path::new("C:\\mozilla-build\\start-shell.bat");
        if !shell.exists() {
            return Err(
                "build: C:\\mozilla-build\\start-shell.bat absent (install MozillaBuild)".into(),
            );
        }
        let mut script =
            String::from("export PATH=\"/c/Program Files/LLVM/bin:/c/tools/nasm:$PATH\" && ");
        script.push_str(&format!(
            "export MOZCONFIG={} && export SCCACHE_DIR={} && ",
            to_msys_path(&mozconfig),
            to_msys_path(&sccache)
        ));
        for key in ["MOZ_WINDOWS_APP_SDK_DIR", "MOZ_WINDOWS_RS_DIR"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    script.push_str(&format!(
                        "export {key}={} && ",
                        to_msys_path(Path::new(&value))
                    ));
                }
            }
        }
        script.push_str(&format!(
            "cd {} && ./mach {}",
            to_msys_path(&engine),
            mach_args.join(" ")
        ));
        Command::new("cmd")
            .args([
                "/C",
                "C:\\mozilla-build\\start-shell.bat",
                "-no-start",
                "-defterm",
                "-c",
            ])
            .arg(script)
            .status()
            .map_err(|e| format!("spawn MozillaBuild: {e}"))?
    } else {
        let mut cmd = Command::new("./mach");
        cmd.args(&mach_args)
            .current_dir(&engine)
            .env("MOZCONFIG", &mozconfig)
            .env("SCCACHE_DIR", &sccache);
        cmd.status().map_err(|e| format!("spawn mach: {e}"))?
    };
    if !status.success() {
        return Err("mach build failed (see output above)".into());
    }
    if let Err(e) = install_core_binary(root, os) {
        // A missing sidecar must not fail a browser build; the shell answers
        // `unavailable` when no core sits beside the binary.
        println!("core: WARNING {e}");
    }
    println!("build: done");
    Ok(())
}

/// Build and install the Rust sidecar next to the browser binary (P5b).
/// `ASTRA_CORE_SKIP=1` opts out; `ASTRA_CORE_PROFILE=debug` builds the debug
/// profile instead of release.
fn install_core_binary(root: &Path, os: &str) -> Result<(), String> {
    if std::env::var("ASTRA_CORE_SKIP").ok().as_deref() == Some("1") {
        println!("core: skipped (ASTRA_CORE_SKIP=1)");
        return Ok(());
    }
    let profile = std::env::var("ASTRA_CORE_PROFILE").unwrap_or_else(|_| "release".into());
    let mut cmd = Command::new("cargo");
    cmd.args(["build", "-p", "astra-core", "--bin", "astra-core"]);
    if profile == "release" {
        cmd.arg("--release");
    }
    cmd.current_dir(root);
    let st = cmd.status().map_err(|e| format!("spawn cargo: {e}"))?;
    if !st.success() {
        return Err("astra-core build failed".into());
    }
    let suffix = exe_suffix(os);
    let src = root
        .join("target")
        .join(&profile)
        .join(format!("astra-core{suffix}"));
    let dist = root.join("engine").join(objdir_name(os)).join("dist/bin");
    if !dist.exists() {
        println!("core: no dist/bin yet; skipping install");
        return Ok(());
    }
    let dest = dist.join(format!("astra-core{suffix}"));
    std::fs::copy(&src, &dest).map_err(|e| format!("copy core: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    println!("core: installed {}", dest.display());
    Ok(())
}

// Run the P1-T11 contract-test harness (P1-T11). Thin wrapper over
// tools/contract-runner/run.py (stdlib Python): boots the built binary via
// the in-tree geckodriver and asserts branding, Host API version and the
// local fixture page. `--smoke` runs the fast subset; `--fixture-only`
// runs the no-browser self-test (works without a build, used in CI).
// Artifacts land in out/contract-p1t11-*/ (gitignored).
fn cmd_test(root: &Path, mode: &str) -> Result<(), String> {
    let runner = root.join("tools/contract-runner/run.py");
    if !runner.exists() {
        return Err("tools/contract-runner/run.py missing".into());
    }
    let mode_arg = match mode {
        "full" => "--full",
        "smoke" => "--smoke",
        "fixture-only" => "--fixture-only",
        other => {
            return Err(format!(
                "unknown test mode {other} (want --smoke|--fixture-only)"
            ));
        }
    };
    let st = Command::new("python3")
        .args([&runner.to_string_lossy() as &str, mode_arg])
        .current_dir(root)
        .status()
        .map_err(|e| format!("spawn python3: {e}"))?;
    match st.code() {
        Some(0) => {
            println!("test: PASS");
            Ok(())
        }
        Some(2) => Err(
            "test: SKIP — built binary absent (run a full build first); see out/contract-p1t11-*/"
                .into(),
        ),
        _ => Err("test: FAIL (see out/contract-p1t11-*/results.json + geckodriver.log)".into()),
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: astra-forge <fetch|doctor|config [--os linux|windows] [--branding astra|unofficial] [--objdir PATH]|overlay [--os linux|windows]|lint|export|import [--check] [--os linux|windows]|footprint [--max-lines N] [--max-patches N] [--max-p3 N]|build [--faster] [--jobs N] [--os linux|windows]|test [--smoke] [--fixture-only]>"
    );
    std::process::exit(2);
}

fn main() {
    let root = repo_root();
    let args: Vec<String> = env::args().skip(1).collect();
    let res = match args.first().map(|s| s.as_str()) {
        Some("fetch") => cmd_fetch(&root),
        Some("doctor") => cmd_doctor(&root),
        Some("overlay") => {
            let mut os = host_os();
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--os" => os = it.next().map(|s| s.as_str()).unwrap_or(os),
                    other => {
                        eprintln!("astra-forge: error: unknown overlay flag {other}");
                        usage();
                    }
                }
            }
            cmd_overlay(&root, os)
        }
        Some("lint") => cmd_lint(&root),
        Some("export") => cmd_export(&root),
        Some("import") => {
            let mut check_only = false;
            let mut os = host_os();
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--check" => check_only = true,
                    "--os" => os = it.next().map(|s| s.as_str()).unwrap_or(os),
                    other => {
                        eprintln!("astra-forge: error: unknown import flag {other}");
                        usage();
                    }
                }
            }
            cmd_import(&root, check_only, os)
        }
        Some("footprint") => {
            let mut max_lines = 4000usize;
            let mut max_patches = 60usize;
            let mut max_p3 = 8usize;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                let mut val = || it.next().map(|s| s.as_str()).unwrap_or("");
                match a.as_str() {
                    "--max-lines" => max_lines = val().parse().unwrap_or(4000),
                    "--max-patches" => max_patches = val().parse().unwrap_or(60),
                    "--max-p3" => max_p3 = val().parse().unwrap_or(8),
                    other => {
                        eprintln!("astra-forge: error: unknown footprint flag {other}");
                        usage();
                    }
                }
            }
            cmd_footprint(&root, max_lines, max_patches, max_p3)
        }
        Some("config") => {
            let mut os = host_os();
            let mut branding = "astra";
            let mut objdir: Option<String> = None;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--os" => os = it.next().map(|s| s.as_str()).unwrap_or(os),
                    "--branding" => branding = it.next().map(|s| s.as_str()).unwrap_or(branding),
                    "--objdir" => {
                        objdir = Some(it.next().map(|s| s.to_string()).unwrap_or_default())
                    }
                    other => {
                        eprintln!("astra-forge: error: unknown config flag {other}");
                        usage();
                    }
                }
            }
            cmd_config(&root, os, branding, objdir.as_deref())
        }
        Some("build") => {
            let mut faster = false;
            let mut jobs: Option<&str> = None;
            let mut os = host_os();
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--faster" => faster = true,
                    "--jobs" => jobs = Some(it.next().map(|s| s.as_str()).unwrap_or("")),
                    "--os" => os = it.next().map(|s| s.as_str()).unwrap_or(os),
                    other => {
                        eprintln!("astra-forge: error: unknown build flag {other}");
                        usage();
                    }
                }
            }
            cmd_build(&root, os, faster, jobs)
        }
        Some("test") => {
            let mut mode = "full";
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--smoke" => mode = "smoke",
                    "--fixture-only" => mode = "fixture-only",
                    other => {
                        eprintln!("astra-forge: error: unknown test flag {other}");
                        usage();
                    }
                }
            }
            cmd_test(&root, mode)
        }
        _ => usage(),
    };
    if let Err(e) = res {
        eprintln!("astra-forge: error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msys_path_converts_a_windows_drive() {
        assert_eq!(
            to_msys_path(Path::new("E:\\Astra\\engine")),
            "/e/Astra/engine"
        );
        assert_eq!(to_msys_path(Path::new("D:/astra-build")), "/d/astra-build");
    }

    #[test]
    fn msys_path_leaves_a_relative_path_alone() {
        assert_eq!(
            to_msys_path(Path::new("out/mozconfig.windows")),
            "out/mozconfig.windows"
        );
    }

    #[test]
    fn verbatim_prefixes_are_dropped() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\E:\Astra\engine")).to_string_lossy(),
            r"E:\Astra\engine"
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share")).to_string_lossy(),
            r"\\server\share"
        );
    }

    #[test]
    fn exe_suffix_is_windows_only() {
        assert_eq!(exe_suffix("windows"), ".exe");
        assert_eq!(exe_suffix("linux"), "");
    }

    #[test]
    fn patch_os_reads_the_header_before_the_body() {
        let dir = env::temp_dir().join(format!(
            "astra-forge-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let patch = dir.join("OS.patch");
        fs::write(&patch, "Patch-Id: T\nOS: linux\n---\ndiff --git a/x b/x\n").unwrap();
        assert_eq!(patch_os(&patch).as_deref(), Some("linux"));
        fs::write(&patch, "Patch-Id: T\n---\ndiff --git a/x b/x\n").unwrap();
        assert_eq!(patch_os(&patch), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
