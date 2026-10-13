import { describe, it } from 'mocha';
import { assert } from 'chai';

import { bannerStrategy } from '../../../src/modules/config/bundle/strategies/banner-strategy';

describe('bannerStrategy', () => {
	describe('validate', () => {
		it('should accept string', () => {
			assert.isTrue(bannerStrategy.validate('/* Copyright */'));
		});

		it('should accept object with top and bottom', () => {
			assert.isTrue(bannerStrategy.validate({ top: 'a', bottom: 'b' }));
		});

		it('should accept object with only bottom', () => {
			assert.isTrue(bannerStrategy.validate({ bottom: 'b' }));
		});

		it('should accept undefined', () => {
			assert.isTrue(bannerStrategy.validate(undefined));
		});

		it('should reject non-string top', () => {
			assert.isString(bannerStrategy.validate({ top: 1 }));
		});

		it('should reject array', () => {
			assert.isString(bannerStrategy.validate(['a']));
		});

		it('should reject boolean', () => {
			assert.isString(bannerStrategy.validate(true));
		});
	});

	describe('prepare', () => {
		it('should place string at the top', () => {
			assert.deepEqual(bannerStrategy.prepare('a'), { top: 'a', bottom: '' });
		});

		it('should fill missing positions with empty strings', () => {
			assert.deepEqual(bannerStrategy.prepare({ bottom: 'b' }), { top: '', bottom: 'b' });
		});

		it('should return empty banner by default', () => {
			assert.deepEqual(bannerStrategy.getDefault(), { top: '', bottom: '' });
		});
	});
});
