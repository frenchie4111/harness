import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStore } from './store'

initStore().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
