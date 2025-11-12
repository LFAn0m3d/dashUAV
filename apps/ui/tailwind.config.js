/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0f172a',
        primary: '#38bdf8',
        accent: '#f97316'
      }
    }
  },
  plugins: [],
};
