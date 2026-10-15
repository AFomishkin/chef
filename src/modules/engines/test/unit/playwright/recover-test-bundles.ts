import * as path from 'node:path';
import * as fs from 'node:fs';

function canonicalPath(file: string): string
{
	try { return fs.realpathSync.native(file); }
	catch { return path.normalize(file); }
}

export function recoveryError(error: unknown): Error
{
	if (error instanceof Error) return error;
	if (error && typeof error === 'object' && 'message' in error)
		return Object.assign(new Error(String(error.message)), error);
	return new Error(String(error));
}

export type BundleFailure = { files: string[]; error: Error };
export type RecoveredBundles<T> = {
	bundles: Array<{ files: string[]; bundle: T }>;
	failures: BundleFailure[];
	recovery: RecoveryReport;
};

// Trust only structured, absolute source locations. An importer or a basename in
// an error message is not proof that this entry caused the failure.
function failedEntry(error: unknown, files: string[]): string | undefined
{
	if (!error || typeof error !== 'object')
	{
		return undefined;
	}
	const diagnostic = error as { id?: unknown; loc?: { file?: unknown } };
	const locations = [diagnostic.id, diagnostic.loc?.file].filter(
		(value): value is string => typeof value === 'string' && value.length > 0,
	);
	if (locations.length === 0 || locations.some((value) => !path.isAbsolute(value)))
	{
		return undefined;
	}
	const normalized = locations.map(canonicalPath);
	if (normalized.some((value) => value !== normalized[0]))
	{
		return undefined;
	}
	return files.find((file) => canonicalPath(file) === normalized[0]);
}

export type RecoveryMode = 'off' | 'exclude' | 'individual';
export type RecoveryOptions = {
	buildRecovery?: RecoveryMode;
	buildRecoveryRetries?: number;
	buildRecoveryTimeoutMs?: number;
};
export type RecoveryReport = {
	schemaVersion: 1;
	mode: RecoveryMode;
	maxRetries: number;
	timeoutMs: number;
	attempts: number;
	recoveryMs: number;
	stopReason: 'complete' | 'disabled' | 'ambiguous' | 'retry-limit' | 'time-limit';
	excludedFiles: string[];
	untestedFiles: string[];
	errors: Array<{ code: 'UNIT_BUILD_FAILED'; files: string[]; message: string }>;
};

export function recoveryOptions(options: RecoveryOptions = {})
{
	const mode = options.buildRecovery ?? 'individual';
	const maxRetries = options.buildRecoveryRetries ?? 3;
	const timeoutMs = options.buildRecoveryTimeoutMs ?? 120000;
	if (!['off', 'exclude', 'individual'].includes(mode)) throw new Error('Invalid build recovery mode');
	if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
		throw new Error('Build recovery retries must be a non-negative integer');
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
		throw new Error('Build recovery timeout must be a non-negative integer');
	return { mode, maxRetries, timeoutMs };
}

/** One initial build, then a shared retry/time budget for BOTH recovery paths.
 * Time starts after the first failed build. In-flight builds finish; no new build
 * starts once a budget is exhausted. Never retries executed tests. */
export async function recoverTestBundles<T>(
	files: string[],
	build: (files: string[]) => Promise<T>,
	options: RecoveryOptions = {},
	now: () => number = () => performance.now(),
): Promise<RecoveredBundles<T>>
{
	const policy = recoveryOptions(options);
	const report: RecoveryReport = {
		schemaVersion: 1,
		...policy,
		attempts: 0,
		recoveryMs: 0,
		stopReason: 'complete',
		excludedFiles: [],
		untestedFiles: [],
		errors: [],
	};
	const result: RecoveredBundles<T> = { bundles: [], failures: [], recovery: report };
	let remaining = [...new Set(files)];
	let recoveryStart: number | undefined;
	const finish = () =>
	{
		report.recoveryMs = recoveryStart === undefined ? 0 : Math.max(0, now() - recoveryStart);
		return result;
	};
	const failure = (entries: string[], error: unknown) =>
	{
		const normalized = recoveryError(error);
		result.failures.push({ files: [...entries], error: normalized });
		report.errors.push({ code: 'UNIT_BUILD_FAILED', files: [...entries], message: normalized.message });
	};
	const canBuild = (pending: string[]) =>
	{
		if (report.attempts === 0) return true;
		const reason =
			policy.mode === 'off'
				? 'disabled'
				: report.attempts - 1 >= policy.maxRetries
					? 'retry-limit'
					: now() - recoveryStart! >= policy.timeoutMs
						? 'time-limit'
						: undefined;
		if (!reason) return true;
		report.stopReason = reason;
		report.untestedFiles = [...pending];
		return false;
	};
	const attempt = async (entries: string[]) =>
	{
		report.attempts++;
		try
		{
			return await build(entries);
		}
		catch (error)
		{
			recoveryStart ??= now();
			throw error;
		}
	};
	while (remaining.length > 0)
	{
		if (!canBuild(remaining)) return finish();
		try
		{
			result.bundles.push({ files: remaining, bundle: await attempt(remaining) });
			return finish();
		}
		catch (error)
		{
			const entry = failedEntry(error, remaining);
			if (entry)
			{
				const excluded = entry ?? remaining[0];
				failure([excluded], error);
				report.excludedFiles.push(excluded);
				remaining = remaining.filter((file) => file !== excluded);
				continue;
			}
			// Preserve the combined failure even if isolation hides the incompatibility.
			failure(remaining, error);
			if (remaining.length === 1)
			{
				report.stopReason = policy.mode === 'off' ? 'disabled' : 'ambiguous';
				report.untestedFiles = [...remaining];
				return finish();
			}
			if (policy.mode !== 'individual')
			{
				report.stopReason = policy.mode === 'off' ? 'disabled' : 'ambiguous';
				report.untestedFiles = [...remaining];
				return finish();
			}
			for (let index = 0; index < remaining.length; index++)
			{
				if (!canBuild(remaining.slice(index))) return finish();
				const file = remaining[index];
				try
				{
					result.bundles.push({ files: [file], bundle: await attempt([file]) });
				}
				catch (singleError)
				{
					// A repeated unlocated plugin/config error does not prove this file is bad.
					const diagnostic = singleError as { id?: unknown; loc?: { file?: unknown } } | null;
					const located = [diagnostic?.id, diagnostic?.loc?.file].some(
						(value) => typeof value === 'string' && path.isAbsolute(value),
					);
					if (!located && result.bundles.length === 0
						&& recoveryError(singleError).message === recoveryError(error).message)
					{
						report.stopReason = 'ambiguous';
						report.untestedFiles = remaining.slice(index);
						return finish();
					}
					failure([file], singleError);
					report.excludedFiles.push(file);
				}
			}
			return finish();
		}
	}
	return finish();
}
