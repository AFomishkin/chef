import * as path from 'node:path';

import { TraceMap } from '@jridgewell/trace-mapping';

import { UnitTestStrategy } from '../unit-test-strategy';
import { PackageBuilder } from '../../../../services/package-builder';
import { ChefError } from '../../../../../diagnostics/chef-error';
import { CF } from '../../../../../diagnostics/diagnostic-codes';
import { findPlaywrightConfig } from './find-playwright-config';
import { resolveMochaWrapper } from '../../env-test-file';
import { resolvePlaywright } from './resolve-playwright';
import { mapStack } from './map-stack';
import { embedSourceMap } from './embed-source-map';
import { signalReady, waitForDebugger } from './debug-signal';
import { recoverTestBundles, type RecoveredBundles } from './recover-test-bundles';

import type { SourceMap } from 'rollup';
import type {
	UnitTestOptions,
	TestResult,
	TestToken,
	ConsoleLog,
} from '../../test-types';

type TestBundle = {
	code: string;
	map: SourceMap | null;
	css: string;
};

export class PlaywrightUnitStrategy extends UnitTestStrategy
{
	static #bundleCache = new Map<string, Promise<RecoveredBundles<TestBundle>>>();

	// Run-level errors carry their full diagnostic in the message. Their JS stack would
	// point at this file — where the ChefError is constructed — which is meaningless to
	// the user and makes the reporter's code-frame highlight chef's own source. Drop it.
	static #runError(code: string, message: string): ChefError
	{
		const error = new ChefError(code, message);
		error.stack = undefined;

		return error;
	}

	static clearBundleCache(): void
	{
		PlaywrightUnitStrategy.#bundleCache.clear();
	}

	async #buildTestBundle(options: UnitTestOptions): Promise<TestBundle>
	{
		const sourceTestsCode = options.testFiles
			.map((filePath) => `import ${JSON.stringify(filePath.replaceAll('\\', '/'))};`)
			.join('\n');

		const buildEngine = await PackageBuilder.getBuildEngine();
		const buildResult = await buildEngine.buildCode({
			code: sourceTestsCode,
			packageName: options.packageName,
			targets: options.targets,
			packageRoot: options.packageRoot,
			publicPath: options.publicPath,
			typescript: options.typescript,
			inline: options.inline,
			namespace: 'BX.TestsBundle',
			sourcemap: true,
		});
		if (buildResult.errors.length > 0)
		{
			const diagnostic = buildResult.errors[0];
			throw Object.assign(new Error(diagnostic.message), {
				code: diagnostic.code,
				loc: diagnostic.loc,
			});
		}

		return {
			code: buildResult.code,
			map: buildResult.map ?? null,
			css: buildResult.css,
		};
	}

	#getCachedBundle(options: UnitTestOptions): Promise<RecoveredBundles<TestBundle>>
	{
		const files = options.file
			? options.testFiles.filter((filePath) => filePath.includes(path.basename(options.file)))
			: options.testFiles;
		const cacheKey = JSON.stringify([
			options.packageRoot, options.projectRoot, options.publicPath, options.packageName,
			options.targets, options.typescript, options.inline, files,
			options.buildRecovery, options.buildRecoveryRetries, options.buildRecoveryTimeoutMs,
		]);
		if (!PlaywrightUnitStrategy.#bundleCache.has(cacheKey))
		{
			PlaywrightUnitStrategy.#bundleCache.set(cacheKey, recoverTestBundles(
				files,
				(testFiles) => this.#buildTestBundle({ ...options, file: undefined, testFiles }),
				options,
			));
		}

		return PlaywrightUnitStrategy.#bundleCache.get(cacheKey)!;
	}

	async run(options: UnitTestOptions): Promise<TestResult>
	{
		let playwrightConfig;
		try
		{
			playwrightConfig = await findPlaywrightConfig(options.packageRoot, options.projectRoot);
		}
		catch (error)
		{
			// A config that exists but can't be loaded (syntax error, missing import) must
			// surface as a real error, not fall through to a config-less run.
			const reason = error instanceof Error ? error.message : String(error);

			return {
				report: [],
				stats: {},
				consoleLogs: [],
				errors: [PlaywrightUnitStrategy.#runError(CF.PLAYWRIGHT_ERROR, `Failed to load Playwright config: ${reason}`)],
			};
		}

		if (playwrightConfig === null)
		{
			return {
				report: [],
				stats: {},
				consoleLogs: [],
				errors: [
					PlaywrightUnitStrategy.#runError(CF.PLAYWRIGHT_CONFIG_NOT_FOUND, 'playwright.config.ts not found. Run `chef init tests` to set up the test environment.'),
				],
			};
		}

		if (!playwrightConfig.use?.baseURL)
		{
			return {
				report: [],
				stats: {},
				consoleLogs: [],
				errors: [
					PlaywrightUnitStrategy.#runError(
						CF.BASE_URL_NOT_SET,
						'baseURL is not set in playwright.config.ts. Add `use: { baseURL: \'http://your-bitrix-host\' }` '
						+ 'so chef knows where the test page lives.',
					),
				],
			};
		}

		options.onStatus?.('building');
		const plan = await this.#getCachedBundle(options);
		const combined: TestResult = { report: [], stats: {}, consoleLogs: [], errors: [] };
		const relativeFile = (file: string) => path.relative(options.packageRoot, file).replaceAll('\\', '/');
		combined.buildRecovery = {
			...plan.recovery,
			excludedFiles: plan.recovery.excludedFiles.map(relativeFile),
			untestedFiles: plan.recovery.untestedFiles.map(relativeFile),
			errors: plan.recovery.errors.map((error) => ({ ...error, files: error.files.map(relativeFile) })),
		};
		const cleanups: Array<() => Promise<void>> = [];
		for (const failure of plan.failures)
		{
			const label = failure.files.length === 1
				? path.relative(options.packageRoot, failure.files[0]).replaceAll('\\', '/')
				: 'combined test bundle';
			const message = `Could not build ${label}: ${failure.error.message}`;
			const error = Object.assign(new Error(message, { cause: failure.error }), {
				code: 'code' in failure.error ? failure.error.code : undefined,
			});
			error.stack = failure.error.stack;
			combined.errors.push(error);
			// A runError alone is invisible to consumers that already received healthy
			// tests for this target. Keep the build failure as a stable red entry too.
			const token: TestToken = {
				id: 'TEST_FAILED',
				title: `[build] ${label}`,
				suite: ['Chef build errors'],
				browser: options.browserType ?? 'chromium',
				error: { message, stack: failure.error.stack },
			};
			combined.report.push(token);
			options.onToken?.(token);
		}
		if (plan.recovery.untestedFiles.length > 0)
		{
			const message = `Build recovery stopped: ${plan.recovery.stopReason}; ${plan.recovery.untestedFiles.length} files not tested`;
			combined.errors.push(Object.assign(new Error(message), { code: 'UNIT_BUILD_RECOVERY_STOPPED' }));
			const token: TestToken = {
				id: 'TEST_FAILED', title: '[build] recovery stopped', suite: ['Chef build errors'],
				browser: options.browserType ?? 'chromium', error: { message },
			};
			combined.report.push(token);
			options.onToken?.(token);
		}
		for (const { bundle } of plan.bundles)
		{
			// Only compilation triggers recovery. Browser/config/runtime/assertion
			// failures are never retried, and each successful bundle executes once.
			const result = await this.#runBundle(options, playwrightConfig, bundle);
			combined.report.push(...result.report);
			combined.errors.push(...result.errors);
			combined.consoleLogs.push(...result.consoleLogs);
			for (const [key, value] of Object.entries(result.stats ?? {}))
			{
				combined.stats[key] = typeof value === 'number'
					? Number(combined.stats[key] ?? 0) + value
					: value;
			}
			if (result.debugCleanup)
			{
				cleanups.push(result.debugCleanup);
			}
		}
		combined.stats.failures = Number(combined.stats.failures ?? 0) + plan.failures.length + (plan.recovery.untestedFiles.length > 0 ? 1 : 0);
		combined.stats.tests = Number(combined.stats.tests ?? 0) + plan.failures.length + (plan.recovery.untestedFiles.length > 0 ? 1 : 0);
		combined.debugCleanup = cleanups.length > 0
			? async () => { await Promise.all(cleanups.map((cleanup) => cleanup())); }
			: null;
		return combined;
	}

	async #runBundle(
		options: UnitTestOptions,
		playwrightConfig: NonNullable<Awaited<ReturnType<typeof findPlaywrightConfig>>>,
		bundle: TestBundle,
	): Promise<TestResult>
	{
		const browserType = options.browserType ?? 'chromium';
		const onStatus = options.onStatus ?? (() => {});

		// Statuses are short per-engine stage words: the reporter shows them next to the
		// engine name in the unified status bar (e.g. "○ Chromium building").
		onStatus('starting');
		const playwright = await resolvePlaywright(options.projectRoot);
		const browserLauncher = playwright[browserType];
		if (!browserLauncher)
		{
			return {
				report: [],
				stats: {},
				consoleLogs: [],
				errors: [
					PlaywrightUnitStrategy.#runError(CF.UNKNOWN_BROWSER, `Unknown browser type: ${browserType}`),
				],
			};
		}

		const isDebug = !!options.debug;
		const cdpPort = options.cdpPort;

		let browser;
		if (cdpPort && browserType === 'chromium')
		{
			// Launch Chromium with CDP port, then connect Playwright to it.
			// We can't pass --remote-debugging-port to Playwright's launch()
			// because Playwright uses its own CDP pipe which conflicts.
			const chromiumPath = browserLauncher.executablePath();
			const { spawn } = await import('node:child_process');
			const os = await import('node:os');
			const chromiumProcess = spawn(chromiumPath, [
				`--remote-debugging-port=${cdpPort}`,
				'--no-first-run',
				'--no-default-browser-check',
				`--user-data-dir=${path.join(os.tmpdir(), `chef-debug-${Date.now()}`)}`,
			], { stdio: 'ignore' });

			// Wait for CDP port to be ready
			await new Promise<void>((resolve) => {
				const check = async () => {
					try
					{
						const response = await fetch(`http://localhost:${cdpPort}/json/version`);
						if (response.ok)
						{
							resolve();
							return;
						}
					}
					catch
					{
						// Port not ready yet
					}
					setTimeout(check, 100);
				};

				check();
			});

			browser = await browserLauncher.connectOverCDP(`http://localhost:${cdpPort}`);

			// Ensure Chromium process is killed when browser disconnects
			browser.on('disconnected', () => {
				chromiumProcess.kill();
			});
		}
		else
		{
			browser = await browserLauncher.launch({
				headless: isDebug ? false : !options.headed,
				...(isDebug ? {
					slowMo: 250,
					devtools: true,
					args: ['--auto-open-devtools-for-tabs'],
				} : {}),
			});
		}

		const context = cdpPort
			? browser.contexts()[0] ?? await browser.newContext()
			: await browser.newContext();
		const page = context.pages()[0] ?? await context.newPage();

		const report: TestToken[] = [];
		const consoleLogs: ConsoleLog[] = [];
		let tracer: TraceMap | null = null;

		try
		{
			onStatus('building');

			// Subscribe to page events BEFORE goto/addScriptTag to capture all messages
			page.on('console', async (message) => {
				try
				{
					const values: string[] = [];
					for (const arg of message.args())
					{
						try
						{
							const value = await arg.jsonValue();
							values.push(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
						}
						catch
						{
							try
							{
								const str = await arg.evaluate((obj: unknown) => {
									if (obj === null) return 'null';
									if (obj === undefined) return 'undefined';
									if (typeof obj === 'object')
									{
										try
										{
											return JSON.stringify(obj, null, 2);
										}
										catch
										{
											return String(obj);
										}
									}
									return String(obj);
								});
								values.push(str);
							}
							catch
							{
								values.push('[unserializable]');
							}
						}
					}

					const type = message.type();
					consoleLogs.push({ type, text: values.join(' ') });
				}
				catch (err)
				{
					consoleLogs.push({ type: 'error', text: `[console capture error: ${err}]` });
				}
			});

			page.on('pageerror', (error) => {
				consoleLogs.push({ type: 'error', text: error.message });
			});

			// Expose function for browser to send tokens directly via CDP
			await page.exposeFunction('__chefSendToken', (data: string) => {
				try
				{
					const token = JSON.parse(data) as TestToken;
					if (token.id === 'TEST_FAILED' && token.error?.stack && tracer)
					{
						token.error.stack = mapStack(token.error.stack, tracer);
					}
					if (!token.browser)
					{
						token.browser = browserType;
					}
					report.push(token);
					options.onToken?.(token);
				}
				catch
				{
					// Skip malformed tokens
				}
			});

			const { code: testsCodeBundle, map: sourceMap, css } = bundle;

			tracer = sourceMap ? new TraceMap(sourceMap as any) : null;

			const mochaWrapper = resolveMochaWrapper(options.packageRoot, options.projectRoot);
			const testsPageUrl = new URL(mochaWrapper, playwrightConfig.use.baseURL);
			testsPageUrl.searchParams.set('extension', options.packageName);

			onStatus('preparing');
			const response = await page.goto(testsPageUrl.toString());

			// page.goto only throws on a network error or timeout — a 404/500/302 resolves
			// fine, so without this check a missing mocha-wrapper.php or an unreachable
			// stand would silently load a wrong page and end as "no tests collected".
			if (!response || !response.ok())
			{
				const status = response ? `HTTP ${response.status()}` : 'no response';

				throw PlaywrightUnitStrategy.#runError(
					CF.TEST_PAGE_UNAVAILABLE,
					`Could not load the test page (${status}): ${testsPageUrl.toString()}\n`
					+ 'Check that the baseURL in playwright.config.ts points to a running Bitrix install '
					+ `and that ${mochaWrapper} exists there.\n`
					+ 'Set MOCHA_WRAPPER in .env.test if the runner page lives elsewhere.',
				);
			}

			// Close extra pages (about:blank) so CDP /json only shows the test page.
			// This prevents WipRemoteVmConnection from connecting to the wrong page.
			if (cdpPort)
			{
				for (const p of context.pages())
				{
					if (p !== page)
					{
						await p.close();
					}
				}
			}

			// Normalize to NFC: a pattern pasted on macOS often arrives decomposed (NFD) —
			// e.g. "й" as "и"+combining breve — while the source titles are NFC. Mocha turns
			// the string into a RegExp, which then matches nothing and silently drops every
			// test. NFC makes the pattern match the way the user sees it.
			const grep = options.grep ? options.grep.normalize('NFC') : null;
			const timeout = isDebug ? 60000 : 10000;

			// The page returned 2xx but might still be the wrong one — a login redirect, a
			// stub, or a mocha-wrapper.php that didn't emit the runner. Fail with a clear
			// reason instead of a cryptic "Cannot read properties of undefined (mocha)".
			const hasMocha = await page.evaluate(() => typeof (globalThis as any).mocha !== 'undefined');
			if (!hasMocha)
			{
				throw PlaywrightUnitStrategy.#runError(
					CF.TEST_PAGE_UNAVAILABLE,
					`The test page loaded but Mocha was not found on it: ${testsPageUrl.toString()}\n`
					+ `The page is likely not the test runner — check that ${mochaWrapper} is `
					+ 'served correctly and that the install does not redirect to an authorization page.',
				);
			}

			await page.evaluate(({ grep, timeout }) => {
				// @ts-ignore
				globalThis.mocha.setup({
					ui: 'bdd',
					// @ts-ignore
					reporter: ProxyReporter,
					checkLeaks: true,
					globals: [
						// Vue 3 creates these globals when first mounted
						'__VUE__',
						'__VUE_DEVTOOLS_HOOK_REPLAY__',
					],
					timeout,
					inlineDiffs: true,
					color: true,
					...(grep ? { grep } : {}),
				});
			}, { grep, timeout });

			onStatus('running');

			const codeWithSourceMap = sourceMap && cdpPort
				? embedSourceMap(testsCodeBundle, sourceMap)
				: testsCodeBundle;

			if (cdpPort)
			{
				// Wait for external debugger to connect BEFORE injecting test scripts.
				// This ensures the debugger receives scriptParsed events and can bind breakpoints.
				signalReady(cdpPort);
				await waitForDebugger();
			}

			if (css)
			{
				await page.addStyleTag({ content: css });
			}

			// Inject test scripts (after debugger is connected when cdpPort is set)
			await page.addScriptTag({
				content: codeWithSourceMap,
			});

			type TestStats = Promise<{ stats: any }>;

			// --list: the bundle is injected (so describe/it have populated mocha.suite), but
			// instead of running we walk the suite tree and emit TEST_LISTED for each test.
			if (options.listOnly)
			{
				const listed = await page.evaluate(() => {
					// Iterative DFS on purpose: a named nested function would make the bundler
					// inject a `__name(...)` helper into the serialized page.evaluate body,
					// which is undefined in the browser and throws "__name is not defined".
					// @ts-ignore — mocha is provided by the test page
					const root = globalThis.mocha.suite;
					const stack: Array<{ suite: any; path: string[] }> = [{ suite: root, path: [] }];
					const tests: Array<{ title: string; suite: string[]; pending: boolean }> = [];

					while (stack.length > 0)
					{
						const { suite, path } = stack.pop()!;
						const here = suite.title ? [...path, suite.title] : path;

						for (const test of suite.tests ?? [])
						{
							tests.push({ title: test.title, suite: here, pending: Boolean(test.pending) });
						}
						// Push children in reverse so they pop in source order.
						const children = suite.suites ?? [];
						for (let index = children.length - 1; index >= 0; index--)
						{
							stack.push({ suite: children[index], path: here });
						}
					}

					return tests;
				});

				for (const test of listed)
				{
					const token: TestToken = { id: 'TEST_LISTED', title: test.title, suite: test.suite, pending: test.pending, browser: browserType };
					report.push(token);
					options.onToken?.(token);
				}

				if (!isDebug && !cdpPort)
				{
					await browser.close();
				}

				return { report, stats: {}, consoleLogs, errors: [] };
			}

			const { stats } = await page.evaluate((): TestStats => {
				return new Promise((resolve) => {
					// @ts-ignore
					globalThis.mocha.run(() => {
						// @ts-ignore
						resolve({ stats: globalThis.mocha.stats });
					});
				});
			});

			// Tokens arrive via exposeFunction (CDP) — already received by this point

			const keepOpen = isDebug || !!cdpPort;

			if (!keepOpen)
			{
				await browser.close();
			}

			const debugCleanup = keepOpen
				? async () => {
					// Keep the Node.js event loop alive while waiting
					const keepAlive = setInterval(() => {}, 30_000);

					await new Promise<void>((resolve) => {
						const cleanup = async () => {
							clearInterval(keepAlive);
							resolve();
						};

						browser.on('disconnected', cleanup);
						page.on('close', cleanup);
						process.on('SIGINT', async () => {
							await browser.close();
						});
					});
				}
				: null;

			return {
				report,
				stats,
				consoleLogs,
				errors: [],
				debugCleanup,
			};
		}
		catch (error)
		{
			await browser.close().catch(() => {});

			return {
				report: [],
				stats: {},
				consoleLogs: [],
				errors: [error instanceof Error ? error : new Error(String(error))],
			};
		}
	}

}
