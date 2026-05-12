Create a scheduled task that runs a prompt on a recurring or one-shot basis using a cron expression.

Use this tool when the user wants to schedule something to run repeatedly or at a specific time in the future. Examples:
- "Remind me every 5 minutes to check the build"
- "Run tests every hour"
- "Check deploy status at 9am daily"

**Parameters:**
- `cron` (required): A valid 5-field cron expression (minute hour day-of-month month day-of-week). Use local time.
- `prompt` (required): The prompt to execute when the schedule fires.
- `recurring` (optional, default false): If true, the task will run repeatedly according to the cron schedule. If false, it runs exactly once.
- `durable` (optional, default false): If true, the task is persisted to disk and survives process restarts. If false, it is session-only and lost when the CLI exits.

**Cron format:**
```
* * * * *
│ │ │ │ └── day of week (0-7, where 0 and 7 = Sunday)
│ │ │ └──── month (1-12)
│ │ └────── day of month (1-31)
│ └──────── hour (0-23)
└────────── minute (0-59)
```

Common patterns:
- Every minute: `* * * * *`
- Every 5 minutes: `*/5 * * * *`
- Every hour: `0 * * * *`
- Every day at 9am: `0 9 * * *`
- Every Monday at 8am: `0 8 * * 1`

**Limits:**
- Maximum 50 scheduled tasks total.
- Durable tasks are not allowed for subagent contexts.
- Recurring tasks auto-expire after 7 days (they fire one final time, then are removed).

After creating the task, confirm the schedule details to the user, then **immediately execute the prompt now** so the user gets immediate feedback.
