use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::share::get_share_dir;

static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();
static LOG_INIT: OnceLock<()> = OnceLock::new();

pub async fn init_logging(debug: bool) -> anyhow::Result<()> {
    if LOG_INIT.get().is_some() {
        return Ok(());
    }

    let log_dir = get_share_dir().join("logs");
    tokio::fs::create_dir_all(&log_dir).await?;

    let file_appender = tracing_appender::rolling::daily(log_dir, "kagent.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let level = if debug {
        tracing::Level::TRACE
    } else {
        tracing::Level::INFO
    };

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .with(tracing_subscriber::filter::LevelFilter::from_level(level))
        .init();

    let _ = LOG_GUARD.set(guard);
    let _ = LOG_INIT.set(());
    Ok(())
}
