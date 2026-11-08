
import pg from "pg";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const { Client } = pg;

const BATCH_SIZE = 10;
const PROCESSING_LEASE_MINUTES = 15;

async function discoverDeliveries(client, startAt) {
    const result = await client.query(
        `
        INSERT INTO "NotificationDeliveries"
        (
            "NotificationId",
            "BrowserPushSubscriptionId",
            "Status",
            "AttemptCount",
            "CreatedAt"
        )
        SELECT
            n."Id",
            b."Id",
            'Pending',
            0,
            NOW()
        FROM "Notifications" n
        INNER JOIN "BrowserPushSubscriptions" b
            ON b."UserId" = n."UserId"
        WHERE
            n."CreatedAt" >= $1
            AND b."IsActive" = TRUE
            AND b."CreatedAt" <= n."CreatedAt"
        ON CONFLICT
            ("NotificationId", "BrowserPushSubscriptionId")
        DO NOTHING
        RETURNING "Id"
        `,
        [startAt]
    );

    return result.rowCount;
}

async function expireInactiveDeliveries(client, startAt) {
    const result = await client.query(
        `
        UPDATE "NotificationDeliveries" d
        SET
            "Status" = 'Expired',
            "NextAttemptAt" = NULL,
            "LastError" = 'Browser push subscription is inactive.'
        FROM "BrowserPushSubscriptions" b,
             "Notifications" n
        WHERE
            b."Id" = d."BrowserPushSubscriptionId"
            AND n."Id" = d."NotificationId"
            AND n."CreatedAt" >= $1
            AND b."IsActive" = FALSE
            AND d."Status" IN ('Pending', 'Failed', 'Processing')
        `,
        [startAt]
    );

    return result.rowCount;
}

async function claimDeliveries(client, batchSize, startAt) {
    const result = await client.query(
        `
        WITH candidates AS
        (
            SELECT
                d."Id",
                d."NotificationId",
                d."BrowserPushSubscriptionId"
            FROM "NotificationDeliveries" d
            INNER JOIN "BrowserPushSubscriptions" b
                ON b."Id" = d."BrowserPushSubscriptionId"
            INNER JOIN "Notifications" n
                ON n."Id" = d."NotificationId"
            WHERE
                n."CreatedAt" >= $2
                AND b."IsActive" = TRUE
                AND b."CreatedAt" <= n."CreatedAt"
                AND
                (
                    d."Status" = 'Pending'
                    OR
                    (
                        d."Status" = 'Failed'
                        AND d."NextAttemptAt" IS NOT NULL
                        AND d."NextAttemptAt" <= NOW()
                    )
                    OR
                    (
                        d."Status" = 'Processing'
                        AND d."NextAttemptAt" <= NOW()
                    )
                )
            ORDER BY d."CreatedAt", d."Id"
            LIMIT $1
            FOR UPDATE OF d SKIP LOCKED
        )
        UPDATE "NotificationDeliveries" d
        SET
            "Status" = 'Processing',
            "AttemptCount" = d."AttemptCount" + 1,
            "LastAttemptAt" = NOW(),
            "NextAttemptAt" =
                NOW() + ($3 * INTERVAL '1 minute'),
            "LastError" = NULL
        FROM candidates c
        INNER JOIN "Notifications" n
            ON n."Id" = c."NotificationId"
        INNER JOIN "BrowserPushSubscriptions" b
            ON b."Id" = c."BrowserPushSubscriptionId"
        WHERE
            d."Id" = c."Id"
            AND n."CreatedAt" >= $2
            AND b."IsActive" = TRUE
            AND b."CreatedAt" <= n."CreatedAt"
        RETURNING
            d."Id" AS "DeliveryId",
            d."AttemptCount",
            n."Id" AS "NotificationId",
            n."Title",
            n."Message",
            b."Id" AS "SubscriptionId",
            b."Endpoint",
            b."P256dh",
            b."Auth"
        `,
        [batchSize, startAt, PROCESSING_LEASE_MINUTES]
    );

    return result.rows;
}

async function markSent(client, deliveryId, subscriptionId) {
    await client.query(
        `
        UPDATE "NotificationDeliveries"
        SET
            "Status" = 'Sent',
            "DeliveredAt" = NOW(),
            "NextAttemptAt" = NULL,
            "LastError" = NULL
        WHERE "Id" = $1
        `,
        [deliveryId]
    );

    await client.query(
        `
        UPDATE "BrowserPushSubscriptions"
        SET "LastUsedAt" = NOW()
        WHERE "Id" = $1
        `,
        [subscriptionId]
    );
}

async function markExpired(client, deliveryId, subscriptionId, status) {
    await client.query(
        `
        UPDATE "BrowserPushSubscriptions"
        SET "IsActive" = FALSE
        WHERE "Id" = $1
        `,
        [subscriptionId]
    );

    await client.query(
        `
        UPDATE "NotificationDeliveries"
        SET
            "Status" = 'Expired',
            "NextAttemptAt" = NULL,
            "LastError" = $2
        WHERE "Id" = $1
        `,
        [
            deliveryId,
            `Push endpoint returned HTTP ${status}.`
        ]
    );
}

async function markFailed(client, delivery, errorMessage) {
    const attempt = delivery.AttemptCount;
    const retryMinutes = Math.min(60, 2 ** Math.min(attempt - 1, 6));
    const permanentlyFailed = attempt >= 8;

    await client.query(
        `
        UPDATE "NotificationDeliveries"
        SET
            "Status" = 'Failed',
            "NextAttemptAt" = CASE
                WHEN $2 THEN NULL
                ELSE NOW() + ($3 * INTERVAL '1 minute')
            END,
            "LastError" = $4
        WHERE "Id" = $1
        `,
        [
            delivery.DeliveryId,
            permanentlyFailed,
            retryMinutes,
            errorMessage.slice(0, 2000)
        ]
    );
}

async function sendDelivery(client, delivery, env) {
    const subscription = {
        endpoint: delivery.Endpoint,
        expirationTime: null,
        keys: {
            p256dh: delivery.P256dh,
            auth: delivery.Auth
        }
    };

    const vapid = {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY
    };

    const message = {
        data: JSON.stringify({
            title: delivery.Title,
            body: delivery.Message,
            url: "/Notifications/Notifications"
        }),
        options: {
            ttl: 60
        }
    };

    const payload = await buildPushPayload(
        message,
        subscription,
        vapid
    );

    const response = await fetch(subscription.endpoint, payload);

    if (response.status === 404 || response.status === 410) {
        await markExpired(
            client,
            delivery.DeliveryId,
            delivery.SubscriptionId,
            response.status
        );

        return "expired";
    }

    if (!response.ok) {
        throw new Error(
            `Push service returned HTTP ${response.status}.`
        );
    }

    await markSent(
        client,
        delivery.DeliveryId,
        delivery.SubscriptionId
    );

    return "sent";
}

export async function processPushDeliveries(env) {
    if (
        !env.HYPERDRIVE?.connectionString ||
        !env.VAPID_SUBJECT ||
        !env.VAPID_PUBLIC_KEY ||
        !env.VAPID_PRIVATE_KEY
    ) {
        throw new Error(
            "Database or VAPID configuration is incomplete."
        );
    }

    if (!env.PUSH_DELIVERY_START_AT) {
        throw new Error(
            "PUSH_DELIVERY_START_AT is not configured."
        );
    }

    const startAt = new Date(env.PUSH_DELIVERY_START_AT);

    if (Number.isNaN(startAt.getTime())) {
        throw new Error(
            "PUSH_DELIVERY_START_AT is not a valid date."
        );
    }

    const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString
    });

    const summary = {
        discovered: 0,
        expiredInactive: 0,
        claimed: 0,
        sent: 0,
        failed: 0,
        expired: 0
    };

    try {
        await client.connect();

        summary.discovered = await discoverDeliveries(
            client,
            startAt.toISOString()
        );

        summary.expiredInactive =
            await expireInactiveDeliveries(
                client,
                startAt.toISOString()
            );

        const deliveries = await claimDeliveries(
            client,
            BATCH_SIZE,
            startAt.toISOString()
        );

        summary.claimed = deliveries.length;

        for (const delivery of deliveries) {
            try {
                const result = await sendDelivery(
                    client,
                    delivery,
                    env
                );

                summary[result]++;
            } catch (error) {
                console.error(
                    `Delivery ${delivery.DeliveryId} failed:`,
                    error
                );

                await markFailed(
                    client,
                    delivery,
                    error instanceof Error
                        ? error.message
                        : "Unknown push delivery error."
                );

                summary.failed++;
            }
        }

        return summary;
    } finally {
        await client.end().catch(() => {});
    }
}
