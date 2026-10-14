import { describe, it } from 'mocha';
import { assert } from 'chai';
import { runUnitTestsTask } from '../../../src/commands/test/tasks/run-unit-tests-task';

describe('unit task partial build failure', () => {
	it('keeps healthy-test metrics when the engine also returns build errors', async () => {
		const extension = {
			hasUnitTests: async () => true,
			runUnitTests: async ({ onToken }: any) => {
				const report = [
					{ id: 'TEST_FAILED', title: '[build] bad.test.ts', suite: ['Chef build errors'], error: { message: 'parse error' } },
					{ id: 'TEST_PASSED', title: 'healthy', suite: ['suite'] },
				];
				for (const token of report) onToken(token);
				return { report, stats: {}, consoleLogs: [], errors: [Object.assign(new Error('parse error'), { code: 'PARSE_ERROR' })] };
			},
		};
		const result = await runUnitTestsTask(extension as any, { project: ['chromium'] }).run(() => {});
		assert.equal(result.status, 'failed');
		assert.equal(result.metrics?.passed, 1);
		assert.equal(result.metrics?.failed, 1);
		assert.lengthOf(result.details, 1);
	});
});
