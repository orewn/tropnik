type AndroidDownloadManifest = Readonly<{version: string; architecture: string}>;

/** The Worker serves large APKs from their immutable, verified public release. */
export function androidDownloadTarget(manifest: AndroidDownloadManifest, requestedFile: string): string | null {
  if (!/^\d+\.\d+\.\d+-preview$/.test(manifest.version)) return null;
  const file = manifest.architecture === 'universal' ? 'tropnik-preview.apk'
    : manifest.architecture === 'arm64-v8a' ? 'tropnik-arm64-preview.apk' : null;
  if (!file || requestedFile !== file) return null;
  return `https://github.com/orewn/tropnik/releases/download/v${manifest.version}/${file}`;
}
