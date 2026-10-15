import { describe, it } from 'mocha';
import { assert } from 'chai';
import * as path from 'node:path';
import {
	recoverTestBundles,
	recoveryOptions,
} from '../../../../../src/modules/engines/test/unit/playwright/recover-test-bundles';

describe('bounded build recovery', () =>
{
	const files = Array.from({ length: 600 }, (_, i) => path.resolve(`${i}.test.ts`));
	it('stops after initial build plus three retries even when all 600 files are broken', async () =>
	{
		const r = await recoverTestBundles(files, async (entries) =>
		{
			throw Object.assign(new Error('parse'), { id: entries[0] });
		});
		assert.equal(r.recovery.attempts, 4);
		assert.equal(r.recovery.stopReason, 'retry-limit');
		assert.lengthOf(r.recovery.excludedFiles, 4);
		assert.deepEqual(r.recovery.untestedFiles, files.slice(4));
	});
	it('shares retries between identified exclusions and individual fallback', async () =>
	{
		let calls = 0;
		const r = await recoverTestBundles(files, async (entries) =>
		{
			calls++;
			if (calls === 1) throw Object.assign(new Error('parse'), { id: entries[0] });
			if (calls === 2) throw new Error('unknown');
			return 'ok';
		});
		assert.equal(calls, 4);
		assert.deepEqual(
			r.bundles.map((b) => b.files),
			[[files[1]], [files[2]]],
		);
		assert.deepEqual(r.recovery.untestedFiles, files.slice(3));
	});
	it('starts the timer after initial failure and never starts another build at the deadline', async () =>
	{
		let clock = 0;
		const r = await recoverTestBundles(
			files,
			async (entries) =>
			{
				clock += 120000;
				throw Object.assign(new Error('parse'), { id: entries[0] });
			},
			{},
			() => clock,
		);
		assert.equal(r.recovery.attempts, 2);
		assert.equal(r.recovery.stopReason, 'time-limit');
		assert.equal(r.recovery.recoveryMs, 120000);
	});
	it('keeps a successful in-flight build even if it finishes after the deadline', async () =>
	{
		let clock = 0,
			calls = 0;
		const r = await recoverTestBundles(
			files,
			async (entries) =>
			{
				if (++calls === 1) throw Object.assign(new Error('parse'), { id: entries[0] });
				clock = 200000;
				return 'ok';
			},
			{},
			() => clock,
		);
		assert.equal(r.recovery.stopReason, 'complete');
		assert.lengthOf(r.bundles, 1);
	});
	for (const options of [
		{ buildRecovery: 'off' as const },
		{ buildRecoveryRetries: 0 },
		{ buildRecoveryTimeoutMs: 0 },
	])
	{
		it(`does not retry for ${JSON.stringify(options)}`, async () =>
		{
			const r = await recoverTestBundles(
				files,
				async () =>
				{
					throw new Error('unknown');
				},
				options,
			);
			assert.equal(r.recovery.attempts, 1);
			assert.deepEqual(r.recovery.untestedFiles, files);
		});
	}
	it('exclude mode stops on ambiguity without attempting individual files', async () =>
	{
		const r = await recoverTestBundles(
			files,
			async () =>
			{
				throw new Error('shared');
			},
			{ buildRecovery: 'exclude' },
		);
		assert.equal(r.recovery.stopReason, 'ambiguous');
		assert.equal(r.recovery.attempts, 1);
	});
	it('validates programmatic limits before the first build', () =>
	{
		for (const n of [-1, NaN, Infinity, 1.5])
		{
			assert.throws(() => recoveryOptions({ buildRecoveryRetries: n }));
			assert.throws(() => recoveryOptions({ buildRecoveryTimeoutMs: n }));
		}
	});
});
