from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "web/lib/offline-map.ts",
    """    const response = await fetch('/offline-map/manifest.json', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Паспорт карты недоступен. Скачивание не начато.');
    const manifest = await response.clone().json() as OfflineManifest;
""",
    """    const response = await fetch('/offline-map/manifest.json', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Паспорт карты недоступен. Скачивание не начато.');
    // Read the body once. Some Response implementations cannot reliably cache
    // the untouched branch of a cloned, large streamed body after its twin was consumed.
    const manifestText = await response.text();
    let manifest: OfflineManifest;
    try {
      manifest = JSON.parse(manifestText) as OfflineManifest;
    } catch {
      throw new Error('Паспорт карты не прошёл проверку.');
    }
""",
)

replace_once(
    "web/lib/offline-map.ts",
    """      const style = await fetch('/maps/pilot-style.json', { cache: 'no-store', signal: transfer.signal });
      if (!style.ok) throw new Error('Не удалось сохранить оформление карты.');
      await cache.put('/maps/pilot-style.json', style);
      // Keep the exact manifest whose hashes were checked, including across a deployment.
      await cache.put('/offline-map/manifest.json', response);
""",
    """      const style = await fetch('/maps/pilot-style.json', { cache: 'no-store', signal: transfer.signal });
      if (!style.ok) throw new Error('Не удалось сохранить оформление карты.');
      const styleBytes = await style.arrayBuffer();
      transfer.signal.throwIfAborted();
      await cache.put('/maps/pilot-style.json', new Response(styleBytes, { headers: {
        'Content-Type': style.headers.get('Content-Type') || 'application/json',
      } }));
      // Cache fresh bodies rather than responses whose streams participated in
      // parsing. This works consistently in browsers and strict Fetch implementations.
      await cache.put('/offline-map/manifest.json', new Response(manifestText, { headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      } }));
""",
)

Path("scripts/fix-offline-package.py").unlink(missing_ok=True)
