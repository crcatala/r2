//! Shared concurrent batch-delete driver used by the provider commands.
//!
//! Splits the key list into sub-batches and runs a few DeleteObjects requests
//! in parallel: large deletes finish ~MAX_IN_FLIGHT× faster than the previous
//! sequential loop, and the finer batch size gives the progress bar real
//! intermediate steps instead of one 0→100 jump for ≤1000 keys.

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::future::Future;
use tauri::{AppHandle, Emitter};

/// Sub-batch size. The S3 DeleteObjects API caps at 1000; 250 keeps request
/// count modest while giving a 1000-file delete four visible progress steps.
const BATCH_SIZE: usize = 250;
/// DeleteObjects requests in flight at once.
const MAX_IN_FLIGHT: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct BatchDeleteProgress {
    pub completed: usize,
    pub total: usize,
    pub failed: usize,
}

pub(crate) struct BatchDeleteOutcome {
    pub completed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub deleted_keys: Vec<String>,
}

/// Delete `keys` via `delete_batch` (one call per sub-batch, up to
/// MAX_IN_FLIGHT concurrently), emitting `batch-delete-progress` as
/// sub-batches complete.
pub(crate) async fn run_batch_delete<F, Fut>(
    app: &AppHandle,
    keys: Vec<String>,
    delete_batch: F,
) -> BatchDeleteOutcome
where
    F: Fn(Vec<String>) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let total = keys.len();
    let mut outcome = BatchDeleteOutcome {
        completed: 0,
        failed: 0,
        errors: Vec::new(),
        deleted_keys: Vec::with_capacity(total),
    };

    let chunks: Vec<Vec<String>> = keys.chunks(BATCH_SIZE).map(|c| c.to_vec()).collect();
    let mut results = stream::iter(chunks)
        .map(|batch| {
            let fut = delete_batch(batch.clone());
            async move { (batch, fut.await) }
        })
        .buffer_unordered(MAX_IN_FLIGHT);

    while let Some((batch, result)) = results.next().await {
        match result {
            Ok(()) => {
                outcome.completed += batch.len();
                outcome.deleted_keys.extend(batch);
            }
            Err(e) => {
                outcome.failed += batch.len();
                outcome.errors.push(e);
            }
        }

        let _ = app.emit(
            "batch-delete-progress",
            BatchDeleteProgress {
                completed: outcome.completed,
                total,
                failed: outcome.failed,
            },
        );
    }

    outcome
}
