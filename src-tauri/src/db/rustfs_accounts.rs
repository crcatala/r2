use super::{get_connection, DbResult};
use crate::credential_crypto::{decrypt, encrypt, ENCRYPTED_V1_FORMAT};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct RustfsAccount {
    pub id: String,
    pub name: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub endpoint_scheme: String,
    pub endpoint_host: String,
    pub force_path_style: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn get_table_sql() -> &'static str {
    "
    CREATE TABLE IF NOT EXISTS rustfs_accounts (
        id TEXT PRIMARY KEY,
        name TEXT,
        access_key_id TEXT NOT NULL,
        secret_access_key TEXT NOT NULL,
        credential_format INTEGER NOT NULL DEFAULT 0,
        endpoint_scheme TEXT NOT NULL,
        endpoint_host TEXT NOT NULL,
        force_path_style INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rustfs_accounts_created ON rustfs_accounts(created_at);
    "
}

async fn generate_id(conn: &turso::Connection) -> DbResult<String> {
    let mut rows = conn.query("SELECT lower(hex(randomblob(16)))", ()).await?;
    if let Some(row) = rows.next().await? {
        Ok(row.get(0)?)
    } else {
        Err("Failed to generate RustFS account id".into())
    }
}

pub async fn create_rustfs_account(
    name: Option<&str>,
    access_key_id: &str,
    secret_access_key: &str,
    endpoint_scheme: &str,
    endpoint_host: &str,
    force_path_style: bool,
) -> DbResult<RustfsAccount> {
    let has_encrypted_records = super::has_encrypted_credentials().await?;
    let conn = get_connection()?.lock().await;
    let now = chrono::Utc::now().timestamp();
    let id = generate_id(&conn).await?;
    let encrypted_access_key_id = encrypt(
        access_key_id,
        "rustfs",
        &id,
        "access_key_id",
        has_encrypted_records,
    )?;
    let encrypted_secret_access_key =
        encrypt(secret_access_key, "rustfs", &id, "secret_access_key", true)?;
    let force_value = if force_path_style { 1 } else { 0 };
    conn.execute(
        "INSERT INTO rustfs_accounts (id, name, access_key_id, secret_access_key, credential_format, endpoint_scheme, endpoint_host, force_path_style, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        turso::params![id.as_str(), name, encrypted_access_key_id, encrypted_secret_access_key, ENCRYPTED_V1_FORMAT, endpoint_scheme, endpoint_host, force_value, now, now],
    ).await?;

    Ok(RustfsAccount {
        id,
        name: name.map(|s| s.to_string()),
        access_key_id: access_key_id.to_string(),
        secret_access_key: secret_access_key.to_string(),
        endpoint_scheme: endpoint_scheme.to_string(),
        endpoint_host: endpoint_host.to_string(),
        force_path_style,
        created_at: now,
        updated_at: now,
    })
}

pub async fn list_rustfs_accounts() -> DbResult<Vec<RustfsAccount>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT id, name, access_key_id, secret_access_key, credential_format, endpoint_scheme, endpoint_host, force_path_style, created_at, updated_at
             FROM rustfs_accounts ORDER BY created_at",
            (),
        )
        .await?;

    let mut accounts = Vec::new();
    while let Some(row) = rows.next().await? {
        let id: String = row.get(0)?;
        let format: i64 = row.get(4)?;
        let access_key_id: String = row.get(2)?;
        let secret_access_key: String = row.get(3)?;
        let force_value: i64 = row.get(7)?;
        accounts.push(RustfsAccount {
            id: id.clone(),
            name: row.get(1)?,
            access_key_id: decrypt(&access_key_id, format, "rustfs", &id, "access_key_id")?,
            secret_access_key: decrypt(
                &secret_access_key,
                format,
                "rustfs",
                &id,
                "secret_access_key",
            )?,
            endpoint_scheme: row.get(5)?,
            endpoint_host: row.get(6)?,
            force_path_style: force_value != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        });
    }
    Ok(accounts)
}

pub async fn update_rustfs_account(
    id: &str,
    name: Option<&str>,
    access_key_id: &str,
    secret_access_key: &str,
    endpoint_scheme: &str,
    endpoint_host: &str,
    force_path_style: bool,
) -> DbResult<()> {
    let has_encrypted_records = super::has_encrypted_credentials().await?;
    let encrypted_access_key_id = encrypt(
        access_key_id,
        "rustfs",
        id,
        "access_key_id",
        has_encrypted_records,
    )?;
    let encrypted_secret_access_key =
        encrypt(secret_access_key, "rustfs", id, "secret_access_key", true)?;
    let conn = get_connection()?.lock().await;
    let now = chrono::Utc::now().timestamp();
    let force_value = if force_path_style { 1 } else { 0 };
    conn.execute(
        "UPDATE rustfs_accounts SET name = ?1, access_key_id = ?2, secret_access_key = ?3, credential_format = ?4,
             endpoint_scheme = ?5, endpoint_host = ?6, force_path_style = ?7, updated_at = ?8 WHERE id = ?9",
        turso::params![name, encrypted_access_key_id, encrypted_secret_access_key, ENCRYPTED_V1_FORMAT, endpoint_scheme, endpoint_host, force_value, now, id],
    ).await?;

    Ok(())
}

pub async fn delete_rustfs_account(id: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;

    conn.execute(
        "DELETE FROM rustfs_buckets WHERE account_id = ?1",
        turso::params![id],
    )
    .await?;

    conn.execute(
        "DELETE FROM rustfs_accounts WHERE id = ?1",
        turso::params![id],
    )
    .await?;

    Ok(())
}
