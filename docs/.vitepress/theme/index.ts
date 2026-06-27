import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import QuizBox from './components/QuizBox.vue'
import TagBrowser from './components/TagBrowser.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('QuizBox', QuizBox)
    app.component('TagBrowser', TagBrowser)
  },
} satisfies Theme
