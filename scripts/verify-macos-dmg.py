"""Check the mounted installer's Finder layout, not merely the image checksum."""
import sys
from pathlib import Path

from ds_store import DSStore
from mac_alias import Alias

volume = Path(sys.argv[1])
with DSStore.open(str(volume / ".DS_Store"), "r") as store:
    view = store["."]["icvp"]
    window = store["."]["bwsp"]
    assert view["backgroundType"] == 2, "Finder must display the background image"
    alias = Alias.from_bytes(view["backgroundImageAlias"])
    assert alias.target.filename == ".background.tiff", "Background alias must point inside the DMG"
    assert (volume / alias.target.filename).is_file(), "Background is missing"
    assert view["iconSize"] == 96 and view["arrangeBy"] == "none"
    assert window["WindowBounds"] == "{{160, 120}, {720, 512}}"
    for key in ["ShowStatusBar", "ShowToolbar", "ShowSidebar", "ShowPathbar", "ShowTabView"]:
        assert not window[key], f"Unexpected Finder chrome: {key}"
    assert store["ShareCode Client.app"]["Iloc"] == (190, 210)
    assert store["Applications"]["Iloc"] == (530, 210)
assert (volume / "Applications").is_symlink()
assert (volume / "Applications").readlink() == Path("/Applications")
assert {p.name for p in volume.iterdir() if not p.name.startswith(".")} == {
    "ShareCode Client.app", "Applications"
}, "Only the app and Applications should be visible"
print("Verified visual DMG: background alias, window size, icon positions, and visible contents")
