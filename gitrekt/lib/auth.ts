import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { Database } from "bun:sqlite";

const db = new Database("./dev.db");

export const auth = betterAuth({
    database: db,
    socialProviders: {
        github: {
            clientId: process.env.GITHUB_CLIENT_ID || "",
            clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
        },
    },
    plugins: [bearer()],
    trustedOrigins: ["http://localhost:3000", "http://localhost:3123"],
});
