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
    let tarball = dist.join(
        url.rsplit('/')
            .next()
            .ok_or("bad source url")?,
    );
    if !tarball.exists() {
        println!("fetch: downloading {url}");
        run("curl", &["-sSL", "--fail", "-o", &tarball.to_string_lossy(), &url], root)?;
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
            Err(e) => println!("fetch: WARNING no signature ({e}); refusing to continue without one in release builds"),
        }
    }
    if asc.exists() {
        println!("fetch: verifying signature");
        run("gpg", &["--verify", &asc.to_string_lossy(), &tarball.to_string_lossy()], root)?;
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
            &["--strip-components=1", "-xJf", &tarball.to_string_lossy(), "-C", &engine.to_string_lossy()],
            root,
        )?;
        fs::write(&marker, want).map_err(|e| e.to_string())?;
        // Baseline commit so applied patches are real diffs.
        if !engine.join(".git").exists() {
            run("git", &["init", "-q"], &engine)?;
            run("git", &["add", "-A"], &engine)?;
            run(
                "git",
                &["-c", "user.name=forge", "-c", "user.email=forge@local", "commit", "-qm", &format!("baseline: firefox {version}")],
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
    for (prog, why) in [("curl", "downloads"), ("tar", "extraction"), ("gpg", "signatures"), ("git", "patch baseline"), ("rustc", "forge itself"), ("python3", "state-check"), ("bun", "UI workspace (P3)")] {
        match run(prog, &["--version"], root) {
            Ok(first) => println!("doctor: {prog:8} OK ({}) — {why}", first.lines().next().unwrap_or("")),
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
                vec![format!("\"--enable-{stem}\""), format!("\"--disable-{stem}\"")]
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
                    println!("doctor: mozconfig export OK: {var} (empty disables per options.py:454-456)");
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
        return Err(format!("{} unknown mozconfig entr{}", bad.len(), if bad.len() == 1 { "y" } else { "ies" }));
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
            raw.insert(k.trim().to_string(), v.trim().trim_matches('"').trim().to_string());
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
    let display = raw.get("display_name").cloned().unwrap_or_else(|| "Astra".into());
    let binary = raw.get("binary_name").cloned().unwrap_or_else(|| "astra".into());
    m.insert("ASTRA_DISPLAY_NAME".into(), display);
    m.insert("ASTRA_BINARY_NAME".into(), binary.clone());
    m.insert("ASTRA_APP_ID".into(), dev("app_id", "com.astra.dev"));
    m.insert("ASTRA_VENDOR".into(), dev("vendor", "Astra (dev placeholder)"));
    m.insert(
        "ASTRA_UPDATE_HOST".into(),
        dev("update_host", "https://localhost:0/placeholder-astra-update"),
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
            return Err(format!("branding: unsubstituted placeholder in {}", t.display()));
        }
        let dest = t.with_extension("");
        fs::write(&dest, &text).map_err(|e| e.to_string())?;
        fs::remove_file(t).map_err(|e| e.to_string())?;
        println!("branding: rendered {}", dest.strip_prefix(root).unwrap_or(&dest).display());
    }
    Ok(())
}

// Render config/mozconfig.<os> into out/mozconfig.<os> (P1-T02).
// Substitutes @ASTRA_*@ placeholders from branding/astra.toml.
fn cmd_config(root: &Path, os: &str, branding: &str) -> Result<(), String> {
    if os != "linux" {
        return Err(format!("os {os}: only linux yet (windows P9, macos P10)"));
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
            println!("config: WARNING branding placeholder pending owner decision: {}", line.trim());
        }
    }
    let branding_dir = match branding {
        "astra" => "astra/branding",
        "unofficial" => "browser/branding/unofficial",
        other => return Err(format!("unknown --branding {other} (want astra|unofficial)")),
    };
    let template = fs::read_to_string(&template_path).map_err(|e| e.to_string())?;
    let rendered = template
        .replace("@ASTRA_BRANDING_DIR@", branding_dir)
        .replace("@ASTRA_DISPLAY_NAME@", &display)
        .replace("@ASTRA_BINARY_NAME@", &binary);
    if rendered.contains("@ASTRA_") {
        return Err("config: unsubstituted @ASTRA_*@ placeholder left".into());
    }
    let out_dir = root.join("out");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let dest = out_dir.join(format!("mozconfig.{os}"));
    fs::write(&dest, &rendered).map_err(|e| e.to_string())?;
    println!("config: rendered {} (branding={branding} -> {branding_dir})", dest.display());
    if branding == "astra" && !root.join("engine/astra/branding").exists() {
        println!("config: WARNING engine/astra/branding absent (lands P1-T03); configure needs `forge config --branding unofficial` until then");
    }
    println!("config: next: export MOZCONFIG={}", dest.display());
    Ok(())
}

// Copy overlay/astra/** into engine/astra/ and apply the P2 hook list (P1-T05).
// Idempotent: re-copies the tree, skips patches that already apply reversed.
fn cmd_overlay(root: &Path) -> Result<(), String> {
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
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    run("cp", &["-a", &format!("{}/.", src.to_string_lossy()), &dest.to_string_lossy()], root)?;
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
        // Already applied? `git apply --reverse --check` exits 0 only then.
        let applied = Command::new("git")
            .args(["apply", "--reverse", "--check", &p.to_string_lossy()])
            .current_dir(&engine)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if applied {
            println!("overlay: {name} already applied, skipping");
            continue;
        }
        run("git", &["apply", "-v", &p.to_string_lossy()], &engine)?;
        println!("overlay: applied {name}");
    }
    // Sanity: the wiring targets must exist after overlay.
    for f in ["astra/moz.build", "astra/jar.mn", "astra/host/HostAPI.sys.mjs", "astra/chrome/hello.html", "browser/app.mozbuild"] {
        if !engine.join(f).exists() {
            return Err(format!("overlay: expected {f} missing after apply"));
        }
    }
    render_branding(root)?;
    println!("overlay: done (chrome://astra/ + resource://astra/ staged)");
    Ok(())
}

// Patch header lint: §6.3 mandatory fields + `git apply --check` (P1-T05/P1-T12).
fn cmd_lint(root: &Path) -> Result<(), String> {
    let dir = root.join("patches");
    if !dir.exists() {
        println!("lint: no patches/ dir yet, nothing to check");
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "patch").unwrap_or(false))
        .collect();
    entries.sort();
    if entries.is_empty() {
        println!("lint: no patches to check");
        return Ok(());
    }
    let required = ["Patch-Id:", "Title:", "Tier:", "Upstream-Files:", "Intent:", "Risk:", "Test:", "Verified-On:", "Removal-Plan:"];
    let mut ok = true;
    for p in &entries {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(p).map_err(|e| e.to_string())?;
        for field in required {
            if !text.lines().any(|l| l.trim_start().starts_with(field)) {
                println!("lint: {name}: missing header field {field}");
                ok = false;
            }
        }
        if let Some(tier) = text.lines().find_map(|l| l.trim_start().strip_prefix("Tier:")) {
            let tier = tier.trim();
            if !["P0", "P1", "P2", "P3"].contains(&tier) {
                println!("lint: {name}: bad Tier {tier}");
                ok = false;
            }
        }
        // Must apply cleanly OR already be applied (reverse-checks clean).
        let engine = root.join("engine");
        if engine.join("mach").exists() {
            let clean = Command::new("git")
                .args(["apply", "--check", &p.to_string_lossy()])
                .current_dir(&engine)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            let applied = Command::new("git")
                .args(["apply", "--reverse", "--check", &p.to_string_lossy()])
                .current_dir(&engine)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if clean || applied {
                println!("lint: {name}: applies {}", if applied { "(already applied)" } else { "cleanly" });
            } else {
                println!("lint: {name}: DOES NOT APPLY");
                ok = false;
            }
        }
    }
    if !ok {
        return Err("lint: patch header/apply failures (see above)".into());
    }
    println!("lint: all {} patch(es) clean", entries.len());
    Ok(())
}

// Run the build: `mach build` (full) or `mach build faster` (frontend-only, U-02).
// Defaults MOZCONFIG to out/mozconfig.linux and SCCACHE_DIR to out/sccache
// when the caller did not set them (the P1-T04 proven setup).
fn cmd_build(root: &Path, faster: bool, jobs: Option<&str>) -> Result<(), String> {
    let engine = root.join("engine");
    if !engine.join("mach").exists() {
        return Err("engine/ source absent (run `forge fetch` first)".into());
    }
    let mut cmd = Command::new("./mach");
    cmd.arg("build").current_dir(&engine);
    if faster {
        cmd.arg("faster");
    }
    if let Some(n) = jobs {
        cmd.arg(format!("-j{n}"));
    }
    if std::env::var("MOZCONFIG").is_err() {
        let rendered = root.join("out/mozconfig.linux");
        if rendered.exists() {
            cmd.env("MOZCONFIG", &rendered);
            println!("build: MOZCONFIG defaulted to {}", rendered.display());
        } else {
            println!("build: WARNING no MOZCONFIG set and out/mozconfig.linux absent (run `forge config`)");
        }
    }
    if std::env::var("SCCACHE_DIR").is_err() {
        let dir = root.join("out/sccache");
        cmd.env("SCCACHE_DIR", &dir);
        println!("build: SCCACHE_DIR defaulted to {}", dir.display());
    }
    let st = cmd.status().map_err(|e| format!("spawn mach: {e}"))?;
    if !st.success() {
        return Err("mach build failed (see output above)".into());
    }
    println!("build: done");
    Ok(())
}

fn usage() -> ! {
    eprintln!("usage: astra-forge <fetch|doctor|config [--os linux] [--branding astra|unofficial]|overlay|lint|build [--faster] [--jobs N]>");
    std::process::exit(2);
}

fn main() {
    let root = repo_root();
    let args: Vec<String> = env::args().skip(1).collect();
    let res = match args.first().map(|s| s.as_str()) {
        Some("fetch") => cmd_fetch(&root),
        Some("doctor") => cmd_doctor(&root),
        Some("overlay") => cmd_overlay(&root),
        Some("lint") => cmd_lint(&root),
        Some("config") => {
            let mut os = "linux";
            let mut branding = "astra";
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--os" => os = it.next().map(|s| s.as_str()).unwrap_or(os),
                    "--branding" => branding = it.next().map(|s| s.as_str()).unwrap_or(branding),
                    other => {
                        eprintln!("astra-forge: error: unknown config flag {other}");
                        usage();
                    }
                }
            }
            cmd_config(&root, os, branding)
        }
        Some("build") => {
            let mut faster = false;
            let mut jobs: Option<&str> = None;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--faster" => faster = true,
                    "--jobs" => jobs = Some(it.next().map(|s| s.as_str()).unwrap_or("")),
                    other => {
                        eprintln!("astra-forge: error: unknown build flag {other}");
                        usage();
                    }
                }
            }
            cmd_build(&root, faster, jobs)
        }
        _ => usage(),
    };
    if let Err(e) = res {
        eprintln!("astra-forge: error: {e}");
        std::process::exit(1);
    }
}
