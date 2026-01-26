import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import js from "@eslint/js";
import globals from "globals";

export default [
	js.configs.recommended,
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				...globals.node,
				...globals.browser,
				NodeJS: "readonly",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
			"no-redeclare": "off",
			"@typescript-eslint/no-redeclare": "off",
			"no-undef": "off",
		},
	},
];
