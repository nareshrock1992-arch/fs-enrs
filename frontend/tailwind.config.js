/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CSS-variable driven palette — light/dark in index.css
        surface: {
          bg:      'rgb(var(--surface-bg)      / <alpha-value>)',
          panel:   'rgb(var(--surface-panel)   / <alpha-value>)',
          raised:  'rgb(var(--surface-raised)  / <alpha-value>)',
          hover:   'rgb(var(--surface-hover)   / <alpha-value>)',
          border:  'rgb(var(--surface-border)  / <alpha-value>)',
          // card is an alias for panel — used by cards and list items
          card:    'rgb(var(--surface-panel)   / <alpha-value>)',
        },
        text: {
          primary:   'rgb(var(--text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--text-muted)     / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand)       / <alpha-value>)',
          light:   'rgb(var(--brand-light) / <alpha-value>)',
          dim:     'rgb(var(--brand-dim)   / <alpha-value>)',
        },
        // primary = semantic alias for brand — use for selection states, focus rings, active borders
        primary: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
        },
        // Semantic status tokens — CSS-variable backed so they follow the theme
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
        },
        // status.* kept for backwards-compatibility with any direct usage
        status: {
          success: 'rgb(var(--success) / <alpha-value>)',
          warning: 'rgb(var(--warning) / <alpha-value>)',
          danger:  'rgb(var(--danger)  / <alpha-value>)',
          info:    'rgb(var(--info)    / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm:  '4px',
        DEFAULT: '6px',
        lg:  '10px',
        xl:  '14px',
        '2xl': '18px',
      },
    },
  },
  plugins: [],
};
