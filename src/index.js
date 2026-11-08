
import pg from "pg";
import { generateNotifications } from "./generation.js";
import { processPushDeliveries } from "./delivery.js";

const { Client } = pg;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ================================================
        // DATABASE HEALTH CHECK
        // ================================================

        if (url.pathname === "/" && request.method === "GET") {
            if (!env.HYPERDRIVE?.connectionString) {
                return Response.json(
                    {
                        database_connected: false,
                        error: "Database configuration is incomplete."
                    },
                    { status: 500 }
                );
            }

            const client = new Client({
                connectionString: env.HYPERDRIVE.connectionString
            });

            try {
                await client.connect();

                const result = await client.query(
                    "SELECT current_database() AS database, NOW() AS server_time"
                );

                return Response.json({
                    service: "KeepTrack Notifications",
                    database_connected: true,
                    database: result.rows[0].database,
                    message: "PostgreSQL connection successful."
                });
            } catch (error) {
                console.error("Database connection failed:", error);

                return Response.json(
                    {
                        database_connected: false,
                        error: "Could not connect to the database."
                    },
                    { status: 500 }
                );
            } finally {
                await client.end().catch(() => {});
            }
        }

        // ================================================
        // API AUTHENTICATION
        // ================================================

        if (url.pathname.startsWith("/api/")) {
            const suppliedSecret = request.headers.get("Authorization");
            const expectedSecret = `Bearer ${env.KEEPTRACK_API_SECRET}`;

            if (
                !env.KEEPTRACK_API_SECRET ||
                suppliedSecret !== expectedSecret
            ) {
                return Response.json(
                    { error: "Unauthorized" },
                    { status: 401 }
                );
            }

            // ============================================
            // NOTIFICATION GENERATION (MANUAL TEST)
            // ============================================

            if (url.pathname === "/api/generate-notifications") {
                if (request.method !== "POST") {
                    return Response.json(
                        { error: "Method not allowed." },
                        { status: 405 }
                    );
                }

                try {
                    const summary = await generateNotifications(env);

                    return Response.json({
                        success: true,
                        message: "Notification generation completed.",
                        summary
                    });
                } catch (error) {
                    console.error(
                        "Notification generation failed:",
                        error
                    );

                    return Response.json(
                        {
                            success: false,
                            error: "Notification generation failed."
                        },
                        { status: 500 }
                    );
                }
            }

            // ============================================
            // AUTOMATIC PUSH DELIVERY (MANUAL TRIGGER)
            // ============================================

            if (url.pathname === "/api/process-push") {
                if (request.method !== "POST") {
                    return Response.json(
                        { error: "Method not allowed." },
                        { status: 405 }
                    );
                }

                try {
                    const summary = await processPushDeliveries(env);

                    return Response.json({
                        success: true,
                        message: "Push delivery processing completed.",
                        summary
                    });
                } catch (error) {
                    console.error(
                        "Push delivery processing failed:",
                        error
                    );

                    return Response.json(
                        {
                            success: false,
                            error: "Push delivery processing failed."
                        },
                        { status: 500 }
                    );
                }
            }

            return Response.json(
                { error: "Not found" },
                { status: 404 }
            );
        }

        return Response.json(
            { error: "Not found" },
            { status: 404 }
        );
    },

    // ================================================
    // CLOUDFLARE CRON TRIGGER
    // ================================================

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(
            (async () => {
                try {
                    const generationSummary =
                        await generateNotifications(env);

                    console.log(
                        "Scheduled notification generation completed:",
                        generationSummary
                    );

                    const deliverySummary =
                        await processPushDeliveries(env);

                    console.log(
                        "Scheduled push delivery completed:",
                        deliverySummary
                    );
                } catch (error) {
                    console.error(
                        "Scheduled notifications push processing failed:",
                        error
                    );
                }
            })()
        );
    }
};
