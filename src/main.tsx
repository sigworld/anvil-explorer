import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { applyThemePreference, getStoredThemePreference } from './lib/theme.ts'

applyThemePreference(getStoredThemePreference())

render(<App />, document.getElementById('app')!)
