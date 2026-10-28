# Atomic native Codex connection

## What / why

Complete the native execution boundary needed by Autonomizer without pretending
subscription calls have API dollar/token ceilings. Joe ordered working activation.

## Approach

Add myosRunBoundedCodex in runtime/bounded-codex.js. Require exact task/account
references, a deadline, AbortSignal, durable reservation callback and synchronous
final guard. Reuse installed model/executable approval and isolated native text
execution. Bind request bytes, chosen model/effort and deadline to a SHA256 receipt.
Add opt-in signal and synchronous beforeSpawn to runCommand; cleanup remains
limited to its owned process group. Return validated ephemeral thread identity,
not a fabricated API response. No retry/fallback. Existing generic myosRun keeps
rejecting bounded API options. Autonomizer separately owns atomic call quotas.
Mapping unknown account cost to zero or weakening API accounting is rejected.

The image follow-through attaches one validated PNG through native `--image`,
verified in the installed native CLI help. Reuse the existing bounded PNG decoder
without its API-only model/pricing assertion. Limit inputs to 8 MiB and 2048 pixels
per dimension. Bind digest/dimensions into the launch receipt, copy into a private
read-only temporary file, recheck its inode and bytes before spawn, then remove only
that owned input. Image input does not enable tools, image generation or API fallback.
The temporary-path guard assumes a trusted same-principal host. Native CLI pathname
input cannot atomically exclude a hostile same-UID writer between the check and read.

## Acceptance criteria

- Reservation and final guard occur before spawn; refusal/cancellation launches none.
- Abort after spawn stops the owned group and cannot return successful output.
- Expiry, model/approval changes and invalid reservation fail closed.
- Successful output binds the exact task, input digest, reservation and native thread.
- Account cost remains null; API dollar/token ceilings are not silently accepted.
- Full suite and installed checks pass without inference or account changes.

## The check

Run Node24 test/bounded-codex.test.js and test/native-output-bound.test.js, then
the full package suite with its existing isolated OAuth and safe Node settings.
Review before governed integration, then replay from the installed checkout.

## Out of scope

No real account approval, paid overage, retries of UNKNOWN effects, journal resets,
public/customer release, protected bot changes or pilot success assertions.
