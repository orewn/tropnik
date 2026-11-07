from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "web/public/sw.js",
    "const VERSION='tropnik-shell-v12';",
    "const VERSION='tropnik-shell-v13';",
)
replace_once(
    "web/public/sw.js",
    """ const base='/maps/russia-relief/',response=await fetch(base+'manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifest=await response.clone().json();
""",
    """ const base='/maps/russia-relief/',response=await fetch(base+'manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifestText=await response.text();let manifest;
 try{manifest=JSON.parse(manifestText);}catch{throw new Error('Invalid overview package');}
""",
)
replace_once(
    "web/public/sw.js",
    " await cache.put(base+'manifest.json',response);",
    " await cache.put(base+'manifest.json',new Response(manifestText,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json'}}));",
)

Path("scripts/fix-overview-cache.py").unlink(missing_ok=True)
