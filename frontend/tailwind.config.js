/** @type {import('tailwindcss').Config} */
export default {
  // Scan these files for class names so Tailwind tree-shakes unused CSS.
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // "Outdoorsy" palette: Forest Green + Earthy tones + tree-bark neutrals.
      colors: {
        forest: {
          50:  '#f2f7f3',
          100: '#dff0e3',
          200: '#c0ddc8',
          300: '#95c3a4',
          400: '#669f78',
          500: '#447d56',
          600: '#336442',
          700: '#2a5237',
          800: '#23412e',
          900: '#1d3526',
        },
        earth: {
          50:  '#faf6ef',
          100: '#f3e9d6',
          200: '#e6d0a8',
          300: '#d6b274',
          400: '#c8964a',
          500: '#b07d35',
          600: '#8f6328',
        },
        bark: {
          700: '#4a3b2a',
          800: '#3a2f22',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
