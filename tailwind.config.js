/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--ada-bg)',
        surface: 'var(--ada-surface)',
        raised: 'var(--ada-surface-raised)',
        ink: {
          900: 'var(--ada-ink-900)',
          850: 'var(--ada-ink-850)',
          800: 'var(--ada-ink-800)',
          700: 'var(--ada-ink-700)',
          600: 'var(--ada-ink-600)',
          500: 'var(--ada-ink-500)',
        },
        gold: {
          200: 'var(--ada-gold-200)',
          300: 'var(--ada-gold-300)',
          400: 'var(--ada-gold-400)',
          500: 'var(--ada-gold-500)',
          600: 'var(--ada-gold-600)',
        },
        txt: 'var(--ada-text)',
        muted: 'var(--ada-text-muted)',
        subtle: 'var(--ada-text-subtle)',
        line: 'var(--ada-line)',
        'line-strong': 'var(--ada-line-strong)',
        accent: 'var(--ada-accent)',
        'accent-ink': 'var(--ada-accent-ink)',
        success: 'var(--ada-success)',
        warning: 'var(--ada-warning)',
        danger: 'var(--ada-danger)',
        info: 'var(--ada-info)',
      },
      fontFamily: {
        display: 'var(--ada-font-display)',
        body: 'var(--ada-font-body)',
        mono: 'var(--ada-font-mono)',
      },
      borderRadius: {
        sm: 'var(--ada-radius-sm)',
        md: 'var(--ada-radius-md)',
        lg: 'var(--ada-radius-lg)',
        xl: 'var(--ada-radius-xl)',
      },
    },
  },
  plugins: [],
}
