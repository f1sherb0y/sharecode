"""Download and statically audit a pinned meeting-installer inventory; never install it.

Example (inventory contains product/version/architecture/installerUrl/sha256):
  python audit-meeting-versions.py --inventory build/meeting-version-audit/inventory.json \
    --cache build/meeting-version-audit --seven-zip /path/to/7z.exe --workers 8
Per-package JSON is resumable. Packages, extracted PE files and manifests stay in
the chosen cache. Only publisher CDN URLs are accepted. No extracted file is run.
"""
import argparse
import concurrent.futures
import hashlib
import json
import mmap
import pathlib
import re
import shutil
import sqlite3
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone


SIGNALS = [
    "ScreenShareTrackerWindow", "screen_share_tracker", "screen_share_float_container",
    "screen_share_toolbar_window", "screen_share_toolbar_docker_window",
    "screen_share_native_normal_tracker", "screen_share_native_multi_tracker",
    "screen_share_normal_tracker", "screen_share_multi_tracker", "screen_share_partial_tracker",
    "wemeet://page/inmeeting/share_tracker", "ShareScreenToolBarWnd", "TrackerWnd",
    "PartialScreenShare", "NXWindow", "Qt5Core", "Qt6Core", "SetWindowDisplayAffinity",
    "GetWindowDisplayAffinity", "RegisterClassExW", "RegisterClassW",
]
MAIN_IMAGES = {"wemeetapp.exe", "voovmeetingapp.exe", "voovmeeting.exe"}
KNOWN_MAIN_IMAGES = MAIN_IMAGES | {s.replace(".exe", "_new.exe") for s in MAIN_IMAGES}
PRINT_LOCK = threading.Lock()
SIGNATURE_SCRIPT = r"""param([string]$InstallerPath)
$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
    Import-Module "$PSHOME/Modules/$module/$module.psd1"
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
$version = (Get-Item -LiteralPath $InstallerPath).VersionInfo
[PSCustomObject]@{
    status = $signature.Status.ToString()
    signer = $signature.SignerCertificate.Subject
    thumbprint = $signature.SignerCertificate.Thumbprint
    timestampSigner = $signature.TimeStamperCertificate.Subject
    productName = $version.ProductName
    productVersion = $version.ProductVersion
    fileVersion = $version.FileVersion
} | ConvertTo-Json -Compress
"""


def now():
    return datetime.now(timezone.utc).isoformat()


def emit(event, **values):
    with PRINT_LOCK:
        print(json.dumps({"event": event, **values}, ensure_ascii=True), flush=True)


def save(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest(path, algorithm="sha256"):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest().upper()


def package_name(row):
    name = "-".join(row[key] for key in ("product", "version", "architecture"))
    if not re.fullmatch(r"(?:TencentMeeting|VooVMeeting)-[0-9.]+-(?:x86|x64|arm64)", name):
        raise ValueError("Unexpected inventory identifier")
    return name


def download(row, destination, legacy):
    algorithm = "sha256" if row.get("sha256") else "md5"
    expected = row[algorithm].upper()
    for candidate in [destination] + ([legacy / destination.name] if legacy else []):
        if candidate.exists() and digest(candidate, algorithm) == expected:
            return candidate
    url = row["installerUrl"]
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"updatecdn.meeting.qq.com", "updatecdn.meeting.tencent.com"}:
        raise ValueError("Inventory URL is not an allowed publisher CDN")
    partial = destination.with_suffix(".partial")
    last_error = None
    for attempt in range(4):
        try:
            if shutil.disk_usage(destination.parent).free < 15 * 1024**3:
                raise RuntimeError("Cache drive has less than 15 GiB free")
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {"User-Agent": "ShareCode-compatibility-audit/1"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
                mode = "ab" if response.status == 206 and offset else "wb"
                with partial.open(mode) as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
            actual = digest(partial, algorithm)
            if actual != expected:
                raise ValueError(f"{algorithm} mismatch: expected {expected}, received {actual}")
            partial.replace(destination)
            return destination
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code in (403, 404, 410):
                break
        except (OSError, TimeoutError) as error:
            last_error = error
        if attempt != 3:
            time.sleep(1 + attempt)
    raise RuntimeError(f"Download failed: {last_error}")


def machine(data):
    if data[:2] != b"MZ":
        return None
    try:
        offset = struct.unpack_from("<I", data, 0x3C)[0]
        if data[offset:offset + 4] != b"PE\0\0":
            return None
        return hex(struct.unpack_from("<H", data, offset + 4)[0])
    except struct.error:
        return None


def scan_binary(path, database):
    sha = digest(path)
    cached = database.execute("SELECT result FROM binaries WHERE sha256 = ?", (sha,)).fetchone()
    if cached:
        record = json.loads(cached[0])
        if record.get("discoveryRevision") == 3:
            return record
    if path.stat().st_size == 0:
        return {"sha256": sha, "machine": None, "signals": []}
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        result = {
            "sha256": sha,
            "machine": machine(data),
            "signals": [s for s in SIGNALS if data.find(s.encode()) >= 0 or data.find(s.encode("utf-16le")) >= 0],
            "discoveryRevision": 3,
            "candidates": discover(data),
        }
    database.execute("INSERT OR REPLACE INTO binaries VALUES (?, ?)", (sha, json.dumps(result)))
    database.commit()
    return result


def discover(data):
    # Broad discovery, independent of the exact-name regression checklist above.
    # Keep whole printable strings (and offsets), including C++ symbols, logs,
    # paths and unrelated tracking. Classification happens later, not by dropping
    # non-window-looking matches here. For very long runs retain bounded context.
    records = []
    seen = set()
    patterns = [(rb"shar(?:e|ing)|track", "utf-8", 1),
                (rb"s\x00h\x00a\x00r\x00(?:e\x00|i\x00n\x00g\x00)|t\x00r\x00a\x00c\x00k\x00", "utf-16le", 2)]
    for pattern, encoding, step in patterns:
        previous_end = -1
        for match in re.finditer(pattern, data, re.I):
            start, end = match.span()
            if start < previous_end:
                continue
            left, right = start, end
            limit = 2048 * step
            while left >= step and start - left < limit:
                part = data[left-step:left]
                if not (part[0] >= 32 and part[0] != 127 if step == 1 else chr(int.from_bytes(part, "little")).isprintable()):
                    break
                left -= step
            while right + step <= len(data) and right - end < limit:
                part = data[right:right+step]
                if not (part[0] >= 32 and part[0] != 127 if step == 1 else chr(int.from_bytes(part, "little")).isprintable()):
                    break
                right += step
            previous_end = right
            text = data[left:right].decode(encoding, errors="replace")
            key = (encoding, left, text)
            if key not in seen:
                seen.add(key)
                records.append({"encoding": encoding, "offset": hex(left), "text": text})
    return records


def analyze(directory, database):
    binaries = sorted(p for p in directory.rglob("*") if p.is_file() and p.suffix.lower() in {".exe", ".dll"})
    executables = []
    signals = {}
    ui_libraries = []
    counts = Counter()
    candidates = {}
    for path in binaries:
        record = scan_binary(path, database)
        relative = path.relative_to(directory).as_posix()
        counts[record["machine"] or "not-pe"] += 1
        if path.suffix.lower() == ".exe":
            executables.append({"path": relative, "machine": record["machine"], "sha256": record["sha256"]})
        if record["signals"]:
            signals[relative] = record["signals"]
        if record.get("candidates"):
            candidates[relative] = record["candidates"]
        if re.search(r"^(?:Qt[56]|ui_kit|ui_framework|nxui|DuiLib|qt_)", path.name, re.I):
            ui_libraries.append(relative)
    mains = [e for e in executables if pathlib.PurePosixPath(e["path"]).name.lower() in KNOWN_MAIN_IMAGES]
    return {
        "peFileCount": len(binaries), "machineCounts": dict(counts), "executables": executables,
        "mainImages": mains, "uiLibraries": ui_libraries, "binaryStringSignals": signals,
        "discoveryRevision": 3,
        "broadCandidates": candidates,
        "broadCandidateCount": sum(len(values) for values in candidates.values()),
        "signalSet": sorted({s for values in signals.values() for s in values}),
        "identityArchitectureGaps": (
            (["No recognized main executable"] if not mains else [])
            + [f"Unsupported main image machine {e['machine']}: {e['path']}" for e in mains if e["machine"] not in {"0x14c", "0x8664"}]
        ),
    }


def analyze_process(directory, database_path):
    with sqlite3.connect(database_path, timeout=60) as database:
        return analyze(directory, database)


def audit(row, args, analyzer):
    name = package_name(row)
    result_path = args.cache / "results" / (name + ".json")
    if result_path.exists():
        previous = json.loads(result_path.read_text(encoding="utf-8"))
        checksum = "sha256" if row.get("sha256") else "md5"
        if previous.get("status") == "complete" and previous[checksum].upper() == row[checksum].upper() and previous.get("analysis", {}).get("discoveryRevision") == 3:
            return previous
    result = {**row, "startedAt": now(), "status": "running", "stage": "download"}
    save(result_path, result)
    try:
        installer = download(row, args.cache / "installers" / (name + ".exe"), args.legacy_cache)
        result.update(bytes=installer.stat().st_size, sha256=digest(installer), hashVerified=True,
                      verifiedChecksumAlgorithm="sha256" if row.get("sha256") else "md5", stage="signature")
        save(result_path, result)
        signature = subprocess.run([
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(args.cache / "signature.ps1"), "-InstallerPath", str(installer),
        ], capture_output=True, timeout=90)
        if signature.returncode:
            raise RuntimeError("Signature check failed: " + signature.stderr.decode(errors="replace")[-1000:])
        result["authenticode"] = json.loads(signature.stdout.decode("utf-8-sig", errors="replace"))
        if result["authenticode"]["status"] != "Valid":
            raise RuntimeError(f"Authenticode is {result['authenticode']['status']}; static extraction not attempted")
        result["stage"] = "extract"
        save(result_path, result)
        directory = args.cache / "extracted" / name
        extraction = subprocess.run([
            str(args.seven_zip), "x", str(installer), "-o" + str(directory), "-y", "-r",
            "*.exe", "*.dll", "-bso0", "-bsp0",
        ], capture_output=True, timeout=180)
        if extraction.returncode:
            raise RuntimeError("Extraction failed: " + extraction.stderr.decode(errors="replace")[-500:])
        result["stage"] = "analyze"
        save(result_path, result)
        result["analysis"] = analyzer.submit(analyze_process, directory, args.cache / "binary-cache.sqlite").result()
        result.update(status="complete", finishedAt=now())
        emit("complete", package=name, mib=round(result["bytes"] / 1024**2, 1),
             mains=[e["path"] for e in result["analysis"]["mainImages"]],
             signals=result["analysis"]["signalSet"], gaps=result["analysis"]["identityArchitectureGaps"])
    except Exception as error:
        result.update(status="failed", finishedAt=now(), error=str(error))
        emit("failed", package=name, stage=result["stage"], error=str(error))
    save(result_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=pathlib.Path, required=True)
    parser.add_argument("--cache", type=pathlib.Path, required=True)
    parser.add_argument("--seven-zip", type=pathlib.Path, required=True)
    parser.add_argument("--legacy-cache", type=pathlib.Path)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    args.cache = args.cache.resolve()
    args.seven_zip = args.seven_zip.resolve()
    for child in ("installers", "extracted", "results"):
        (args.cache / child).mkdir(parents=True, exist_ok=True)
    (args.cache / "signature.ps1").write_text(SIGNATURE_SCRIPT, encoding="utf-8-sig")
    with sqlite3.connect(args.cache / "binary-cache.sqlite") as database:
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("CREATE TABLE IF NOT EXISTS binaries (sha256 TEXT PRIMARY KEY, result TEXT NOT NULL)")
    rows = json.loads(args.inventory.read_text(encoding="utf-8"))
    emit("start", packages=len(rows), workers=args.workers, cache=str(args.cache))
    with concurrent.futures.ProcessPoolExecutor(max_workers=4) as analyzer:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            results = list(executor.map(lambda row: audit(row, args, analyzer), rows))
    summary = {"checkedAt": now(), "counts": dict(Counter(r["status"] for r in results)), "packages": results}
    save(args.cache / "audit.json", summary)
    emit("finished", counts=summary["counts"])


if __name__ == "__main__":
    main()
