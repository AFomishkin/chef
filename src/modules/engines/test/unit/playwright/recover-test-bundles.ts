import * as path from 'node:path';

export type BundleFailure = { files: string[]; error: Error };
export type RecoveredBundles<T> = {
	bundles: Array<{ files: string[]; bundle: T }>;
	failures: BundleFailure[];
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
	const locations = [diagnostic.id, diagnostic.loc?.file]
		.filter((value): value is string => typeof value === 'string' && value.length > 0);
	if (locations.length === 0 || locations.some((value) => !path.isAbsolute(value)))
	{
		return undefined;
	}
	const normalized = locations.map((value) => path.normalize(value));
	if (normalized.some((value) => value !== normalized[0]))
	{
		return undefined;
	}
	return files.find((file) => path.normalize(file) === normalized[0]);
}

/** Build before executing anything: remove proven bad entries, otherwise try each
 * remaining entry once. At most 2N builds; no retries of executed tests. */
export async function recoverTestBundles<T>(
	files: string[],
	build: (files: string[]) => Promise<T>,
): Promise<RecoveredBundles<T>>
{
	const result: RecoveredBundles<T> = { bundles: [], failures: [] };
	let remaining = [...new Set(files)];
	const failure = (entries: string[], error: unknown): void => {
		result.failures.push({
			files: entries,
			error: error instanceof Error ? error : new Error(String(error)),
		});
	};
	while (remaining.length > 0)
	{
		try
		{
			result.bundles.push({ files: remaining, bundle: await build(remaining) });
			return result;
		}
		catch (error)
		{
			const entry = failedEntry(error, remaining);
			if (entry || remaining.length === 1)
			{
				const excluded = entry ?? remaining[0];
				failure([excluded], error);
				remaining = remaining.filter((file) => file !== excluded);
				continue;
			}

			// Keep the combined-build failure even if every file builds separately:
			// isolation may hide a cross-file incompatibility, not fix it.
			failure(remaining, error);
			for (const file of remaining)
			{
				try
				{
					result.bundles.push({ files: [file], bundle: await build([file]) });
				}
				catch (singleError)
				{
					failure([file], singleError);
				}
			}
			return result;
		}
	}
	return result;
}
