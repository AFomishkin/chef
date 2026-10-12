import { stripComments } from './strip-comments';

import type { OutputAsset, Plugin } from 'rollup';
import type { BannerConfig } from '../../../../config/bundle/strategies/banner-strategy';

const ESLINT_DISABLE_LINE = '/* eslint-disable */\n';
const SOURCE_MAPPING_URL_PATTERN = /\n\/\/# sourceMappingURL=[^\n]*\n?$/;

/**
 * Adds the banner to the final JS bundle. Runs in `generateBundle` as the last plugin,
 * so the text is not touched by strip-comments or terser and also lands in the file
 * assembled by the concat plugin. The source map is shifted by the lines added on top.
 */
export default function bannerPlugin(banner: BannerConfig): Plugin
{
	const top = toComment(banner.top);
	const bottom = toComment(banner.bottom);

	return {
		name: 'banner',
		generateBundle(outputOptions, bundle)
		{
			for (const file of Object.values(bundle))
			{
				if (!file.fileName.endsWith('.js'))
				{
					continue;
				}

				const code = file.type === 'chunk' ? file.code : String(file.source);
				const result = insertBanner(code, top, bottom);

				if (file.type === 'chunk')
				{
					file.code = result.code;
				}
				else
				{
					file.source = result.code;
				}

				const sourceMap = bundle[`${file.fileName}.map`] as OutputAsset | undefined;
				if (sourceMap && result.addedLines > 0)
				{
					const map = JSON.parse(String(sourceMap.source));
					map.mappings = shiftMappings(map.mappings, result.insertLine, result.addedLines);
					sourceMap.source = JSON.stringify(map);
				}
			}
		},
	};
}

/**
 * Returns the text as is when it consists of comments only, otherwise wraps it
 * into a legal block comment (`/*! ... *\/`), which minifiers and bundlers keep
 * if the bundle is processed again.
 */
export function toComment(text: string): string
{
	const trimmedText = text.trim();
	if (trimmedText === '' || stripComments(trimmedText).trim() === '')
	{
		return trimmedText;
	}

	const lines = trimmedText.replaceAll('*/', '*\\/').split('\n');
	if (lines.length === 1)
	{
		return `/*! ${lines[0]} */`;
	}

	return ['/*!', ...lines.map((line) => ` * ${line}`.trimEnd()), ' */'].join('\n');
}

/**
 * Places `top` after the leading `/* eslint-disable *\/` line (or at the very start)
 * and `bottom` before the trailing source map comment (or at the very end).
 */
export function insertBanner(code: string, top: string, bottom: string): {
	code: string;
	insertLine: number;
	addedLines: number;
}
{
	let result = code;
	const insertLine = result.startsWith(ESLINT_DISABLE_LINE) ? 1 : 0;
	const addedLines = top === '' ? 0 : top.split('\n').length;

	if (top !== '')
	{
		const insertIndex = insertLine === 1 ? ESLINT_DISABLE_LINE.length : 0;
		result = `${result.slice(0, insertIndex)}${top}\n${result.slice(insertIndex)}`;
	}

	if (bottom !== '')
	{
		const sourceMappingUrl = SOURCE_MAPPING_URL_PATTERN.exec(result);
		if (sourceMappingUrl)
		{
			result = `${result.slice(0, sourceMappingUrl.index)}\n${bottom}${result.slice(sourceMappingUrl.index)}`;
		}
		else
		{
			result = `${result.endsWith('\n') ? result : `${result}\n`}${bottom}\n`;
		}
	}

	return { code: result, insertLine, addedLines };
}

/**
 * Inserts `count` empty lines into source map `mappings` at `line`.
 */
export function shiftMappings(mappings: string, line: number, count: number): string
{
	const lines = mappings.split(';');
	lines.splice(line, 0, ...Array.from({ length: count }, () => ''));

	return lines.join(';');
}
