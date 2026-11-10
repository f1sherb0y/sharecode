"""Statically inspect pinned Tencent/VooV DMGs; never mount, install or run them.

python frontend/scripts/audit-meeting-macos.py \
  --inventory notes/client-meeting-privacy-macos-versions.json \
  --cache build/meeting-macos-audit --seven-zip /path/to/7z \
  --output build/meeting-macos-audit/audit.json

Requires 7-Zip with DMG/HFS support. SHA-256 is checked before extraction.
This does not validate Apple code signatures or exercise ScreenCaptureKit.
"""
import argparse
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import urllib.parse
import urllib.request


def architectures(data):
    names = {7: "i386", 0x1000007: "x86_64", 12: "arm", 0x100000C: "arm64"}
    magic = data[:4]
    if magic in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        return [names.get(struct.unpack_from("<I", data, 4)[0], "unknown")]
    if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        count = struct.unpack_from(">I", data, 4)[0]
        stride = 32 if magic[-1] == 0xBF else 20
        return [names.get(struct.unpack_from(">I", data, 8 + i * stride)[0], "unknown")
                for i in range(count)]
    raise ValueError("Main executable is not a supported Mach-O image")


def inspect(item, cache, seven_zip):
    item = {k: item[k] for k in ("product", "version", "arch", "url", "sha256", "source")}
    url = urllib.parse.urlparse(item["url"])
    if url.scheme != "https" or url.hostname not in ("updatecdn.meeting.qq.com", "down.qq.com"):
        raise ValueError("Only HTTPS publisher downloads are accepted")
    key = f"{item['product']}-{item['version']}-{item['arch']}"
    if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._" for c in key):
        raise ValueError("Invalid cache key")
    dmg = cache / (key + ".dmg")
    if not dmg.exists():
        partial = dmg.with_suffix(".part")
        with urllib.request.urlopen(item["url"], timeout=120) as response, partial.open("wb") as out:
            while block := response.read(1024 * 1024):
                out.write(block)
        partial.replace(dmg)
    with dmg.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != item["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {dmg.name}")
    destination = cache / "extracted" / key
    subprocess.run([seven_zip, "x", str(dmg), f"-o{destination}", "-y", "-r", "Info.plist"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    bundles = []
    for path in sorted(destination.rglob("Info.plist")):
        info = plistlib.loads(path.read_bytes())
        if info.get("CFBundlePackageType") not in ("APPL", "XPC!"):
            continue
        relative = path.relative_to(destination).as_posix()
        bundles.append({"path": relative, "bundleID": info.get("CFBundleIdentifier"),
                        "name": info.get("CFBundleName"), "executable": info.get("CFBundleExecutable"),
                        "version": info.get("CFBundleShortVersionString"),
                        "build": info.get("CFBundleVersion"), "type": info["CFBundlePackageType"]})
    main = [bundle for bundle in bundles if bundle["path"].count(".app/") == 1
            and bundle["path"].endswith(".app/Contents/Info.plist")]
    if len(main) != 1:
        raise ValueError(f"Expected one main application: {dmg.name}")
    executable = main[0]["path"].removesuffix("Info.plist") + "MacOS/" + main[0]["executable"]
    binary = subprocess.run([seven_zip, "x", "-so", str(dmg), executable], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    item.update(size=dmg.stat().st_size, verifiedSha256=actual,
                mainArchitectures=architectures(binary), bundles=bundles)
    print(f"Verified {key}: {len(bundles)} app/XPC bundles", flush=True)
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--seven-zip", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    packages = inventory if isinstance(inventory, list) else inventory["packages"]
    args.cache.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda item: inspect(item, args.cache, args.seven_zip), packages))
    output = {"auditedAt": datetime.now(timezone.utc).isoformat(),
              "method": "SHA-256 against Homebrew cask; 7-Zip extraction; plist and main Mach-O inspection",
              "limitations": "Static inspection only; Apple signatures and live capture not verified.",
              "packages": results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
