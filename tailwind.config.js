/** @type {import('tailwindcss').Config} */
export default {
  content: ['./web/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        mint: '#4ef0a8',
        aqua: '#3dd8f5',
        amberx: '#ffbe55',
        coral: '#ff7a7a',
        ink: { 950: '#060a10', 900: '#0a0f18', 800: '#0f1622', 700: '#172131' },
      },
      fontFamily: {
        // System fonts only: no network requests, and SF Pro on Apple platforms (HIG).
        sans: ['ui-sans-serif', '-apple-system', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Roboto Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
