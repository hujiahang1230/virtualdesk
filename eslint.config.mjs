import nextPlugin from '@next/eslint-plugin-next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint 扁平配置。
 * 直接组合 next / react / react-hooks / jsx-a11y 插件,而不是走 FlatCompat 兼容层:
 * 依赖更少,规则来源也更清楚。
 */
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      'drizzle/**',
      'next-env.d.ts',

      // 桌面壳:.NET 宿主(源码是 shell/*.cs),打包产物与启动器源码不走 Web 规则
      'shell/dist/**',
      'shell/bin/**',
      'shell/obj/**',
      'shell/assets/**',
      'shell/launcher/**',

      // 第三方库源码(vendored,保持原样便于比对上游)
      'src/lib/vendor/**',

      // 一次性验证脚本与探针产物
      '.probe-*/**',
      '.probe-*.mjs',
      '*.probe.mjs',
      'shell/.*.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        React: 'readonly',
      },
    },
    plugins: {
      '@next/next': nextPlugin,
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // App Router 不需要在每个文件里 import React
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
);
