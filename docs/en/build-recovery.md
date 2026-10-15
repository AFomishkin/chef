# Unit build recovery

`chef test unit <extension> --build-recovery individual --build-recovery-retries 3 --build-recovery-timeout-ms 120000`

Modes: `off` (one build), `exclude` (remove only proven failing input entries),
`individual` (also try remaining files separately on ambiguous errors; default).
All recovery paths share three additional builds and 120000 ms per target by default.
The clock starts after the first failed build. Zero disallows additional builds.
An in-flight build finishes even after the deadline; this is not a process timeout.
Successful bundles execute once. Assertion, browser and runtime failures do not trigger recovery.
Browsers share the same cached build plan; policy changes use a different cache key.

JSON `extensions[].details.unit.buildRecovery` (schemaVersion 1) contains mode,
maxRetries, timeoutMs, attempts, recoveryMs, stopReason, excludedFiles, untestedFiles,
and structured errors with code UNIT_BUILD_FAILED. Paths are relative to the package root.
Stop reasons: complete, disabled, ambiguous, retry-limit, time-limit.
Untested files are coverage loss, not failed assertions. A stopped plan adds one failed
synthetic result, retaining the original build errors and results of successful bundles.
The CLI help advertises the options with `protocol v1` so callers can detect support.

With `--debug` or `--cdp-port`, `individual` is restricted to `exclude`: an interactive
session has one bundle, browser and debugger handshake. An ambiguous build error
stops recovery and reports the remaining files as untested.

The retry budget also limits individual fallback. With three retries, an ambiguous
failure on 600 entries can try at most three individual entries, not all 600.
Increase the budget explicitly if that cost is acceptable. A repeated unlocated
error before any successful isolated build stops as `ambiguous`, without blaming
input files for a global plugin/configuration failure.

A browser or runtime error stops subsequent bundles; the run error names their
unexecuted files. Assertion failures still allow other bundles to run.
`complete` describes recovery, not test success: build failures remain errors.
