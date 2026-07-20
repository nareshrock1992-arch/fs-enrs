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
        },
        text: {
          primary:   'rgb(var(--text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--text-muted)     / <alpha-value>)',
        },
        brand: {
          DEFAULT: '#2563EB',
          light:   '#60A5FA',
          dim:     '#1E4FB5',
        },
        status: {
          success: '#16A34A',
          warning: '#D97706',
          danger:  '#DC2626',
          info:    '#2563EB',
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
