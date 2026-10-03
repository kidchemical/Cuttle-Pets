import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsWindow } from './components/SettingsWindow'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).has('settings') ? <SettingsWindow /> : <App />}
  </React.StrictMode>,
)
