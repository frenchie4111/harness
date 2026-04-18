declare module '*.css'

declare module '*.png' {
  const src: string
  export default src
}

declare module '*?worker' {
  const WorkerCtor: new () => Worker
  export default WorkerCtor
}
