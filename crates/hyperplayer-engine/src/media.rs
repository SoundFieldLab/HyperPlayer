use crate::error::Result;
use crate::model::Track;
use std::fmt;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaHandleKind {
    Local,
    PrivateCache,
    PrivateTemporary,
}

struct MediaHandleInner {
    file: File,
    label: PathBuf,
    kind: MediaHandleKind,
    authorize_read: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
    remove_on_drop: Option<PathBuf>,
}

impl Drop for MediaHandleInner {
    fn drop(&mut self) {
        if let Some(path) = self.remove_on_drop.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Clone)]
pub struct MediaHandle(Arc<MediaHandleInner>);

impl MediaHandle {
    pub fn local(file: File, canonical_path: PathBuf) -> Self {
        Self::new(file, canonical_path, MediaHandleKind::Local, None, None)
    }

    pub fn private_cache(file: File, label: PathBuf) -> Self {
        Self::new(file, label, MediaHandleKind::PrivateCache, None, None)
    }

    pub fn guarded_private_cache(
        file: File,
        label: PathBuf,
        authorize_read: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Self {
        Self::new(
            file,
            label,
            MediaHandleKind::PrivateCache,
            Some(authorize_read),
            None,
        )
    }

    pub fn private_temporary(file: File, path: PathBuf) -> Self {
        Self::new(
            file,
            path.clone(),
            MediaHandleKind::PrivateTemporary,
            None,
            Some(path),
        )
    }

    fn new(
        file: File,
        label: PathBuf,
        kind: MediaHandleKind,
        authorize_read: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
        remove_on_drop: Option<PathBuf>,
    ) -> Self {
        Self(Arc::new(MediaHandleInner {
            file,
            label,
            kind,
            authorize_read,
            remove_on_drop,
        }))
    }

    pub fn try_clone_file(&self) -> Result<File> {
        if let Some(authorize_read) = &self.0.authorize_read {
            authorize_read()?;
        }
        Ok(self.0.file.try_clone()?)
    }

    pub fn label(&self) -> &Path {
        &self.0.label
    }

    pub fn kind(&self) -> MediaHandleKind {
        self.0.kind
    }
}

impl fmt::Debug for MediaHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaHandle")
            .field("label", &self.0.label)
            .field("kind", &self.0.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct TrustedResolvedMedia {
    pub track: Track,
    pub handle: MediaHandle,
}

impl TrustedResolvedMedia {
    pub fn new(track: Track, handle: MediaHandle) -> Self {
        Self { track, handle }
    }
}
