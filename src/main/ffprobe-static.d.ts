// ffprobe-static ships no type declarations of its own.
declare module 'ffprobe-static' {
  const ffprobeStatic: { path: string }
  export default ffprobeStatic
}
