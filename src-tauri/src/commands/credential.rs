use crate::{
    dto::CredentialUpdateRequestDto,
    error::{AppError, CommandResult},
    ports::AppState,
    credential_vault::CredentialVault,
};
use tauri::State;

const MAX_CREDENTIAL_BYTES: usize = 4 * 1024 * 1024;

/// DPAPI 保险库读取（D35 Q17）：返回已加密落盘的会话 JSON；未存储返回 None。
/// Rust 不解析内容——哑加密存取，cookie 语义归 TS。
#[tauri::command]
pub fn credential_get(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    let result = read_credential(state.services.credential.as_ref());
    super::command(result)
}

/// DPAPI 保险库写入/删除：payload = 会话 JSON；None 删除。防数据目录拷贝盗号档位。
#[tauri::command]
pub fn credential_set(
    state: State<'_, AppState>,
    request: CredentialUpdateRequestDto,
) -> CommandResult<()> {
    let result = write_credential(state.services.credential.as_ref(), request.payload);
    super::command(result)
}

fn read_credential(vault: &dyn CredentialVault) -> crate::error::AppResult<Option<String>> {
    vault
        .load()
        .map(|value| value.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

fn write_credential(
    vault: &dyn CredentialVault,
    payload: Option<String>,
) -> crate::error::AppResult<()> {
    match payload {
        None => vault.delete(),
        Some(payload) => {
            if payload.len() > MAX_CREDENTIAL_BYTES {
                return Err(AppError::InvalidArgument(
                    "credential payload exceeds the 4 MiB limit".into(),
                ));
            }
            vault.replace(payload.as_bytes())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_vault::MemoryCredentialVault;

    #[test]
    fn credential_write_then_read_round_trips() {
        let vault = MemoryCredentialVault::new(None);
        write_credential(&vault, Some("{\"cookie\":\"session\"}".into())).unwrap();
        assert_eq!(
            read_credential(&vault).unwrap(),
            Some("{\"cookie\":\"session\"}".into())
        );
    }

    #[test]
    fn credential_delete_clears_stored_value() {
        let vault = MemoryCredentialVault::new(Some(b"secret".to_vec()));
        write_credential(&vault, None).unwrap();
        assert_eq!(read_credential(&vault).unwrap(), None);
    }

    #[test]
    fn credential_read_without_value_returns_none() {
        let vault = MemoryCredentialVault::new(None);
        assert_eq!(read_credential(&vault).unwrap(), None);
    }

    #[test]
    fn credential_payload_over_limit_is_rejected() {
        let vault = MemoryCredentialVault::new(None);
        let oversized = "x".repeat(MAX_CREDENTIAL_BYTES + 1);
        let error = write_credential(&vault, Some(oversized)).unwrap_err();
        assert!(matches!(error, AppError::InvalidArgument(_)));
        assert_eq!(vault.snapshot(), None);
    }

    #[test]
    fn credential_failed_write_propagates_and_keeps_storage_untouched() {
        let vault = MemoryCredentialVault::new(Some(b"old".to_vec()));
        vault.set_fail_replace(true);
        let error = write_credential(&vault, Some("new".into())).unwrap_err();
        assert!(matches!(error, AppError::Credential(_)));
        assert_eq!(vault.snapshot(), Some(b"old".to_vec()));
    }
}
