//! Shared by the monitor and both architectures of the in-process helper.
//! Window captions and UI frameworks are deliberately not application identity.
use std::path::{Path, PathBuf};

const MAIN_IMAGES: &[&str] = &["wemeetapp.exe", "voovmeeting.exe", "voovmeetingapp.exe"];

pub fn installation_root(image: &Path) -> Option<PathBuf> {
    let name = image.file_name()?.to_str()?.to_ascii_lowercase();
    let parent = image.parent()?;
    if MAIN_IMAGES.contains(&name.as_str())
        || MAIN_IMAGES
            .iter()
            .any(|main| name == main.replace(".exe", "_new.exe"))
    {
        return Some(parent.to_path_buf());
    }
    // Old versions have TBSWebRenderer; newer ones have WMExternal/XnnExternal.
    // Accept helpers inside an installed meeting application, not every Tencent
    // process or every process with one of these generic helper names.
    parent.ancestors().take(4).find_map(|directory| {
        if directory.parent().is_some()
            && MAIN_IMAGES
                .iter()
                .any(|main| directory.join(main).is_file())
        {
            Some(directory.to_path_buf())
        } else {
            None
        }
    })
}
