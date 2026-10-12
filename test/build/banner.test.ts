import { describe, it } from 'mocha';
import { assert } from 'chai';

import { toComment, insertBanner, shiftMappings } from '../../src/modules/engines/build/rollup/plugins/banner';

describe('banner plugin', () => {
	describe('toComment', () => {
		it('should keep a block comment as is', () => {
			assert.equal(toComment('/* Copyright */'), '/* Copyright */');
		});

		it('should keep line comments as is', () => {
			assert.equal(toComment('// first\n// second'), '// first\n// second');
		});

		it('should keep a legal comment as is', () => {
			assert.equal(toComment('/*! Copyright */'), '/*! Copyright */');
		});

		it('should wrap single-line text into a legal comment', () => {
			assert.equal(toComment('Copyright 2026'), '/*! Copyright 2026 */');
		});

		it('should wrap multi-line text into a legal comment', () => {
			assert.equal(toComment('Line one\n\nLine two'), '/*!\n * Line one\n *\n * Line two\n */');
		});

		it('should escape comment terminator inside wrapped text', () => {
			assert.equal(toComment('a */ b'), '/*! a *\\/ b */');
		});

		it('should wrap text that mixes comments and code', () => {
			assert.equal(toComment('/* a */ alert(1)'), '/*! /* a *\\/ alert(1) */');
		});

		it('should return empty string for empty text', () => {
			assert.equal(toComment('  \n '), '');
		});
	});

	describe('insertBanner', () => {
		const code = '/* eslint-disable */\n(function () {\n})();\n//# sourceMappingURL=bundle.js.map\n';

		it('should place top banner after the eslint-disable line', () => {
			const result = insertBanner(code, '/* top */', '');

			assert.equal(result.code, '/* eslint-disable */\n/* top */\n(function () {\n})();\n//# sourceMappingURL=bundle.js.map\n');
			assert.equal(result.insertLine, 1);
			assert.equal(result.addedLines, 1);
		});

		it('should place top banner at the start when there is no eslint-disable line', () => {
			const result = insertBanner('(function () {\n})();\n', '/*\n * top\n */', '');

			assert.equal(result.code, '/*\n * top\n */\n(function () {\n})();\n');
			assert.equal(result.insertLine, 0);
			assert.equal(result.addedLines, 3);
		});

		it('should place bottom banner before the source map comment', () => {
			const result = insertBanner(code, '', '/* bottom */');

			assert.equal(result.code, '/* eslint-disable */\n(function () {\n})();\n/* bottom */\n//# sourceMappingURL=bundle.js.map\n');
			assert.equal(result.addedLines, 0);
		});

		it('should place bottom banner before the source map comment without trailing newline', () => {
			const result = insertBanner('a();\n//# sourceMappingURL=bundle.js.map', '', '/* bottom */');

			assert.equal(result.code, 'a();\n/* bottom */\n//# sourceMappingURL=bundle.js.map');
		});

		it('should append bottom banner at the end when there is no source map comment', () => {
			assert.equal(insertBanner('a();', '', '/* bottom */').code, 'a();\n/* bottom */\n');
			assert.equal(insertBanner('a();\n', '', '/* bottom */').code, 'a();\n/* bottom */\n');
		});

		it('should place both banners', () => {
			const result = insertBanner(code, '/* top */', '/* bottom */');

			assert.equal(result.code, '/* eslint-disable */\n/* top */\n(function () {\n})();\n/* bottom */\n//# sourceMappingURL=bundle.js.map\n');
		});
	});

	describe('shiftMappings', () => {
		it('should insert empty lines at the given line', () => {
			assert.equal(shiftMappings(';AAAA;AACA', 1, 2), ';;;AAAA;AACA');
		});

		it('should insert empty lines at the start', () => {
			assert.equal(shiftMappings('AAAA;AACA', 0, 1), ';AAAA;AACA');
		});
	});
});
