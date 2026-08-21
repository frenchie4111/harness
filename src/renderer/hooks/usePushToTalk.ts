import { useCallback, useEffect, useRef, useState } from 'react'

// Hand-rolled rather than pulled from lib.dom: `processLocally` and the
// static `available()`/`install()` are new enough that the shipped DOM
// typings don't carry them, and @types/dom-speech-recognition doesn't
// either.
interface SpeechAlternativeLike {
  transcript: string
}
interface SpeechResultLike extends ArrayLike<SpeechAlternativeLike> {
  isFinal: boolean
}
interface SpeechResultEventLike {
  resultIndex: number
  results: ArrayLike<SpeechResultLike>
}
interface SpeechErrorEventLike {
  error: string
  message?: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechErrorEventLike) => void) | null
  onresult: ((e: SpeechResultEventLike) => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function describeError(code: string): string {
  switch (code) {
    case 'network':
      // Chromium's cloud recognition endpoint needs a Google API key that
      // Electron builds don't ship. If this fires, the on-device model
      // didn't engage and there is no usable path in this runtime.
      return 'Speech service unreachable in this build'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied'
    case 'language-not-supported':
      return 'On-device model not installed for this language'
    case 'no-speech':
      return 'Nothing heard'
    case 'audio-capture':
      return 'No microphone found'
    default:
      return `Dictation failed (${code})`
  }
}

export interface PushToTalk {
  supported: boolean
  recording: boolean
  error: string | null
  start: () => void
  stop: () => void
  clearError: () => void
}

export interface UsePushToTalkOptions {
  /** Fires on every interim + final update with the full text so far. */
  onUpdate: (text: string) => void
  /** Fires once when recognition ends, with the final text. */
  onFinal: (text: string) => void
}

export function usePushToTalk({
  onUpdate,
  onFinal
}: UsePushToTalkOptions): PushToTalk {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const finalRef = useRef('')
  const [supported] = useState(() => getRecognitionCtor() !== null)

  const cbRef = useRef({ onUpdate, onFinal })
  cbRef.current = { onUpdate, onFinal }

  const stop = useCallback((): void => {
    const rec = recRef.current
    if (!rec) return
    try {
      rec.stop()
    } catch {
      recRef.current = null
      setRecording(false)
    }
  }, [])

  const start = useCallback((): void => {
    const Ctor = getRecognitionCtor()
    if (!Ctor || recRef.current) return

    setError(null)
    finalRef.current = ''

    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true

    rec.onstart = () => setRecording(true)

    rec.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalRef.current += text
        else interim += text
      }
      cbRef.current.onUpdate((finalRef.current + interim).trimStart())
    }

    rec.onerror = (ev) => {
      if (ev.error !== 'no-speech') setError(describeError(ev.error))
    }

    rec.onend = () => {
      recRef.current = null
      setRecording(false)
      cbRef.current.onFinal(finalRef.current.trim())
    }

    recRef.current = rec
    try {
      rec.start()
    } catch (e) {
      recRef.current = null
      setRecording(false)
      setError(e instanceof Error ? e.message : 'Could not start dictation')
    }
  }, [])

  // A held key never sends keyup if the window loses focus mid-hold, which
  // would otherwise strand recognition running with no way to stop it.
  useEffect(() => {
    if (!recording) return
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [recording, stop])

  useEffect(() => {
    return () => {
      const rec = recRef.current
      if (!rec) return
      recRef.current = null
      try {
        rec.abort()
      } catch {
        /* torn down mid-flight */
      }
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { supported, recording, error, start, stop, clearError }
}
