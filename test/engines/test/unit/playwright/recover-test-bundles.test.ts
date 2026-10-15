import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, it } from 'mocha';
import { assert } from 'chai';
import { rollup } from 'rollup';
import { recoverTestBundles } from '../../../../../src/modules/engines/test/unit/playwright/recover-test-bundles';
import { RollupBuildStrategy } from '../../../../../src/modules/engines/build/rollup/rollup-strategy';

describe('unit bundle recovery', () => {
	const a = path.resolve('first.test.js');
	const b = path.resolve('second.test.js');
	const c = path.resolve('third.test.js');

	it('keeps the fast path to one build', async () => {
		let calls = 0;
		const result = await recoverTestBundles([a, b], async (files) => {
			calls++;
			return files.join(',');
		});
		assert.equal(calls, 1);
		assert.lengthOf(result.bundles, 1);
		assert.isEmpty(result.failures);
	});

	it('removes identified entries successively and builds the healthy remainder together', async () => {
		const calls: string[][] = [];
		const result = await recoverTestBundles([a, b, c], async (files) => {
			calls.push([...files]);
			const bad = [b, c].find((file) => files.includes(file));
			if (bad) throw Object.assign(new Error('parse error'), { id: bad });
			return 'healthy';
		});
		assert.deepEqual(calls, [[a, b, c], [a, c], [a]]);
		assert.deepEqual(result.failures.map((f) => f.files), [[b], [c]]);
		assert.deepEqual(result.bundles[0].files, [a]);
	});

	for (const diagnostic of [
		{},
		{ id: path.resolve('shared.js') },
		{ id: path.basename(b) },
		{ id: a, loc: { file: b } },
	])
	{
		it(`falls back once per remaining file for ambiguous source ${JSON.stringify(diagnostic)}`, async () => {
			const calls: string[][] = [];
			const result = await recoverTestBundles([a, b], async (files) => {
				calls.push([...files]);
				if (files.length > 1 || files[0] === b)
				{
					throw Object.assign(new Error('failed'), diagnostic);
				}
				return 'healthy';
			});
			assert.deepEqual(calls, [[a, b], [a], [b]]);
			assert.deepEqual(result.bundles.map((group) => group.files), [[a]]);
			assert.lengthOf(result.failures, 2);
		});
	}

	it('keeps a combined-build error even when all individual builds succeed', async () => {
		const result = await recoverTestBundles([a, b], async (files) => {
			if (files.length > 1) throw new Error('cross-file conflict');
			return 'healthy';
		});
		assert.lengthOf(result.bundles, 2);
		assert.lengthOf(result.failures, 1);
	});

	it('falls back if an excluded entry is still imported by another test', async () => {
		const calls: string[][] = [];
		const result = await recoverTestBundles([a, b, c], async (files) => {
			calls.push([...files]);
			if (files.includes(a) || files.includes(b))
			{
				throw Object.assign(new Error('bad shared import'), { id: a });
			}
			return 'healthy';
		});
		assert.deepEqual(calls, [[a, b, c], [b, c], [b], [c]]);
		assert.deepEqual(result.bundles.map((group) => group.files), [[c]]);
		assert.lengthOf(result.failures, 3);
	});

	it('does not retry an empty or wholly broken set indefinitely', async () => {
		let calls = 0;
		const build = async (): Promise<string> => { calls++; throw new Error('broken'); };
		assert.isEmpty((await recoverTestBundles([], build)).bundles);
		assert.equal(calls, 0);
		assert.lengthOf((await recoverTestBundles([a], build)).failures, 1);
		assert.equal(calls, 1);
	});

	it('recovers a real Rollup parse failure without confusing identical basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-recovery-'));
		try
		{
			fs.mkdirSync(path.join(root, 'bad'));
			fs.mkdirSync(path.join(root, 'good'));
			const bad = path.join(root, 'bad', 'same.test.js');
			const good = path.join(root, 'good', 'same.test.js');
			fs.writeFileSync(bad, 'export const broken = ;');
			fs.writeFileSync(good, 'globalThis.healthy = true;');
			const result = await recoverTestBundles([bad, good], async (files) => {
				const bundle = await rollup({
					input: 'entry',
					plugins: [{
						name: 'entry',
						resolveId: (id) => id === 'entry' ? id : null,
						load: (id) => id === 'entry'
							? files.map((file) => `import ${JSON.stringify(file.replaceAll('\\', '/'))};`).join('\n')
							: null,
					}],
				});
				try { return (await bundle.generate({ format: 'iife' })).output[0].code; }
				finally { await bundle.close(); }
			});
			assert.deepEqual(result.failures.map((f) => f.files), [[bad]]);
			assert.lengthOf(result.bundles, 1);
			assert.include(result.bundles[0].bundle, 'healthy = true');
		}
		finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it('recovers the Flow annotation in a .ts file through the actual Chef build engine', async function() {
		this.timeout(30000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-flow-recovery-'));
		try
		{
			const bad = path.join(root, 'bad.test.ts');
			const good = path.join(root, 'good.test.ts');
			fs.writeFileSync(bad, `function mountInto(parent: HTMLElement, onDeletedBlock: ?(blockId: string) => void = null): Object { return {}; } globalThis.mountInto = mountInto;`);
			fs.writeFileSync(good, 'globalThis.healthy = true;');
			const engine = new RollupBuildStrategy();
			const result = await recoverTestBundles([bad, good], async (files) => {
				return engine.buildCode({
					code: files.map((file) => `import ${JSON.stringify(file.replaceAll('\\', '/'))};`).join('\n'),
					packageRoot: root, packageName: 'test.recovery', publicPath: '/', targets: [],
					namespace: 'BX.TestsBundle', typescript: true, sourcemap: true,
				});
			});
			assert.deepEqual(result.failures.map((f) => f.files), [[bad]]);
			assert.lengthOf(result.bundles, 1);
			assert.include(result.bundles[0].bundle.code, 'healthy');
			assert.isEmpty(result.bundles[0].bundle.errors);
		}
		finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
