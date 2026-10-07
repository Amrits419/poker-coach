/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        ink: { 950: '#070a12', 900: '#0b1020', 800: '#10172a', 700: '#182238', 600: '#223050', 500: '#2e3f66' },
        accent: { DEFAULT: '#8b7cff', dim: '#6a5ce0' },
        fold: '#4f8cff',
        call: '#2fcf7a',
        raise: '#ff5c5c',
      },
      boxShadow: {
        seat: '0 2px 10px rgba(0,0,0,0.55)',
        glow: '0 0 0 2px rgba(139,124,255,0.9), 0 0 18px rgba(139,124,255,0.55)',
      },
    },
  },
  plugins: [],
}
