# Gotham Pro

No Gotham Pro binaries were supplied or found in the accessible project files.
No Gotham Pro binaries are redistributed in this build.

The CSS supports locally installed Gotham Pro plus owner-supplied licensed webfonts:
GothamPro-Thin, GothamPro-Light, GothamPro-Regular, GothamPro-Medium,
GothamPro-Bold, GothamPro-Black, and their Italic variants, .woff2 or .ttf.

After adding files licensed for web embedding (and separately app embedding if used
in the Android APK), run `node scripts/prepare-gotham.mjs` and rebuild.
Manrope is the openly licensed fallback until actual Gotham Pro assets are supplied.
No synthetic bold/italic is enabled. Do not report the fallback as embedded Gotham Pro.

## Offline Manrope fallback

The local Manrope Latin and Cyrillic WOFF2 files at weights 400 and 600 are bundled
for offline pages. They are redistributed under the SIL Open Font License 1.1;
see `MANROPE-LICENSE.txt`. `public/offline-fonts.css` declares these exact files.
The application bundle also retains its existing Manrope 500/700 imports.
