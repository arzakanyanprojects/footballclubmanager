# Ավտոմատացումներ (Automations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A When → If → Then rules engine in Կարգավորումներ → Ավտոմատացումներ that runs on every save (any computer) and on a schedule, replacing today's fixed automations in Ծանուցումներ.

**Architecture:** `service.call` already wraps every write in one transaction. Write paths emit typed events into a per-call list; after COMMIT the engine (`electron/automations.js`) runs each matching enabled rule in its own transaction and records a run. Scheduled rules run from the existing per-minute timer in `electron/notify.js`. Rules and runs live in SQLite.

**Tech Stack:** Electron 45 main (CommonJS, `node:sqlite`), React 19 + Vite renderer, exceljs, nodemailer. Tests: `node --test` against a real temp database (the service runs under plain Node — verified).

**Spec:** `docs/superpowers/specs/2026-11-27-automations-design.md`

## Global Constraints

- Rules apply to every save from every computer; scheduled rules fire from the main computer's clock only.
- A failing rule never blocks or rolls back the user's save; it is logged as `failed`.
- A rule's own writes never trigger rules (no chaining).
- No starter / example rules; only currently-enabled notify automations are migrated.
- Rule changes appear in the activity log as user `Ավտոմատացում · <rule name>`.
- Keep-discount fee: `round500(currentFee × newPrice / oldPrice)`; 0 stays 0; `category = 'order'` skipped («fee set by order»); fee changed by hand in the same save → skipped; no old group / old price 0 → skipped.
- Run history kept 12 months.
- New permission `settings.automations` (admins have it). Tab after Մատյան.
- All user-facing text in `src/locales.js` (hy + en); Armenian texts the main process needs in `electron/activityLabels.js` / `electron/reportLabels.js`.
- Comment style: short English comments explaining why, like the existing code. No new dependencies.
- QA (qa-tester agent) passes before any `npm run dist`.
- The owner decides about commits: "Commit" steps run only once they have agreed to commits for this work (then on a
  branch, not `main`); otherwise skip them and leave the changes in the working tree.

## Review Focus

- A group change and a fee change in the same save (user typed 35 000 and moved the group) → user's fee kept, run `skipped`.
- Email not set up / no parent email → email action `failed` with a clear reason; other actions of the rule still done.
- App closed at the scheduled time and opened later that day → rule runs exactly once; opened the next day → yesterday's slot is not run.
- A rule edited or deleted while it has runs → history still readable (runs keep the rule name).
- Payment of several months in one action → one run, `{total}` is the sum, `{items}` lists each month.

---

## File Structure

- Create `electron/automations.js` — engine: rule validation, condition matching, actions, schedule slots, run log, CRUD methods, notify migration. Pure helpers exported for tests.
- Modify `electron/db.js` — migration: `automations`, `automation_runs`, outbox `attachment` column.
- Modify `electron/service.js` — event emission, engine wiring after COMMIT, `applyFee` extraction, `notifyPaid` without the fixed switches, `outbox` API additions.
- Modify `electron/auth.js`, `electron/permissions.json` — `settings.automations`.
- Modify `electron/notify.js` — tick automations, drop fixed daily/monthly/reminder schedule, email attachments.
- Modify `electron/main.js` — migration call on host start, report attachment builder.
- Create `electron/reportSheets.mjs` — report columns (moved from `Reports.jsx`), shared by renderer and main. Create `electron/reportLabels.js` — Armenian labels for main.
- Create `src/components/Automations.jsx` — list, editor, history. Modify `src/pages/Settings.jsx`, `src/components/Notify.jsx`, `src/components/Reports.jsx`, `src/lib.js` (toast of rule results), `src/locales.js`.
- Create `tests/helpers.js`, `tests/automations.*.test.js`. Modify `package.json` (`"test": "node --test tests/"`).

## Shared shapes (all tasks use these exact names)

```js
// Rule (automations row; trigger/conditions/actions stored as JSON text)
{ id, name, enabled: 0|1,
  trigger: { type: 'student.created'|'student.groupChanged'|'student.statusChanged'|'student.categoryChanged'
                  |'payment.received'|'schedule',
             every?: 'daily'|'weekly'|'monthly', time?: 'HH:MM', weekday?: 0..6, day?: 1..28 },
  conditions: [{ field, op, value }],
  actions: [{ type, ...fields }] }

// condition fields: 'group' | 'group.championship' | 'oldGroup' | 'oldGroup.championship' | 'newGroup'
//   | 'newGroup.championship' | 'category' | 'oldCategory' | 'newCategory' | 'status' | 'oldStatus' | 'newStatus'
//   | 'fee' | 'payment.total' | 'payment.method' | 'payment.hasMonthly'
// ops: 'is' | 'isNot' (value scalar; group fields take a group id; category '' = none) | 'in' | 'notIn' (array)
//   | 'eq' | 'lt' | 'gt' (numbers); championship / hasMonthly take value true|false with 'is'.

// actions:
{ type: 'setFee', mode: 'fixed'|'keepDiscount', amount? }
{ type: 'setCategory', value }                       // a CATEGORIES key or ''
{ type: 'addNote', text }
{ type: 'sendEmail', toParent: bool, to: 'a@x, b@y', subject, body }
{ type: 'sendTelegram', text }
{ type: 'sendSummary', kind: 'daily'|'monthly', telegram: bool, emails: 'a@x' }
{ type: 'sendReminders' }
{ type: 'emailReport', report, range: 'yesterday'|'last7'|'thisMonth'|'lastMonth', to }
{ type: 'addDebt', amount, month: 'this'|'next', note }

// Event (emitted by service write paths, consumed by the engine)
{ type, studentId?, before?: { group_id, status, category, monthly_fee }, after?: { …same },
  feeByHand?: bool, payment?: { chargeIds: number[], total: number, method: string } }

// Run (automation_runs row)
{ id, automation_id, rule_name, at, student_id, status: 'done'|'skipped'|'failed', detail: [{ action, status, text }] }
```

Placeholders filled by `fill()` (existing in `service.js`): `{student} {parent} {club} {date} {group} {oldGroup}
{newGroup} {oldFee} {newFee} {oldStatus} {newStatus} {oldCategory} {newCategory} {total} {method} {items}`.

---

### Task 1: Test harness and storage

**Files:**
- Create: `tests/helpers.js`, `tests/automations.storage.test.js`
- Modify: `electron/db.js` (append one migration), `package.json` (scripts.test)

**Interfaces:**
- Produces: `makeService(notifyCfg = {}) -> { service, db, dir }` (temp DB via `openDatabase`, `createService(db, { getNotify: () => notifyCfg })`); `seed(service) -> { regular, champ, studentId }` creating groups «A» (30 000, championship 0) and «C» (35 000, championship 1) and one active student in «A» with fee 30 000. Tables `automations(id, name, enabled, trigger, conditions, actions, schedule_state, created_by, created_at, updated_at)`, `automation_runs(id, automation_id, rule_name, at, student_id, status, detail)`, `outbox.attachment TEXT`.

- [ ] **Step 1:** Test `storage: migration creates automations tables` — after `makeService()`, `PRAGMA table_info(automations)` includes `trigger`, `schedule_state`; `automation_runs` includes `rule_name`; `outbox` includes `attachment`.
- [ ] **Step 2:** Run `npm test` → FAIL (no tables).
- [ ] **Step 3:** Add the migration (SQL string entry at the end of `MIGRATIONS`), the helpers, and `"test": "node --test tests/"`.
- [ ] **Step 4:** Run `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): storage and test harness`.

### Task 2: Rule CRUD, validation, permission

**Files:**
- Create: `electron/automations.js`, `tests/automations.crud.test.js`
- Modify: `electron/service.js` (merge `automations.methods` into `methods`), `electron/auth.js` (method rules), `electron/permissions.json` (`settings` section gets `automations`), `src/locales.js` (`perm.settings.automations`, `.hint`)

**Interfaces:**
- Produces: `createAutomations({ one, all, run, db }, deps) -> { methods, handle, tick, migrateNotify }` (later tasks fill `handle`/`tick`/`migrateNotify`); `validateRule(p) -> rule` throwing `AppError('AUTOMATION_INVALID', { field })`. Methods: `automations.list() -> Rule[]` (with `runs_count`, `last_run_at`), `automations.save(rule) -> { id }`, `automations.delete({ id })` (runs kept), `automations.runs({ id?, limit = 200 }) -> Run[]`. All four need `settings.automations`.

- [ ] **Step 1:** Tests: `crud: save and list round-trips trigger, conditions, actions`; `crud: rejects unknown trigger type / action type / setFee without mode`; `crud: delete keeps runs`; `crud: non-admin without settings.automations gets FORBIDDEN` (create a user via `users.save`, sign in via `auth.login`, call with its token).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Unknown condition fields / ops are rejected too; `name` required (`NAME_REQUIRED`).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): rules CRUD and permission`.

### Task 3: Events and the engine run loop

**Files:**
- Modify: `electron/service.js` (`emit`, pending list next to `actionNotes`, call `automations.handle` after COMMIT, return runs), `electron/automations.js`
- Test: `tests/automations.engine.test.js`

**Interfaces:**
- Consumes: Task 2 `createAutomations`.
- Produces: `emit(event)` inside service (no-op when `ctx.automation`); emitted from `students.save` (create → `student.created`; update → one event per changed field among `group_id`→`student.groupChanged`, `status`→`student.statusChanged`, `category`→`student.categoryChanged`, with `before`/`after` and `feeByHand = before.monthly_fee !== after.monthly_fee`), `students.terminate` (`student.statusChanged`), `notifyPaid` (`payment.received` with `payment`). `handle(events, ctx) -> [{ ruleId, name, status, summary }]`; `call()` returns `{ ok, result, automations }` when non-empty. Each rule: `BEGIN IMMEDIATE` … `COMMIT`, on throw `ROLLBACK` then insert a `failed` run outside it. Rule ctx: `{ user: 'Ավտոմատացում · ' + name, automation: true, quiet: true }`.

- [ ] **Step 1:** Tests (using an `addNote` action; Task 5 adds the rest — implement `addNote` here as the first action): `engine: groupChanged rule adds a note when the group changes`; `engine: disabled rule does nothing`; `engine: rule for statusChanged ignores a group change`; `engine: failing action → save stands, run failed` (force with an action whose handler throws, e.g. `addNote` with a stubbed dependency via `createAutomations` deps); `engine: rule writes do not trigger rules` (rule A on categoryChanged sets category; rule B on categoryChanged adds note → B runs once, only for the user's change); `engine: call result carries automations summary`; `engine: rule note shows in student history under the rule name`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Events are cleared on ROLLBACK like `actionNotes`. `onWrite` already fires after the call.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): event emission and run loop`.

### Task 4: Conditions

**Files:**
- Modify: `electron/automations.js` — `factsFor(event) -> facts`, `matches(conditions, facts) -> boolean` (exported)
- Test: `tests/automations.conditions.test.js`

- [ ] **Step 1:** Unit tests of `matches` with hand-built facts: championship true/false; `in` / `notIn` group lists; category `''` matches no category; `fee lt 20000`; `payment.total gt 0`; `payment.hasMonthly is true`; empty condition list matches; unknown field → false (never throws). Integration: `conditions: championship example matches only regular→championship moves`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Facts come from fresh rows at run time (group rows for old/new group ids).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): conditions`.

### Task 5: Student and message actions

**Files:**
- Modify: `electron/service.js` — extract `applyFee(studentId, fee, ctx)` from the fee branch of `students.save` (updates the row, re-prices unpaid monthly charges from this month, logs `student.updated` with the fee change) and use it in both places; pass deps to `createAutomations`.
- Modify: `electron/automations.js` — actions `setFee`, `setCategory`, `sendEmail`, `sendTelegram`, `addDebt`; exported `keepDiscountFee(currentFee, oldPrice, newPrice) -> number | null` (null = cannot compute).
- Test: `tests/automations.actions.test.js`

**Interfaces:**
- Consumes: service `enqueue`, `telegramChats`, `emailOn`, `studentVars`, `fill`, `methods['charges.create']` (debt: `{ studentId, kind: 'monthly'|'other', … }` exactly as `DebtModal` builds it — monthly if the month has no fee charge yet, else `other` with `description: '<month> · <note>'`).
- Each action returns `{ status: 'done'|'skipped'|'failed', text }`; the run's status is `failed` if any failed, else `done` if any done, else `skipped`.

- [ ] **Step 1:** Tests: `keepDiscountFee(15000, 30000, 35000) === 17500`, `(30000, 30000, 35000) === 35000`, `(0, 30000, 35000) === 0`, `(20000, 30000, 35000) === 23500` (round500), `(30000, 0, 35000) === null`; integration `actions: championship example` — half-price student moved A→C gets fee 17 500, this month's unpaid charge becomes 17 500, note text filled; `actions: category order is skipped with reason, note still added`; `actions: fee typed by hand in same save is kept`; `actions: sendEmail without email setup → failed «email is not set up»`; `actions: sendEmail toParent queues outbox row with filled subject`; `actions: sendTelegram queues one row per chat`; `actions: addDebt creates an unpaid charge`; `actions: setCategory changes category and is not re-triggered`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): student and message actions`.

### Task 6: Scheduled rules, summaries, reminders

**Files:**
- Modify: `electron/automations.js` — `slotKey(trigger, now: Date) -> string | null` (exported: `'2026-11-27'` daily, `'2026-W48'` weekly, `'2026-11'` monthly, `null` before the slot time / wrong weekday / before day N); `tick(now) -> runs`; actions `sendSummary`, `sendReminders`.
- Modify: `electron/notify.js` — `schedule()` calls `service.automations.tick(new Date())`; remove the fixed daily / monthly / reminders blocks.
- Modify: `electron/service.js` — expose `automations: { tick, migrateNotify }` on the returned object.
- Test: `tests/automations.schedule.test.js`

**Interfaces:**
- `schedule_state` JSON `{ slot }`; a rule runs when `slotKey(...)` is non-null and differs from `slot`; the new slot is saved in the rule's transaction. Monthly summary action sends the previous month (as today).

- [ ] **Step 1:** Tests: `slotKey daily 20:00` → null at 19:59, `'2026-11-27'` at 20:05 and at 23:00; weekly Monday 09:00 null on Sunday; monthly day 20 null on the 19th; `tick runs once per slot` (two ticks at 20:05 and 20:06 → one run); `tick next day runs again`; `sendSummary queues the daily summary to Telegram chats and emails`; `sendReminders skips students reminded this month`; `tick prunes runs older than 12 months` (a run dated 13 months ago is gone, one from 11 months ago stays — pruning happens at most once per day).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): scheduled rules`.

### Task 7: Migrate today's automations

**Files:**
- Modify: `electron/automations.js` — `migrateNotify(cfg) -> string[]` (names created)
- Modify: `electron/service.js` — `notifyPaid` no longer reads `cfg.receipts` / `cfg.paymentAlerts` (it only emits the event)
- Modify: `electron/main.js` — on host start after the service exists: if `!config.notify.automationsMigrated`, call `migrateNotify(config.notify)`, then set `receipts/paymentAlerts/daily.enabled/monthly.enabled/reminders.auto` to false and `automationsMigrated: true`, save config.
- Test: `tests/automations.migrate.test.js`

**Interfaces:**
- Created rules (only for switches that are on): «Օրական ամփոփում» (schedule daily at `daily.time` → `sendSummary daily`, telegram true, emails `summaryEmails`), «Ամսական ամփոփում» (monthly day 1 00:00 → `sendSummary monthly`), «Պարտքի հիշեցումներ» (monthly day `reminders.day` 09:00 → `sendReminders`), «Անդորրագիր ծնողին» (payment.received → `sendEmail` toParent with the current receipt template), «Վճարման ծանուցում Telegram-ով» (payment.received → `sendTelegram` with today's alert text as placeholders).

- [ ] **Step 1:** Tests: `migrate: only enabled switches become rules`; `migrate: receipt rule sends the same email text as before for a payment`; `migrate: second call creates nothing` (main's flag; also `migrateNotify` skips names that already exist).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(automations): move notify automations into rules`.

### Task 8: Email a report

**Files:**
- Create: `electron/reportSheets.mjs` — `sheetOf(kind, rows, t, club)` and its helpers moved verbatim from `src/components/Reports.jsx` (ESM, no React; `monthName` passed in via `t`-based helper inside); `REPORT_KINDS` = the `sheetOf` kinds.
- Create: `electron/reportLabels.js` — Armenian strings for the keys `sheetOf` uses, plus month names, and `t(key, vars)`.
- Modify: `src/components/Reports.jsx` — import `sheetOf` from `../../electron/reportSheets.mjs`.
- Modify: `electron/automations.js` — `emailReport` queues one outbox email per address with `attachment = JSON { report, from, to, period }` (range resolved at run time); `electron/notify.js` — `sendEmail` takes `attachments`; `sendPending` builds it via `getAttachment(m)` passed from main; `electron/main.js` — `getAttachment` = `reports.sheet` rows → `sheetOf` → `buildTable` buffer, file name `<title> <period>.xlsx`.
- Test: `tests/automations.report.test.js`

- [ ] **Step 1:** Tests: `report: emailReport lastMonth queues spec with first/last day of previous month`; `report: attachment builds an xlsx whose title row contains the report name` (call the builder with a seeded debt, read back with exceljs).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Check `npm run build` still bundles `Reports.jsx` (Vite imports the `.mjs` from outside `src`).
- [ ] **Step 4:** `npm test` → PASS and `npx vite build` → `✓ built`.
- [ ] **Step 5:** Commit `feat(automations): email a report as Excel`.

### Task 9: The Ավտոմատացումներ screen

**Files:**
- Create: `src/components/Automations.jsx` — `AutomationsSettings` (list with on/off toggle, summary line, last run, runs count; New / Edit / Delete / History), `AutomationEditor` (Name · Երբ · Եթե · Ապա, add/remove rows, placeholder hint per trigger; offers only student actions for student triggers and only club-wide actions for schedule), `AutomationRuns` (table: date, rule, student link, status badge, detail).
- Modify: `src/pages/Settings.jsx` — tab `{ id: 'automations', icon: Workflow }` after `activity`, shown with `settings.automations`.
- Modify: `src/components/Notify.jsx` — remove the receipts / payment alerts / daily / monthly / auto-reminders cards; keep email, Telegram, outbox, watched users, manual reminders; add one line pointing to Ավտոմատացումներ.
- Modify: `src/lib.js` (`rpc`) — when a response has `automations`, show a toast per rule: `«{name}»՝ {summary}`.
- Modify: `src/locales.js` — all `auto.*` texts, hy + en.

- [ ] **Step 1:** `npx vite build` → `✓ built`.
- [ ] **Step 2:** On a data copy (qa-tester recipe: `FC_USER_DATA`, `FC_EXPORT_DIR`, `add-admin.js`, `cdp.mjs`): create the championship rule in the editor, move a half-price student from a regular to a championship group, check fee 17 500, the note, the toast, and the run in History; screenshot the list and the editor.
- [ ] **Step 3:** Commit `feat(automations): settings screen`.

### Task 10: Final check

- [ ] **Step 1:** `npm test` → all pass; `npx vite build` → `✓ built`.
- [ ] **Step 2:** Run the qa-tester agent (full QA from source) including the automations area; fix FAILs.
- [ ] **Step 3:** Report to the owner; build the installer only on their go-ahead.
