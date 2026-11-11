/** Vite compiles this worker separately and returns its deployed asset URL. */
declare module '*?worker&url' {
  const workerURL:string;
  export default workerURL;
}
