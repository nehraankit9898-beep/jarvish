#!/usr/bin/env python3
"""Assemble the final deliverable zip for the user (Jarvis 7-feature session).

Structure (mirrors the user's uploaded zip):
  agentscope-suite/
    README.md            <- zip's README + a short Jarvis section on top
    .gitignore / start-studio.* / agentscope/  <- from the zip (untouched)
    studio/              <- sandbox root project (all feature work)
        + docs/, check-secret.mjs, start-studio.bat restored from the zip
        - node_modules, .next, db, .env, dev.log, build artifacts
"""
import os
import shutil
import zipfile

SRC_ZIP = "/home/z/my-project/upload/extracted/../agentscope-suite-jarvis.zip"
ROOT = "/home/z/my-project"
STAGE = "/home/z/my-project/work/deliver-jarvis"
OUT = "/home/z/my-project/download/agentscope-suite-jarvis-7-features.zip"

# items NEVER copied from the sandbox root (infra / secrets / artifacts)
SKIP_ROOT = {
    "node_modules", ".next", "db", ".env", "dev.log", "server.log",
    "nohup.out", "tsconfig.tsbuildinfo", ".agentic-workspace", ".zscripts",
    "work", "upload", "download", "skills", "examples", "mini-services",
    "tool-results", "Caddyfile", "bunfig.toml", ".git", "bun.lockb",
    ".z-ai-config", "public_build_report.json",
}
# files dropped from the staged studio copy (sandbox state / secrets)
SKIP_FILE_NAMES = {
    "dev.log", ".env", "tsconfig.tsbuildinfo", "nohup.out", "server.log",
    "custom.db", "custom.db-journal", ".secret-key", ".desktop-token",
    ".mic-muted", ".jarvis-paused",
}
SKIP_DIR_NAMES = {"node_modules", ".next", ".git", ".agentic-workspace", "dev"}


def extract_user_zip():
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
    """Overlay the sandbox project (the feature work) onto studio/."""
    studio = os.path.join(STAGE, "agentscope-suite", "studio")
    for item in sorted(os.listdir(ROOT)):
        if item in SKIP_ROOT:
            continue
        src = os.path.join(ROOT, item)
        dst = os.path.join(studio, item)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(
                src, dst,
                ignore=shutil.ignore_patterns(
                    "node_modules", ".next*", "dev.log", ".agentic-workspace",
                    "__pycache__", "*.tsbuildinfo",
                ),
            )
        else:
            shutil.copy2(src, dst)

    # prune sandbox state files that must not ship
    for root, dirs, files in os.walk(studio):
        dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES]
        for f in list(files):
            if f in SKIP_FILE_NAMES or f.endswith(".tsbuildinfo"):
                os.remove(os.path.join(root, f))
    # db/ from the zip stays EXCEPT runtime secrets the sandbox created
    for name in (".secret-key", ".desktop-token", ".mic-muted", ".jarvis-paused"):
        p = os.path.join(studio, "db", name)
        if os.path.exists(p):
            os.remove(p)

    # fresh lockfile: the sandbox bun.lock matches the merged package.json
    lock = os.path.join(ROOT, "bun.lock")
    if os.path.exists(lock):
        shutil.copy2(lock, os.path.join(studio, "bun.lock"))


def update_suite_readme():
    """Prepend a short Jarvis section to the suite README (from the zip)."""
    readme = os.path.join(STAGE, "agentscope-suite", "README.md")
    section = (
        "\n\n## Jarvis update — 7 naye features (is session ke kaam)\n\n"
        "Memory (#4) · Natural TTS edge-tts (#3) · Wake word \"Hey Jarvis\" (#1) · "
        "Startup + tray (#6) · Proactive subah-summary + guard-rails (#5) · "
        "Google Calendar/Gmail connector (#7) · Vision screen-tasks (#2).\n\n"
        "Setup + use + test steps: **studio/docs/JARVIS_FEATURES.md**\n"
        "Google connector ka OAuth setup: **studio/docs/GOOGLE_CONNECTOR_SETUP.md**\n\n"
        "Naye python packages (Windows laptop pe ek baar):\n"
        "`pip install -r python-bridge/requirements-voice.txt` (TTS + wake word)\n"
        "`bun install` + `bunx prisma generate` + `bun run db:push` (naye schema ke liye)\n"
        "`pip install pystray pillow` (tray icon)\n"
        "Studio + tray auto-start: `scripts\\windows\\install-studio.ps1`\n"
    )
    if os.path.exists(readme):
        with open(readme, "a", encoding="utf-8") as f:
            f.write(section)


def make_zip():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    base = STAGE
    count = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES]
            for file in sorted(files):
                if file in SKIP_FILE_NAMES:
                    continue
                full = os.path.join(root, file)
                rel = os.path.relpath(full, base)
                z.write(full, rel)
                count += 1
    return count


def main():
    extract_user_zip()
    sync_studio()
    update_suite_readme()
    n = make_zip()
    size = os.path.getsize(OUT) / (1024 * 1024)
    print(f"OK -> {OUT} ({size:.1f} MB, {n} files)")


if __name__ == "__main__":
    main()
