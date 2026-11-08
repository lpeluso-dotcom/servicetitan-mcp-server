# Configuration and parity release

This release adds a documented configuration surface and reviewed tool manifests. New configuration writes default to disabled. Local contract and protocol tests are not live tenant validation.

## Configuration tools

| Object | Read tools | Write tools | Limits |
| --- | --- | --- | --- |
| Job types | list_job_types, get_job_type | create_job_type, update_job_type | Custom-field assignments use replacement semantics. No active/deactivate field is supported by this update contract. |
| Business units | list_business_units, get_business_unit | update_business_unit_metadata | Only application-scoped external metadata can be updated. Name, tax and ordinary settings are not writable through this endpoint. |
| Tag types | list_tag_types, get_tag_type | create_tag_type, update_tag_type | Detail lookup scans at most 20 pages of 200 records because ST has no tag-type GET-by-ID endpoint. |

Request schemas were retrieved from the ServiceTitan developer portal on 2026-11-08: `tenant-jpm-v2` and `tenant-settings-v2`. The resolved source schemas are pinned in `contracts/configuration-request-schemas.json`. Exposed fields are intentionally narrower: job-type external data and customFieldsUpdateMode are omitted; customFieldTypeIds uses the documented default replacement mode. List calls default to 50 records and cap pageSize at 200. Request arrays cap at 500 entries.

Writes require an authenticated admin role and `CONFIGURATION_WRITES_ENABLED="true"`; missing or false refuses even previews. Keep this off until integration validation. A preview reads the current record and returns current values, proposed fields and a 15-minute confirmation token. The token binds tenant, principal, requested changes and the current-record hash. Confirmation re-reads before consuming the token. A changed record requires a fresh preview. The upstream API has no conditional-update primitive, so a race after this check remains possible.

Every accepted write reads the object back and checks the requested fields. `verified:false` or `state:outcome-unknown` means inspect ServiceTitan and the operation status; do not automatically resubmit. Confirmation tokens are consumed once. Metadata previews model Replace/Merge and null-valued deletions; applicationGuid limits the visible metadata scope. Create tools do not promise safe automatic retries after a lost response.

## Integration canary and rollout

1. Select an integration tenant and dedicated test objects. Record the deployment revision, tenant, API scopes and object IDs in a private release record.
2. Deploy to integration with configuration writes disabled; check tools/list for admin, operational and OAuth identities. Operational/OAuth identities must not see configuration writes.
3. Enable the switch in integration. Preview and confirm one job-type create/update, tag-type create/update and business-unit metadata update. Re-read using an independent API/UI path. Do not create business records in production to substitute for this step.
4. Check stale-preview rejection, wrong-principal rejection, token replay rejection, readonly/lockdown, ignored-field mismatch and interrupted-response recovery. Preserve evidence of the final state.
5. Keep configuration writes disabled in production until the canary record is reviewed. Roll back by disabling the switch; READONLY=1 stops all token-confirmed writes and MCP_LOCKDOWN=true removes all write tools.

Technician assignment replacement is corrected and tested but remains outside the served catalog. It reads current assignments, adds only missing technicians, removes only obsolete technicians, and verifies the final set. It uses dispatch/v2 and jobAppointmentId. The operation is non-atomic; partial failures return completed steps and an unknown outcome without automatic rollback. A separate integration canary is required before registering it.

## Configuration snapshots and diffs

`configuration_snapshot` captures the three configuration sections with explicit completeness, timestamps and bounded pagination (at most 5 pages of 200 per section). It is not an atomic database snapshot or a full restore backup; it captures fields returned by default list requests, without application-scoped external metadata. `compare_configuration_snapshots` compares two returned snapshot objects and reports added, removed and changed records, including missing-versus-null fields. It rejects incomplete snapshots, duplicate IDs, different tenants or different section sets. No automatic apply/restore is provided.

## Tool manifest and ongoing parity

`contracts/tool-capabilities.json` records served names, write flags, roles, endpoint descriptors and input schemas. CI compares it to the actual registry. After an intentional contract change, run `npm run capabilities:update`, review the generated diff, then run the tests.

Compare two builds without tenant credentials:

```sh
node scripts/compare-capabilities.mjs path/to/first/tool-capabilities.json path/to/second/tool-capabilities.json
```

The report distinguishes missing names and differing shared contracts. It is not proof of runtime behavior; transport-specific adapters, business logic, output fields and live availability still need review. Keep the configuration factory, schema index, request schema snapshot, and assignment lifecycle tests aligned across distributions.

## Remaining expansion

This release covers job types, business-unit metadata and tag types. Dispatch configuration (zones, teams, skills, arrival windows and business hours), membership/recurring-service definitions, employee/custom-field configuration, configuration batches and further operational write workflows remain separate work. Only add a write when its documented API schema, permission, preview, failure recovery and read-back behavior are defined. Existing quarantined job/appointment/marketing writes still require their own canaries.

## Public authentication and profiles

Set `MCP_CONFIG_ADMIN_TOKEN` with `wrangler secret put MCP_CONFIG_ADMIN_TOKEN`. It must differ from `MCP_TOKEN`. This credential is restricted to the configuration-admin profile plus result-page and operation-status follow-ups. It does not grant arbitrary API access. Setting MCP_TOKEN_ROLE=admin still fails closed to readonly; OAuth remains readonly.

Optional `TOOL_PROFILES_JSON` maps authenticated principals to daily-operations, pricebook, reporting, investigation or configuration-admin. Example:

```json
{"mcp-token":"daily-operations","oauth:user@example.com":"reporting"}
```

Unmapped principals retain their role catalog. Profile selection never promotes a role. Invalid mappings fail closed. The dedicated configuration credential always uses configuration-admin, irrespective of mappings. Result pages enforce the source tool's current visibility as well as owner and role.

The public release adds equipment, service agreements, payment/AP-bill, call media metadata, lead/booking and purchase-order reads, plus estimate listing/detail reference evidence. It removes create_recurring_service because the published create endpoint is unsupported. Large result pages remain inline when fetched, avoiding recursive offloading; category trees can use up to 8 MiB of stored data, while ordinary results retain the 1 MiB ceiling.

## Adversarial review hardening

Confirmed configuration updates and assignment replacements now hold a shared database lease through the current-state read, mutation and read-back. A competing MCP write receives a retryable conflict before it reads or consumes its token. This excludes overlapping requests through this server; it cannot lock ServiceTitan UI edits or other integrations. Updates still reject records changed since preview. A lost response remains an unknown outcome and must be inspected before another preview.

Confirmation tokens lacking an authenticated ownership record are rejected; request a new preview after upgrading. Operation results respect the currently available tool profile. Configuration responses exceeding the requested page size are rejected rather than treated as complete snapshots.
