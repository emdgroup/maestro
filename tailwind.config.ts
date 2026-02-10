import type { Config } from 'tailwindcss';
import containerQueries from '@tailwindcss/container-queries';

export default {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Primary (interactive, buttons, links)
        primary: 'hsl(var(--primary) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--primary-foreground) / <alpha-value>)',

        // Secondary (alternative accent, less prominent)
        secondary: 'hsl(var(--secondary) / <alpha-value>)',
        'secondary-foreground': 'hsl(var(--secondary-foreground) / <alpha-value>)',

        // Accent (system-driven, brand color)
        accent: 'hsl(var(--accent) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--accent-foreground) / <alpha-value>)',

        // Destructive (danger, delete, error states)
        destructive: 'hsl(var(--destructive) / <alpha-value>)',
        'destructive-foreground': 'hsl(var(--destructive-foreground) / <alpha-value>)',

        // Muted (secondary text, disabled states, placeholders)
        muted: 'hsl(var(--muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-foreground) / <alpha-value>)',

        // Semantic colors (independent of theme)
        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        error: 'hsl(var(--error) / <alpha-value>)',

        // Background/card/border
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        card: 'hsl(var(--card) / <alpha-value>)',
        'card-foreground': 'hsl(var(--card-foreground) / <alpha-value>)',
        popover: 'hsl(var(--popover) / <alpha-value>)',
        'popover-foreground': 'hsl(var(--popover-foreground) / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
      },
      fontFamily: {
        inter: ['Inter', 'system-ui', 'sans-serif'],
        firacode: ['FiraCode', 'Menlo', 'Monaco', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['FiraCode', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.875rem', { lineHeight: '1.25rem' }],
        'base': ['1rem', { lineHeight: '1.5rem' }],
        'lg': ['1.125rem', { lineHeight: '1.75rem' }],
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],
      },
    },
  },
  plugins: [containerQueries],
} satisfies Config;
