#[tokio::main]
async fn main() {
    if let Err(err) = kagent::cli::run().await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
