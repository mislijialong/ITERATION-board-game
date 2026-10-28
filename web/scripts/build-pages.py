"""Build a fully self-contained, static-hostable page for GitHub Pages.
Inlines CSS/JS, rewrites absolute asset paths to relative, and enables P2P
multiplayer. No backend is required: the host browser acts as the authority.
"""
from pathlib import Path
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist-pages'
UTF8 = dict(encoding='utf-8')

data = json.loads((ROOT / 'game/game_data.json').read_text(**UTF8))
assets = json.loads((ROOT / 'src/card-assets.json').read_text(**UTF8))

def safe_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')

# Version asset URLs by content so browsers do not keep stale card images.
asset_urls = {
    key: path + '?v=' + hashlib.sha256((ROOT / path).read_bytes()).hexdigest()[:12]
    for key, path in assets.items()
}
for wonder in data['wonders']:
    wonder.pop('image', None)
assert len(data['tech']) == 60 and len(data['events']) == 14 and len(data['wonders']) == 15

# Inline CSS; background textures live next to the page, not one level up.
css = (ROOT / 'src/tabletop-v4.css').read_text(**UTF8)
css = css.replace("url('../assets/", "url('assets/").replace('url("../assets/', 'url("assets/')

def js(name):
    text = (ROOT / 'src' / name).read_text(**UTF8)
    # Relative asset paths for project pages (https://user.github.io/repo/).
    text = text.replace("img.src='/'+src;", "img.src=src;")
    text = text.replace("'<img src=\"/'+", "'<img src=\"'+")
    text = text.replace("'/assets/", "'assets/")
    return text

game_data_html = '<script id="card-data" type="application/json">' + safe_json(data) + '</script>'
card_assets_html = '<script id="tabletop-assets" type="application/json">' + safe_json(asset_urls) + '</script>'
rule_engine_html = ''.join(
    '<script>' + (ROOT / 'game' / name).read_text(**UTF8).replace('</script', '<\\/script') + '</script>'
    for name in ('game_config.js', 'game_engine.js', 'game_flow.js')
)
p2p_flag_html = '<script>window.ITERATION_P2P_ONLY=true;</script>'
scripts_html = ''.join(
    '<script>' + js(name) + '</script>'
    for name in ('tabletop-v4-testing.js', 'tabletop-v4-network.js', 'tabletop-v4-p2p.js',
                 'tabletop-v4-controller.js', 'tabletop-v4-assist.js', 'tabletop-v4-board.js')
)

html = (ROOT / 'src/tabletop-v4.html').read_text(**UTF8)
html = html.replace('<link rel="stylesheet" href="/source/tabletop-v4.css">', '<style>' + css + '</style>')
html = html.replace('<!-- GAME_DATA -->', game_data_html)
html = html.replace('<!-- CARD_ASSETS -->', card_assets_html)
html = html.replace('<!-- RULE_ENGINE -->', rule_engine_html)
html = html.replace(
    '<script src="/source/tabletop-v4-testing.js"></script>'
    '<script src="/source/tabletop-v4-network.js"></script>'
    '<script src="/source/tabletop-v4-p2p.js"></script>'
    '<script src="/source/tabletop-v4-controller.js"></script>'
    '<script src="/source/tabletop-v4-assist.js"></script>'
    '<script src="/source/tabletop-v4-board.js"></script>',
    p2p_flag_html + scripts_html
)

# Clean output and copy the asset directory next to the page.
shutil.rmtree(OUT, ignore_errors=True)
(OUT / 'assets').mkdir(parents=True, exist_ok=True)
source_assets = ROOT / 'assets'
if source_assets.is_dir():
    for item in source_assets.iterdir():
        if item.is_file():
            shutil.copy2(item, OUT / 'assets' / item.name)

(OUT / 'index.html').write_text(html, **UTF8)
print(f'Built {OUT / "index.html"} ({len(html)} bytes, assets={len(list((OUT/"assets").iterdir()))})')