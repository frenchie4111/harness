import { HeaderNav } from './components/HeaderNav'
import { Hero } from './components/Hero'
import { DemoVideo } from './components/DemoVideo'
import { Features } from './components/Features'
import { OpenSource } from './components/OpenSource'
import { Install } from './components/Install'
import { Footer } from './components/Footer'
import { ScrollDiorama } from './components/ScrollDiorama'

export function App() {
  return (
    <div className="min-h-screen grid-bg">
      <HeaderNav />
      <Hero />
      <DemoVideo />
      <ScrollDiorama />
      <Features />
      <OpenSource />
      <Install />
      <Footer />
    </div>
  )
}
