import { auth } from "./lib/auth";
import { getMigrations } from "better-auth/db";

async function runMigration() {
    console.log("Checking for database migrations...");
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    
    if (toBeCreated.length === 0 && toBeAdded.length === 0) {
        console.log("Database is up to date.");
        return;
    }

    console.log(`Found ${toBeCreated.length} tables to create and ${toBeAdded.length} fields to add.`);
    await runMigrations();
    console.log("Migrations applied successfully!");
}

runMigration().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
