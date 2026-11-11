# Astra alpha — 0.1.745 (channel: alpha)

One engine build (`out/release/stage/Astra`, `BUILD.txt` inside each package:
Astra 0.1.745, Firefox ESR 153.6.0, Work **off**), repackaged for the four
supported Linux distro families. Same bits everywhere; only dependency
metadata and post-install hooks differ.

| File | Distro family | Install |
|---|---|---|
| `astra_0.1.745~alpha1_amd64.deb` | Debian 12+, Ubuntu 22.04/24.04, Mint, Pop!_OS | `sudo dpkg -i …; sudo apt-get install -f` |
| `astra-0.1.745-0.1.alpha1-fedora.x86_64.rpm` | Fedora 36+, RHEL/Rocky/Alma 9 | `sudo dnf install …` |
| `astra-0.1.745-0.1.alpha1-opensuse.x86_64.rpm` | openSUSE Leap 15.6+, Tumbleweed | `sudo zypper install …` |
| `astra-0.1.745.alpha1-1-x86_64.pkg.tar.zst` | Arch, CachyOS, Manjaro | `sudo pacman -U …` |
| `Astra-0.1.745-linux-x86_64.tar.xz` (+`.sha256`) | portable fallback, any distro | `./install.sh` / `sudo ./install.sh --system` |

Verify: `sha256sum -c SHA256SUMS` (covers every artifact in this folder,
tarball included).

## Building

```sh
./tools/package-alpha.sh                 # this OS only (from /etc/os-release)
./tools/package-alpha.sh --distro debian # one family: debian|fedora|suse|arch
./tools/package-alpha.sh --all           # all four
```

Needs `nfpm` 2.48+ in `PATH` and a staged build from
`tools/package-release.sh`; per-family configs live in
`tools/distro-packages/` (`nfpm-{debian,fedora,opensuse,arch}.yaml`) with the
OS map in the script header. The payload is prebuilt, so any host can build
any family — OS detection only picks the default yaml. New entries merge into
`SHA256SUMS`, existing lines untouched.

This folder is git-ignored (large binaries, assembled here for manual
upload); this README stays tracked.

## Layout (system packages)

- `/usr/lib/astra/` — browser tree + `astra-core` sidecar
- `/usr/bin/astra` → `/usr/lib/astra/package/astra`
- `/usr/share/applications/astra.desktop`, icons under `/usr/share/icons/hicolor/`
- `/etc/apparmor.d/astra` — Ubuntu 24.04+ unprivileged-userns profile; loaded
  best-effort by post-install (needs `apparmor_parser`, warn-only otherwise).
  Inert on distros without AppArmor.

## Notes

- Profile lives in `~/.mozilla/astra` (`ASTRA_PROFILE` overrides). No migration
  from Firefox; first launch creates it.
- No auto-update: replacing the package (or the folder) updates the build.
- ML features need libstdc++ from GCC 12+; older toolchains run with ML off.
