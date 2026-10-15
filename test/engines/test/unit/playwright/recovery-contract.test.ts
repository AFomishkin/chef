import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { assert } from 'chai';
import sinon from 'sinon';
import { PlaywrightUnitStrategy } from '../../../../../src/modules/engines/test/unit/playwright/playwright-unit-strategy';
import { PackageBuilder } from '../../../../../src/modules/services/package-builder';
import { recoverTestBundles } from '../../../../../src/modules/engines/test/unit/playwright/recover-test-bundles';

describe('unit recovery contracts without a browser', () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-recovery-contract-'));
		fs.writeFileSync(path.join(root, 'playwright.config.js'), "module.exports={use:{baseURL:'http://localhost'}};");
		PlaywrightUnitStrategy.clearBundleCache();
	});
	afterEach(() => { sinon.restore(); fs.rmSync(root, { recursive: true, force: true }); });
	const options = () => ({ packageName: 'test.recovery', packageRoot: root, projectRoot: root,
		publicPath: '/', targets: [], typescript: false, testFiles: ['a', 'b'].map(f => path.join(root, f + '.test.js')) });
	for (const debuggerOption of [{ debug: true }, { cdpPort: 9222 }])
	{
		it(`does not split ambiguous builds with ${JSON.stringify(debuggerOption)}`, async () => {
			const buildCode = sinon.stub().rejects(new Error('unlocated plugin error'));
			sinon.stub(PackageBuilder, 'getBuildEngine').resolves({ buildCode } as any);
			const result = await new PlaywrightUnitStrategy().run({ ...options(), ...debuggerOption });
			assert.equal(buildCode.callCount, 1);
			assert.equal(result.buildRecovery?.mode, 'exclude');
			assert.equal(result.buildRecovery?.stopReason, 'ambiguous');
			assert.lengthOf(result.buildRecovery!.untestedFiles, 2);
		});
	}
	it('returns validation errors and permits a subsequent valid call', async () => {
		const buildCode = sinon.stub().rejects(new Error('plugin'));
		sinon.stub(PackageBuilder, 'getBuildEngine').resolves({ buildCode } as any);
		const strategy = new PlaywrightUnitStrategy();
		const invalid = await strategy.run({ ...options(), buildRecoveryRetries: -1 });
		assert.include(invalid.errors[0].message, 'non-negative');
		assert.equal(buildCode.callCount, 0);
		const valid = await strategy.run({ ...options(), buildRecoveryRetries: 0 });
		assert.equal(valid.buildRecovery?.attempts, 1);
	});
	it('does not blame healthy files for a repeated global plugin error', async () => {
		const files = options().testFiles;
		const result = await recoverTestBundles(files, async () => { throw { message: 'plugin configuration', code: 'PLUGIN_ERROR' }; });
		assert.equal(result.recovery.stopReason, 'ambiguous');
		assert.equal(result.recovery.attempts, 2);
		assert.isEmpty(result.recovery.excludedFiles);
		assert.deepEqual(result.recovery.untestedFiles, files);
		assert.equal(result.failures[0].error.message, 'plugin configuration');
	});
	it('matches real diagnostic paths to entries reached through a junction', async () => {
		const real = path.join(root, 'real'); const link = path.join(root, 'link');
		fs.mkdirSync(real); fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
		fs.writeFileSync(path.join(real, 'bad.js'), 'bad');
		const bad = path.join(link, 'bad.js'), good = path.join(root, 'good.js');
		const result = await recoverTestBundles([bad, good], async (files) => {
			if (files.includes(bad)) throw Object.assign(new Error('parse'), { id: path.join(real, 'bad.js') });
			return 'ok';
		});
		assert.deepEqual(result.recovery.excludedFiles, [bad]);
		assert.equal(result.recovery.attempts, 2);
		assert.deepEqual(result.bundles[0].files, [good]);
	});
	it('stops inside individual fallback when the time budget expires', async () => {
		let clock = 0, calls = 0;
		const files = [...options().testFiles, path.join(root, 'c.test.js')];
		const result = await recoverTestBundles(files, async () => {
			if (++calls === 1) throw new Error('combined');
			clock = 10; return 'ok';
		}, { buildRecoveryTimeoutMs: 10 }, () => clock);
		assert.equal(result.recovery.stopReason, 'time-limit');
		assert.equal(result.recovery.attempts, 2);
		assert.deepEqual(result.recovery.untestedFiles, files.slice(1));
	});
});
