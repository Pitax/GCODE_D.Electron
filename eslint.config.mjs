import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['**/out/**', '**/node_modules/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			semi: ['error', 'always'],
			quotes: ['error', 'single', { allowTemplateLiterals: true }],
			eqeqeq: 'error',
			curly: ['warn', 'multi-line'],
			indent: ['warn', 'tab', { SwitchCase: 1 }]
		}
	}
);
