use crate::error::{AppError, AppResult};
use std::{path::Path, sync::Arc};

const NETEASE_CREDENTIAL_FILE: &str = "netease-session.dpapi";

pub trait CredentialVault: Send + Sync {
    fn load(&self) -> AppResult<Option<Vec<u8>>>;
    fn replace(&self, secret: &[u8]) -> AppResult<()>;
    fn delete(&self) -> AppResult<()>;
}

pub fn netease_credential_vault(app_data_dir: &Path) -> AppResult<Arc<dyn CredentialVault>> {
    #[cfg(windows)]
    {
        Ok(Arc::new(WindowsDpapiVault::new(
            app_data_dir.join(NETEASE_CREDENTIAL_FILE),
        )))
    }
    #[cfg(not(windows))]
    {
        // 非 Windows 平台（开发/CI）使用内存 vault：不落盘、不加密，
        // 仅保证应用可用；Windows 实机才是生产路径。
        let _ = app_data_dir;
        Ok(Arc::new(MemoryCredentialVault::new(None)))
    }
}

#[cfg(windows)]
struct WindowsDpapiVault {
    path: std::path::PathBuf,
}

#[cfg(windows)]
impl WindowsDpapiVault {
    fn new(path: std::path::PathBuf) -> Self {
        Self { path }
    }

    fn protect(secret: &[u8]) -> AppResult<Vec<u8>> {
        use windows::{
            core::w,
            Win32::{
                Foundation::{LocalFree, HLOCAL},
                Security::Cryptography::{
                    CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
                },
            },
        };

        let input_len = u32::try_from(secret.len())
            .map_err(|_| AppError::Credential("credential payload is too large"))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: input_len,
            pbData: secret.as_ptr().cast_mut(),
        };
        let entropy_bytes = b"HyperPlayer/NetEase/session/v1";
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: entropy_bytes.len() as u32,
            pbData: entropy_bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                w!("HyperPlayer NetEase session"),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|_| AppError::Credential("could not protect credential"))?;
            let protected =
                std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(protected)
        }
    }

    fn unprotect(protected: &[u8]) -> AppResult<Vec<u8>> {
        use windows::Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };

        let input_len = u32::try_from(protected.len())
            .map_err(|_| AppError::Credential("credential payload is too large"))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: input_len,
            pbData: protected.as_ptr().cast_mut(),
        };
        let entropy_bytes = b"HyperPlayer/NetEase/session/v1";
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: entropy_bytes.len() as u32,
            pbData: entropy_bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|_| AppError::Credential("could not unprotect credential"))?;
            let secret = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(secret)
        }
    }

    fn replace_file(&self, temporary: &Path) -> AppResult<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };

        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = self
            .path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| AppError::Credential("could not replace credential"))
        }
    }
}

#[cfg(windows)]
impl CredentialVault for WindowsDpapiVault {
    fn load(&self) -> AppResult<Option<Vec<u8>>> {
        use std::io::ErrorKind;

        let protected = match std::fs::read(&self.path) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(AppError::Credential("could not read credential")),
        };
        if protected.is_empty() || protected.len() > 1024 * 1024 {
            return Err(AppError::Credential("stored credential is invalid"));
        }
        Self::unprotect(&protected).map(Some)
    }

    fn replace(&self, secret: &[u8]) -> AppResult<()> {
        use std::io::Write;

        let parent = self
            .path
            .parent()
            .ok_or(AppError::Credential("credential path is invalid"))?;
        std::fs::create_dir_all(parent)
            .map_err(|_| AppError::Credential("could not prepare credential storage"))?;
        let mut protected = Self::protect(secret)?;
        let temporary = parent.join(format!(
            ".{NETEASE_CREDENTIAL_FILE}.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| AppError::Credential("could not write credential"))?;
            file.write_all(&protected)
                .and_then(|_| file.sync_all())
                .map_err(|_| AppError::Credential("could not write credential"))?;
            drop(file);
            self.replace_file(&temporary)
        })();
        protected.fill(0);
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn delete(&self) -> AppResult<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AppError::Credential("could not delete credential")),
        }
    }
}

#[cfg(any(test, not(windows)))]
pub struct MemoryCredentialVault {
    value: std::sync::Mutex<Option<Vec<u8>>>,
    fail_replace: std::sync::atomic::AtomicBool,
}

#[cfg(any(test, not(windows)))]
impl MemoryCredentialVault {
    pub fn new(value: Option<Vec<u8>>) -> Self {
        Self {
            value: std::sync::Mutex::new(value),
            fail_replace: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn set_fail_replace(&self, fail: bool) {
        self.fail_replace
            .store(fail, std::sync::atomic::Ordering::Release);
    }

    pub fn snapshot(&self) -> Option<Vec<u8>> {
        self.value.lock().unwrap().clone()
    }
}

#[cfg(any(test, not(windows)))]
impl CredentialVault for MemoryCredentialVault {
    fn load(&self) -> AppResult<Option<Vec<u8>>> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn replace(&self, secret: &[u8]) -> AppResult<()> {
        if self.fail_replace.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AppError::Credential("fake replacement failed"));
        }
        *self.value.lock().unwrap() = Some(secret.to_vec());
        Ok(())
    }

    fn delete(&self) -> AppResult<()> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}
