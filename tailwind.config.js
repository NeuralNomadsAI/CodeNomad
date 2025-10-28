export default {
  content: ["./src/**/*.{ts,tsx}", "./src/renderer/**/*.html"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {},
      spacing: {},
      fontSize: {
        'xs': ['var(--font-size-xs)', { lineHeight: 'var(--line-height-normal)' }],
        'sm': ['var(--font-size-sm)', { lineHeight: 'var(--line-height-normal)' }],
        'base': ['var(--font-size-base)', { lineHeight: 'var(--line-height-normal)' }],
        'lg': ['var(--font-size-lg)', { lineHeight: 'var(--line-height-tight)' }],
        'xl': ['var(--font-size-xl)', { lineHeight: 'var(--line-height-tight)' }],
        '2xl': ['var(--font-size-2xl)', { lineHeight: 'var(--line-height-tight)' }],
        'body': ['var(--font-size-base)', { lineHeight: 'var(--line-height-normal)' }],
        'label': ['var(--font-size-sm)', { lineHeight: 'var(--line-height-normal)' }],
        'heading': ['var(--font-size-lg)', { lineHeight: 'var(--line-height-tight)' }],
      },
      fontFamily: {
        'sans': ['var(--font-family-sans)', 'system-ui', 'sans-serif'],
        'mono': ['var(--font-family-mono)', 'monospace'],
        'body': ['var(--font-family-sans)', 'system-ui', 'sans-serif'],
        'heading': ['var(--font-family-sans)', 'system-ui', 'sans-serif'],
      },
      fontWeight: {
        'regular': 'var(--font-weight-regular)',
        'medium': 'var(--font-weight-medium)',
        'semibold': 'var(--font-weight-semibold)',
        'bold': 'var(--font-weight-bold)',
      },
      borderRadius: {},
      boxShadow: {},
    },
  },
  plugins: [],
}
