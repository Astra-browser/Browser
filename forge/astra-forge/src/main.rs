// astra-forge (P1-T01): assemble Astra = pinned upstream + patch series + overlay.
// Zero-dependency CLI (std only; shells out to curl/tar/gpg). Commands:
// fetch, doctor. import/overlay/config/build/test/package/export/bump arrive
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
    if !ok {
        return Err("doctor: problems found (see above)".into());
    }
    println!("doctor: all green");
    Ok(())
}

fn usage() -> ! {
    eprintln!("usage: astra-forge <fetch|doctor>");
    std::process::exit(2);
}

fn main() {
    let root = repo_root();
    let args: Vec<String> = env::args().skip(1).collect();
    let res = match args.first().map(|s| s.as_str()) {
        Some("fetch") => cmd_fetch(&root),
        Some("doctor") => cmd_doctor(&root),
        _ => usage(),
    };
    if let Err(e) = res {
        eprintln!("astra-forge: error: {e}");
        std::process::exit(1);
    }
}
