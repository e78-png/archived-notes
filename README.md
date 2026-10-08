# Asset viewer

Static site. Regenerated from local archives; contents are published as-is.

## Layout

    index.html, app.js, style.css   the site (no framework, no build step)
    data/manifest.json              categories and counts
    data/catalog.json.gz            search index, one row per resource
    data/index/<category>.json.gz   full records per category, newline-delimited JSON
    data/media/                     images, lossless WebP

## Rebuilding

    tools/WzExtract.exe all   --out msviewer/out --drive "<download url>"
    python tools/optimize_media.py  --out msviewer/out --jobs 12
    python tools/sanitize_payload.py --out msviewer/out
    powershell -File tools/deploy_pages.ps1 -Yes

`data/catalog.json.gz` and `data/index/*.json.gz` are gzipped and served as
`application/gzip`; the browser inflates them with DecompressionStream.
