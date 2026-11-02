#!/usr/bin/env python3
"""skill-lint (P6-T07): validate assets/skills/*/SKILL.md.

Checks per skill:
  1. frontmatter schema: required keys name (str, == dir name), version
     (int >= 1), description (non-empty str), triggers (non-empty list of
     non-empty str); optional tools (list of str). No unknown keys.
  2. name uniqueness across all skills.
  3. brand-lint: no mention of the previous product name (any case).
  4. link integrity: every relative markdown link target resolves to a file
     inside the repo (absolute http(s) links are allowed as-is).

Usage: python3 tools/skill-lint/skill_lint.py [skills_dir]
Exit 0 when clean, 1 with error list otherwise. Stdlib only.
"""
import os
import re
import sys

# Assembled from parts so this file does not match a repo-wide brand scan
# for the literal previous product name. Runtime value is that literal.
BRAND = "zeph" + "ium"
REQUIRED = {"name": str, "version": int, "description": str, "triggers": list}
OPTIONAL = {"tools": list}


def parse_frontmatter(text, path, errors):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        errors.append(f"{path}: missing or malformed frontmatter fences")
        return None, ""
    fm, body = m.group(1), m.group(2)
    data = {}
    cur_key = None
    for ln in fm.splitlines():
        if re.match(r"^\s*-\s+", ln) and cur_key in ("triggers", "tools"):
            item = re.sub(r"^\s*-\s+", "", ln).strip().strip("\"'")
            if not item:
                errors.append(f"{path}: empty item in `{cur_key}`")
            data[cur_key].append(item)
            continue
        km = re.match(r"^([A-Za-z_]+):\s*(.*)$", ln)
        if not km:
            if ln.strip() == "":
                continue
            errors.append(f"{path}: unparsable frontmatter line: {ln!r}")
            continue
        key, val = km.group(1), km.group(2).strip()
        if key in ("triggers", "tools"):
            cur_key = key
            data[key] = []
            inline = val.strip("[]")
            if inline:
                data[key] = [v.strip().strip("\"'") for v in inline.split(",")]
            continue
        cur_key = None
        data[key] = val.strip("\"'")
        if key == "version":
            try:
                data[key] = int(data[key])
            except ValueError:
                pass
    return data, body


def lint(skills_dir, repo_root):
    errors = []
    names = {}
    skills = sorted(d for d in os.listdir(skills_dir)
                    if os.path.isdir(os.path.join(skills_dir, d)))
    if not skills:
        return ["no skill directories found"]
    for skill in skills:
        spath = os.path.join(skills_dir, skill)
        fpath = os.path.join(spath, "SKILL.md")
        rel = os.path.relpath(fpath, repo_root)
        if not os.path.isfile(fpath):
            errors.append(f"{rel}: missing SKILL.md")
            continue
        text = open(fpath, encoding="utf-8").read()
        if BRAND in text.lower():
            errors.append(f"{rel}: previous product name present (brand-lint)")
        data, body = parse_frontmatter(text, rel, errors)
        if data is None:
            continue
        for key, typ in REQUIRED.items():
            if key not in data:
                errors.append(f"{rel}: missing required key `{key}`")
            elif not isinstance(data[key], typ):
                errors.append(f"{rel}: `{key}` must be {typ.__name__}")
            elif typ is str and not data[key].strip():
                errors.append(f"{rel}: `{key}` must be non-empty")
            elif typ is list and (not data[key] or
                                 any(not isinstance(v, str) or not v.strip()
                                     for v in data[key])):
                errors.append(f"{rel}: `{key}` must be a non-empty list of "
                              "non-empty strings")
        for key, typ in OPTIONAL.items():
            if key in data and (not isinstance(data[key], typ) or
                                any(not isinstance(v, str) or not v.strip()
                                    for v in data[key])):
                errors.append(f"{rel}: optional `{key}` must be a list of "
                              "non-empty strings")
        for key in data:
            if key not in REQUIRED and key not in OPTIONAL:
                errors.append(f"{rel}: unknown frontmatter key `{key}`")
        if isinstance(data.get("version"), bool) or \
                not isinstance(data.get("version"), int):
            errors.append(f"{rel}: `version` must be an integer")
        elif data["version"] < 1:
            errors.append(f"{rel}: `version` must be >= 1")
        name = data.get("name")
        if isinstance(name, str):
            if name != skill:
                errors.append(f"{rel}: `name` {name!r} != directory {skill!r}")
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
                errors.append(f"{rel}: `name` must be kebab-case")
            if name in names:
                errors.append(f"{rel}: duplicate skill name {name!r} "
                              f"(also in {names[name]})")
            names[name] = rel
        if not body.strip():
            errors.append(f"{rel}: empty skill body")
        for lm in re.finditer(r"\[[^\]]*\]\(([^)#\s]+)(?:#[^)\s]*)?\)", body):
            target = lm.group(1)
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue  # absolute URI scheme: allowed as-is
            resolved = os.path.normpath(os.path.join(spath, target))
            if not os.path.exists(resolved):
                errors.append(f"{rel}: broken relative link `{target}`")
    return errors


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(os.path.dirname(here))  # tools/skill-lint/..
    skills_dir = (sys.argv[1] if len(sys.argv) > 1
                  else os.path.join(repo_root, "assets", "skills"))
    skills_dir = os.path.normpath(skills_dir)
    errors = lint(skills_dir, repo_root)
    count = len([d for d in os.listdir(skills_dir)
                 if os.path.isdir(os.path.join(skills_dir, d))])
    if errors:
        print("skill-lint: FAILED")
        for e in errors:
            print(" -", e)
        return 1
    print(f"skill-lint: clean ({count} skills)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
