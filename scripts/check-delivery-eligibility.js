import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
}

const client = new Client({
    connectionString: process.env.DATABASE_URL
});

try {
    await client.connect();

    const result = await client.query(`
        SELECT
            n."Id" AS "NotificationId",
            n."Title",
            n."CreatedAt" AS "NotificationCreatedAt",
            b."Id" AS "SubscriptionId",
            b."CreatedAt" AS "SubscriptionCreatedAt",
            b."IsActive",
            (
                b."CreatedAt" <= n."CreatedAt"
                AND b."IsActive" = TRUE
            ) AS "Eligible"
        FROM "Notifications" n
        INNER JOIN "BrowserPushSubscriptions" b
            ON b."UserId" = n."UserId"
        ORDER BY n."CreatedAt" DESC, b."CreatedAt" DESC
        LIMIT 30;
    `);

    console.table(result.rows);
} finally {
    await client.end();
}
