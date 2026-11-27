# Ավտոմատացումներ (Automations) — design

Date: 2026-11-27 · Status: draft, waiting for approval

## Why

The club repeats the same follow-ups by hand: when a student moves into a championship group someone has to
remember to change the fee and write a note; summaries, reminders and receipts are sent on fixed rules hidden in
Ծանուցումներ. The owner wants one place — Կարգավորումներ → **Ավտոմատացումներ** — where they build their own
CRM-style rules: **When** something happens → **If** conditions match → **Then** do actions. The owner creates
the rules; the app supplies the building blocks. Missing triggers or actions are added later, on request.

The example that defines the feature:

> When a student's group changes · If the old group is not championship and the new one is · Then set the
> monthly fee to the new group's price keeping the student's discount (30 000 → 35 000, 15 000 → 17 500) and
> add a note in Նշումներ.

## Goals

- A rules engine: any trigger + any number of AND conditions + one or more actions, each rule on/off.
- Rules act immediately: by the time the screen reloads after a save, the rule's changes are there.
- Every run is visible: a per-rule history (when, which student, done / skipped / failed and why), and the
  rule's own changes appear in the student's Գործողություններ history under the rule's name.
- The automations that exist today move into this tab as rules (see Migration), and their fixed switches leave
  Ծանուցումներ.

## Non-goals (first version)

- No starter / example rules. The list starts empty apart from the migrated live behaviour.
- No branching, delays ("3 days after…"), OR-conditions, or rules that trigger other rules.
- No triggers or actions beyond the catalog below; new ones are added when the owner asks.

## Anti-goals (a failure even if it "works")

- A rule must never block, slow noticeably, or roll back the user's own save. A failing rule is logged, the save
  stands.
- No silent changes: every change a rule makes is traceable to that rule (run history + activity log).
- No double sending: a scheduled rule runs once per slot even across restarts; emails keep the outbox's retry
  logic and are not re-queued by a retry of the rule.
- No guessing discounts from Կարգավիճակ (real data contradicts it: some «Աշխատակցի երեխա» pay full price).

## Approaches considered

- **A — run rules right after the change (chosen by the owner).** Every write already goes through one place
  (`service.call` → one transaction, `log()` records the action with old/new values). Events are collected during
  the transaction and the rules run right after it commits. Immediate, builds on the existing history log.
- B — a timer reads new history entries every ~30 s and runs rules then. Fully decoupled, but the old fee is
  visible (and payable) for up to half a minute.
- C — fixed automation types, each its own small form (like today's Ծանուցումներ switches). Simpler, but not
  combinable, which is the point of the request.

## How it works

### Storage (database, so every computer sees the same rules)

- `automations`: `id, name, enabled, trigger (JSON), conditions (JSON), actions (JSON), created_by, created_at,
  updated_at, schedule_state (JSON: last slot run, for scheduled triggers)`.
- `automation_runs`: `id, automation_id, at, student_id, status ('done' | 'skipped' | 'failed'), detail (JSON:
  what each action did, or the error)`. Kept for 12 months.

### Running — for every user on every computer

Rules apply to every save, whichever computer or user makes it. Other computers don't save anything locally:
every call goes to the main computer's service (`electron/main.js` forwards it in client mode), so the engine
sits there and sees all saves. Scheduled rules are fired by the main computer's clock only, so they never run
twice (once per computer).

1. `log()` also pushes an **event** `{ action, studentId, meta }` to a pending list for the current call (the
   same pattern as `actionNotes` / `sendActionNotes`). On ROLLBACK the list is cleared.
2. After COMMIT (next to `sendActionNotes()`), the engine maps events to triggers, loads enabled rules for them,
   checks conditions against fresh data, and runs each matching rule **in its own transaction**. A thrown error
   rolls back only that rule and is written to `automation_runs` as failed.
3. The rule's writes use a context `{ user: 'Ավտոմատացում · <rule name>', automation: true, quiet: true }`:
   they show in the activity log under the rule's name, are not sent as users' Telegram action notes, and their
   events are **not** fed back to the engine (no chains, no loops).
4. Then `onWrite()` as today, so other computers refresh.
5. Scheduled triggers: the existing per-minute timer in `electron/notify.js` calls `service.automations.tick()`.
   A rule runs when its slot time has passed and `schedule_state` shows the slot not done yet (if the app was off
   at 20:00 it runs once when started later the same day — today's summary behaviour). The slot is stored in the
   same transaction as the run.

### Trigger catalog (v1)

| Trigger | Fires on | Gives conditions |
|---|---|---|
| Student created | `student.created` | the student |
| Group changed | `student.updated` with `group_id` in changes, and transfers between groups | student, old group, new group |
| Status changed | `status` in changes, termination | student, old / new status |
| Կարգավիճակ changed | `category` in changes | student, old / new Կարգավիճակ |
| Payment received | `charge.paid`, `charge.created_paid` (one run per payment action, all its charges together) | student, charges, total, method |
| Schedule | daily at HH:MM · weekly on a weekday at HH:MM · monthly on day N at HH:MM | none (no student) |

### Conditions (all must match)

On the student: group is / is not (one or more groups), group is / is not championship, Կարգավիճակ is / is not
(list, including «Առանց կարգավիճակ»), status is / is not, monthly fee =, <, >. For group change: old group and new
group each with the same group tests. For payment: total =, <, >; method is; contains a monthly fee / a product.

### Action catalog (v1)

| Action | Notes |
|---|---|
| Set monthly fee | Either a fixed amount, or **new group's price keeping the student's discount**: `new = round500(groupPrice(new) × currentFee / groupPrice(old))`. 0 stays 0. «Ըստ հրամանի» students are skipped (fee set by an order) and the run says so; other actions of the rule still run. Unpaid charges from the current month on are updated the same way a manual fee edit does today (`students.save` path). |
| Set Կարգավիճակ | One of the categories or none. |
| Add a note | Text with placeholders (`{student}`, `{oldGroup}`, `{newGroup}`, `{oldFee}`, `{newFee}`, `{date}` …). Author shown as the rule. |
| Send email | To the parent and/or fixed addresses. Subject + body with the placeholders the trigger provides. Through the outbox (retries as today). Needs email set up in Ծանուցումներ; otherwise the run fails with that reason. |
| Send Telegram | To the chats set up in Ծանուցումներ; text with placeholders. |
| Send summary | The existing daily / monthly summary text (`summaryText`) by Telegram and/or email. |
| Send payment reminders | The existing overdue reminder emails (`remindOverdue`, skipping students reminded this month). |
| Email a report | One of the Հաշվետվություններ reports as an Excel attachment, for a relative period (yesterday · last 7 days · this month · last month), to fixed addresses. |
| Add a debt | Amount, month (this / next), note — the same as «Ավելացնել պարտք». |

Actions that need a student are only offered for student triggers; schedule rules get the club-wide ones.

### Migration of today's automations (once, on upgrade, on the host)

Each one that is **turned on** in `config.notify` becomes an enabled rule with the same behaviour and text
(the current template copied into the rule): daily summary (schedule daily at its time), monthly summary
(monthly, day 1), automatic reminders (monthly, day N), receipt email to the parent (payment received → send
email to parent), Telegram payment alert (payment received → send Telegram). Ones that are off are not created
(that would be templates). The switches leave Ծանուցումներ; it keeps the email and Telegram connections, the
outbox, the users' Telegram action notes and the manual «send reminders» button.

### Screen — Կարգավորումներ → Ավտոմատացումներ

New tab after Մատյան, permission `settings.automations` (new in `permissions.json`, admins have it).

```
Ավտոմատացումներ                                              [+ Նոր ավտոմատացում]
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● On  Առաջնության խումբ → 35 000      Երբ՝ խումբը փոխվել է · 2 պայման · 2 գործողություն │
│       Վերջին անգամ՝ 26/11/2026 14:02 · 7 անգամ           [Պատմություն] [Խմբագրել] [🗑] │
└──────────────────────────────────────────────────────────────────────────────┘
```

Editor (modal): Name · **Երբ** (trigger + its settings) · **Եթե** (condition rows, add / remove) · **Ապա**
(action rows, add / remove; each with its fields and a placeholder hint) · Save. Pattern follows the existing
forms (Field, Segmented, selects). History: a table of runs (date, student link, done / skipped / failed, detail).

## Decided by the owner

- Approach A. Lives in Settings after Մատյան. No templates. Move existing automations here.
- Championship example: the discount is kept (17 500 for a half-price student).

## Calls made by me (check while reading)

- Discount kept by ratio to the old group's price, rounded to 500; «Ըստ հրամանի» skipped with a logged reason.
- Only currently-enabled automations are migrated.
- No rule chaining; one transaction per rule; run history kept 12 months.
- Overdue-charge and absence triggers are left out of v1 (owner adds when needed).
- «Set monthly fee» uses the fee from before the save. If the user changed the fee in the same save, the user's
  fee wins and the action is skipped («fee changed by hand»). A student moving from no group (no old price) is
  skipped the same way.
- The person whose save started a rule sees a short toast of what it did («Ավտոմատացում "…"՝ ամսավճարը 17 500»):
  the call's result carries a list of the rules that ran.

## Left to the builder

- Exact table / column names, JSON shapes, and the editor's component split.
- **Email a report** needs the reports' column definitions (today `sheetOf` in `src/components/Reports.jsx`, React
  side, using the translations) available in the main process. Move them to one module both sides use; the
  builder picks how (it must ship in the package: `electron/**` and `dist/**` only). Email attachments are new:
  the outbox needs to carry a file.
- Placeholder list per trigger, Armenian and English texts in `src/locales.js` (and `electron/activityLabels.js`
  for the rule's history lines).
- Tests: the QA pass (qa-tester agent) before `npm run dist`.
