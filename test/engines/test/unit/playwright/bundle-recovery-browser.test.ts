import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { assert } from 'chai';
import sinon from 'sinon';
import { rollup } from 'rollup';
import { PlaywrightUnitStrategy } from '../../../../../src/modules/engines/test/unit/playwright/playwright-unit-strategy';
import { PackageBuilder } from '../../../../../src/modules/services/package-builder';
import type { UnitTestOptions, TestToken } from '../../../../../src/modules/engines/test/test-types';

// Opt-in integration check with an existing local browser; never installs or
// changes a browser used by another runner. The page substitutes only the portal.
(process.env.CHEF_TEST_BROWSER ? describe : describe.skip)('bundle recovery in Chromium', function() {
	this.timeout(30000);
	let root: string;
	let server: http.Server;
	let options: UnitTestOptions;
	let builds: string[];
	let unknownLocation: boolean;
	let brokenPage: boolean;
	const require = createRequire(import.meta.url);

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-browser-recovery-'));
		builds = [];
		unknownLocation = false;
		brokenPage = false;
		PlaywrightUnitStrategy.clearBundleCache();
		const mocha = fs.readFileSync(require.resolve('mocha/mocha.js'), 'utf8');
		server = http.createServer((_req, res) => {
			if (brokenPage) { res.writeHead(503); res.end('offline'); return; }
			res.setHeader('content-type', 'text/html');
			res.end(`<html><script>${mocha}</script><script>
			window.ProxyReporter = function(runner) {
				runner.on('end', () => { window.mocha.stats = runner.stats; });
				for (const [event, id] of [['pass', 'TEST_PASSED'], ['fail', 'TEST_FAILED'], ['pending', 'TEST_PENDING']]) {
					runner.on(event, (test, error) => window.__chefSendToken(JSON.stringify({
						id, title: test.title, suite: [test.parent.title], duration: test.duration,
						error: error ? {message: error.message, stack: error.stack} : undefined
					})));
				}
			};
			</script></html>`);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		fs.writeFileSync(path.join(root, 'playwright.config.js'), `module.exports = {use: {baseURL: 'http://127.0.0.1:${port}'}};`);
		const pwDir = path.join(root, 'node_modules', 'playwright');
		fs.mkdirSync(pwDir, { recursive: true });
		fs.writeFileSync(path.join(pwDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
		fs.writeFileSync(path.join(pwDir, 'index.js'), `
			import pw from ${JSON.stringify(pathToFileURL(require.resolve('playwright')).href)};
			export default { chromium: { launch: (opts) => pw.chromium.launch({...opts, executablePath: ${JSON.stringify(process.env.CHEF_TEST_BROWSER)}}) } };
		`);
		options = {
			packageName: 'test.recovery', packageRoot: root, projectRoot: root,
			publicPath: '/', targets: [], typescript: false, testFiles: [],
		};
		// Real Rollup compilation; the production strategy, browser, Mocha, and
		// report-token path remain untouched. Unknown metadata simulates plugins
		// that fail without naming an input entry.
		sinon.stub(PackageBuilder, 'getBuildEngine').resolves({
			buildCode: async ({ code }: { code: string }) => {
				builds.push(code);
				try
				{
					const bundle = await rollup({ input: 'entry', plugins: [{
						name: 'entry', resolveId: (id) => id === 'entry' ? id : null,
						load: (id) => id === 'entry' ? code : null,
					}] });
					try
					{
						const output = (await bundle.generate({ format: 'iife', sourcemap: true })).output[0];
						return { code: output.code, map: output.map, css: '', errors: [], warnings: [], dependencies: [] };
					}
					finally { await bundle.close(); }
				}
				catch (error)
				{
					if (unknownLocation) throw new Error((error as Error).message);
					throw error;
				}
			},
		} as any);
	});

	afterEach(async () => {
		sinon.restore();
		PlaywrightUnitStrategy.clearBundleCache();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	});

	function file(name: string, source: string): void
	{
		const target = path.join(root, name);
		fs.writeFileSync(target, source);
		options.testFiles.push(target);
	}
	function healthy(name: string): void
	{
		file(`${name}.test.js`, `describe('healthy', () => it('${name}', () => {}));`);
	}

	it('runs healthy tests once and reports the excluded file as failed, including live tokens', async () => {
		healthy('first'); healthy('second'); file('bad.test.js', 'const broken = ;');
		const tokens: TestToken[] = [];
		const result = await new PlaywrightUnitStrategy().run({ ...options, onToken: (token) => tokens.push(token) });
		assert.equal(builds.length, 2);
		assert.deepEqual(result.report.filter((t) => t.id === 'TEST_PASSED').map((t) => t.title), ['first', 'second']);
		assert.lengthOf(result.errors, 1);
		assert.include(result.report.find((t) => t.id === 'TEST_FAILED')!.title, 'bad.test.js');
		assert.deepEqual(tokens, result.report);
		assert.equal(result.stats.failures, 1);
	});

	it('executes independent bundles when the source is unknown and keeps the target red', async () => {
		unknownLocation = true;
		healthy('first'); file('bad.test.js', 'const broken = ;'); healthy('second');
		const result = await new PlaywrightUnitStrategy().run(options);
		assert.equal(builds.length, 4);
		assert.deepEqual(result.report.filter((t) => t.id === 'TEST_PASSED').map((t) => t.title), ['first', 'second']);
		assert.lengthOf(result.errors, 2);
	});

	it('does not retry assertions or page failures', async () => {
		file('assert.test.js', `describe('suite', () => it('fails', () => { throw new Error('assertion'); }));`);
		const assertion = await new PlaywrightUnitStrategy().run(options);
		assert.lengthOf(assertion.report.filter((t) => t.id === 'TEST_FAILED'), 1);
		assert.equal(builds.length, 1);
		brokenPage = true;
		const page = await new PlaywrightUnitStrategy().run(options);
		assert.lengthOf(page.errors, 1);
		assert.isEmpty(page.report);
		assert.equal(builds.length, 1);
	});

	it('keeps build failures under grep and list without executing listed tests', async () => {
		file('good.test.js', `describe('suite', () => it('selected', () => { throw new Error('must not execute'); }));`);
		file('bad.test.js', 'const broken = ;');
		const result = await new PlaywrightUnitStrategy().run({ ...options, grep: 'selected', listOnly: true });
		assert.lengthOf(result.report.filter((t) => t.id === 'TEST_LISTED'), 1);
		assert.lengthOf(result.report.filter((t) => t.id === 'TEST_FAILED'), 1);
		assert.lengthOf(result.errors, 1);
	});
});
