use std::cell::RefCell;
use std::sync::{Arc, OnceLock, RwLock};

use tokio::task_local;

use crate::{Kaos, LocalKaos};

task_local! {
    static TASK_KAOS: RefCell<Option<Arc<dyn Kaos>>>;
}

static GLOBAL_KAOS: OnceLock<RwLock<Arc<dyn Kaos>>> = OnceLock::new();

pub struct CurrentKaosToken {
    previous: Option<Arc<dyn Kaos>>,
    scope: TokenScope,
}

enum TokenScope {
    TaskLocal,
    Global,
}

fn default_kaos() -> Arc<dyn Kaos> {
    Arc::new(LocalKaos::new())
}

fn global_kaos_cell() -> &'static RwLock<Arc<dyn Kaos>> {
    GLOBAL_KAOS.get_or_init(|| RwLock::new(default_kaos()))
}

pub async fn with_current_kaos_scope<F, R>(future: F) -> R
where
    F: std::future::Future<Output = R>,
{
    TASK_KAOS.scope(RefCell::new(None), future).await
}

pub fn get_current_kaos() -> Arc<dyn Kaos> {
    if let Ok(current) = TASK_KAOS.try_with(|cell| cell.borrow().clone()) {
        return current.unwrap_or_else(|| global_kaos_cell().read().unwrap().clone());
    }
    global_kaos_cell().read().unwrap().clone()
}

pub fn set_current_kaos(kaos: Arc<dyn Kaos>) -> CurrentKaosToken {
    if let Ok(previous) = TASK_KAOS.try_with(|cell| cell.borrow().clone()) {
        let _ = TASK_KAOS.try_with(|cell| {
            *cell.borrow_mut() = Some(kaos);
        });
        return CurrentKaosToken {
            previous,
            scope: TokenScope::TaskLocal,
        };
    }
    let mut guard = global_kaos_cell().write().unwrap();
    let previous = guard.clone();
    *guard = kaos;
    CurrentKaosToken {
        previous: Some(previous),
        scope: TokenScope::Global,
    }
}

pub fn reset_current_kaos(token: CurrentKaosToken) {
    match token.scope {
        TokenScope::TaskLocal => {
            let _ = TASK_KAOS.try_with(|cell| {
                *cell.borrow_mut() = token.previous;
            });
        }
        TokenScope::Global => {
            let mut guard = global_kaos_cell().write().unwrap();
            *guard = token.previous.unwrap_or_else(default_kaos);
        }
    }
}
