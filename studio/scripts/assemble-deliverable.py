#!/usr/bin/env python3
"""Assemble the final deliverable zip for the user.

Structure (mirrors the user's original zip):
  agentscope-suite/
    README.md            <- updated (15 features section)
    .gitignore           <- from user's zip
    start-studio.sh/.bat <- from user's zip
    agentscope/          <- python framework from user's zip (untouched)
    studio/              <- sandbox root project (the feature work)
        + docs/, check-secret.mjs, start-studio.bat restored from the zip
        - node_modules, .next, db, .env, dev.log, bun.lock (regenerated fresh)
"""
import os
import shutil
import subprocess
import zipfile

SRC_ZIP = "/home/z/my-project/upload/ashokagenticscope.zip"
ROOT = "/home/z/my-project"                # sandbox project = studio with features
STAGE = "/home/z/my-project/work/deliver"
OUT = "/home/z/my-project/download/agentscope-suite-15-features.zip"

def extract_user_zip():
    """Extract the user's zip with correct path separators into STAGE."""
    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE, exist_ok=True)
    with zipfile.ZipFile(SRC_ZIP) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            if not name.startswith("agentscope-suite/"):
                continue
            target = os.path.join(STAGE, name)
            if name.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)

def sync_studio():
    """Overlay the sandbox root project (the feature work) onto studio/."""
    studio = os.path.join(STAGE, "agentscope-suite", "studio")
    keep_from_zip = {"node_modules", ".next", "db", ".env", "dev.log", "bun.lock", ".git"}
    for item in os.listdir(ROOT):
        if item in keep_from_zip or item.startswith(".") and item not in {".gitignore"}:
            continue
        if item in {"work", "upload", "download", "skills", "examples", "mini-services",
                    "tool-results", "Caddyfile", "bunfig.toml", "db"}:
            continue
        src = os.path.join(ROOT, item)
        dst = os.path.join(studio, item)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst,
                            ignore=shutil.ignore_patterns("node_modules", ".next*", "dev.log"))
        else:
            shutil.copy2(src, dst)

    # remove the sandbox-only tsconfig excludes so the delivered tsconfig matches
    # the user's original (no upload/skills/... entries that only exist here)
    ts = os.path.join(studio, "tsconfig.json")
    with open(ts) as f:
        content = f.read()
    content = content.replace(''',\n    "upload",
    "examples",
    "skills",
    "tool-results",
    "mini-services"''', "")
    with open(ts, "w") as f:
        f.write(content)

    # drop the debug-only repro script, keep the useful browser smoke script
    repro = os.path.join(studio, "scripts", "pw-eval-repro.ts")
    if os.path.exists(repro):
        os.remove(repro)

def fresh_lockfile():
    """Generate a bun.lock that includes playwright, without installing."""
    studio = os.path.join(STAGE, "agentscope-suite", "studio")
    env = dict(os.environ)
    env["NODE_ENV"] = "development"
    subprocess.run(["bun", "install", "--lockfile-only"], cwd=studio, env=env,
                   check=True, capture_output=True, timeout=600)

def make_zip():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    base = STAGE
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in {"node_modules", ".next", "dev", ".git"}]
            for file in files:
                if file in {"dev.log", ".env", "tsconfig.tsbuildinfo"}:
                    continue
                full = os.path.join(root, file)
                rel = os.path.relpath(full, base)
                z.write(full, rel)

def main():
    extract_user_zip()
    sync_studio()
    fresh_lockfile()
    make_zip()
    size = os.path.getsize(OUT) / (1024 * 1024)
    print(f"OK -> {OUT} ({size:.1f} MB)")

if __name__ == "__main__":
    main()
