import { ConfigStrategy } from '../../config-strategy';

export type BannerConfig = {
	top: string;
	bottom: string;
};

export const bannerStrategy = {
	key: 'banner',
	getDefault(): BannerConfig
	{
		return { top: '', bottom: '' };
	},
	prepare(value: any): BannerConfig
	{
		if (typeof value === 'string')
		{
			return { top: value, bottom: '' };
		}

		if (typeof value === 'object' && value !== null && !Array.isArray(value))
		{
			return {
				top: typeof value.top === 'string' ? value.top : '',
				bottom: typeof value.bottom === 'string' ? value.bottom : '',
			};
		}

		return this.getDefault();
	},
	validate(value: any): true | string
	{
		if (typeof value === 'string' || value === undefined)
		{
			return true;
		}

		if (
			typeof value === 'object'
			&& value !== null
			&& !Array.isArray(value)
			&& ['top', 'bottom'].every((key) => value[key] === undefined || typeof value[key] === 'string')
		)
		{
			return true;
		}

		return 'Invalid \'banner\' value. Expected string or { top?: string, bottom?: string }';
	},
} satisfies ConfigStrategy<BannerConfig>;
