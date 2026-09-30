# Tapplet pilot runbook

This is the operator checklist for the August 2026 pilot. It covers Tapplet's
public API at
`https://classroom-widgets-studio-api.tinkertanker.workers.dev` and Tapplet
Studio on iPad. Run Cloudflare commands from `services/api`.
The production resources are in Wrangler's `tinkertanker` profile; keep
`--profile tinkertanker` on every production command below.

## Web operations panel

After migration `0011_admin_settings.sql` and the matching Worker release are
deployed, the operator panel is available at `/admin` on the API origin. It
shows stored content and 14-day activity, and can replace the active
OpenAI-compatible model, endpoint and API key. It can also mint workshop class
access codes with an activation limit and explicit expiry. A minted code is
shown once and only its SHA-256 hash is stored in D1, so copy it immediately to
a protected location. Provider keys are encrypted in D1 with AES-GCM and are
never returned to the browser. The panel reports persisted requests and
uploads; the provider contract does not currently expose token counts or spend.

Configure two independent Worker secrets before using it:

```bash
cd services/api
npx wrangler secret put ADMIN_TOKEN --profile tinkertanker
npx wrangler secret put ADMIN_ENCRYPTION_KEY --profile tinkertanker
```

Both values must be at least 32 characters. Keep `ADMIN_ENCRYPTION_KEY` stable:
rotating it makes any API key already encrypted in D1 unreadable. To rotate the
encryption key, first switch the panel back to environment defaults, rotate the
secret, then save the provider key again. The browser keeps `ADMIN_TOKEN` in
tab-scoped session storage and clears it on sign-out; never put either secret in
a URL, command argument, source file or support message.

## Production preflight and canonical examples

Before changing production, run these read-only checks and save their
non-secret output with the change record:

```bash
# Pending migration names must be understood before proceeding (do not apply yet).
cd services/api
npx wrangler d1 migrations list DB --remote --profile tinkertanker
# Confirm the active deployment is the reviewed version intended for this pilot.
npx wrangler deployments list --profile tinkertanker
# Inspect D1 size/capacity and current class-code activation headroom.
npx wrangler d1 info DB --profile tinkertanker
npx wrangler d1 execute DB --remote --profile tinkertanker --command \
  "SELECT label, maximum_uses, use_count, maximum_uses-use_count AS remaining, expires_at FROM class_codes ORDER BY label"
# Inspect today's aggregate shared request counters and stored D1 records.
npx wrangler d1 execute DB --remote --profile tinkertanker --command \
  "SELECT 'shared_request_counters_today' AS metric, COALESCE(SUM(request_count),0) AS value FROM generation_usage WHERE usage_date=date('now') UNION ALL SELECT 'uploads_today',COALESCE(SUM(upload_count),0) FROM asset_usage WHERE usage_date=date('now') UNION ALL SELECT 'upload_bytes_today',COALESCE(SUM(total_bytes),0) FROM asset_usage WHERE usage_date=date('now') UNION ALL SELECT 'artifacts',COUNT(*) FROM artifacts UNION ALL SELECT 'publications',COUNT(*) FROM publications"
cd ../..

# Exit nonzero on any missing, stale, wrong-revision or wrong-hash curated seed.
npm run examples:verify-production
```

Do not proceed unless remaining class activations, configured daily quotas and
D1/R2 account capacity cover the workshop plus a deliberate safety margin.
Confirm R2 storage/request headroom in the Cloudflare account dashboard; the D1
queries above do not measure R2 usage. `generation_usage` contains several
subject-prefixed counters, so its aggregate is not a generation-only metric.
Deployment parity means the active deployment ID/code is the reviewed release,
not merely that `/health` responds. The parity command requires exactly the 18
canonical IDs, expected `-seed` revisions and local source hashes, and reports
every extra remote curated ID as stale.

The production order is exact: **apply migrations → deploy the matching Worker
release → import canonical seeds → repeat the read-only parity/capacity checks
and live verification**. Never import against code with pending migrations.
Validate the source corpus, then execute the first three steps:

```bash
npm run examples:validate
cd services/api
npx wrangler d1 migrations apply DB --remote --profile tinkertanker
npx wrangler deploy --profile tinkertanker
cd ../..
printf "Seed import token: " >&2
IFS= read -rs STUDIO_SEED_IMPORT_TOKEN; printf "\n" >&2
export STUDIO_SEED_IMPORT_TOKEN
npm run examples:import -- \
  --endpoint https://classroom-widgets-studio-api.tinkertanker.workers.dev/v1/seeds
unset STUDIO_SEED_IMPORT_TOKEN
npm run examples:verify-production
```

The importer writes HTML to R2 before updating D1 and marks retrieval rows as
curated. It is an upsert, not reconciliation: it does **not** remove stale
remote curated IDs. Stale cleanup is a separate change requiring validation of
each exact ID and its D1/R2 references before a narrowly scoped deletion; never
turn the import into an automatic delete. Never print or commit the token.
Use the existing externally managed Worker secret. If deliberate rotation is
required, enter the same new value into `wrangler secret put` via its hidden
prompt and the local import prompt, record the resulting deployment version,
then unset it; do not rotate it as a routine import step.

## Roles and response times

- Name one Tinkertanker facilitator as the operator before each workshop.
- Check reports before the workshop, at the midpoint, at the end, and once each
  working day while any pilot publication remains live.
- Review reports concerning personal data, child safety or inappropriate
  content immediately; review every other report within one working day.
- Revoke first when safety is uncertain. A teacher can correct and republish
  after review.

## Advisory AI review

AI review is deliberately warning-only for this pre-launch teacher workshop.
If a prompt, generated tapplet, publication or image is flagged, Tapplet Studio
names the possible concern and preserves the teacher's work. The teacher may
edit or re-prompt, remove an image, or continue. A warning is not a factual
determination that content is unsafe, and it is not a publication approval.

Technical and security checks remain blocking: malformed or oversized input,
invalid executable HTML, external requests or unsupported capabilities,
authentication, ownership, quotas, storage and publication integrity. Do not
describe these failures as moderation warnings or add a warning-only bypass for
them.

## Before inviting teachers

**Important:** Before any class-code verification, trash the legacy `.studio-pilot-codes.txt` and any stale pre-cutover `.studio-smoke-token` from prior pilot runs. The new `.studio-smoke-token` created afterwards remains active and ignored.

1. Confirm `GET /health` returns 200.
2. Apply all D1 migrations before deploying Worker code that queries a newly
   introduced table. In particular, confirm that the complete migration set,
   including `0010_owner_token_versions.sql`, has been applied remotely with
   `npx wrangler d1 migrations apply DB --remote --profile tinkertanker`.
   Dropping `pilot_codes` only removes the old provisioning table; it does not
   revoke any device token already issued to a pilot iPad.
3. To revoke tokens for one iPad owner, use the per-owner token version rather
   than rotating the global signing secret. First identify the owner safely
   from a validated artifact or publication associated with that iPad: validate
   the exact artifact ID or publication slug, then use a read-only lookup on the
   matching owner-scoped record to obtain its `owner_hash`:

   ```sql
   SELECT owner_hash FROM artifacts WHERE id = 'VALIDATED_ARTIFACT_ID';
   SELECT owner_hash FROM publications WHERE slug = 'VALIDATED_PUBLICATION_SLUG';
   ```

   Do not accept an owner hash copied from an unvalidated request, log, or
   screenshot. Bump the validated hash with one atomic D1 upsert:

   ```sql
   INSERT INTO owner_token_versions(owner_hash, token_version)
   VALUES ('VALIDATED_OWNER_HASH', 1)
   ON CONFLICT(owner_hash) DO UPDATE
     SET token_version = owner_token_versions.token_version + 1;
   ```

   Run that statement as a single D1 execution after replacing the placeholder
   only with the hash obtained from the validated record. The iPad will then
   need to register again. If no artifact or publication can identify the iPad's
   owner, per-owner revocation is not possible; global
   `DEVICE_TOKEN_SIGNING_SECRET` rotation remains the last resort and invalidates
   every pilot iPad. Confirm the active provider credential (`AI_API_KEY`,
   `OPENCODE_API_KEY`, or `OPENROUTER_API_KEY`) is configured. Also confirm
   `OPENCODE_API_KEY` is configured for uploaded-image safety review. If
   `INFERENCE_TRANSPORT` is `tkslopper`, confirm `TKSLOPPER_SERVICE_CREDENTIAL`
   and the aliases instead (see
   [`TKSLOPPER_TRANSPORT.md`](TKSLOPPER_TRANSPORT.md)).
4. Provision one shared code for each class with an explicit reviewed expiry:
   `npm run class-access:provision -- 1234 30 2026-08-24T00:00:00.000Z`,
   replacing every example argument (including the expiry) with workshop
   values and having a second operator review the UTC expiry. Keep it valid only
   through setup, the workshop and a short contingency period. The activation
   limit must be 1 to 100. The generated code contains those four numbers followed by eight
   random letters. Its ignored `.studio-class-codes/1234.txt` file has
   owner-only permissions. Each successful iPad activation consumes one use;
   the code remains valid until it reaches the configured limit or expires. If
   Wrangler fails, retry the **identical command**: provisioning reuses the
   protected file only when class, limit and expiry all match, performs a
   convergent insert, verifies the matching remote metadata, and never prints
   the code or its hash. A mismatch requires deliberate rotation; do not delete
   the file merely to clear an error.
5. Provision class `0000` with a 100-use limit for automated live verification.
   Set `STUDIO_CLASS_ACCESS_CODE` to that code and run
   `npm run verify:live`, then immediately `unset STUDIO_CLASS_ACCESS_CODE`.
   Later runs reuse the ignored, owner-only `.studio-smoke-token` file without
   consuming another activation. The flow deliberately triggers and validates
   one warning-only prompt advisory without echoing its test marker, then
   completes image upload, publication, reporting, revocation and cleanup. An
   image review warning must not stop the flow; invalid files, ownership
   failures and other technical checks still must.
6. For external TestFlight or App Store review, place a still-valid multi-use
   workshop code in App Review notes. Verify it immediately before submission
   and keep it valid until review has completed; never put it in source control
   or public metadata.
7. Install the Release build on a physical A16 iPad. Complete the full flow for
   at least three representative tapplets, including a simulation: generate,
   revise, add a classroom image where appropriate, publish, and open each
   resulting URL on a separate device in Safari. Exercise one advisory warning
   and verify that the work remains available to edit, re-prompt, remove or
   continue. Across the three flows, test VoiceOver, portrait and landscape.
   Revoke every link and verify that the student sees the unavailable state.

## TestFlight release gate

The unsigned CI build is not a distribution check. Before uploading:

1. Confirm App Store Connect ownership for `sg.tinkertanker.Tapplet`, active
   agreements, the `PQ6U5ESLN2` team, and an automatic-distribution signing
   identity/profile on the release Mac.
2. Generate the project with XcodeGen 2.44.1, create a signed Release archive
   with Xcode 26, export with `ExportOptions.plist`, and run Xcode's Validate App
   action. Increment `CURRENT_PROJECT_VERSION` before any upload after build 1;
   automatic build-number management is intentionally disabled.
3. Have the release owner confirm the export-compliance determination behind
   `ITSAppUsesNonExemptEncryption = NO`: native first-party use is limited to
   Apple-provided HTTPS/Keychain and SHA-256 hashing, and no bundled code adds
   non-exempt encryption. If that scope is not accurate, remove the declaration
   and answer App Store Connect's encryption questions with the required
   documentation instead. This repository setting is not legal advice.
4. Reconcile App Store privacy labels with the checked-in privacy manifest and
   actual API behavior, complete Apple's current age-rating questionnaire, and
   provide beta review contact details, concise testing instructions, and a
   still-valid review class code. Do not put the code in public metadata.
5. Install the archived build on a physical iPad and repeat the workshop flow
   on the venue Wi-Fi. Keep the preinstalled, preactivated offline-example path
   as the class-day fallback; TestFlight review timing is not a workshop
   dependency.

If a class code must be replaced, preserve its protected provisioning file, or
the protected record made when it was minted in the panel, as the audit and
recovery record. Derive its hash locally without printing either value, verify
the exact row's label, limit, expiry and use count, and disable only that hash
before securely archiving the record and provisioning a replacement. Never
identify a row only by the non-unique label, and never paste class codes or
hashes into issues, commits, chat logs or screenshots.

## Review public content reports

List unreviewed reports with their tapplet metadata:

```sh
npx wrangler d1 execute DB --remote --profile tinkertanker --command "SELECT r.id, r.created_at, r.reason, r.publication_slug, p.title, p.expires_at, p.revoked_at FROM content_reports r JOIN publications p ON p.slug = r.publication_slug WHERE r.reviewed_at IS NULL ORDER BY r.created_at ASC"
```

Open the exact reported publication URL and assess only the reported tapplet.
Do not enter student information while testing it.

For an unsafe report, validate that the slug contains only letters, numbers,
`_` or `-`, then revoke that exact publication:

```sh
npx wrangler d1 execute DB --remote --profile tinkertanker --command "UPDATE publications SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE slug = 'VALIDATED_SLUG'"
```

Record the outcome against the exact report ID:

```sh
npx wrangler d1 execute DB --remote --profile tinkertanker --command "UPDATE content_reports SET reviewed_at = datetime('now'), resolution = 'widget-revoked' WHERE id = 'VALIDATED_REPORT_ID' AND reviewed_at IS NULL"
```

Use `no-action` only after checking the live tapplet, or `teacher-contacted` when
follow-up is still required. Reports are retained for 180 days and then removed
by the scheduled cleanup.

## Restore projects after reinstall or device replacement

The signed device credential is stored in Keychain and is eligible for an
encrypted-device-backup restore. With that credential, Tapplet Studio can list the
owner's remote artifacts and publications and re-download a selected project. If the
credential is unavailable, do not issue a replacement credential that assumes
ownership: ask the operator to identify the exact link, then revoke it directly
after validating the slug.

Local projects are stored as separate atomic files with backups. If Tapplet Studio
offers a conflict or recovered copy, keep both until the teacher confirms which
one is current.

## Incident and rollback

- To stop new AI generation while keeping student links available, remove or
  rotate the credential shown as active in the operations panel. If its source
  is **Admin override**, remove the stored key in `/admin` first; if its source
  is **Environment default**, remove or rotate `AI_API_KEY`,
  `OPENCODE_API_KEY`, or `OPENROUTER_API_KEY` as appropriate. Confirm a model
  request then fails closed. Stored HTML publications remain readable.
  Publication review outages are warning-only, so revoke affected links
  separately if new publishing must also stop.
- If `INFERENCE_TRANSPORT` is `tkslopper`, the admin override is inactive.
  Stop generation with the tkslopper kill switch or by revoking the service
  credential, or return to the direct providers by setting
  `INFERENCE_TRANSPORT=direct` and redeploying. See
  [`TKSLOPPER_TRANSPORT.md`](TKSLOPPER_TRANSPORT.md).
- To remove one unsafe tapplet, revoke only its validated slug as above.
- To roll back a bad Worker deployment, inspect the recent deployment list with
  `npx wrangler deployments list --profile tinkertanker`, then run
  `npx wrangler rollback KNOWN_GOOD_VERSION_ID --name classroom-widgets-studio-api --profile tinkertanker`
  only after validating the selected version. A Worker rollback does not undo
  D1 migrations or imported D1/R2 data, so the known-good Worker must remain
  schema-compatible or use a separately reviewed forward recovery. Re-run
  `/health` and the complete live flow.
- If public rendering itself is unsafe, disable the Worker deployment and tell
  facilitators that published links are temporarily unavailable. Do not purge
  D1 or R2 during incident response.

## End of pilot

1. Export the anonymised counts needed for evaluation; do not export teacher
   prompts or tapplet content unnecessarily.
2. Review every outstanding report.
3. Revoke the smoke-test publication if one remains.
4. Keep teacher publications until their displayed expiry unless a teacher asks
   for earlier deletion.
5. Rotate each class code before a later workshop and set a fresh activation
   limit for that class.
