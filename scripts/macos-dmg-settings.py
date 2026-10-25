"""Headless Finder layout. Coordinates match docs/macos/dmg-background.svg."""
from pathlib import Path

root = Path(defines["root"])
application = defines["app"]
format = "UDZO"
filesystem = "HFS+"
files = [application]
symlinks = {"Applications": "/Applications"}
# Do not set FinderInfo on the signed .app: even hiding its extension breaks codesign.
hide_extensions = []
background = str(root / "docs/macos/dmg-background.png")  # @2x becomes a Retina TIFF
# Leave room for Finder's title bar above the 720 × 660 artwork.
window_rect = ((160, 60), (720, 692))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
include_icon_view_settings = True
include_list_view_settings = False
arrange_by = None
icon_size = 96
text_size = 13
label_pos = "bottom"
icon_locations = {"ShareCode Client.app": (190, 210), "Applications": (530, 210)}
