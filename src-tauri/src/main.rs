use std::path::PathBuf;

/// Standalone CLI for database initialization (for testing)
///
/// In production, this will be integrated with Tauri's setup hook
fn main() {
    println!("GSD Demo - Database Layer");
    println!("========================\n");

    // For standalone testing, create database in temp directory
    let db_path = PathBuf::from("/tmp/gsd-demo/gsd-demo.db");

    if let Some(parent) = db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("Failed to create directory: {}", e);
            std::process::exit(1);
        }
    }

    match rusqlite::Connection::open(&db_path) {
        Ok(conn) => {
            println!("Database created at: {:?}", db_path);

            if let Err(e) = gsd_demo::db::initialize_schema(&conn) {
                eprintln!("Failed to initialize schema: {}", e);
                std::process::exit(1);
            }

            println!("Schema initialized successfully");

            // Verify schema
            match conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0)) {
                Ok(version) => println!("Schema version: {}", version),
                Err(e) => eprintln!("Error reading schema version: {}", e),
            }
        }
        Err(e) => {
            eprintln!("Failed to create database: {}", e);
            std::process::exit(1);
        }
    }
}
