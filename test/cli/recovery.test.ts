import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it } from 'mocha';
import { assert } from 'chai';
import { runChef, sourceRepo } from './run-chef';

describe('CLI build recovery contract', function ()
{
	this.timeout(60000);
	it('advertises support and rejects invalid limits before running', async () =>
	{
		const help = await runChef(['test', '--help']);
		assert.include(help.stdout, 'protocol v1');
		for (const flag of ['--build-recovery', '--build-recovery-retries', '--build-recovery-timeout-ms'])
		{
			assert.include(help.stdout, flag);
			const invalid = await runChef(['test', 'unit', 'ui.ts-valid', `${flag}=-1`]);
			assert.notEqual(invalid.exitCode, 0);
		}
	});
	it('forwards a zero retry budget to the engine and emits machine-readable coverage loss', async () =>
	{
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chef-cli-recovery-')));
		try
		{
			fs.cpSync(sourceRepo, root, { recursive: true });
			fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({private: true}));
			const extension = path.join(root, 'ui/install/js/ui/ts-valid');
			fs.appendFileSync(path.join(extension, 'bundle.config.js'), '\nmodule.exports.targets = [];');
			const unit = path.join(extension, 'tests/unit');
			fs.mkdirSync(unit, { recursive: true });
			fs.writeFileSync(path.join(unit, 'broken.test.ts'), 'function mountInto(parent: HTMLElement, cb: ?(id: string) => void = null): Object { return {}; } globalThis.mountInto = mountInto;');
			fs.writeFileSync(path.join(unit, 'healthy.test.ts'), "describe('healthy', () => it('ok', () => {}));");
			fs.writeFileSync(
				path.join(root, 'playwright.config.js'),
				"module.exports = {use:{baseURL:'http://127.0.0.1:1'}};",
			);
			const output = await runChef(
				[
					'test',
					'unit',
					'ui.ts-valid',
					'--reporter',
					'json',
					'--project',
					'chromium',
					'--build-recovery',
					'exclude',
					'--build-recovery-retries',
					'0',
					'--build-recovery-timeout-ms',
					'120000',
				],
				{ cwd: root },
			);
			assert.equal(output.exitCode, 1, output.stderr);
			assert.isNotEmpty(output.stdout, `No JSON returned: ${output.stderr}`);
			const json = JSON.parse(output.stdout);
			const recovery = json.extensions[0].details.unit.buildRecovery;
			assert.equal(recovery.schemaVersion, 1);
			assert.equal(recovery.mode, 'exclude');
			assert.equal(recovery.attempts, 1);
			assert.equal(recovery.stopReason, 'retry-limit');
			assert.include(recovery.excludedFiles, 'tests/unit/broken.test.ts');
			assert.include(recovery.untestedFiles, 'tests/unit/healthy.test.ts');
			assert.equal(recovery.errors[0].code, 'UNIT_BUILD_FAILED');
			assert.isFalse(json.success);
		}
		finally
		{
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
