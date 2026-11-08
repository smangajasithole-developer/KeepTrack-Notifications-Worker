
import pg from "pg";

const { Client } = pg;

const SOUTH_AFRICAN_TIME_ZONE = "Africa/Johannesburg";
const MICROSECONDS_PER_SECOND = 1_000_000;
const MICROSECONDS_PER_DAY = 86_400 * MICROSECONDS_PER_SECOND;

// --------------------------------------------------
// SOUTH AFRICAN WALL-CLOCK TIME
// --------------------------------------------------

function getSouthAfricanNow() {
    const instant = new Date();

    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: SOUTH_AFRICAN_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(instant);

    const values = Object.fromEntries(
        parts
            .filter(part => part.type !== "literal")
            .map(part => [part.type, Number(part.value)])
    );

    return Date.UTC(
        values.year,
        values.month - 1,
        values.day,
        values.hour,
        values.minute,
        values.second
    ) * 1000 + instant.getUTCMilliseconds() * 1000;
}

// PostgreSQL timestamp without time zone values are returned
// as text so JavaScript does not interpret them as UTC/local dates.
function parseWallClock(value) {
    if (!value) {
        return null;
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})$/.exec(value);

    if (!match) {
        throw new Error(`Invalid wall-clock timestamp: ${value}`);
    }

    const [
        ,
        year,
        month,
        day,
        hour,
        minute,
        second,
        microseconds
    ] = match;

    return Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    ) * 1000 + Number(microseconds);
}

function getDateParts(value) {
    const date = new Date(Math.floor(value / 1000));

    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
    };
}

function formatTimestamp(value) {
    const date = new Date(Math.floor(value / 1000));

    const pad = number => String(number).padStart(2, "0");

    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hour = pad(date.getUTCHours());
    const minute = pad(date.getUTCMinutes());
    const second = pad(date.getUTCSeconds());

    const fraction = String(
        ((value % MICROSECONDS_PER_SECOND) + MICROSECONDS_PER_SECOND)
        % MICROSECONDS_PER_SECOND
    ).padStart(6, "0");

    return `${year}-${month}-${day} ${hour}:${minute}:${second}.${fraction}`;
}

function formatNotificationDate(value) {
    const date = new Date(Math.floor(value / 1000));

    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    const pad = number => String(number).padStart(2, "0");

    return (
        `${pad(date.getUTCDate())} ` +
        `${months[date.getUTCMonth()]} ` +
        `${date.getUTCFullYear()}, ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
    );
}

// --------------------------------------------------
// REMINDER TIME PARSING
// --------------------------------------------------

function parseReminderInterval(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = /^(?:\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value.trim());

    if (!match) {
        return null;
    }

    const parts = value.trim().split(":").map(Number);
    const [hours, minutes, seconds] = parts;

    const interval =
        (hours * 3600 + minutes * 60 + seconds) *
        MICROSECONDS_PER_SECOND;

    return interval > 0 ? interval : null;
}

function parseReminderTime(value) {
    if (typeof value !== "string") {
        return null;
    }

    const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,7}))?)?$/.exec(
        value.trim()
    );

    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] ?? 0);
    const fraction = (match[4] ?? "").padEnd(6, "0").slice(0, 6);

    if (hours > 23) {
        return null;
    }

    return (
        (hours * 3600 + minutes * 60 + seconds) *
        MICROSECONDS_PER_SECOND
    ) + Number(fraction || 0);
}

// --------------------------------------------------
// CALENDAR DATE CALCULATIONS
// --------------------------------------------------

function addDaysToStartDate(start, days) {
    const { year, month, day } = getDateParts(start);

    return Date.UTC(
        year,
        month - 1,
        day + days
    ) * 1000;
}

// Matches DateTime.AddMonths behaviour by clamping
// the day to the last day of the target month.
function addMonthsToStartDate(start, months) {
    const { year, month, day } = getDateParts(start);

    const targetMonthIndex = year * 12 + (month - 1) + months;
    const targetYear = Math.floor(targetMonthIndex / 12);
    const targetMonth = targetMonthIndex % 12;

    const lastDayOfTargetMonth = new Date(
        Date.UTC(targetYear, targetMonth + 1, 0)
    ).getUTCDate();

    return Date.UTC(
        targetYear,
        targetMonth,
        Math.min(day, lastDayOfTargetMonth)
    ) * 1000;
}

// --------------------------------------------------
// LATEST TASK REMINDER OCCURRENCE
// --------------------------------------------------

function getLatestReminderOccurrence(task, start, now) {
    if (task.ReminderUnit?.toLowerCase() === "hour") {
        const interval = parseReminderInterval(
            task.ReminderInterval
        );

        if (!interval) {
            return null;
        }

        const elapsed = now - start;

        if (elapsed < interval) {
            return null;
        }

        const occurrenceNumber = Math.floor(elapsed / interval);

        const scheduled = start + occurrenceNumber * interval;

        return scheduled <= now ? scheduled : null;
    }

    const value = Number(task.ReminderValue);

    if (
        !Number.isInteger(value) ||
        value < 1
    ) {
        return null;
    }

    const reminderOffset = parseReminderTime(task.ReminderTime);

    if (reminderOffset === null) {
        return null;
    }

    const startParts = getDateParts(start);
    const nowParts = getDateParts(now);

    const startDay = Date.UTC(
        startParts.year,
        startParts.month - 1,
        startParts.day
    ) * 1000;

    const nowDay = Date.UTC(
        nowParts.year,
        nowParts.month - 1,
        nowParts.day
    ) * 1000;

    let occurrenceNumber;
    let candidate;
    let scheduled;

    switch (task.ReminderUnit) {
        case "Day": {
            occurrenceNumber = Math.floor(
                (nowDay - startDay) /
                (value * MICROSECONDS_PER_DAY)
            );

            candidate =
                addDaysToStartDate(start, occurrenceNumber * value) +
                reminderOffset;

            if (candidate < start) {
                occurrenceNumber++;
            } else if (candidate > now) {
                occurrenceNumber--;
            }

            if (occurrenceNumber < 0) {
                return null;
            }

            scheduled =
                addDaysToStartDate(start, occurrenceNumber * value) +
                reminderOffset;

            break;
        }

        case "Week": {
            const days = value * 7;

            occurrenceNumber = Math.floor(
                (nowDay - startDay) /
                (days * MICROSECONDS_PER_DAY)
            );

            candidate =
                addDaysToStartDate(start, occurrenceNumber * days) +
                reminderOffset;

            if (candidate < start) {
                occurrenceNumber++;
            } else if (candidate > now) {
                occurrenceNumber--;
            }

            if (occurrenceNumber < 0) {
                return null;
            }

            scheduled =
                addDaysToStartDate(start, occurrenceNumber * days) +
                reminderOffset;

            break;
        }

        case "Month": {
            const monthsElapsed =
                (nowParts.year - startParts.year) * 12 +
                nowParts.month - startParts.month;

            occurrenceNumber = Math.floor(monthsElapsed / value);

            candidate =
                addMonthsToStartDate(start, occurrenceNumber * value) +
                reminderOffset;

            if (candidate < start) {
                occurrenceNumber++;
            } else if (candidate > now) {
                occurrenceNumber--;
            }

            if (occurrenceNumber < 0) {
                return null;
            }

            scheduled =
                addMonthsToStartDate(start, occurrenceNumber * value) +
                reminderOffset;

            break;
        }

        case "Year": {
            const yearsElapsed = nowParts.year - startParts.year;

            occurrenceNumber = Math.floor(yearsElapsed / value);

            candidate =
                addMonthsToStartDate(start, occurrenceNumber * value * 12) +
                reminderOffset;

            if (candidate < start) {
                occurrenceNumber++;
            } else if (candidate > now) {
                occurrenceNumber--;
            }

            if (occurrenceNumber < 0) {
                return null;
            }

            scheduled =
                addMonthsToStartDate(start, occurrenceNumber * value * 12) +
                reminderOffset;

            break;
        }

        default:
            return null;
    }

    return scheduled >= start && scheduled <= now
        ? scheduled
        : null;
}

// --------------------------------------------------
// TASK REMINDER GENERATION
// --------------------------------------------------

async function generateTaskReminder(client, task, now) {
    if (
        !task.ReminderEnabled ||
        task.StartDate === null ||
        task.DueDate === null
    ) {
        return false;
    }

    const start = parseWallClock(task.StartDate);
    const due = parseWallClock(task.DueDate);

    if (now < start || due <= start) {
        return false;
    }

    const scheduledFor = getLatestReminderOccurrence(
        task,
        start,
        now
    );

    if (
        scheduledFor === null ||
        scheduledFor < start ||
        scheduledFor > now
    ) {
        return false;
    }

    const message =
        `Reminder for "${task.Title}". ` +
        `It was due on ${formatNotificationDate(due)}.` +
        (now > due
            ? " This task is overdue and still needs to be completed."
            : "");

    const result = await client.query(
        `
        INSERT INTO "Notifications"
        (
            "UserId",
            "TaskId",
            "Type",
            "Title",
            "Message",
            "CreatedAt",
            "ScheduledFor",
            "IsRead"
        )
        VALUES ($1, $2, 'TaskReminder', 'Task reminder', $3, NOW(), $4::timestamp, FALSE)
        ON CONFLICT DO NOTHING
        RETURNING "Id"
        `,
        [
            task.UserId,
            task.Id,
            message,
            formatTimestamp(scheduledFor)
        ]
    );

    return result.rowCount > 0;
}

// --------------------------------------------------
// OVERDUE TASK GENERATION
// --------------------------------------------------

async function generateOverdueNotification(client, task, now) {
    if (!task.DueDate) {
        return false;
    }

    const due = parseWallClock(task.DueDate);

    if (due > now) {
        return false;
    }

    const message =
        `Your task "${task.Title}" was due on ` +
        `${formatNotificationDate(due)} and is not yet completed.`;

    const result = await client.query(
        `
        INSERT INTO "Notifications"
        (
            "UserId",
            "TaskId",
            "Type",
            "Title",
            "Message",
            "CreatedAt",
            "IsRead"
        )
        VALUES ($1, $2, 'OverdueTask', 'Task overdue', $3, NOW(), FALSE)
        ON CONFLICT DO NOTHING
        RETURNING "Id"
        `,
        [
            task.UserId,
            task.Id,
            message
        ]
    );

    return result.rowCount > 0;
}

// --------------------------------------------------
// MAIN GENERATION PROCESS
// --------------------------------------------------

export async function generateNotifications(env) {
    if (!env.HYPERDRIVE?.connectionString) {
        throw new Error("Database configuration is incomplete.");
    }

    const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString
    });

    const summary = {
        lockAcquired: false,
        tasksChecked: 0,
        taskRemindersCreated: 0,
        overdueNotificationsCreated: 0
    };

    try {
        await client.connect();
        await client.query("BEGIN");

        // Prevent overlapping generation runs.
        const lockResult = await client.query(
            "SELECT pg_try_advisory_xact_lock(784512309) AS acquired"
        );

        if (!lockResult.rows[0].acquired) {
            await client.query("ROLLBACK");
            return summary;
        }

        summary.lockAcquired = true;

        const now = getSouthAfricanNow();

        const tasksResult = await client.query(
            `
            SELECT
                "Id",
                "UserId",
                "Title",
                "ReminderEnabled",
                "ReminderValue",
                "ReminderUnit",
                "ReminderTime",
                "ReminderInterval",
                CASE
                    WHEN "StartDate" IS NULL THEN NULL
                    ELSE to_char(
                        "StartDate",
                        'YYYY-MM-DD"T"HH24:MI:SS.US'
                    )
                END AS "StartDate",
                to_char(
                    "DueDate",
                    'YYYY-MM-DD"T"HH24:MI:SS.US'
                ) AS "DueDate"
            FROM "Tasks"
            WHERE
                NOT "IsCompleted"
                AND "DueDate" IS NOT NULL
                AND (
                    (
                        "ReminderEnabled" = TRUE
                        AND "StartDate" IS NOT NULL
                    )
                    OR "DueDate" <= $1::timestamp
                )
            `,
            [formatTimestamp(now)]
        );

        summary.tasksChecked = tasksResult.rows.length;

        for (const task of tasksResult.rows) {
            if (
                await generateTaskReminder(client, task, now)
            ) {
                summary.taskRemindersCreated++;
            }

            if (
                await generateOverdueNotification(client, task, now)
            ) {
                summary.overdueNotificationsCreated++;
            }
        }

        await client.query("COMMIT");

        return summary;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        await client.end().catch(() => {});
    }
}



