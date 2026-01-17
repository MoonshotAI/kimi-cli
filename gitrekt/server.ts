import { Hono } from "hono";
import { auth } from "./lib/auth";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { getMigrations } from "better-auth/db";

const app = new Hono();

// Auto-migrate on startup
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

app.use("*", logger());
app.use("*", cors({
    origin: ["http://localhost:3000", "http://localhost:3123"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Gitrekt-Token"],
    credentials: true,
}));

// Better Auth handlers
app.on(["POST", "GET"], "/api/auth/*", (c) => {
    return auth.handler(c.req.raw);
});

// A simple API to get the current user/session
app.get("/api/me", async (c) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });
    if (!session) {
        return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(session);
});

// CLI configuration endpoint - returns model config for authenticated users
app.get("/api/cli/config", async (c) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });
    if (!session) {
        return c.json({ error: "Unauthorized" }, 401);
    }
    
    // Return the model configuration for CLI users
    // This is the "out of the box" config that users get after authenticating
    return c.json({
        default_model: "gpt-5.2",
        default_thinking: true,
        models: {
            "gpt-5.2": {
                provider: "openai-responses",
                model: "gpt-5.2",
                max_context_size: 400000,
            }
        },
        providers: {
            "openai-responses": {
                type: "openai_responses",
                base_url: process.env.LLM_BASE_URL || "https://api.kowyo.com/v1",
                api_key: process.env.LLM_API_KEY || "",
            }
        }
    });
});

// Serve the React app in production (after bun run build)
// For development, we might run vite separately, or just proxy.
// But the user asked for "out of box experience", so let's make it easy.

console.log("Gitrekt Server running at http://localhost:3001");

export default {
    port: 3001,
    fetch: app.fetch,
};
